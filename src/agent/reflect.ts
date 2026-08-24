import type Anthropic from '@anthropic-ai/sdk';
import type { ChatProvider } from '../provider/types.js';
import { estimateTokens } from './compaction/compact.js';
import type { StoredMessage } from './message.js';

/**
 * /reflect 的核心：分段遍历完整对话历史（map → reduce），提炼可复用的通用方法论经验。
 *
 * 设计要点（对齐「对话回顾与经验沉淀」设计文档）：
 * - 自建循环、直接调 provider.stream，不进主 agent 循环，遍历过程不污染主上下文、也不触发压缩。
 * - map：把历史按 token 预算切成若干段，逐段用「提炼方法论」的 prompt 调模型，
 *   段间携带「已发现经验」的滚动摘要，保持连贯（对齐游走语义）。
 * - reduce：把各段经验点合并、去重、按重要性排序，产出最终清单。
 * - 护栏：段数上限，超限截断并在结尾给出提示。
 *
 * 纯函数：provider 以参数注入，便于单测用 fake provider 覆盖切段/map/reduce/护栏。
 */

/** 空历史占位文案。App 侧据此判断：占位产出不注入会话流（注入了也没内容可选摘）。 */
export const REFLECT_EMPTY_HISTORY = '（没有可回顾的对话历史。）';

/** 未提炼出经验的占位文案。同上。 */
export const REFLECT_NO_FINDINGS = '（未从历史中提炼出可复用的方法论经验。）';

/** map 阶段的默认系统提示词：提炼可复用经验，标注类型，排除噪音。 */
const DEFAULT_MAP_SYSTEM =
  '你是一个协作复盘器。给你一段 AI 助手与用户的对话历史，请只提炼**可复用的通用方法论经验**，' +
  '维度包括：有效的协作/推进策略、踩过的坑与其信号（什么症状、什么原因、怎么发现的）、' +
  '被推翻的判断（先怎么想、后来为何改、教训是什么）、下次遇到同类任务该怎么做。\n\n' +
  '明确排除（不要提炼这些，它们是噪音不是经验）：\n' +
  '- 本次任务的具体代码细节和项目信息\n' +
  '- 一次性的配置值或路径\n' +
  '- 环境偶发错误（缺工具、未配凭证、路径不匹配）\n' +
  '- 对工具的负面断言（"X 工具坏了"——环境会变，这类结论会硬化成自我限制）\n' +
  '- 未解决的失败序列（试了多种都没成，不许包装成"可靠工作流"）\n' +
  '- 一次性任务叙事（"帮我总结今天的新闻"不是一类工作）\n\n' +
  '用简洁的中文条目输出，每条标注类型前缀：\n' +
  '- [方法论] 可复用的工作流或技术模式\n' +
  '- [教训] 踩过的坑，含症状→原因→发现的链路\n' +
  '- [偏好] 用户表达的协作偏好或行为期望\n\n' +
  '这一段没有值得沉淀的经验时，只回复「（本段无）」。';

/** reduce 阶段的默认系统提示词：分类合并去重，标注分流目标。 */
const DEFAULT_REDUCE_SYSTEM =
  '你是一个经验汇总器。给你若干段从对话中提炼的经验点，请按以下步骤处理：\n\n' +
  '1. **合并去重**：语义重复的项合并为一条。\n' +
  '2. **过滤噪音**：删除以下类型的条目（它们是噪音不是经验）：\n' +
  '   - 环境偶发错误（缺工具、未配凭证、fresh-install 报错）\n' +
  '   - 对工具的负面断言（"X 工具坏了"——环境会变，这类结论会硬化成自我限制）\n' +
  '   - 会话内已自愈的瞬时错误\n' +
  '   - 未解决的失败序列（不许包装成"可靠工作流"）\n' +
  '   - 一次性任务叙事\n' +
  '3. **分类标注**：每条标注分流目标：\n' +
  '   - [memory] 用户偏好、行为期望、环境事实——应写入持久记忆\n' +
  '   - [skill:<名称>] 方法论、工作流、技术 fix——应写入对应 skill\n' +
  '   - [observation] 项目约定、设计教训——应写入 observation 池\n' +
  '4. **Skill 优先级**：标注 [skill:xxx] 时，优先标注本轮对话中已加载的 skill；\n' +
  '   其次标注已有的相关 skill；仅当无对应 skill 时才标注 [skill:新建议名称]。\n' +
  '5. **措辞纪律**：[memory] 类条目用陈述事实句，不用祈使句。\n' +
  '   ✓ "用户偏好直接回答，不要铺垫"\n' +
  '   ✗ "始终直接回答，不要铺垫"\n' +
  '6. **排序**：按可迁移性和重要性从高到低排序。\n\n' +
  '输出格式：每条一行，以 `[类型] 内容` 的格式排列。\n' +
  '没有值得沉淀的内容时，回复「（未提炼出可复用的经验。）」。';

export interface ReflectOptions {
  /** 每段的 token 预算（估算）。超过即切段。默认 8000。 */
  maxTokensPerSegment?: number;
  /** 段数上限护栏。历史切出的段数超过此值时截断，只回顾前 N 段。默认 12。 */
  maxSegments?: number;
  /** 透传给 provider 的中断信号。 */
  signal?: AbortSignal;
  /** 模型覆盖，省略用 provider 默认模型。 */
  model?: string;
  /** 自定义 map 阶段 system prompt（省略用默认）。 */
  mapPrompt?: string;
  /** 自定义 reduce 阶段 system prompt（省略用默认）。 */
  reducePrompt?: string;
}

const DEFAULT_MAX_TOKENS_PER_SEGMENT = 8000;
const DEFAULT_MAX_SEGMENTS = 12;

/**
 * 把完整历史按 token 预算切段。单条消息即便超过预算也自成一段（不拆消息）。
 * 返回按时间顺序排列的段数组。
 */
export function segmentMessages(
  messages: readonly StoredMessage[],
  maxTokensPerSegment: number,
): StoredMessage[][] {
  const segments: StoredMessage[][] = [];
  let current: StoredMessage[] = [];
  let currentTokens = 0;
  for (const m of messages) {
    const t = estimateTokens([m]);
    // 当前段非空且加入后会超预算 → 先收尾，另起一段
    if (current.length > 0 && currentTokens + t > maxTokensPerSegment) {
      segments.push(current);
      current = [];
      currentTokens = 0;
    }
    current.push(m);
    currentTokens += t;
  }
  if (current.length > 0) segments.push(current);
  return segments;
}

/** 把一段消息序列化成给模型看的纯文本（role: 内容）。 */
function serializeSegment(segment: readonly StoredMessage[]): string {
  return segment.map((m) => `${m.message.role}: ${serializeContent(m.message.content)}`).join('\n');
}

function serializeContent(content: Anthropic.MessageParam['content']): string {
  if (typeof content === 'string') return content;
  return content
    .map((b: Anthropic.ContentBlockParam) => {
      if (b.type === 'text') return b.text;
      if (b.type === 'tool_use') return `[调用工具 ${b.name}]`;
      if (b.type === 'tool_result') return '[工具结果]';
      return `[${b.type}]`;
    })
    .join(' ');
}

/** 用给定 system + 用户正文调一次 provider，收集文本输出。 */
async function collectText(
  provider: ChatProvider,
  system: string,
  userContent: string,
  opts: ReflectOptions,
): Promise<string> {
  const stream = provider.stream({
    system,
    tools: [],
    messages: [{ role: 'user', content: userContent }],
    signal: opts.signal,
    model: opts.model,
  });
  const final: Anthropic.Message = await stream.finalMessage();
  return final.content
    .filter((b): b is Anthropic.TextBlock => b.type === 'text')
    .map((b) => b.text)
    .join('')
    .trim();
}

/** 判断一段 map 产出是否为「无经验」占位（避免把空段喂进 reduce）。 */
function isEmptyFinding(text: string): boolean {
  return text === '' || text.replace(/[（）()\s]/g, '') === '本段无';
}

/**
 * 分段遍历完整历史，提炼可复用方法论经验，返回最终经验清单字符串。
 * 空历史 / 未提炼出经验时返回友好提示文案（供调用方直接 pushItem）。
 */
export async function runReflect(
  provider: ChatProvider,
  fullMessages: readonly StoredMessage[],
  opts: ReflectOptions = {},
): Promise<string> {
  if (fullMessages.length === 0) return REFLECT_EMPTY_HISTORY;

  const maxTokensPerSegment = opts.maxTokensPerSegment ?? DEFAULT_MAX_TOKENS_PER_SEGMENT;
  const maxSegments = opts.maxSegments ?? DEFAULT_MAX_SEGMENTS;

  const allSegments = segmentMessages(fullMessages, maxTokensPerSegment);
  const truncated = allSegments.length > maxSegments;
  const segments = truncated ? allSegments.slice(0, maxSegments) : allSegments;

  // map：逐段提炼，携带「已发现经验」滚动摘要保持连贯（串行）。
  const mapSystem = opts.mapPrompt ?? DEFAULT_MAP_SYSTEM;
  const reduceSystem = opts.reducePrompt ?? DEFAULT_REDUCE_SYSTEM;

  const findings: string[] = [];
  for (const segment of segments) {
    const prior =
      findings.length > 0
        ? `已发现的经验（供参考，避免重复，可补充或修正）：\n${findings.join('\n')}\n\n`
        : '';
    const userContent = `${prior}本段对话历史：\n${serializeSegment(segment)}`;
    const finding = await collectText(provider, mapSystem, userContent, opts);
    if (!isEmptyFinding(finding)) findings.push(finding);
  }

  let result: string;
  if (findings.length === 0) {
    result = REFLECT_NO_FINDINGS;
  } else if (findings.length === 1) {
    // 只有一段有产出，无需再 reduce
    result = findings[0]!;
  } else {
    const reduceInput = findings.map((f, i) => `【第 ${i + 1} 段】\n${f}`).join('\n\n');
    const reduced = await collectText(provider, reduceSystem, reduceInput, opts);
    result = reduced === '' ? findings.join('\n\n') : reduced;
  }

  if (truncated) {
    result += `\n\n（历史过长：共 ${allSegments.length} 段，仅回顾了前 ${maxSegments} 段。）`;
  }
  return result;
}
