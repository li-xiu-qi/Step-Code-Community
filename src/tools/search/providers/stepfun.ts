/**
 * 阶跃官方搜索提供商：现有单端点逻辑的提供商化封装。
 * endpoint 解析复用 searchBase.ts（[search.web]/[search]/主会话渠道三级）。
 */
import { resolveSearchToolEndpoint } from '../../searchBase.js';
import { searchHttpError } from '../../searchError.js';
import { SearchProviderError, type SearchHit, type SearchProvider, type ProviderSearchArgs } from './types.js';

interface StepfunResult {
  url: string;
  position: number;
  title: string;
  time?: string;
  snippet?: string;
  content?: string;
}

/** 把阶跃的错误响应归类：plan 过期/额度尽 → quota（长冷却），其余非 2xx → http。 */
function classifyHttpFailure(status: number, bodyText: string): SearchProviderError {
  const t = bodyText.toLowerCase();
  if (
    status === 401 ||
    status === 403 ||
    status === 429 ||
    t.includes('subscription') ||
    t.includes('no active step plan') ||
    t.includes('quota') ||
    t.includes('insufficient') ||
    t.includes('余额') ||
    t.includes('额度')
  ) {
    return new SearchProviderError('quota', `HTTP ${status}：${bodyText.slice(0, 200)}`, status);
  }
  return new SearchProviderError('http', `HTTP ${status}：${bodyText.slice(0, 200)}`, status);
}

export interface StepfunSession {
  readonly apiKey?: string;
  readonly baseUrl?: string;
}

/** 创建阶跃提供商实例（需要主会话渠道与 [search] 配置参与 endpoint 解析）。 */
export function createStepfunProvider(
  searchCfg: Parameters<typeof resolveSearchToolEndpoint>[0],
  session: StepfunSession,
  category?: 'programming' | 'research' | 'gov' | 'business',
): SearchProvider {
  return {
    name: 'stepfun',
    needsKey: true,
    async search({ query, n, signal }: ProviderSearchArgs): Promise<SearchHit[]> {
      const endpoint = resolveSearchToolEndpoint(searchCfg, 'web', session, '/search');
      if (endpoint.key === undefined || endpoint.key === '') {
        throw new SearchProviderError('config', '未配置 StepFun API key');
      }
      const body: Record<string, unknown> = { query, n };
      if (category !== undefined) body['category'] = category;
      let res: Response;
      try {
        res = await fetch(endpoint.url, {
          method: 'POST',
          headers: { Authorization: `Bearer ${endpoint.key}`, 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
          signal: signal ?? null,
        });
      } catch (e) {
        if (signal?.aborted) throw e;
        throw new SearchProviderError('network', `请求失败：${(e as Error).message}`);
      }
      if (!res.ok) {
        let text = '';
        try {
          text = await res.text();
        } catch {
          // 读取失败不影响归类
        }
        // 451 内容审核：查询词本身被平台拦，降级到别家等于绕过审核边界——fatal 短路，
        // 文案沿用 searchHttpError（明确「与 key、额度无关」防误导）。
        if (res.status === 451) {
          throw new SearchProviderError('fatal', searchHttpError('搜索', res.status, text), res.status);
        }
        throw classifyHttpFailure(res.status, text);
      }
      let data: { results?: StepfunResult[] };
      try {
        data = (await res.json()) as { results?: StepfunResult[] };
      } catch {
        throw new SearchProviderError('parse', '返回 JSON 无法解析');
      }
      return (data.results ?? []).map((r) => ({
        title: r.title,
        url: r.url,
        snippet: r.snippet,
        content: r.content,
        time: r.time,
      }));
    },
  };
}
