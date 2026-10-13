/**
 * 多提供商搜索路由测试：链组装、失败降级、冷却跳过、聚合错误。
 * fetch 一律 stub，不打真实网络。
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildChain, routedWebSearch, DEFAULT_PROVIDER_ORDER } from '../../src/tools/search/router.js';
import { SearchProviderError } from '../../src/tools/search/providers/types.js';

let base: string;
let healthPath: string;
// 本机用户环境变量持久存在 ANYSEARCH_API_KEY，会漏进测试改变链构成——隔离之。
const ENV_KEYS = ['ANYSEARCH_API_KEY', 'TAVILY_API_KEY'] as const;
const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'search-router-'));
  healthPath = join(base, 'search-health.json');
  for (const k of ENV_KEYS) {
    savedEnv[k] = process.env[k];
    delete process.env[k];
  }
});

afterEach(() => {
  vi.unstubAllGlobals();
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  rmSync(base, { recursive: true, force: true });
});

const SESSION = { apiKey: 'sk-test', baseUrl: 'https://api.stepfun.com' };

describe('buildChain', () => {
  it('默认链：无 key 的 key 制提供商跳过', () => {
    const chain = buildChain(undefined, SESSION);
    const names = chain.map((c) => c.provider.name);
    expect(names).toEqual(['stepfun']); // tavily/anysearch 无 key 自动跳过
    // 默认顺序常量与文档承诺一致
    expect(DEFAULT_PROVIDER_ORDER).toEqual(['stepfun', 'tavily', 'anysearch']);
  });

  it('providers 配置覆盖链与顺序', () => {
    const chain = buildChain({ providers: ['anysearch', 'stepfun'], anysearch: { key: 'as-x' } }, SESSION);
    expect(chain.map((c) => c.provider.name)).toEqual(['anysearch', 'stepfun']);
  });

  it('disabledProviders 与 enabled=false 都摘除', () => {
    const chain = buildChain({ disabledProviders: ['anysearch'], tavily: { enabled: false } }, SESSION);
    const names = chain.map((c) => c.provider.name);
    expect(names).not.toContain('anysearch');
    expect(names).not.toContain('tavily');
  });

  it('key 制提供商：config 子段给 key 即入链', () => {
    const chain = buildChain({ tavily: { key: 'tvly-x' } }, SESSION);
    const tavily = chain.find((c) => c.provider.name === 'tavily');
    expect(tavily?.key).toBe('tvly-x');
  });

  it('providers 给了空链时 buildChain 返回空', () => {
    const chain = buildChain({ providers: ['tavily'] }, SESSION); // tavily 无 key
    expect(chain).toHaveLength(0);
  });
});

describe('routedWebSearch 降级', () => {
  const TAVILY_JSON = JSON.stringify({
    results: [
      { title: '结果甲', url: 'https://example.com/a', content: '摘要甲' },
      { title: '结果乙', url: 'https://example.com/b', content: '摘要乙' },
    ],
  });
  const TAVILY_CFG = { key: 'tvly-x' } as const;

  function stubFetchSequence(handlers: Record<string, (url: string) => Response>): void {
    vi.stubGlobal('fetch', async (url: unknown) => {
      const u = String(url);
      for (const [pattern, fn] of Object.entries(handlers)) {
        if (u.includes(pattern)) return fn(u);
      }
      throw new Error(`未 stub 的请求：${u}`);
    });
  }

  it('stepfun 配额失败 → 自动降级 tavily 命中，并标注来源与降级数', async () => {
    stubFetchSequence({
      'stepfun.com': () => new Response('you have no active step plan subscription', { status: 400 }),
      'tavily.com': () => new Response(TAVILY_JSON, { status: 200 }),
    });
    const outcome = await routedWebSearch({ query: '测试', n: 5, searchCfg: { providers: ['stepfun', 'tavily'], tavily: TAVILY_CFG }, session: SESSION, healthPath });
    expect(outcome.provider).toBe('tavily');
    expect(outcome.hits).toHaveLength(2);
    expect(outcome.attempts).toHaveLength(1);
    expect(outcome.attempts[0]!.provider).toBe('stepfun');
    expect(outcome.attempts[0]!.error).toContain('quota');
  });

  it('全部失败 → 聚合错误列出每家原因', async () => {
    stubFetchSequence({
      'stepfun.com': () => new Response('bad key', { status: 401 }),
      'tavily.com': () => new Response('oops', { status: 500 }),
    });
    await expect(
      routedWebSearch({ query: 'x', n: 5, searchCfg: { providers: ['stepfun', 'tavily'], tavily: TAVILY_CFG }, session: SESSION, healthPath }),
    ).rejects.toThrow(/stepfun.*tavily/s);
  });

  it('配额失败的提供商进入冷却：下一次直接跳过不再请求', async () => {
    let stepfunCalls = 0;
    vi.stubGlobal('fetch', async (url: unknown) => {
      const u = String(url);
      if (u.includes('stepfun.com')) {
        stepfunCalls += 1;
        return new Response('you have no active step plan subscription', { status: 400 });
      }
      if (u.includes('tavily.com')) return new Response(TAVILY_JSON, { status: 200 });
      throw new Error(u);
    });
    const args = { query: 'x', n: 5, searchCfg: { providers: ['stepfun', 'tavily'], tavily: TAVILY_CFG } as const, session: SESSION, healthPath };
    await routedWebSearch(args);
    expect(stepfunCalls).toBe(1);
    const second = await routedWebSearch(args);
    expect(stepfunCalls).toBe(1); // 冷却中，没再发请求
    expect(second.attempts[0]!.error).toContain('冷却中');
  });

  it('用户中断（父 signal）不降级，直接上抛', async () => {
    const parent = new AbortController();
    vi.stubGlobal('fetch', async (_url: unknown, init?: { signal?: AbortSignal }) => {
      parent.abort();
      const err = new Error('This operation was aborted');
      err.name = 'AbortError';
      throw err;
    });
    await expect(
      routedWebSearch({ query: 'x', n: 5, searchCfg: { providers: ['stepfun', 'tavily'] }, session: SESSION, healthPath, signal: parent.signal }),
    ).rejects.toThrow(/abort/i);
  });

  it('链为空时给可配置指引', async () => {
    await expect(
      routedWebSearch({ query: 'x', n: 5, searchCfg: { providers: ['tavily'] }, session: SESSION, healthPath }),
    ).rejects.toThrow(SearchProviderError);
  });
});
