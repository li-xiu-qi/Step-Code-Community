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
const ENV_KEYS = ['ANYSEARCH_API_KEY', 'TAVILY_API_KEY', 'DOUBAO_SEARCH_API_KEY'] as const;
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
    expect(names).toEqual(['stepfun']); // kimi/tavily/anysearch/doubao 无 key 自动跳过
    // 默认顺序常量与文档承诺一致
    expect(DEFAULT_PROVIDER_ORDER).toEqual(['stepfun', 'kimi', 'tavily', 'anysearch', 'doubao']);
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

  it('doubao 命中：Query/Count 请求体 + WebResults 解析 + 权威度标签前缀', async () => {
    let doubaoBody: unknown;
    let authHeader: string | undefined;
    vi.stubGlobal('fetch', async (url: unknown, init?: RequestInit) => {
      const u = String(url);
      if (u.includes('stepfun.com')) return new Response('you have no active step plan subscription', { status: 400 });
      if (u.includes('feedcoopapi.com')) {
        expect(u).toBe('https://open.feedcoopapi.com/search_api/web_search');
        authHeader = (init!.headers as Record<string, string>).Authorization;
        doubaoBody = JSON.parse(init!.body as string);
        return new Response(JSON.stringify({
          ResponseMetadata: { RequestId: 'r1' },
          Result: {
            WebResults: [
              { Title: '甲', Url: 'https://a.com', Summary: '甲的摘要'.repeat(50), AuthInfoDes: '非常权威', PublishTime: '2026-10-01' },
              { Title: '乙', Url: 'https://b.com', Snippet: '乙的片段' },
            ],
          },
        }), { status: 200 });
      }
      throw new Error(u);
    });
    const outcome = await routedWebSearch({ query: '测试', n: 5, searchCfg: { providers: ['stepfun', 'doubao'], doubao: { key: 'db-x' } }, session: SESSION, healthPath });
    expect(outcome.provider).toBe('doubao');
    expect(authHeader).toBe('Bearer db-x');
    expect(doubaoBody).toMatchObject({ Query: '测试', SearchType: 'web', Count: 5 });
    expect(outcome.hits[0]).toMatchObject({ title: '甲', url: 'https://a.com', time: '2026-10-01' });
    expect(outcome.hits[0]!.snippet!.startsWith('[非常权威] ')).toBe(true);
    expect(outcome.hits[1]!.snippet).toBe('乙的片段');
  });

  it('doubao 10406 免费额度用尽归类 quota，HTTP 200 也带业务错误码', async () => {
    vi.stubGlobal('fetch', async () => new Response(JSON.stringify({
      ResponseMetadata: { Error: { CodeN: 10406, Message: '免费额度已用尽' } },
    }), { status: 200 }));
    await expect(
      routedWebSearch({ query: 'x', n: 5, searchCfg: { providers: ['doubao'], doubao: { key: 'db-x' } }, session: SESSION, healthPath }),
    ).rejects.toThrow(/quota/);
  });

  it('stepfun 配额失败 → 自动降级 kimi 命中（text_query 请求体 + search_results 解析）', async () => {
    let kimiBody: unknown;
    vi.stubGlobal('fetch', async (url: unknown, init?: RequestInit) => {
      const u = String(url);
      if (u.includes('stepfun.com')) return new Response('you have no active step plan subscription', { status: 400 });
      if (u.includes('kimi.com')) {
        expect(u).toBe('https://api.kimi.com/coding/v1/search');
        kimiBody = JSON.parse(init!.body as string);
        return new Response(JSON.stringify({
          search_results: [
            { title: '甲', url: 'https://a.com', snippet: '摘甲', date: '2026-10-01', site_name: 'A站' },
            { title: '乙', url: 'https://b.com', content: '正文乙' },
          ],
        }), { status: 200 });
      }
      throw new Error(u);
    });
    const outcome = await routedWebSearch({ query: '测试', n: 5, searchCfg: { providers: ['stepfun', 'kimi'], kimi: { key: 'sk-kimi-x' } }, session: SESSION, healthPath });
    expect(outcome.provider).toBe('kimi');
    expect(kimiBody).toEqual({ text_query: '测试' });
    expect(outcome.hits).toHaveLength(2);
    expect(outcome.hits[0]).toMatchObject({ title: '甲', url: 'https://a.com', snippet: '摘甲', time: '2026-10-01' });
    expect(outcome.hits[1]!.snippet).toBe('正文乙'); // snippet 缺省回退 content
  });

  it('kimi 命中按 n 截断', async () => {
    vi.stubGlobal('fetch', async () => new Response(JSON.stringify({
      search_results: [
        { title: '1', url: 'https://1.com' }, { title: '2', url: 'https://2.com' }, { title: '3', url: 'https://3.com' },
      ],
    }), { status: 200 }));
    const outcome = await routedWebSearch({ query: 'x', n: 2, searchCfg: { providers: ['kimi'], kimi: { key: 'sk-kimi-x' } }, session: SESSION, healthPath });
    expect(outcome.hits).toHaveLength(2);
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
