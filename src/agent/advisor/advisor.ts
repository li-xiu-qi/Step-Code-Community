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

const ADVISOR_SYSTEM = `You are a code review advisor. You observe the main agent's conversation and flag concrete technical risks.

Rules:
- SILENCE when the agent is on track. Only flag concrete, specific technical risks visible in the transcript.
- NEVER restate information the agent already has.
- NEVER repeat prior advice.
- NEVER question the user's intent or police scope.
- Output ONLY the advice text. If no advice, output exactly: SILENT`;

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
}

/**
 * 运行一次 advisor review。
 *
 * @returns 建议文本，或 null（沉默/被护栏拦截/出错）
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

  const userContent = `Review this transcript and flag any concrete technical risks:\n\n${transcript}`;
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

  return { note };
}
