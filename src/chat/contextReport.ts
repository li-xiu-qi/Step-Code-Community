/**
 * `/context` 命令的上下文分解报告。
 *
 * 显示当前上下文窗口的 token 占用分解：
 * - system prompt（分段：prefix / skills / subagents / AGENTS.md / memory / sessionContext）
 * - tools schema
 * - messages（历史）
 * - 总计 vs 上限
 *
 * 与 `/usage` 的区别：`/usage` 是跨轮累计统计（token 用量、缓存命中），
 * `/context` 是当前窗口快照（各部分此刻各占多少）。
 */

import { estimateTextTokens, estimateTokens } from '../agent/compaction/compact.js';
import { toAnthropicTools } from '../tools/index.js';
import type { StoredMessage } from '../agent/message.js';

export interface ContextReportOptions {
  /** 静态前缀 */
  prefix: string;
  /** skill 清单文本（已生成） */
  skills: string;
  /** 子 agent 清单文本（已生成） */
  subagents: string;
  /** AGENTS.md 正文 */
  agentsMd: string;
  /** memory 段正文 */
  memory: string;
  /** SessionStart hook stdout */
  sessionContext: string;
  /** 消息历史 */
  messages: readonly StoredMessage[];
  /** 上下文上限（maxContextSize） */
  maxContextSize: number;
}

export interface ContextBreakdown {
  label: string;
  tokens: number;
  note?: string;
}

/** 按 % 格式化占比。 */
function pct(tokens: number, total: number): string {
  if (total === 0) return '—';
  return `${((tokens / total) * 100).toFixed(1)}%`;
}

/** 紧凑数字（千分位）。 */
function fmt(n: number): string {
  return n.toLocaleString('en-US');
}

/** 一行渲染。 */
function row(label: string, tokens: number, total: number, note?: string): string {
  const labelPart = label.padEnd(16);
  const tokPart = fmt(tokens).padStart(10);
  const pctPart = pct(tokens, total).padStart(6);
  const notePart = note !== undefined ? `  ${note}` : '';
  return `  ${labelPart}${tokPart}  ${pctPart}${notePart}`;
}

/**
 * 生成上下文分解报告文本。
 */
export function generateContextReport(opts: ContextReportOptions): string {
  // 直接使用预计算的文本，分段统计
  const prefixTokens = estimateTextTokens(opts.prefix);
  const skillsTokens = opts.skills !== '' ? estimateTextTokens(opts.skills) : 0;
  const subagentsTokens = opts.subagents !== '' ? estimateTextTokens(opts.subagents) : 0;
  const agentsMdTokens = opts.agentsMd !== '' ? estimateTextTokens(opts.agentsMd) : 0;
  const memoryTokens = opts.memory !== '' ? estimateTextTokens(opts.memory) : 0;
  const sessionCtxTokens = opts.sessionContext !== '' ? estimateTextTokens(opts.sessionContext) : 0;

  const systemParts: ContextBreakdown[] = [
    { label: '  prefix', tokens: prefixTokens },
    { label: '  skills', tokens: skillsTokens, note: opts.skills === '' ? '(无)' : undefined },
    { label: '  subagents', tokens: subagentsTokens, note: opts.subagents === '' ? '(无)' : undefined },
    { label: '  AGENTS.md', tokens: agentsMdTokens, note: opts.agentsMd === '' ? '(无)' : undefined },
    { label: '  memory', tokens: memoryTokens, note: opts.memory === '' ? '(无/未开)' : undefined },
    { label: '  sessionContext', tokens: sessionCtxTokens, note: opts.sessionContext === '' ? '(无)' : undefined },
  ];

  // 2. 工具 schema token
  const tools = toAnthropicTools();
  const toolsTokens = estimateTextTokens(JSON.stringify(tools));

  // 3. 消息历史 token
  const messagesTokens = estimateTokens(opts.messages);

  // 4. 汇总
  const systemTotal = prefixTokens + skillsTokens + subagentsTokens + agentsMdTokens + memoryTokens + sessionCtxTokens;
  const total = systemTotal + toolsTokens + messagesTokens;

  const lines: string[] = [];

  // 表头
  lines.push('上下文窗口分解');
  lines.push('');
  lines.push(`  ${'组件'.padEnd(16)}${'tokens'.padStart(10)}  ${'占比'.padStart(6)}`);
  lines.push(`  ${'─'.repeat(16)}${'─'.repeat(10)}  ${'─'.repeat(6)}`);

  // system prompt（分段展示）
  lines.push(row('system prompt', systemTotal, total));
  for (const p of systemParts) {
    if (p.tokens > 0 || p.note !== undefined) {
      lines.push(row(p.label, p.tokens, total, p.note));
    }
  }

  // tools
  lines.push(row('tools schema', toolsTokens, total, `(${tools.length} 个工具)`));

  // messages
  lines.push(row('messages', messagesTokens, total, `(${opts.messages.length} 条)`));

  // 分隔线
  lines.push(`  ${'─'.repeat(16)}${'─'.repeat(10)}  ${'─'.repeat(6)}`);
  lines.push(row('合计', total, total));

  // 上限与占比
  lines.push('');
  const ctxPct = ((total / opts.maxContextSize) * 100).toFixed(1);
  lines.push(`  窗口上限: ${fmt(opts.maxContextSize)} tokens`);
  lines.push(`  当前占用: ${fmt(total)} tokens (${ctxPct}%)`);

  if (total > opts.maxContextSize * 0.9) {
    lines.push('  ⚠ 接近上限，建议 /compact 压缩历史');
  } else if (total > opts.maxContextSize * 0.7) {
    lines.push('  ⚠ 占用较高，长任务可能触发自动压缩');
  }

  return lines.join('\n');
}
