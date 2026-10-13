import { z } from 'zod';
import { routedWebSearch } from './search/router.js';
import { SearchProviderError } from './search/providers/types.js';
import { fail, ok, type ToolDef } from './types.js';
import { webResultCache } from './webCache.js';

const schema = z.object({
  query: z.string().describe('检索关键词。'),
  n: z
    .number()
    .int()
    .min(1)
    .max(20)
    .optional()
    .describe('返回结果条数，默认 10，范围 1-20。'),
  category: z
    .enum(['programming', 'research', 'gov', 'business'])
    .optional()
    .describe('检索场景：programming 代码编程 / research 学术研究 / gov 政务 / business 商业财经；省略则全网（仅 stepfun 渠道生效）。'),
});

const MAX_SNIPPET = 500;

/**
 * 联网搜索工具：多提供商路由（stepfun → tavily → anysearch，全为 key 制），
 * 失败自动降级，连续失败自动冷却。Step plan 过期后由独立的 key 制服务接管，
 * web_search 不再随订阅状态整体失效（2026-10-12 事故背景；HTML 抓取类提供商
 * 已于 2026-10-13 移除）。
 * 链与开关在 config.toml 的 [search] 段：providers / disabled_providers / [search.<name>] key。
 */
export const webSearchTool: ToolDef<z.infer<typeof schema>> = {
  name: 'web_search',
  description:
    '联网搜索互联网公开信息（多提供商路由，失败自动降级）。用于获取最新信息（库版本、API 文档、实时资讯等模型训练后才有的内容）。返回标题、链接与摘要。结果缓存 30 分钟，web_extract 可直接读缓存。',
  schema,
  access: () => ({ kind: 'none' }), // 纯网络调用，无本地副作用
  /** 上游搜索接口卡住时回合会无限期挂起；挂 per-tool 超时（signal 已传 fetch）。 */
  timeoutMs: 30_000,
  async execute(input, ctx) {
    let outcome;
    try {
      outcome = await routedWebSearch({
        query: input.query,
        n: input.n ?? 10,
        category: input.category,
        searchCfg: ctx.searchConfig,
        session: { apiKey: ctx.apiKey, baseUrl: ctx.baseUrl },
        signal: ctx.signal,
      });
    } catch (e) {
      if (ctx.signal?.aborted) return fail('用户中断，搜索已取消。');
      if (e instanceof SearchProviderError && (e.kind === 'config' || e.kind === 'fatal')) return fail(e.message);
      return fail(`搜索失败：${(e as Error).message}`);
    }

    const results = outcome.hits;
    if (results.length === 0) {
      return ok('[无搜索结果，可调整关键词后重试]');
    }

    // 将搜索结果写入缓存（仅 content 字段），供后续 web_extract 复用
    for (const r of results) {
      const content = (r.content ?? '').trim();
      if (content.length > 0) {
        webResultCache.set({
          url: r.url,
          content,
          title: r.title,
          kind: 'search',
          ttlMs: 30 * 60 * 1000,
        });
      }
    }

    const formatted = results
      .map((r, i) => {
        const snippet = (r.snippet ?? '').slice(0, MAX_SNIPPET);
        return `[${i + 1}] ${r.title}\n    ${r.url}\n    ${snippet}`;
      })
      .join('\n\n');

    // 来源标注：降级链路的可信度不同，模型引用时应该知道是哪家给的
    const via = `\n\n---\n[via ${outcome.provider}${outcome.attempts.length > 0 ? `（降级 ${outcome.attempts.length} 家后命中）` : ''}]`;
    const cachedCount = results.filter((r) => (r.content ?? '').trim().length > 0).length;
    const cacheNote =
      cachedCount > 0 ? `\n[Cached ${cachedCount} URLs with full content for web_extract (memory cache, TTL 30 min)]` : '';
    return ok(formatted + via + cacheNote);
  },
};
