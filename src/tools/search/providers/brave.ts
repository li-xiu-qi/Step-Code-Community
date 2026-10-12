/**
 * Brave Search API（key 制，https://brave.com/search/api/）。
 */
import { SearchProviderError, type SearchHit, type SearchProvider, type ProviderSearchArgs } from './types.js';

interface BraveResult {
  title?: string;
  url?: string;
  description?: string;
  age?: string;
}

export const braveProvider: SearchProvider = {
  name: 'brave',
  needsKey: true,
  keyEnv: 'BRAVE_API_KEY',
  async search({ query, n, key, baseUrl, signal }: ProviderSearchArgs): Promise<SearchHit[]> {
    if (key === undefined || key === '') throw new SearchProviderError('config', '未配置 Brave key（[search.brave] key 或 BRAVE_API_KEY）');
    const url = `${(baseUrl ?? 'https://api.search.brave.com').replace(/\/+$/, '')}/res/v1/web/search?q=${encodeURIComponent(query)}&count=${n}`;
    let res: Response;
    try {
      res = await fetch(url, {
        headers: { 'X-Subscription-Token': key, Accept: 'application/json' },
        signal: signal ?? null,
      });
    } catch (e) {
      if (signal?.aborted) throw e;
      throw new SearchProviderError('network', `请求失败：${(e as Error).message}`);
    }
    if (!res.ok) {
      throw new SearchProviderError(res.status === 401 || res.status === 403 || res.status === 429 ? 'quota' : 'http', `HTTP ${res.status}`, res.status);
    }
    let data: { web?: { results?: BraveResult[] } };
    try {
      data = (await res.json()) as { web?: { results?: BraveResult[] } };
    } catch {
      throw new SearchProviderError('parse', '返回 JSON 无法解析');
    }
    return (data.web?.results ?? [])
      .filter((r) => typeof r.url === 'string' && typeof r.title === 'string')
      .map((r) => ({ title: r.title!, url: r.url!, snippet: r.description, time: r.age }));
  },
};
