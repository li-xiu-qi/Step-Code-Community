/**
 * Advisor reviewer：旁路影子审查。
 *
 * 每轮 tool_use 结束后（主 agent 继续下一轮之前），用一次独立的 LLM 调用审查
 * 最近一轮的 transcript。只在发现具体技术风险时返回建议，否则返回 null（沉默）。
 *
 * 移植自 omp (oh-my-pi) 的 advisor 机制，做了以下简化：
 * - 无 mid-turn 打断（step-code 是同步生成器循环，不跑并行影子进程）
 * - 无 read/grep/glob 验证工具（advisor 只能看 transcript，不能查文件）
 * - 无 advise 工具注册（advisor 直接返回文本，不走工具通道）
 */

import type Anthropic from '@anthropic-ai/sdk';
import type { ChatProvider } from '../../provider/types.js';
import { toWire } from '../wire.js';
import type { ToolContext } from '../../tools/types.js';
import { stored, type StoredMessage } from '../message.js';
import type { AdvisorConfig } from './config.js';
import { EmissionGuard } from './guard.js';

const ADVISOR_SYSTEM = `你是一个旁路审查顾问。你观察主 agent 的对话记录，只在发现具体风险时给出建议。

规则：
- 主 agent 方向正确时保持沉默，只标记 transcript 中可见的具体风险。
- 不要重复主 agent 已有的信息。
- 不要重复之前的建议。
- 不要质疑用户的意图或范围。

审查范围（不只是代码）：
- 代码风险：空指针、竞态、SQL 注入、未处理的错误
- 文件操作风险：删除不可逆操作、路径错误、覆盖未保存内容
- 命令安全风险：rm -rf、git reset --hard 等破坏性操作
- 逻辑风险：前提错误、论证跳跃、遗漏关键维度

输出格式：
- 无建议时，输出：SILENT
- 有建议时，第一行输出严重度标签，第二行起输出建议内容：
  [nit] 小建议，不紧急，不打断
  [concern] 可能走错方向，需要关注
  [blocker] 必须停下来，有严重问题

用中文输出建议。只输出建议本身，不要解释推理过程。`;

/** 从 messages 尾部提取最近一轮的 assistant 文本 + tool 结果文本，拼成 advisor 可读的 transcript。 */
function extractRecentTranscript(messages: StoredMessage[], maxChars = 4000): string {
  // 取最后 4 条消息（通常 = 最后 1-2 轮 assistant + tool_result）
  const recent = messages.slice(-4);
  const parts: string[] = [];
  let total = 0;
  for (const sm of recent) {
    const role = sm.message.role;
    const content = sm.message.content;
    let text: string;
    if (typeof content === 'string') {
      text = content;
    } else {
      text = content
        .filter((b): b is Anthropic.TextBlock => b.type === 'text')
        .map((b) => b.text)
        .join('\n');
      // tool_result 块也提取
      const toolTexts = content
        .filter((b): b is Anthropic.ToolResultBlockParam => b.type === 'tool_result')
        .map((b) => (typeof b.content === 'string' ? b.content : JSON.stringify(b.content)))
        .join('\n');
      if (toolTexts) text += (text ? '\n' : '') + toolTexts;
    }
    if (!text) continue;
    const entry = `[${role}] ${text}`;
    if (total + entry.length > maxChars) {
      parts.push(entry.slice(0, maxChars - total));
      break;
    }
    parts.push(entry);
    total += entry.length;
  }
  return parts.join('\n\n');
}

export interface AdvisorReviewResult {
  /** 建议文本。 */
  note: string;
  /** 严重度：nit=不打断，concern=需要关注，blocker=必须停下。 */
  severity: 'nit' | 'concern' | 'blocker';
}

/** 从 advisor 输出中解析严重度标签。 */
function parseSeverity(text: string): { severity: AdvisorReviewResult['severity']; note: string } {
  const firstLine = text.split('\n')[0]!.trim();
  if (firstLine.startsWith('[blocker]')) {
    return { severity: 'blocker', note: text.replace(/^\[blocker\]\s*/, '').trim() };
  }
  if (firstLine.startsWith('[concern]')) {
    return { severity: 'concern', note: text.replace(/^\[concern\]\s*/, '').trim() };
  }
  if (firstLine.startsWith('[nit]')) {
    return { severity: 'nit', note: text.replace(/^\[nit\]\s*/, '').trim() };
  }
  // 没有标签 → 默认 concern（保守起见，宁可多报不漏报）
  return { severity: 'concern', note: text };
}

/**
 * 运行一次 advisor review。
 *
 * @returns 建议文本 + 严重度，或 null（沉默/被护栏拦截/出错）
 */
export async function runAdvisorReview(
  messages: StoredMessage[],
  provider: ChatProvider,
  config: AdvisorConfig,
  ctx: ToolContext,
  signal: AbortSignal | undefined,
  guard: EmissionGuard,
): Promise<AdvisorReviewResult | null> {
  const transcript = extractRecentTranscript(messages);
  if (!transcript || transcript.length < 50) return null;

  const userContent = `审查以下对话记录，如果发现具体风险请给出建议：\n\n${transcript}`;
  const advisorMessages: StoredMessage[] = [
    stored({ role: 'user', content: userContent }, { kind: 'injection' }),
  ];

  let responseText = '';
  try {
    const stream = provider.stream({
      system: ADVISOR_SYSTEM,
      tools: [],
      messages: toWire(advisorMessages, ctx.attachments !== undefined ? { cwd: ctx.cwd, attachments: ctx.attachments } : undefined),
      signal,
      model: config.model,
    });
    for await (const event of stream) {
      if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
        responseText += event.delta.text;
      }
    }
    await stream.finalMessage();
  } catch {
    // advisor 调用失败不阻塞主循环
    return null;
  }

  const trimmed = responseText.trim();
  if (!trimmed || trimmed === 'SILENT' || trimmed === 'null') return null;

  const note = guard.emit(trimmed);
  if (note === null) return null;

  const { severity, note: cleanNote } = parseSeverity(note);
  return { note: cleanNote, severity };
}
