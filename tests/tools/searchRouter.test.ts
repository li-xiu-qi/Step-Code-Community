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

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'search-router-'));
  healthPath = join(base, 'search-health.json');
});

afterEach(() => {
  vi.unstubAllGlobals();
  rmSync(base, { recursive: true, force: true });
});

const SESSION = { apiKey: 'sk-test', baseUrl: 'https://api.stepfun.com' };

describe('buildChain', () => {
  it('默认链：无 key 的 key 制提供商跳过，免 key 兜底保留', () => {
    const chain = buildChain(undefined, SESSION);
    const names = chain.map((c) => c.provider.name);
    expect(names[0]).toBe('stepfun');
    expect(names).toContain('bing');
    expect(names).toContain('duckduckgo');
    expect(names).not.toContain('tavily'); // 无 key
    expect(names).not.toContain('bocha');
    expect(names).not.toContain('brave');
    // 默认顺序常量与文档承诺一致
    expect(DEFAULT_PROVIDER_ORDER).toEqual(['stepfun', 'tavily', 'bocha', 'brave', 'bing', 'duckduckgo']);
  });

  it('providers 配置覆盖链与顺序', () => {
    const chain = buildChain({ providers: ['bing', 'stepfun'] }, SESSION);
    expect(chain.map((c) => c.provider.name)).toEqual(['bing', 'stepfun']);
  });

  it('disabledProviders 与 enabled=false 都摘除', () => {
    const chain = buildChain({ disabledProviders: ['bing'], duckduckgo: { enabled: false } }, SESSION);
    const names = chain.map((c) => c.provider.name);
    expect(names).not.toContain('bing');
    expect(names).not.toContain('duckduckgo');
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
  const BING_HTML = `
    <html><body><ol id="b_results">
      <li class="b_algo"><h2><a href="https://example.com/a">结果甲</a></h2><p>摘要甲</p></li>
      <li class="b_algo"><h2><a href="https://example.com/b">结果乙</a></h2><p>摘要乙</p></li>
    </ol></body></html>`;

  function stubFetchSequence(handlers: Record<string, (url: string) => Response>): void {
    vi.stubGlobal('fetch', async (url: unknown) => {
      const u = String(url);
      for (const [pattern, fn] of Object.entries(handlers)) {
        if (u.includes(pattern)) return fn(u);
      }
      throw new Error(`未 stub 的请求：${u}`);
    });
  }

  it('stepfun 配额失败 → 自动降级 bing 命中，并标注来源与降级数', async () => {
    stubFetchSequence({
      'stepfun.com': () => new Response('you have no active step plan subscription', { status: 400 }),
      'bing.com': () => new Response(BING_HTML, { status: 200 }),
    });
    const outcome = await routedWebSearch({ query: '测试', n: 5, searchCfg: { providers: ['stepfun', 'bing'] }, session: SESSION, healthPath });
    expect(outcome.provider).toBe('bing');
    expect(outcome.hits).toHaveLength(2);
    expect(outcome.attempts).toHaveLength(1);
    expect(outcome.attempts[0]!.provider).toBe('stepfun');
    expect(outcome.attempts[0]!.error).toContain('quota');
  });

  it('全部失败 → 聚合错误列出每家原因', async () => {
    stubFetchSequence({
      'stepfun.com': () => new Response('bad key', { status: 401 }),
      'bing.com': () => new Response('<html>无卡片</html>', { status: 200 }),
    });
    await expect(
      routedWebSearch({ query: 'x', n: 5, searchCfg: { providers: ['stepfun', 'bing'] }, session: SESSION, healthPath }),
    ).rejects.toThrow(/stepfun.*bing/s);
  });

  it('配额失败的提供商进入冷却：下一次直接跳过不再请求', async () => {
    let stepfunCalls = 0;
    vi.stubGlobal('fetch', async (url: unknown) => {
      const u = String(url);
      if (u.includes('stepfun.com')) {
        stepfunCalls += 1;
        return new Response('you have no active step plan subscription', { status: 400 });
      }
      if (u.includes('bing.com')) return new Response(BING_HTML, { status: 200 });
      throw new Error(u);
    });
    const args = { query: 'x', n: 5, searchCfg: { providers: ['stepfun', 'bing'] } as const, session: SESSION, healthPath };
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
      routedWebSearch({ query: 'x', n: 5, searchCfg: { providers: ['stepfun', 'bing'] }, session: SESSION, healthPath, signal: parent.signal }),
    ).rejects.toThrow(/abort/i);
  });

  it('链为空时给可配置指引', async () => {
    await expect(
      routedWebSearch({ query: 'x', n: 5, searchCfg: { providers: ['tavily'] }, session: SESSION, healthPath }),
    ).rejects.toThrow(SearchProviderError);
  });
});
