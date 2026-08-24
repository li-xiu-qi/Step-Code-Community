/**
 * Advisor 配置（[advisor] 段）。
 *
 * 移植自 omp 的旁路影子审查机制：主 agent 每完成一轮后，一个独立 LLM 调用
 * 审查 transcript 中的技术风险，只在发现具体问题时输出建议。
 */

/** Advisor 配置。 */
export interface AdvisorConfig {
  /** 是否启用 advisor。默认 false（只有显式 enabled=true 才启用）。 */
  enabled: boolean;
  /** advisor 专用模型。缺省用主会话模型。 */
  model?: string;
}

/**
 * 解析 [advisor] 段。
 *
 * 默认关闭：只有 `enabled = true` 时才返回配置对象。
 * 其他情况返回 undefined（消费方按「未配置」处理，零开销）。
 */
export function resolveAdvisorConfig(raw: unknown): AdvisorConfig | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const t = raw as Record<string, unknown>;
  if (t['enabled'] !== true) return undefined;
  const model = typeof t['model'] === 'string' && t['model'].trim() !== '' ? t['model'].trim() : undefined;
  return { enabled: true, model };
}
