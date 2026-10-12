/**
 * 博查 Bocha 搜索（key 制，https://open.bochaai.com）。中文覆盖好，有 summary。
 */
import { SearchProviderError, type SearchHit, type SearchProvider, type ProviderSearchArgs } from './types.js';

interface BochaPage {
  name?: string;
  url?: string;
  snippet?: string;
  summary?: string;
  datePublished?: string;
}

export const bochaProvider: SearchProvider = {
  name: 'bocha',
  needsKey: true,
  keyEnv: 'BOCHA_API_KEY',
  async search({ query, n, key, baseUrl, signal }: ProviderSearchArgs): Promise<SearchHit[]> {
    if (key === undefined || key === '') throw new SearchProviderError('config', '未配置博查 key（[search.bocha] key 或 BOCHA_API_KEY）');
    const url = `${(baseUrl ?? 'https://api.bochaai.com').replace(/\/+$/, '')}/v1/web-search`;
    let res: Response;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ query, count: n, summary: true }),
        signal: signal ?? null,
      });
    } catch (e) {
      if (signal?.aborted) throw e;
      throw new SearchProviderError('network', `请求失败：${(e as Error).message}`);
    }
    if (!res.ok) {
      throw new SearchProviderError(res.status === 401 || res.status === 403 || res.status === 429 ? 'quota' : 'http', `HTTP ${res.status}`, res.status);
    }
    let data: { data?: { webPages?: { value?: BochaPage[] } } };
    try {
      data = (await res.json()) as { data?: { webPages?: { value?: BochaPage[] } } };
    } catch {
      throw new SearchProviderError('parse', '返回 JSON 无法解析');
    }
    return (data.data?.webPages?.value ?? [])
      .filter((r) => typeof r.url === 'string' && typeof r.name === 'string')
      .map((r) => ({ title: r.name!, url: r.url!, snippet: r.snippet, content: r.summary ?? r.snippet, time: r.datePublished }));
  },
};
