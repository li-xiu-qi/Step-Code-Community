import { z } from 'zod';
import { searchHttpError } from './searchError.js';
import { resolveSearchToolEndpoint } from './searchBase.js';
import { fail, ok, type ToolContext, type ToolDef } from './types.js';

const schema = z.object({
  query: z.string().describe('图片搜索词，建议中文，也支持英文。'),
  topk: z.number().int().min(1).max(20).optional().describe('返回图片张数上限，默认 5。'),
});

interface ImageResult {
  contentUrl: string;
  snippet?: string;
  width?: number;
  height?: number;
  hostPageUrl?: string;
  hostname?: string;
}

interface ImageSearchResponse {
  code?: number;
  msg?: string;
  data?: { result?: { block?: boolean; search_results?: ImageResult[] } };
}

/** 统一输出格式（与 stepfun 通道一致，模型看到的形态不变）。 */
function formatResults(images: ImageResult[]): string {
  if (images.length === 0) return '[无图片结果，可调整描述后重试]';
  return images
    .map((img, i) => {
      const size = img.width && img.height ? `  (${img.width}x${img.height})` : '';
      const desc = img.snippet ?? '';
      const from = img.hostPageUrl ? `\n    来源: ${img.hostPageUrl}` : '';
      return `[${i + 1}] ${desc}\n    ${img.contentUrl}${size}${from}`;
    })
    .join('\n\n');
}

/** stepfun 通道（Step Plan）：原实现，百度图源。 */
async function searchStepfun(
  query: string,
  topk: number,
  ctx: ToolContext,
): Promise<{ ok: true; text: string; via: string } | { ok: false; error: string }> {
  const endpoint = resolveSearchToolEndpoint(
    ctx.searchConfig,
    'image',
    { apiKey: ctx.apiKey, baseUrl: ctx.baseUrl },
    '/search-image',
  );
  if (endpoint.key === undefined || endpoint.key === '') {
    return { ok: false, error: '未配置 StepFun API key' };
  }
  let res: Response;
  try {
    res = await fetch(endpoint.url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${endpoint.key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ query, topk }),
      signal: ctx.signal,
    });
  } catch (e) {
    if (ctx.signal?.aborted) throw e;
    return { ok: false, error: `请求失败：${(e as Error).message}` };
  }
  if (!res.ok) {
    let text = '';
    try { text = await res.text(); } catch { /* 响应体读取失败不影响错误上报 */ }
    return { ok: false, error: searchHttpError('图片搜索', res.status, text) };
  }
  let data: ImageSearchResponse;
  try {
    data = (await res.json()) as ImageSearchResponse;
  } catch {
    return { ok: false, error: '返回无法解析' };
  }
  if (data.code !== 0) return { ok: false, error: `接口出错：${data.msg ?? `code ${data.code}`}` };
  const result = data.data?.result;
  if (result?.block === true) return { ok: false, error: '搜索词命中内容审核拦截' };
  const images = result?.search_results ?? [];
  if (images.length === 0) return { ok: false, error: '无图片结果' };
  return { ok: true, text: formatResults(images), via: 'stepfun' };
}

/** 豆包通道（火山引擎 feedcoopapi，与内容搜索同端点，SearchType=image，Count ≤ 5）。 */
async function searchDoubao(
  query: string,
  topk: number,
  key: string,
  ctx: ToolContext,
): Promise<{ ok: true; text: string; via: string } | { ok: false; error: string }> {
  interface DoubaoImageItem {
    Title?: string; Url?: string; SiteName?: string;
    Image?: { Url?: string; Width?: number; Height?: number };
  }
  interface DoubaoImageResponse {
    ResponseMetadata?: { Error?: { CodeN?: number; Code?: string; Message?: string } };
    Result?: { ImageResults?: DoubaoImageItem[] };
  }
  let res: Response;
  try {
    res = await fetch('https://open.feedcoopapi.com/search_api/web_search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify({ Query: query, SearchType: 'image', Count: Math.min(topk, 5), Filter: { NeedUrl: true } }),
      signal: ctx.signal,
    });
  } catch (e) {
    if (ctx.signal?.aborted) throw e;
    return { ok: false, error: `请求失败：${(e as Error).message}` };
  }
  let data: DoubaoImageResponse;
  try {
    data = (await res.json()) as DoubaoImageResponse;
  } catch {
    return { ok: false, error: '返回无法解析' };
  }
  const err = data.ResponseMetadata?.Error;
  if (err) return { ok: false, error: `接口错误 [${err.CodeN ?? err.Code ?? ''}] ${err.Message ?? ''}` };
  if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
  const images = (data.Result?.ImageResults ?? [])
    .filter((r) => typeof r.Image?.Url === 'string')
    .map((r) => ({
      contentUrl: r.Image!.Url!,
      snippet: r.Title,
      width: r.Image?.Width,
      height: r.Image?.Height,
      hostPageUrl: r.Url,
      hostname: r.SiteName,
    }));
  if (images.length === 0) return { ok: false, error: '无图片结果' };
  return { ok: true, text: formatResults(images), via: 'doubao' };
}

/** tavily 通道（include_images，免费档 1000 credits/月与内容搜索共用）。 */
async function searchTavily(
  query: string,
  topk: number,
  key: string,
  ctx: ToolContext,
): Promise<{ ok: true; text: string; via: string } | { ok: false; error: string }> {
  interface TavilyResponse { images?: { url?: string; description?: string }[] }
  let res: Response;
  try {
    res = await fetch('https://api.tavily.com/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ api_key: key, query, max_results: 1, include_images: true, include_image_descriptions: true }),
      signal: ctx.signal,
    });
  } catch (e) {
    if (ctx.signal?.aborted) throw e;
    return { ok: false, error: `请求失败：${(e as Error).message}` };
  }
  if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
  let data: TavilyResponse;
  try {
    data = (await res.json()) as TavilyResponse;
  } catch {
    return { ok: false, error: '返回无法解析' };
  }
  const images = (data.images ?? [])
    .filter((i) => typeof i.url === 'string')
    .slice(0, topk)
    .map((i) => ({ contentUrl: i.url!, snippet: i.description }));
  if (images.length === 0) return { ok: false, error: '无图片结果' };
  return { ok: true, text: formatResults(images), via: 'tavily' };
}

/**
 * 文搜图工具。三级回退：stepfun（Step Plan 通道，百度图源）→ 豆包（火山引擎，
 * SearchType=image，免费 500 次/月与内容搜索共用额度）→ tavily（include_images，
 * 与内容搜索共用 1000 credits/月）。Step Plan 过期不再等于文搜图整体失效。
 * key 复用 [search.doubao] / [search.tavily] 或其环境变量，无需新增配置面。
 */
export const imageSearchTool: ToolDef<z.infer<typeof schema>> = {
  name: 'web_image_search',
  description:
    '按文字描述联网搜索图片（多提供商回退：阶跃官方文搜图 → 豆包 → tavily）。用于为文档/文章/演示稿找配图。返回原图地址、描述（可作 alt）、尺寸与来源网页。',
  schema,
  access: () => ({ kind: 'none' }), // 纯网络调用，无本地副作用
  /** 上游搜索接口卡住时回合会无限期挂起；挂 per-tool 超时（signal 已传 fetch）。 */
  timeoutMs: 30_000,
  async execute(input, ctx) {
    const topk = input.topk ?? 5;
    // 文搜图链：image_providers 覆盖缺省顺序；image_disabled_providers 与
    // [search.<name>] enabled=false 摘除（enabled 与内容链共用同一段配置）。
    const DEFAULT_IMAGE_CHAIN = ['stepfun', 'doubao', 'tavily'] as const;
    const sc = ctx.searchConfig;
    const disabled = new Set(sc?.imageDisabledProviders ?? []);
    const order = sc?.imageProviders ?? [...DEFAULT_IMAGE_CHAIN];
    const keyOf = (name: 'doubao' | 'tavily'): string | undefined => {
      const entry = sc?.[name];
      if (entry?.enabled === false) return undefined;
      const envKey = name === 'doubao' ? 'DOUBAO_SEARCH_API_KEY' : 'TAVILY_API_KEY';
      return entry?.key ?? process.env[envKey];
    };
    const attempts: { name: string; run: () => Promise<{ ok: true; text: string; via: string } | { ok: false; error: string }> }[] = [];
    for (const name of order) {
      if (disabled.has(name)) continue;
      if (name === 'stepfun') {
        attempts.push({ name, run: () => searchStepfun(input.query, topk, ctx) });
      } else if (name === 'doubao') {
        const key = keyOf('doubao');
        if (key !== undefined && key !== '') attempts.push({ name, run: () => searchDoubao(input.query, topk, key, ctx) });
      } else if (name === 'tavily') {
        const key = keyOf('tavily');
        if (key !== undefined && key !== '') attempts.push({ name, run: () => searchTavily(input.query, topk, key, ctx) });
      }
      // 未知名字忽略（拼错不至于崩配置）
    }

    const errors: string[] = [];
    for (const a of attempts) {
      try {
        const r = await a.run();
        if (r.ok) return ok(`${r.text}\n\n[via ${r.via}]`);
        errors.push(`${a.name}: ${r.error}`);
      } catch (e) {
        if (ctx.signal?.aborted) return fail('用户中断，图片搜索已取消。');
        errors.push(`${a.name}: ${(e as Error).message}`);
      }
    }
    return fail(`图片搜索全部失败：${errors.join('；')}`);
  },
};
