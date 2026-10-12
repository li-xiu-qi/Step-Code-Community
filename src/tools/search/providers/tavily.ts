/**
 * Tavily 搜索（key 制，https://tavily.com）。返回含 content，可进缓存供 web_extract。
 */
import { SearchProviderError, type SearchHit, type SearchProvider, type ProviderSearchArgs } from './types.js';

interface TavilyResult {
  title?: string;
  url?: string;
  content?: string;
  published_date?: string;
}

export const tavilyProvider: SearchProvider = {
  name: 'tavily',
  needsKey: true,
  keyEnv: 'TAVILY_API_KEY',
  async search({ query, n, key, baseUrl, signal }: ProviderSearchArgs): Promise<SearchHit[]> {
    if (key === undefined || key === '') throw new SearchProviderError('config', '未配置 Tavily key（[search.tavily] key 或 TAVILY_API_KEY）');
    const url = `${(baseUrl ?? 'https://api.tavily.com').replace(/\/+$/, '')}/search`;
    let res: Response;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ api_key: key, query, max_results: n, search_depth: 'basic' }),
        signal: signal ?? null,
      });
    } catch (e) {
      if (signal?.aborted) throw e;
      throw new SearchProviderError('network', `请求失败：${(e as Error).message}`);
    }
    if (!res.ok) {
      throw new SearchProviderError(res.status === 401 || res.status === 403 || res.status === 429 ? 'quota' : 'http', `HTTP ${res.status}`, res.status);
    }
    let data: { results?: TavilyResult[] };
    try {
      data = (await res.json()) as { results?: TavilyResult[] };
    } catch {
      throw new SearchProviderError('parse', '返回 JSON 无法解析');
    }
    return (data.results ?? [])
      .filter((r) => typeof r.url === 'string' && typeof r.title === 'string')
      .map((r) => ({ title: r.title!, url: r.url!, content: r.content, snippet: r.content?.slice(0, 300), time: r.published_date }));
  },
};
