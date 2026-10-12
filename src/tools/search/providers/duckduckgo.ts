/**
 * DuckDuckGo HTML 搜索（无 key，公开网页抓取）。
 * 走 html.duckduckgo.com 的轻量端点，结果链接是 uddg 跳转参数，需解码。
 */
import { BROWSER_UA, SearchProviderError, stripHtml, type SearchHit, type SearchProvider, type ProviderSearchArgs } from './types.js';

/** 从 DDG HTML 提取结果（导出以便单测）。 */
export function parseDdgHtml(html: string, max: number): SearchHit[] {
  const hits: SearchHit[] = [];
  const linkRe = /<a[^>]*class="[^"]*result__a[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  const snippetRe = /<a[^>]*class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>/gi;
  const links = [...html.matchAll(linkRe)];
  const snippets = [...html.matchAll(snippetRe)];
  for (let i = 0; i < links.length && hits.length < max; i++) {
    const m = links[i]!;
    let url = m[1]!;
    // DDG 跳转链接：//duckduckgo.com/l/?uddg=<urlencoded>
    const uddg = /[?&]uddg=([^&]+)/.exec(url);
    if (uddg !== null) {
      try {
        url = decodeURIComponent(uddg[1]!);
      } catch {
        continue;
      }
    }
    if (!/^https?:\/\//i.test(url)) continue;
    const title = stripHtml(m[2]!);
    const snippet = i < snippets.length ? stripHtml(snippets[i]![1]!) : undefined;
    hits.push({ title, url, snippet });
  }
  return hits;
}

export const duckduckgoProvider: SearchProvider = {
  name: 'duckduckgo',
  needsKey: false,
  async search({ query, n, baseUrl, signal }: ProviderSearchArgs): Promise<SearchHit[]> {
    const base = baseUrl ?? 'https://html.duckduckgo.com';
    const url = `${base.replace(/\/+$/, '')}/html/?q=${encodeURIComponent(query)}`;
    let res: Response;
    try {
      res = await fetch(url, {
        method: 'GET',
        headers: { 'User-Agent': BROWSER_UA, 'Accept-Language': 'zh-CN,zh;q=0.9' },
        signal: signal ?? null,
      });
    } catch (e) {
      if (signal?.aborted) throw e;
      throw new SearchProviderError('network', `请求失败：${(e as Error).message}`);
    }
    if (!res.ok) throw new SearchProviderError(res.status === 429 || res.status === 403 ? 'quota' : 'http', `HTTP ${res.status}`, res.status);
    const html = await res.text();
    const hits = parseDdgHtml(html, n);
    if (hits.length === 0) throw new SearchProviderError('parse', 'DuckDuckGo 页面零命中（可能改版或触发验证）');
    return hits;
  },
};
