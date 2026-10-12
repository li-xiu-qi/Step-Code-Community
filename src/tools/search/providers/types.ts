/**
 * 联网搜索提供商的统一接口与错误类型。
 *
 * 背景：单端点（阶跃官方搜索）在 Step plan 过期后整个 web_search 不可用
 * （2026-10-12 实测 HTTP 400 "you have no active step plan subscription"）。
 * 多提供商路由（router.ts）按配置顺序尝试，失败降级；各提供商实现只负责
 * 「一次请求 → 统一命中结构」，失败一律抛 SearchProviderError 并归类，
 * 由路由决定冷却与降级策略。
 */

/** 统一命中结构（对齐原阶跃返回的最小字段集）。 */
export interface SearchHit {
  readonly title: string;
  readonly url: string;
  readonly snippet?: string;
  /** 全文内容（有则进 webResultCache 供 web_extract 复用）。 */
  readonly content?: string;
  readonly time?: string;
}

/** 失败归类：驱动冷却时长与是否值得降级。 */
export type FailureKind =
  /** 配额/订阅/鉴权问题（401/403/429、plan 过期）：长冷却，立刻降级。 */
  | 'quota'
  /** 上游 HTTP 错误（非配额类 4xx/5xx）：中冷却，可降级。 */
  | 'http'
  /** 网络层失败（DNS/连接/超时/中断）：短冷却，可降级。 */
  | 'network'
  /** 返回解析失败（HTML 改版等）：中冷却，可降级。 */
  | 'parse'
  /** 未配置（缺 key）：本进程内永久跳过。 */
  | 'config'
  /** 不该降级的失败（451 内容审核是查询词本身被拦，换一家等于绕过平台审核边界）：
   *  路由遇到直接上抛，不记冷却、不尝试下一家。 */
  | 'fatal';

export class SearchProviderError extends Error {
  readonly kind: FailureKind;
  readonly status?: number;
  constructor(kind: FailureKind, message: string, status?: number) {
    super(message);
    this.name = 'SearchProviderError';
    this.kind = kind;
    this.status = status;
  }
}

/** 把未知异常归类为 FailureKind（fetch/undici 的网络错误形态）。 */
export function classifyError(e: unknown): FailureKind {
  if (e instanceof SearchProviderError) return e.kind;
  const msg = e instanceof Error ? e.message : String(e);
  if (/abort/i.test(msg)) return 'network';
  return 'network';
}

export interface ProviderSearchArgs {
  readonly query: string;
  readonly n: number;
  /** 提供商 key（[search.<name>] key 或对应环境变量）。 */
  readonly key?: string;
  /** 自定义端点覆盖（[search.<name>] url）。 */
  readonly baseUrl?: string;
  readonly signal?: AbortSignal;
}

export interface SearchProvider {
  readonly name: string;
  /** 无 key 时是否不可用（true → 未配置 key 即跳过）。 */
  readonly needsKey: boolean;
  /** 对应环境变量名（config 未给 key 时的兜底来源）。 */
  readonly keyEnv?: string;
  search(args: ProviderSearchArgs): Promise<SearchHit[]>;
}

/** HTML 工具：去标签 + 常见实体解码（Bing/DDG 解析共用）。 */
export function stripHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&#x([0-9a-f]+);/gi, (_, h: string) => String.fromCodePoint(Number.parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d: string) => String.fromCodePoint(Number.parseInt(d, 10)))
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** 浏览器 UA：HTML 搜索引擎对裸 node UA 会返回精简/验证页。 */
export const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
