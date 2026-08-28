import { z } from 'zod';
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
    '列出当前工作目录下的子 agent 会话（按更新时间倒序）。支持按标题/角色关键词过滤、父会话过滤、状态过滤。不返回消息内容。',
  schema: listSchema,
  access: () => ({ kind: 'none' }),
  async execute(input, ctx) {
    if (ctx.subagentStore === undefined) return fail('当前上下文不支持子 agent 管理。');
    const q = input.query?.trim().toLowerCase();
    const limit = Math.min(input.limit ?? 20, 50);
    const now = Date.now();
    let all = ctx.subagentStore.list(ctx.cwd);
    if (input.parent_id !== undefined) all = all.filter((m) => m.parentId === input.parent_id);
    if (input.status !== undefined) all = all.filter((m) => m.status === input.status);
    if (q) all = all.filter((m) => `${m.title ?? ''} ${m.agentType ?? ''}`.toLowerCase().includes(q));
    const total = all.length;
    const shown = all.slice(0, limit);
    if (shown.length === 0) {
      return ok(q ? '没有匹配的子 agent 会话。' : '当前工作目录下没有子 agent 会话。');
    }
    const lines = shown.map((m) => {
      const tag = m.status === 'running' ? ' ◉' : m.status === 'error' ? ' ✗' : '';
      const title = m.title ?? m.agentType ?? '（无标题）';
      return `${m.id} · ${title}${tag} · ${relativeTime(m.updatedAt, now)}`;
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
