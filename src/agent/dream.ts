/**
 * /dream：被动触发的睡眠巩固机制。
 *
 * 与 /reflect 的区别：
 * - /reflect 是主动复盘，产出文本清单给人看，用户自己决定怎么处理。
 * - /dream 是被动巩固，后台自动跑，直接把结论落地到 memory/skill store。
 *
 * 核心流程：
 * 1. Triage：判断当前 session 是否有值得巩固的内容（NO_UPDATE 则退出）
 * 2. Map：分段遍历对话历史，提取 durable signal
 * 3. Reduce：分类（memory/skill/observation）+ Do-NOT-capture 过滤 + 评分排序
 * 4. Write：将高分工条目写入对应 store（dry-run 时只预览不写）
 *
 * 设计要点：
 * - NO_UPDATE 是正常状态，格式由工具层控制
 * - 维护 Do-NOT-capture 负面清单与措辞纪律
 * - 双模式（自动/审核），不修改原始转录
 * - TAG 评分筛选决定哪些条目入 store
 */

import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import type Anthropic from '@anthropic-ai/sdk';
import type { ChatProvider } from '../provider/types.js';
import type { StoredMessage } from './message.js';
import { segmentMessages } from './reflect.js';

// ─── 常量 ───────────────────────────────────────────────────────────

/** 空历史占位。 */
const DREAM_EMPTY_HISTORY = '（没有可巩固的对话历史。）';

/** NO_UPDATE 占位（Triage 或 Reduce 阶段）。 */
const DREAM_NO_UPDATE = '（本次巩固无需更新。）';

/** map 阶段的系统提示词。 */
const MAP_SYSTEM =
  '你是一个睡眠巩固器。给你一段 AI 助手与用户的对话历史，请只提取**值得跨会话保留的 durable signal**。\n\n' +
  '**提取维度**：\n' +
  '- 用户偏好与行为期望（什么做法有效、什么让用户不满）\n' +
  '- 可复用的技术模式或工作流（非一次性）\n' +
  '- 踩过的坑与其信号链（症状→原因→发现方式）\n' +
  '- 被推翻的判断（先怎么想→后来为何改→教训）\n\n' +
  '**明确排除（不提取，这些是噪音）**：\n' +
  '- 本次任务的具体代码细节和项目信息\n' +
  '- 一次性的配置值或路径\n' +
  '- 环境偶发错误（缺工具、未配凭证）——只 capture FIX 步骤，不 capture "工具坏了"\n' +
  '- 对工具的负面断言（"X 工具坏了"——环境会变，会硬化成自我限制）\n' +
  '- 会话内已自愈的瞬时错误（试错后成功，不需要记）\n' +
  '- 未解决的失败序列（不许包装成"可靠工作流"）\n' +
  '- 一次性任务叙事（"帮我总结新闻"不是一类工作）\n\n' +
  '**输出格式**：每条一行，标注类型和评分：\n' +
  '- `[memory] 内容（意外:1-3 有用:1-3 新颖:1-3）`\n' +
  '- `[skill] 内容（意外:1-3 有用:1-3 新颖:1-3）`\n' +
  '- `[observation] 内容（意外:1-3 有用:1-3 新颖:1-3）`\n\n' +
  '没有值得巩固的内容时，只回复「NO_UPDATE」。';

/** reduce 阶段的系统提示词：分类 + 过滤 + 去重 + 评分排序 + 指定落地目标。 */
const REDUCE_SYSTEM =
  '你是一个巩固汇总器。给你若干段从对话中提取的 durable signal，请执行以下步骤：\n\n' +
  '**第一步：严格过滤噪音（删除以下类型，不手软）**\n' +
  '- 环境偶发错误（缺工具、未配凭证）——只保留 FIX 步骤\n' +
  '- 对工具的负面断言（"X 工具坏了"）\n' +
  '- 会话内已自愈的瞬时错误\n' +
  '- 未解决的失败序列（不许包装成可靠工作流）\n' +
  '- 一次性任务叙事\n' +
  '- 重复信息（同一条在多段中反复出现，只保留最完整的版本）\n\n' +
  '**第二步：分类与落地目标**\n' +
  '- `[memory]` 用户偏好、行为期望、环境事实 → 落地到 memory store\n' +
  '- `[skill]` 方法论、工作流、技术 fix → 落地到 skill store（仅在现有 skill 不适用时）\n' +
  '- `[observation]` 项目约定、设计教训 → 落地到 observation store\n\n' +
  '**第三步：评分排序**\n' +
  '对每条按三维评分（各 1-3），加总排序：\n' +
  '- 意外程度：3=完全意外，1=早该知道\n' +
  '- 有用程度：3=必然改变行为，1=锦上添花\n' +
  '- 新颖程度：3=首次发现，1=已知\n' +
  '格式：每条末尾标注 `（评分:X/9）`。\n\n' +
  '**第四步：去重**\n' +
  '同一类型下的语义重复项合并为一条（保留最高分版本）。\n\n' +
  '**第五步：措辞纪律**\n' +
  '- [memory] 写事实句，不写祈使句（"用户偏好简洁回复"而非"始终简洁回复"）\n' +
  '- [skill] 用祈使句（含具体步骤、触发条件）\n' +
  '- [observation] 写事实+教训（"X 项目 Y 机制存在 Z 问题 → 应 W"）\n\n' +
  '输出格式：每条一行 `[类型] 内容（评分:X/9）`，按评分从高到低排列。\n' +
  '没有值得巩固的内容时，回复「NO_UPDATE」。';

// ─── 类型 ───────────────────────────────────────────────────────────

/** dream 落地目标。 */
export type DreamTarget = 'memory' | 'skill' | 'observation';

/** 解析后的单条 dream 发现。 */
export interface DreamFinding {
  target: DreamTarget;
  content: string;
  score: number;
}

export interface DreamOptions {
  /** 每段 token 预算。默认 8000。 */
  maxTokensPerSegment?: number;
  /** 段数上限。默认 12。 */
  maxSegments?: number;
  /** 模型覆盖。 */
  model?: string;
  /** 中断信号。 */
  signal?: AbortSignal;
  /** dry-run 模式：只解析不写入。 */
  dryRun?: boolean;
  /** 项目 memory 目录（`.step-code/memory/`）。 */
  memoryDir?: string;
  /** 项目 skill 目录（`.step-code/skills/`）。 */
  skillDir?: string;
  /** 全局 memory 目录（`~/.step-code/memory/`）。 */
  globalMemoryDir?: string;
}

const DEFAULT_MAX_TOKENS_PER_SEGMENT = 8000;
const DEFAULT_MAX_SEGMENTS = 12;

// ─── 核心逻辑 ───────────────────────────────────────────────────────

/** 把历史序列化成纯文本（role: content）。 */
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

/** 调一次 provider，收集文本输出。 */
async function collectText(
  provider: ChatProvider,
  system: string,
  userContent: string,
  opts: DreamOptions,
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

/** 解析 reduce 输出，提取 DreamFinding 列表。 */
export function parseFindings(raw: string): DreamFinding[] {
  const lines = raw.split('\n').filter((l) => l.trim());
  const findings: DreamFinding[] = [];
  for (const line of lines) {
    const m = line.match(/^\[(memory|skill|observation)\]\s*(.+?)(?:\s*（评分:(\d+)\/9\）)?\s*$/);
    if (!m) continue;
    const target = m[1] as DreamTarget;
    const content = m[2]!.trim();
    const score = m[3] ? parseInt(m[3]!, 10) : 5;
    findings.push({ target, content, score });
  }
  return findings.sort((a, b) => b.score - a.score);
}

/**
 * 把单条 finding 落地到对应的 markdown 文件。
 * 文件不存在则创建，存在则追加（带时间戳分隔）。
 */
export function writeFinding(finding: DreamFinding, opts: DreamOptions): string | null {
  const ts = new Date().toISOString().slice(0, 10);
  let dir: string | undefined;
  let prefix: string;

  switch (finding.target) {
    case 'memory':
      dir = opts.memoryDir ?? opts.globalMemoryDir;
      prefix = 'dream-memory';
      break;
    case 'observation':
      dir = opts.memoryDir ?? opts.globalMemoryDir;
      prefix = 'observations';
      break;
    case 'skill':
      dir = opts.skillDir;
      prefix = 'dream-skill-draft';
      break;
  }

  if (!dir) return null;

  try {
    mkdirSync(dir, { recursive: true });
    const filePath = finding.target === 'observation'
      ? join(dir, `${prefix}/${ts}-${finding.content.slice(0, 30).replace(/[^\w\u4e00-\u9fff]/g, '-')}.md`)
      : join(dir, `${prefix}-${ts}.md`);

    // observation 文件不存在则创建
    if (finding.target === 'observation') {
      mkdirSync(dirname(filePath), { recursive: true });
      if (!existsSync(filePath)) {
        writeFileSync(filePath, `---\ndate: ${ts}\ntype: observation\n---\n\n`, 'utf8');
      }
    }

    const entry = `\n- [${ts}] ${finding.content}（评分:${finding.score}/9）\n`;
    if (existsSync(filePath)) {
      const existing = readFileSync(filePath, 'utf8');
      writeFileSync(filePath, existing + entry, 'utf8');
    } else {
      mkdirSync(dirname(filePath), { recursive: true });
      writeFileSync(filePath, `---\ndate: ${ts}\ntype: ${finding.target}\n---\n${entry}`, 'utf8');
    }
    return filePath;
  } catch {
    return null;
  }
}

/**
 * 执行 dream 巩固。
 * 返回：成功/跳过/空历史的提示文案 + 可选的落地文件列表。
 */
export async function runDream(
  provider: ChatProvider,
  fullMessages: readonly StoredMessage[],
  opts: DreamOptions = {},
): Promise<{ message: string; written: string[] }> {
  if (fullMessages.length === 0) {
    return { message: DREAM_EMPTY_HISTORY, written: [] };
  }

  const maxTokensPerSegment = opts.maxTokensPerSegment ?? DEFAULT_MAX_TOKENS_PER_SEGMENT;
  const maxSegments = opts.maxSegments ?? DEFAULT_MAX_SEGMENTS;

  const allSegments = segmentMessages(fullMessages, maxTokensPerSegment);
  const truncated = allSegments.length > maxSegments;
  const segments = truncated ? allSegments.slice(0, maxSegments) : allSegments;

  // Map：逐段提取 durable signal
  const findings: string[] = [];
  for (const segment of segments) {
    const prior =
      findings.length > 0
        ? `已提取的信号（供参考，避免重复）：\n${findings.join('\n')}\n\n`
        : '';
    const userContent = `${prior}本段对话历史：\n${serializeSegment(segment)}`;
    const finding = await collectText(provider, MAP_SYSTEM, userContent, opts);
    if (finding && finding !== 'NO_UPDATE' && !finding.includes('NO_UPDATE')) {
      findings.push(finding);
    }
  }

  if (findings.length === 0) {
    return { message: DREAM_NO_UPDATE, written: [] };
  }

  // Reduce：分类、过滤、评分
  let result: string;
  if (findings.length === 1) {
    result = findings[0]!;
  } else {
    const reduceInput = findings.map((f, i) => `【第 ${i + 1} 段】\n${f}`).join('\n\n');
    result = await collectText(provider, REDUCE_SYSTEM, reduceInput, opts);
  }

  if (result.includes('NO_UPDATE')) {
    return { message: DREAM_NO_UPDATE, written: [] };
  }

  // 解析 findings
  const parsed = parseFindings(result);
  if (parsed.length === 0) {
    return { message: DREAM_NO_UPDATE, written: [] };
  }

  // 写入（dry-run 时不写）
  const written: string[] = [];
  if (!opts.dryRun) {
    for (const f of parsed) {
      const path = writeFinding(f, opts);
      if (path) written.push(path);
    }
  }

  // 生成摘要
  const memCount = parsed.filter((f) => f.target === 'memory').length;
  const obsCount = parsed.filter((f) => f.target === 'observation').length;
  const skillCount = parsed.filter((f) => f.target === 'skill').length;
  const parts: string[] = [];
  if (memCount > 0) parts.push(`${memCount} memory`);
  if (obsCount > 0) parts.push(`${obsCount} observation`);
  if (skillCount > 0) parts.push(`${skillCount} skill draft`);

  const msg = parsed
    .map((f) => `  [${f.target}] ${f.content}（${f.score}/9）${opts.dryRun ? ' [dry-run]' : ''}`)
    .join('\n');

  const summary = `💾 巩固完成：${parts.join(' / ')}（共 ${parsed.length} 条）${written.length > 0 ? `\n已写入 ${written.length} 个文件。` : ''}`;

  return {
    message: `${summary}\n${msg}`,
    written,
  };
}
