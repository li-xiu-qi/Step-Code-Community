/**
 * 联网搜索路由器：多提供商链 + 失败降级 + 冷却。
 *
 * 链的构成（SearchConfig.providers 覆盖默认链；disabledProviders 与 enabled=false 摘除）：
 *   stepfun → tavily → bocha → brave → bing → duckduckgo
 * key 制提供商未配 key（config 或环境变量）时直接跳过；stepfun 的 key 解析沿用
 * searchBase 的三级规则。每个提供商独立 12s 超时，失败按归类记冷却（health.ts），
 * 全部失败时返回聚合错误（每家的失败原因都列出，便于判断该补 key 还是换链）。
 */
import { diagDir } from '../../lifecycle.js';
import type { SearchConfig } from '../../config/config.js';
import { bingProvider } from './providers/bing.js';
import { bochaProvider } from './providers/bocha.js';
import { braveProvider } from './providers/brave.js';
import { duckduckgoProvider } from './providers/duckduckgo.js';
import { createStepfunProvider, type StepfunSession } from './providers/stepfun.js';
import { tavilyProvider } from './providers/tavily.js';
import { SearchProviderError, type SearchHit, type SearchProvider } from './providers/types.js';
import { SearchHealth } from './health.js';
import { join } from 'node:path';

export const DEFAULT_PROVIDER_ORDER = ['stepfun', 'tavily', 'bocha', 'brave', 'bing', 'duckduckgo'] as const;

const STATIC_PROVIDERS: Record<string, SearchProvider> = {
  tavily: tavilyProvider,
  bocha: bochaProvider,
  brave: braveProvider,
  bing: bingProvider,
  duckduckgo: duckduckgoProvider,
};

const PER_PROVIDER_TIMEOUT_MS = 12_000;

export interface RoutedSearchArgs {
  readonly query: string;
  readonly n: number;
  readonly category?: 'programming' | 'research' | 'gov' | 'business';
  readonly searchCfg: SearchConfig | undefined;
  readonly session: StepfunSession;
  readonly signal?: AbortSignal;
  /** 测试覆盖：健康文件路径（默认 diag 目录）。 */
  readonly healthPath?: string;
}

export interface SearchAttempt {
  readonly provider: string;
  readonly error: string;
}

export interface RoutedSearchOutcome {
  readonly hits: SearchHit[];
  /** 实际命中的提供商（输出里标注来源，模型可据此判断可信度）。 */
  readonly provider: string;
  readonly attempts: readonly SearchAttempt[];
}

/** 组装本次调用的提供商链（纯逻辑，导出以便单测）。 */
export function buildChain(
  searchCfg: SearchConfig | undefined,
  session: StepfunSession,
  category?: 'programming' | 'research' | 'gov' | 'business',
): { provider: SearchProvider; key?: string; baseUrl?: string }[] {
  const order = searchCfg?.providers ?? [...DEFAULT_PROVIDER_ORDER];
  const disabled = new Set(searchCfg?.disabledProviders ?? []);
  const chain: { provider: SearchProvider; key?: string; baseUrl?: string }[] = [];
  for (const name of order) {
    if (disabled.has(name)) continue;
    const entry = searchCfg?.[name as keyof SearchConfig] as { key?: string; url?: string; enabled?: boolean } | undefined;
    if (entry?.enabled === false) continue;
    if (name === 'stepfun') {
      chain.push({ provider: createStepfunProvider(searchCfg, session, category), baseUrl: entry?.url });
      continue;
    }
    const provider = STATIC_PROVIDERS[name];
    if (provider === undefined) continue; // 未知名字忽略（拼错不至于崩配置）
    if (provider.needsKey) {
      const key = entry?.key ?? (provider.keyEnv !== undefined ? process.env[provider.keyEnv] : undefined);
      if (key === undefined || key === '') continue; // 无 key 直接跳过，不算失败
      chain.push({ provider, key, baseUrl: entry?.url });
    } else {
      chain.push({ provider, baseUrl: entry?.url });
    }
  }
  return chain;
}

/** 执行路由搜索。全部失败时抛 SearchProviderError('http', 聚合原因)。 */
export async function routedWebSearch(args: RoutedSearchArgs): Promise<RoutedSearchOutcome> {
  const chain = buildChain(args.searchCfg, args.session, args.category);
  if (chain.length === 0) {
    throw new SearchProviderError(
      'config',
      '搜索提供商链为空：未配置任何可用渠道。可在 config.toml 的 [search] 段配置 providers 与各家 key（bing/duckduckgo 免 key 可直接启用）。',
    );
  }
  const health = new SearchHealth(args.healthPath ?? join(diagDir(), 'search-health.json'));
  const attempts: SearchAttempt[] = [];
  for (const { provider, key, baseUrl } of chain) {
    if (health.isCooledDown(provider.name)) {
      attempts.push({ provider: provider.name, error: '冷却中（近期连续失败，已跳过）' });
      continue;
    }
    // 每家独立超时，并与父 signal 联动（用户中断/工具级 30s 超时）
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), PER_PROVIDER_TIMEOUT_MS);
    const onParentAbort = (): void => controller.abort();
    args.signal?.addEventListener('abort', onParentAbort, { once: true });
    try {
      const hits = await provider.search({ query: args.query, n: args.n, key, baseUrl, signal: controller.signal });
      health.recordSuccess(provider.name);
      return { hits, provider: provider.name, attempts };
    } catch (e) {
      if (args.signal?.aborted) throw e; // 用户中断：不再降级，直接上抛
      if (e instanceof SearchProviderError && e.kind === 'fatal') throw e; // 审核拦截等不可降级失败：直接上抛
      const err = e instanceof SearchProviderError ? e : new SearchProviderError('network', (e as Error).message);
      health.recordFailure(provider.name, err.kind);
      attempts.push({ provider: provider.name, error: `[${err.kind}] ${err.message}`.slice(0, 200) });
    } finally {
      clearTimeout(timer);
      args.signal?.removeEventListener('abort', onParentAbort);
    }
  }
  const detail = attempts.map((a) => `${a.provider}: ${a.error}`).join('；');
  throw new SearchProviderError('http', `全部搜索提供商失败（${attempts.length} 家）：${detail}`);
}
