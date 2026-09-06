import { z } from 'zod';
import { mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import Anthropic from '@anthropic-ai/sdk';
import { fail, ok, type ToolDef, type ToolResult } from './types.js';
import type { SubagentDeleteResult } from '../agent/subagent/store.js';

// ─── subagent_list ───────────────────────────────────────────────────────────

const listSchema = z.object({
  query: z
    .string()
    .optional()
    .describe('按标题/角色名关键词过滤（不区分大小写）。留空列出全部。'),
  limit: z
    .number()
    .int()
    .positive()
    .optional()
    .describe('最多返回条数，默认 20，上限 50。'),
  parent_id: z
    .string()
    .optional()
    .describe('只列出该父会话派生的子 agent。留空列出全部。'),
  status: z
    .string()
    .optional()
    .describe('按状态过滤：running / done / error。留空不过滤。'),
  scope: z
    .enum(['mine', 'all'])
    .optional()
    .describe('可见性范围。mine=只看本会话派生的 + 待命中的(默认，降低噪音，避免跨会话子 agent 越攒越多找不到自己的)；all=当前工作目录下跨会话全部。要找历史会话创建的子 agent 时用 all。'),
});

function relativeTime(iso: string, now: number): string {
  const diff = now - Date.parse(iso);
  if (diff < 0) return '未来';
  const s = Math.floor(diff / 1000);
  if (s < 5) return '刚刚';
  if (s < 60) return `${s} 秒前`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} 分钟前`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} 小时前`;
  const d = Math.floor(h / 24);
  return `${d} 天前`;
}

export const subagentListTool: ToolDef<z.infer<typeof listSchema>> = {
  name: 'subagent_list',
  description:
    '列出子 agent 会话（按更新时间倒序），不返回消息内容。默认只看本会话派生的 + 待命中的(standby)。可用动作：status="running"/"done"/"error" 按状态筛（status="running" 叠加默认范围即"自己正在跑的"）；scope="all" 看当前 cwd 下跨会话全部（含历史会话的一次性子 agent）；query="关键词" 按标题/角色名/模型搜；parent_id="父会话id" 只列该父会话派生的（显式指定时绕过默认降噪）。常用：subagent_list(status="running") 看自己正在运行的；subagent_list(scope="all") 找回历史会话的子 agent。',
  schema: listSchema,
  access: () => ({ kind: 'none' }),
  async execute(input, ctx) {
    if (ctx.subagentStore === undefined) return fail('当前上下文不支持子 agent 管理。');
    const q = input.query?.trim().toLowerCase();
    const limit = Math.min(input.limit ?? 20, 50);
    const now = Date.now();
    let all = ctx.subagentStore.list(ctx.cwd);
    // 默认降噪：只看本会话派生的 + 待命中的；显式指定 parent_id 或 scope=all 时绕过（用户意图已明确）
    if (input.scope !== 'all' && input.parent_id === undefined) {
      const sid = ctx.sessionId;
      all = all.filter((m) => (sid !== undefined && m.parentId === sid) || m.standby === true);
    }
    if (input.parent_id !== undefined) all = all.filter((m) => m.parentId === input.parent_id);
    if (input.status !== undefined) all = all.filter((m) => m.status === input.status);
    if (q) all = all.filter((m) => `${m.title ?? ''} ${m.agentType ?? ''} ${m.model ?? ''}`.toLowerCase().includes(q));
    const total = all.length;
    const shown = all.slice(0, limit);
    if (shown.length === 0) {
      return ok(q ? '没有匹配的子 agent 会话。' : '当前工作目录下没有子 agent 会话。');
    }
    const lines = shown.map((m) => {
      const tag = m.status === 'running' ? ' ◉' : m.status === 'error' ? ' ✗' : '';
      const title = m.title ?? m.agentType ?? '（无标题）';
      const model = m.model && m.model !== '' ? ` · ${m.model}` : '';
      return `${m.id} · ${title}${tag}${model} · ${relativeTime(m.updatedAt, now)}`;
    });
    let out = lines.join('\n');
    if (total > shown.length) {
      out += `\n\n（还有 ${total - shown.length} 条未显示，用 query 缩小范围或调高 limit）`;
    }
    return ok(out);
  },
};

// ─── subagent_kill ───────────────────────────────────────────────────────────

const killSchema = z.object({
  id: z.string().describe('要删除的子 agent 会话 id。从 subagent_list 获取。'),
});

export const subagentKillTool: ToolDef<z.infer<typeof killSchema>> = {
  name: 'subagent_kill',
  description:
    '删除一个子 agent 会话的全部落盘数据（快照 + 日志）。运行中的子 agent 不会被强制杀死（持活跃锁拒绝删除）。',
  schema: killSchema,
  access: () => ({ kind: 'none' }),
  async execute(input, ctx): Promise<ToolResult> {
    if (ctx.subagentStore === undefined) return fail('当前上下文不支持子 agent 管理。');
    const result: SubagentDeleteResult = ctx.subagentStore.delete(ctx.cwd, input.id);
    switch (result) {
      case 'deleted':
        return ok(`已删除子 agent 会话 ${input.id} 的全部数据。`);
      case 'locked':
        return fail(`子 agent 会话 ${input.id} 正在运行中，无法删除。如需终止，使用后续可能增加的 subagent_stop 工具，或等它自然结束后再删。`);
      case 'missing':
        return fail(`子 agent 会话 ${input.id} 不存在。用 subagent_list 确认 id。`);
    }
  },
};

// ─── subagent_trace ─────────────────────────────────────────────────────────

const traceSchema = z.object({
  id: z.string().describe('要查看的子 agent 会话 id。从 subagent_list 获取。'),
  limit: z
    .number()
    .int()
    .positive()
    .max(50)
    .optional()
    .describe('返回最近 N 条消息，默认 20，上限 50。防止上下文爆炸。'),
  role: z
    .enum(['user', 'assistant', 'tool'])
    .optional()
    .describe('只返回指定角色的消息。留空返回全部。'),
});

/** 提取消息文本内容（兼容 string 和 block array 两种形态）。导出器与 subagent_trace 共用，
 *  避免两处格式化逻辑漂移后导出内容与屏显内容不一致。 */
export function extractText(content: Anthropic.MessageParam['content']): string {
  if (typeof content === 'string') return content;
  const parts: string[] = [];
  for (const block of content) {
    if (block.type === 'text') parts.push(block.text);
    else if (block.type === 'tool_use') {
      const args = JSON.stringify(block.input);
      const truncated = args.length > 200 ? args.slice(0, 200) + '...' : args;
      parts.push(`[tool_use: ${block.name}(${truncated})]`);
    } else if (block.type === 'tool_result') {
      const resultContent = block.content;
      let text: string;
      if (typeof resultContent === 'string') text = resultContent;
      else if (Array.isArray(resultContent)) {
        text = resultContent
          .filter((b): b is Anthropic.TextBlock => b.type === 'text')
          .map((b) => b.text)
          .join('');
      } else text = '';
      const truncated = text.length > 300 ? text.slice(0, 300) + '...' : text;
      parts.push(`[tool_result: ${truncated}]`);
    }
  }
  return parts.join('\n');
}

export const subagentTraceTool: ToolDef<z.infer<typeof traceSchema>> = {
  name: 'subagent_trace',
  description:
    '读取一个子 agent 会话的消息历史（正文），用于分析子 agent 的执行过程、调试行为、或提取关键信息。默认返回最近 20 条，可用 limit 调整。',
  schema: traceSchema,
  access: () => ({ kind: 'none' }),
  async execute(input, ctx) {
    if (ctx.subagentStore === undefined) return fail('当前上下文不支持子 agent 管理。');
    const snap = ctx.subagentStore.loadSnapshot(ctx.cwd, input.id);
    if (snap === null) return fail(`子 agent 会话 ${input.id} 不存在。用 subagent_list 确认 id。`);
    const all = ctx.subagentStore.loadFull(ctx.cwd, input.id);
    if (all.length === 0) return fail(`子 agent 会话 ${input.id} 没有消息记录。`);
    let filtered = all;
    if (input.role !== undefined) {
      filtered = all.filter((m) => m.message.role === input.role);
    }
    const limit = input.limit ?? 20;
    const shown = filtered.slice(-limit);
    if (shown.length === 0) {
      return ok(`子 agent 会话 ${input.id} 没有 ${input.role} 角色的消息。`);
    }
    const lines = shown.map((m, i) => {
      const role = m.message.role;
      const text = extractText(m.message.content).trim();
      const preview = text.length > 500 ? text.slice(0, 500) + '...' : text;
      return `[${i + 1}] ${role}: ${preview}`;
    });
    const header = `子 agent ${input.id}（${snap.agentType ?? '未知角色'}）消息历史，共 ${filtered.length} 条，显示最近 ${shown.length} 条：\n`;
    return ok(header + lines.join('\n\n'));
  },
};

// ─── subagent_status ─────────────────────────────────────────────────────────

const statusSchema = z.object({
  id: z.string().describe('要查看的子 agent 会话 id。从 subagent_list 获取。'),
});

export const subagentStatusTool: ToolDef<z.infer<typeof statusSchema>> = {
  name: 'subagent_status',
  description:
    '查看一个子 agent 会话的详细信息：状态、角色、模型、消息条数、运行时长、锁状态。',
  schema: statusSchema,
  access: () => ({ kind: 'none' }),
  async execute(input, ctx) {
    if (ctx.subagentStore === undefined) return fail('当前上下文不支持子 agent 管理。');
    const snap = ctx.subagentStore.loadSnapshot(ctx.cwd, input.id);
    if (snap === null) return fail(`子 agent 会话 ${input.id} 不存在。用 subagent_list 确认 id。`);
    const created = Date.parse(snap.createdAt);
    const updated = Date.parse(snap.updatedAt);
    const duration = updated - created;
    const mm = Math.floor(duration / 60000);
    const ss = Math.floor((duration % 60000) / 1000);
    const lockPath = ctx.subagentStore['lockFileFor'](ctx.cwd, input.id);
    const isRunning = ctx.subagentStore['isLockAlive'](lockPath);
    const lines = [
      `id:          ${snap.id}`,
      `角色:        ${snap.agentType ?? '未知'}`,
      `状态:        ${snap.status}${isRunning ? '（运行中）' : ''}`,
      `模型:        ${snap.model}`,
      `消息条数:    ${snap.messageCount}`,
      `运行时长:    ${mm > 0 ? `${mm} 分` : ''}${ss} 秒`,
      `创建时间:    ${snap.createdAt}`,
      `更新时间:    ${snap.updatedAt}`,
      `父会话:      ${snap.parentId ?? '无（顶层派生）'}`,
      `深度:        ${snap.depth}`,
      `标题:        ${snap.title ?? '（无）'}`,
      `锁文件:      ${isRunning ? '活跃（进程存活）' : '无/已释放'}`,
    ];
    return ok(lines.join('\n'));
  },
};

// ─── subagent_trace_export ───────────────────────────────────────────────────

const traceExportSchema = z.object({
  id: z.string().describe('要导出的子 agent 会话 id。从 subagent_list 获取。'),
  /** 导出目录。缺省 ~/.step-code/traces/。相对路径按 cwd 解析。 */
  outDir: z.string().optional().describe('导出目录，缺省 ~/.step-code/traces/'),
  /** 是否同时产出人读的 .md。缺省 true——复盘时人要看，脚本要读 jsonl，两者都要。 */
  withMarkdown: z.boolean().optional().describe('是否同时导出人读的 Markdown，缺省 true'),
});

/** 时间戳后缀：与 debugBundle 同一格式，保证同目录下按名排序即时间序。 */
function traceStamp(now: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return (
    `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}` +
    `${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}`
  );
}

/**
 * 把子 agent 的完整 trace 落盘。
 *
 * 与 subagent_trace 的分工：后者把历史灌进对话上下文（受 50 条上限约束，防上下文爆炸），
 * 本工具落盘不受限——测评对比需要全量 trace，截断会丢掉关键轮次。
 *
 * 双格式：.jsonl 一行一条消息（与 SubagentStore 存储格式一致，可被脚本回读），
 * .md 供人读。工具使用场景是 A/B 对比两个模型在同一任务上的产出，人和脚本都要消费。
 */
export const subagentTraceExportTool: ToolDef<z.infer<typeof traceExportSchema>> = {
  name: 'subagent_trace_export',
  description:
    '把一个子 agent 会话的完整消息历史导出为文件（.jsonl 供程序读取 + .md 供人阅读）。' +
    '与 subagent_trace 的区别：那条受 50 条上限约束防上下文爆炸，本工具落盘不受限，适合留存全量 trace 做复盘或对比。',
  schema: traceExportSchema,
  access: () => ({ kind: 'none' }),
  async execute(input, ctx) {
    if (ctx.subagentStore === undefined) return fail('当前上下文不支持子 agent 管理。');
    const snap = ctx.subagentStore.loadSnapshot(ctx.cwd, input.id);
    if (snap === null) return fail(`子 agent 会话 ${input.id} 不存在。用 subagent_list 确认 id。`);
    const all = ctx.subagentStore.loadFull(ctx.cwd, input.id);
    if (all.length === 0) return fail(`子 agent 会话 ${input.id} 没有消息记录。`);

    const outDir =
      input.outDir !== undefined && input.outDir !== ''
        ? isAbsolute(input.outDir)
          ? input.outDir
          : join(ctx.cwd, input.outDir)
        : join(homedir(), '.step-code', 'traces');
    const base = `${snap.agentType ?? 'subagent'}-${input.id.slice(0, 8)}-${traceStamp(new Date())}`;

    try {
      mkdirSync(outDir, { recursive: true });
    } catch (e) {
      return fail(`无法创建导出目录 ${outDir}：${(e as Error).message}`);
    }

    const jsonlPath = join(outDir, `${base}.jsonl`);
    const lines = all.map((m) =>
      JSON.stringify({ ts: m.ts, id: m.id, origin: m.origin, message: m.message }),
    );
    try {
      writeFileSync(jsonlPath, lines.join('\n') + '\n', 'utf8');
    } catch (e) {
      return fail(`写入 ${jsonlPath} 失败：${(e as Error).message}`);
    }

    const written = [jsonlPath];
    if (input.withMarkdown !== false) {
      const mdPath = join(outDir, `${base}.md`);
      const head = [
        `# 子 agent trace：${snap.agentType ?? '未知角色'}（${input.id}）`,
        '',
        `- 消息数：${all.length}`,
        `- 创建：${snap.createdAt}`,
        `- 更新：${snap.updatedAt}`,
        `- 父会话：${snap.parentId ?? '无（顶层派生）'}`,
        `- 深度：${snap.depth}`,
        snap.title !== undefined ? `- 标题：${snap.title}` : '',
        '',
        '---',
        '',
      ]
        .filter((l) => l !== '')
        .join('\n');
      const body = all
        .map((m, i) => {
          const text = extractText(m.message.content).trim();
          return `## [${i + 1}] ${m.message.role}（${m.ts}）\n\n${text === '' ? '（空）' : text}`;
        })
        .join('\n\n');
      try {
        writeFileSync(mdPath, head + body + '\n', 'utf8');
        written.push(mdPath);
      } catch {
        // md 是附加产物，写失败不影响 jsonl 已落盘这一事实
      }
    }

    return ok(`已导出 ${all.length} 条消息：\n${written.map((p) => `- ${p}`).join('\n')}`);
  },
};
