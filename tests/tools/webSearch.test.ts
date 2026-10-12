import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { webSearchTool } from '../../src/tools/webSearch.js';
import type { ToolContext } from '../../src/tools/types.js';

const ctx: ToolContext = { cwd: process.cwd(), apiKey: 'k-test', baseUrl: 'https://api.stepfun.com' };

// 健康冷却文件必须隔离：默认路径在真实 ~/.step-code，线上失败记录会污染测试，
// 测试失败记录也会污染线上（2026-10-12 实测双向串扰）。
let diagTmp: string;

beforeEach(() => {
  diagTmp = mkdtempSync(join(tmpdir(), 'websearch-test-'));
  process.env.STEP_CODE_DIAG_DIR = diagTmp;
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.STEP_CODE_DIAG_DIR;
  rmSync(diagTmp, { recursive: true, force: true });
});

describe('web_search 工具', () => {
  it('无任何 key 且免 key 渠道也失败时：聚合错误逐家列出（新契约：无 key 不再直接判死，会尝试免 key 兜底）', async () => {
    vi.stubGlobal('fetch', async () => {
      throw new Error('network down');
    });
    const r = await webSearchTool.execute({ query: 'x' }, { cwd: process.cwd() });
    expect(r.isError).toBe(true);
    expect(r.content).toContain('stepfun');
    expect(r.content).toContain('bing');
  });

  it('正常返回时格式化 results（标题/链接/摘要），并标注来源提供商', async () => {
    const captured: { url?: string; body?: any; auth?: string } = {};
    vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
      captured.url = url;
      captured.body = JSON.parse(init.body as string);
      captured.auth = (init.headers as Record<string, string>)['Authorization'];
      return {
        ok: true,
        status: 200,
        json: async () => ({
          query: 'q',
          category: '',
          results: [
            { url: 'https://a.com', position: 1, title: '标题A', snippet: '摘要A' },
            { url: 'https://b.com', position: 2, title: '标题B', snippet: '摘要B' },
          ],
        }),
      } as unknown as Response;
    });

    const r = await webSearchTool.execute({ query: '阶跃', n: 2, category: 'research' }, ctx);
    expect(r.isError).toBe(false);
    expect(r.content).toContain('[1] 标题A');
    expect(r.content).toContain('https://a.com');
    expect(r.content).toContain('摘要A');
    expect(r.content).toContain('[2] 标题B');
    expect(r.content).toContain('via stepfun');
    // 请求形状正确
    expect(captured.url).toBe('https://api.stepfun.com/step_plan/v1/search');
    expect(captured.body).toMatchObject({ query: '阶跃', n: 2, category: 'research' });
    expect(captured.auth).toBe('Bearer k-test');
  });

  it('baseUrl 带 /v1 或 /step_plan/v1 后缀时去重拼接，避免 404', async () => {
    const captured: { url?: string } = {};
    vi.stubGlobal('fetch', async (url: string) => {
      captured.url = url;
      return {
        ok: true,
        status: 200,
        json: async () => ({ query: 'q', category: '', results: [] }),
      } as unknown as Response;
    });

    await webSearchTool.execute({ query: 'x' }, { cwd: process.cwd(), apiKey: 'k', baseUrl: 'https://api.stepfun.com/v1' });
    expect(captured.url).toBe('https://api.stepfun.com/step_plan/v1/search');

    await webSearchTool.execute({ query: 'x' }, { cwd: process.cwd(), apiKey: 'k', baseUrl: 'https://api.stepfun.com/step_plan/v1' });
    expect(captured.url).toBe('https://api.stepfun.com/step_plan/v1/search');
  });

  it('HTTP 非 2xx 且兜底也失败：聚合错误含状态码', async () => {
    vi.stubGlobal('fetch', async (url: string) => {
      if (url.includes('stepfun.com')) return { ok: false, status: 401, text: async () => '' } as unknown as Response;
      throw new Error('network down');
    });
    const r = await webSearchTool.execute({ query: 'x' }, ctx);
    expect(r.isError).toBe(true);
    expect(r.content).toContain('401');
  });

  it('无结果时给出明确提示', async () => {
    vi.stubGlobal('fetch', async () => ({
      ok: true,
      status: 200,
      json: async () => ({ query: 'x', category: '', results: [] }),
    }) as unknown as Response);
    const r = await webSearchTool.execute({ query: 'x' }, ctx);
    expect(r.content).toContain('无搜索结果');
  });
});
