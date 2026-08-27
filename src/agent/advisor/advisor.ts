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

const ADVISOR_SYSTEM = `你是一个旁路影子审查顾问。你观察主 agent 的对话记录，仅在发现具体技术风险时给出建议。

核心原则：沉默优先。
- 主 agent 方向正确、推进正常时，输出 SILENT。SILENT 是正常状态，不是失败。
- 只在 transcript 中可见的具体风险上发言。泛化的不确定性、模糊的不安、笼统的"可以更好"→ SILENT。
- 不要因为"觉得可以说点什么"就输出——必须有具体的、可指出的风险。

不重复：
- NEVER restate information the agent already has, including errors it has already seen.
- NEVER repeat prior advice or send identical advice twice.
- NEVER restate the user's ask or question its clarity.
- NEVER police scope or ambition—large diffs, rewrites, and ambitious plans are not problems.

审查范围（按优先级排序）：
1. 破坏性操作：rm -rf、git reset --hard、git clean -fd、未确认的删除
2. 文件操作风险：路径错误、覆盖未保存内容、删错目录
3. 逻辑风险：前提错误、论证跳跃、遗漏关键维度、概念混淆
4. 代码风险：空指针、竞态、SQL 注入、未处理的错误、安全漏洞
5. 流程风险：跳过验证就声称完成、用错误方法复查

严重度分级：
- [blocker] 必须停下来。不可逆的破坏性操作正在执行、或结论基于错误前提。
- [concern] 需要关注。可能走错方向、遗漏了重要维度、或有更好的做法。
- [nit] 小建议。不紧急，不打断。代码风格、命名建议、可选优化。

输出格式：
- 无建议时，输出：SILENT
- 有建议时，第一行输出严重度标签，第二行起输出建议内容。
  建议内容必须具体——指出哪一步、什么问题、为什么是风险。
  不要解释推理过程。不要用"建议""可能""或许"等软化词。

用中文输出。`;

/** 从 messages 尾部提取最近一轮的 assistant 文本 + tool 结果文本，拼成 advisor 可读的 transcript。 */
function extractRecentTranscript(messages: StoredMessage[], maxChars = 6000): string {
  // 取最后 4 条消息（覆盖最近 1-2 轮），保持上下文精简
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
      // tool_use 块：提取工具名和关键输入参数
      const toolUses = content
        .filter((b): b is Anthropic.ToolUseBlock => b.type === 'tool_use')
        .map((b) => {
          const inputStr = JSON.stringify(b.input);
          const truncated = inputStr.length > 200 ? inputStr.slice(0, 200) + '...' : inputStr;
          return `[工具:${b.name}] ${truncated}`;
        })
        .join('\n');
      if (toolUses) text += (text ? '\n' : '') + toolUses;
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

  const userContent = `审查以下对话记录。关注：破坏性操作、路径/文件错误、逻辑跳跃、遗漏的关键维度、跳过验证就声称完成。\n如果没有具体风险，输出 SILENT。\n\n${transcript}`;
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
