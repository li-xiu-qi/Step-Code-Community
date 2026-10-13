/**
 * 豆包搜索（火山引擎联网搜索 API，key 制）。Bearer key，免费额度每账号每月 500 次、
 * 默认 1 QPS，放链尾保护额度。核心差异化能力是权威分级（AuthInfoDes），命中摘要
 * 带来源权威度标签前缀。接口形态见官方文档
 * https://www.volcengine.com/docs/87772/2272953。
 */
import { SearchProviderError, type SearchHit, type SearchProvider, type ProviderSearchArgs } from './types.js';

interface DoubaoWebItem {
  Title?: string;
  Url?: string;
  Summary?: string;
  Snippet?: string;
  SiteName?: string;
  PublishTime?: string;
  AuthInfoDes?: string;
}

interface DoubaoResponse {
  ResponseMetadata?: { Error?: { CodeN?: number; Code?: string; Message?: string } };
  Result?: { WebResults?: DoubaoWebItem[] };
}

export const doubaoProvider: SearchProvider = {
  name: 'doubao',
  needsKey: true,
  keyEnv: 'DOUBAO_SEARCH_API_KEY',
  async search({ query, n, key, baseUrl, signal }: ProviderSearchArgs): Promise<SearchHit[]> {
    if (key === undefined || key === '') throw new SearchProviderError('config', '未配置豆包搜索 key（[search.doubao] key 或 DOUBAO_SEARCH_API_KEY）');
    const url = baseUrl ?? 'https://open.feedcoopapi.com/search_api/web_search';
    let res: Response;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
        body: JSON.stringify({
          Query: query,
          SearchType: 'web',
          Count: n,
          Filter: { NeedContent: true, NeedUrl: true },
          QueryControl: { QueryRewrite: true },
        }),
        signal: signal ?? null,
      });
    } catch (e) {
      if (signal?.aborted) throw e;
      throw new SearchProviderError('network', `请求失败：${(e as Error).message}`);
    }
    let data: DoubaoResponse;
    try {
      data = (await res.json()) as DoubaoResponse;
    } catch {
      throw new SearchProviderError('parse', '返回 JSON 无法解析');
    }
    // 业务错误码在 ResponseMetadata.Error（HTTP 200 也会带）
    const err = data.ResponseMetadata?.Error;
    if (err) {
      const code = String(err.CodeN ?? err.Code ?? '');
      const msg = err.Message ?? '';
      if (code === '10406') throw new SearchProviderError('quota', `免费额度已用尽（每月 500 次）[${code}] ${msg}`, res.status);
      if (code === '10403') throw new SearchProviderError('config', `账号未开通豆包搜索服务 [${code}] ${msg}`, res.status);
      if (!res.ok) throw new SearchProviderError('http', `HTTP ${res.status} [${code}] ${msg}`, res.status);
      throw new SearchProviderError('http', `[${code}] ${msg}`, res.status);
    }
    if (!res.ok) {
      throw new SearchProviderError(res.status === 401 || res.status === 403 || res.status === 429 ? 'quota' : 'http', `HTTP ${res.status}`, res.status);
    }
    return (data.Result?.WebResults ?? [])
      .filter((r) => typeof r.Url === 'string' && typeof r.Title === 'string')
      .map((r) => {
        const text = r.Summary ?? r.Snippet;
        const label = r.AuthInfoDes ? `[${r.AuthInfoDes}] ` : '';
        return { title: r.Title!, url: r.Url!, content: text, snippet: text !== undefined ? label + text.slice(0, 300) : undefined, time: r.PublishTime };
      });
  },
};
