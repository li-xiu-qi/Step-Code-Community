/**
 * AnySearch 聚合搜索（key 制，https://anysearch.com，POST /v1/search）。
 * 与阶跃侧额度完全独立（阶跃 plan 过期/被风控时仍可用），有免费额度（具体次数
 * 以官方控制台实时为准）。响应形如 { data: { results: [...] } }，顶层 results 兜底。
 */
import { SearchProviderError, type SearchHit, type SearchProvider, type ProviderSearchArgs } from './types.js';

interface AnySearchResult {
  title?: string;
  url?: string;
  snippet?: string;
  content?: string;
  date?: string;
}

export const anysearchProvider: SearchProvider = {
  name: 'anysearch',
  needsKey: true,
  keyEnv: 'ANYSEARCH_API_KEY',
  async search({ query, n, key, baseUrl, signal }: ProviderSearchArgs): Promise<SearchHit[]> {
    if (key === undefined || key === '') throw new SearchProviderError('config', '未配置 AnySearch key（[search.anysearch] key 或 ANYSEARCH_API_KEY）');
    const url = `${(baseUrl ?? 'https://api.anysearch.com').replace(/\/+$/, '')}/v1/search`;
    let res: Response;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ query, max_results: n }),
        signal: signal ?? null,
      });
    } catch (e) {
      if (signal?.aborted) throw e;
      throw new SearchProviderError('network', `请求失败：${(e as Error).message}`);
    }
    if (!res.ok) {
      throw new SearchProviderError(res.status === 401 || res.status === 403 || res.status === 429 ? 'quota' : 'http', `HTTP ${res.status}`, res.status);
    }
    let data: { data?: { results?: AnySearchResult[] }; results?: AnySearchResult[] };
    try {
      data = (await res.json()) as { data?: { results?: AnySearchResult[] }; results?: AnySearchResult[] };
    } catch {
      throw new SearchProviderError('parse', '返回 JSON 无法解析');
    }
    return (data.data?.results ?? data.results ?? [])
      .filter((r) => typeof r.url === 'string' && typeof r.title === 'string')
      .map((r) => ({ title: r.title!, url: r.url!, snippet: r.snippet ?? r.content, content: r.content ?? r.snippet, time: r.date }));
  },
};
