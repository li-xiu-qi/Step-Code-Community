import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { imageSearchTool } from '../../src/tools/imageSearch.js';
import type { ToolContext } from '../../src/tools/types.js';

const ctx: ToolContext = { cwd: process.cwd(), apiKey: 'k-test', baseUrl: 'https://api.stepfun.com' };

// 本机用户环境变量持久存在 DOUBAO/TAVILY key，不隔离会漏进链里真发网络请求。
const ENV_KEYS = ['DOUBAO_SEARCH_API_KEY', 'TAVILY_API_KEY'] as const;
const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
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
});

function stubJson(payload: unknown, ok = true, status = 200): void {
  vi.stubGlobal(
    'fetch',
    async () => ({ ok, status, json: async () => payload }) as unknown as Response,
  );
}

describe('web_image_search 工具', () => {
  it('缺少 apiKey 时返回错误', async () => {
    const r = await imageSearchTool.execute({ query: 'x' }, { cwd: process.cwd() });
    expect(r.isError).toBe(true);
    expect(r.content).toContain('API key');
  });

  it('正常返回时格式化图片（描述/原图/尺寸/来源），并打到 step_plan 端点', async () => {
    const captured: { url?: string; body?: any } = {};
    vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
      captured.url = url;
      captured.body = JSON.parse(init.body as string);
      return {
        ok: true,
        status: 200,
        json: async () => ({
          code: 0,
          msg: '',
          data: {
            result: {
              block: false,
              search_results: [
                {
                  contentUrl: 'https://img.example/a.png',
                  snippet: '一只猫',
                  width: 800,
                  height: 600,
                  hostPageUrl: 'https://page.example/a',
                  hostname: 'example',
                },
              ],
            },
          },
        }),
      } as unknown as Response;
    });

    const r = await imageSearchTool.execute({ query: '猫', topk: 3 }, ctx);
    expect(r.isError).toBe(false);
    expect(r.content).toContain('一只猫');
    expect(r.content).toContain('https://img.example/a.png');
    expect(r.content).toContain('(800x600)');
    expect(r.content).toContain('来源: https://page.example/a');
    expect(captured.url).toBe('https://api.stepfun.com/step_plan/v1/search-image');
    expect(captured.body).toMatchObject({ query: '猫', topk: 3 });
  });

  it('baseUrl 带 /v1 或 /step_plan/v1 后缀时去重拼接，避免 404', async () => {
    const captured: { url?: string } = {};
    vi.stubGlobal('fetch', async (url: string) => {
      captured.url = url;
      return {
        ok: true,
        status: 200,
        json: async () => ({ code: 0, msg: '', data: { result: { block: false, search_results: [] } } }),
      } as unknown as Response;
    });

    await imageSearchTool.execute({ query: 'x' }, { cwd: process.cwd(), apiKey: 'k', baseUrl: 'https://api.stepfun.com/v1' });
    expect(captured.url).toBe('https://api.stepfun.com/step_plan/v1/search-image');

    await imageSearchTool.execute({ query: 'x' }, { cwd: process.cwd(), apiKey: 'k', baseUrl: 'https://api.stepfun.com/step_plan/v1' });
    expect(captured.url).toBe('https://api.stepfun.com/step_plan/v1/search-image');
  });

  it('命中审核拦截 block=true 时返回错误提示', async () => {
    stubJson({ code: 0, msg: '', data: { result: { block: true, search_results: [] } } });
    const r = await imageSearchTool.execute({ query: 'x' }, ctx);
    expect(r.isError).toBe(true);
    expect(r.content).toContain('审核拦截');
  });

  it('code 非 0 返回错误', async () => {
    stubJson({ code: 1, msg: '额度不足' });
    const r = await imageSearchTool.execute({ query: 'x' }, ctx);
    expect(r.isError).toBe(true);
    expect(r.content).toContain('额度不足');
  });

  it('无结果时给出明确提示', async () => {
    stubJson({ code: 0, msg: '', data: { result: { block: false, search_results: [] } } });
    const r = await imageSearchTool.execute({ query: 'x' }, ctx);
    expect(r.content).toContain('无图片结果');
  });

  it('image_providers 链：doubao 优先时跳过 stepfun 直打 feedcoopapi，标注 [via doubao]', async () => {
    const captured: { url?: string; body?: any; auth?: string } = {};
    vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
      captured.url = url;
      captured.body = JSON.parse(init.body as string);
      captured.auth = (init.headers as Record<string, string>).Authorization;
      return {
        ok: true, status: 200,
        json: async () => ({
          ResponseMetadata: { RequestId: 'r' },
          Result: { ImageResults: [{ Title: '图一', Url: 'https://page.example/x', SiteName: 'P站', Image: { Url: 'https://img.example/x.jpg', Width: 640, Height: 480 } }] },
        }),
      } as unknown as Response;
    });
    const searchConfig = { imageProviders: ['doubao'], doubao: { key: 'db-test' } };
    const r = await imageSearchTool.execute({ query: '猫', topk: 3 }, { ...ctx, searchConfig: searchConfig as never });
    expect(r.isError).toBe(false);
    expect(captured.url).toBe('https://open.feedcoopapi.com/search_api/web_search');
    expect(captured.auth).toBe('Bearer db-test');
    expect(captured.body).toMatchObject({ Query: '猫', SearchType: 'image', Count: 3 });
    expect(r.content).toContain('https://img.example/x.jpg');
    expect(r.content).toContain('(640x480)');
    expect(r.content).toContain('[via doubao]');
  });

  it('imageDisabledProviders 与 [search.doubao] enabled=false 都摘除对应提供商', async () => {
    // stepfun 无 key 不进链；doubao 被 enabled=false 摘掉；tavily 被 image_disabled_providers 摘掉
    const seen: string[] = [];
    vi.stubGlobal('fetch', async (url: string) => {
      seen.push(String(url));
      return { ok: false, status: 401, json: async () => ({}) } as unknown as Response;
    });
    const searchConfig = { doubao: { key: 'db-test', enabled: false }, tavily: { key: 'tv-test' }, imageDisabledProviders: ['tavily'] };
    const r = await imageSearchTool.execute({ query: 'x' }, { cwd: process.cwd(), searchConfig: searchConfig as never });
    expect(r.isError).toBe(true);
    expect(seen).toHaveLength(0); // 三家全被摘掉，一个请求都没发
    expect(r.content).toContain('全部失败');
  });
});
