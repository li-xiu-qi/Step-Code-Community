/**
 * Emission Guard：advisor 建议输出的护栏。
 *
 * 三重过滤：
 * 1. 空内容过滤 — 少于 10 字的建议不输出（避免无意义填充）
 * 2. 内容空洞过滤 — 纯填充词（"看起来不错"、"没有问题"等）不输出
 * 3. 去重 — 最近 N 条建议的哈希命中即跳过（防止重复建议）
 */

/** 内容空洞短语：模型回复没有实质建议时常用的填充词。 */
const EMPTY_PHRASES = [
  '看起来不错',
  '没有问题',
  '进展顺利',
  '方向正确',
  '继续保持',
  '做得好',
  'lgtm',
  'looks good',
  'no issues',
  'no concerns',
  'on track',
  'sounds good',
  'going well',
  'no problems',
];

/** 简单哈希：用字符码和的前 8 位。不需要密码学强度，只用于去重比较。 */
function simpleHash(text: string): string {
  let h = 0;
  for (let i = 0; i < text.length; i++) {
    h = ((h << 5) - h + text.charCodeAt(i)) | 0;
  }
  return h.toString(36);
}

export class EmissionGuard {
  private readonly recentHashes: string[] = [];
  private readonly maxRecent: number;

  constructor(maxRecent = 3) {
    this.maxRecent = maxRecent;
  }

  /**
   * 检查一条建议是否应该发出。
   * @returns 原文（通过）或 null（被拦截）
   */
  emit(note: string): string | null {
    // 1. 空内容过滤
    const trimmed = note.trim();
    if (trimmed.length < 10) return null;

    // 2. 内容空洞过滤：短文本 + 含填充词
    const lower = trimmed.toLowerCase();
    for (const phrase of EMPTY_PHRASES) {
      if (lower.includes(phrase.toLowerCase()) && trimmed.length < 30) return null;
    }

    // 3. 去重
    const hash = simpleHash(trimmed);
    if (this.recentHashes.includes(hash)) return null;

    this.recentHashes.push(hash);
    if (this.recentHashes.length > this.maxRecent) {
      this.recentHashes.shift();
    }

    return trimmed;
  }
}
