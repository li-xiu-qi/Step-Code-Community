/**
 * Bing HTML 搜索（无 key，公开网页抓取）。
 * 解析 <li class="b_algo"> 卡片；Bing 改版导致零命中时抛 parse 错误交给路由降级。
 */
import { BROWSER_UA, SearchProviderError, stripHtml, type SearchHit, type SearchProvider, type ProviderSearchArgs } from './types.js';

/** 从 Bing HTML 提取结果（导出以便单测）。 */
export function parseBingHtml(html: string, max: number): SearchHit[] {
  const hits: SearchHit[] = [];
  // 每个 b_algo 卡片：标题链接在 h2>a，摘要在 .b_caption 的 p（可选）
  const cardRe = /<li class="b_algo"[\s\S]*?<\/li>/g;
  for (const m of html.matchAll(cardRe)) {
    const card = m[0];
    const link = /<h2[^>]*>\s*<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i.exec(card);
    if (link === null) continue;
    const url = link[1]!;
    if (!/^https?:\/\//i.test(url)) continue;
    const title = stripHtml(link[2]!);
    const cap = /<p[^>]*class="[^"]*b_lineclamp[^"]*"[^>]*>([\s\S]*?)<\/p>/i.exec(card) ?? /<p[^>]*>([\s\S]*?)<\/p>/i.exec(card);
    const snippet = cap !== null ? stripHtml(cap[1]!) : undefined;
    hits.push({ title, url, snippet });
    if (hits.length >= max) break;
  }
  return hits;
}

export const bingProvider: SearchProvider = {
  name: 'bing',
  needsKey: false,
  async search({ query, n, baseUrl, signal }: ProviderSearchArgs): Promise<SearchHit[]> {
    const base = baseUrl ?? 'https://www.bing.com';
    const url = `${base.replace(/\/+$/, '')}/search?q=${encodeURIComponent(query)}&count=${Math.min(n * 2, 30)}&setlang=zh-CN&mkt=zh-CN`;
    let res: Response;
    try {
      res = await fetch(url, { headers: { 'User-Agent': BROWSER_UA, 'Accept-Language': 'zh-CN,zh;q=0.9' }, signal: signal ?? null });
    } catch (e) {
      if (signal?.aborted) throw e;
      throw new SearchProviderError('network', `请求失败：${(e as Error).message}`);
    }
    if (!res.ok) throw new SearchProviderError(res.status === 429 || res.status === 403 ? 'quota' : 'http', `HTTP ${res.status}`, res.status);
    const html = await res.text();
    const hits = parseBingHtml(html, n);
    if (hits.length === 0) throw new SearchProviderError('parse', 'Bing 页面零命中（可能改版或触发验证）');
    return hits;
  },
};
