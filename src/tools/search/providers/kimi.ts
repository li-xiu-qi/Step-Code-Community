/**
 * Kimi（Moonshot）搜索：POST {baseUrl}/search，Bearer key，body {"text_query": query}。
 * 接口形态逆向自 Kimi Code 2.x 源码（2026-10-13）：
 *   agent-core-v2/src/app/auth/webSearch/providers/moonshot-web-search.ts
 *   agent-core-v2/src/app/auth/webSearch/webSearchService.ts（baseUrl = 渠道 baseUrl + /search）
 * 响应：{ search_results: [{ title, url, snippet, content?, date?, site_name?, icon?, mime? }] }。
 * 接口不接受条数参数，客户端按 n 截断。Kimi Code 会员 plan 自带该服务，
 * key 与 [providers.kimi-code] 渠道同源（config 加载时自动借用，见 config.ts）。
 */
import { SearchProviderError, type SearchHit, type SearchProvider, type ProviderSearchArgs } from './types.js';

interface KimiSearchResult {
  site_name?: string;
  title?: string;
  url?: string;
  snippet?: string;
  content?: string;
  date?: string;
}

export const kimiProvider: SearchProvider = {
  name: 'kimi',
  needsKey: true,
  keyEnv: 'KIMI_API_KEY',
  async search({ query, n, key, baseUrl, signal }: ProviderSearchArgs): Promise<SearchHit[]> {
    if (key === undefined || key === '') throw new SearchProviderError('config', '未配置 Kimi key（[search.kimi] key、KIMI_API_KEY，或配置 [providers.kimi-code] 渠道自动借用）');
    const url = `${(baseUrl ?? 'https://api.kimi.com/coding/v1').replace(/\/+$/, '')}/search`;
    let res: Response;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ text_query: query }),
        signal: signal ?? null,
      });
    } catch (e) {
      if (signal?.aborted) throw e;
      throw new SearchProviderError('network', `请求失败：${(e as Error).message}`);
    }
    if (!res.ok) {
      throw new SearchProviderError(res.status === 401 || res.status === 403 || res.status === 429 ? 'quota' : 'http', `HTTP ${res.status}`, res.status);
    }
    let data: { search_results?: KimiSearchResult[] };
    try {
      data = (await res.json()) as { search_results?: KimiSearchResult[] };
    } catch {
      throw new SearchProviderError('parse', '返回 JSON 无法解析');
    }
    return (data.search_results ?? [])
      .filter((r) => typeof r.url === 'string' && typeof r.title === 'string')
      .slice(0, n)
      .map((r) => ({
        title: r.title!,
        url: r.url!,
        snippet: r.snippet ?? r.content,
        content: r.content ?? r.snippet,
        time: r.date,
      }));
  },
};
