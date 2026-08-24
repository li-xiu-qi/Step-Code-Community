import { z } from 'zod';
import { fail, ok, type ToolDef } from './types.js';

const sendSchema = z.object({
  targetSessionId: z.string().describe('目标会话 id（先用 session_list 查到 id）。消息会跨工作目录投递到该会话。'),
  message: z.string().describe('要投递给目标会话的指令或消息正文。'),
});

/** 跨 session 投递：把一条指令写入目标会话的队列。 */
export const sessionSendTool: ToolDef<z.infer<typeof sendSchema>> = {
  name: 'session_send',
  description: '给另一个会话投递一条指令。消息跨工作目录送达；目标会话在下次启动/续跑时自动取出并执行。用于跨会话任务交接。',
  schema: sendSchema,
  async execute(input, ctx) {
    if (ctx.sessionQueue === undefined) return fail('当前上下文不支持跨会话投递。');
    const target = input.targetSessionId.trim();
    if (target === '') return fail('目标会话 id 不能为空。');
    const text = input.message.trim();
    if (text === '') return fail('消息正文不能为空。');
    const from = ctx.sessionId ?? '';
    const id = ctx.sessionQueue.enqueue(target, from, text);
    return ok(`已投递到会话 ${target}（消息 ${id.slice(0, 8)}）。目标会话在下次启动/续跑时自动取出执行。`);
  },
};

// 收件箱无需入参：占位可选字段，执行时忽略。
const inboxSchema = z.object({
  _: z.string().optional().describe('无需入参。'),
});

/** 查看当前会话的跨 session 待收件箱（未消费消息），不消费。 */
export const sessionInboxTool: ToolDef<z.infer<typeof inboxSchema>> = {
  name: 'session_inbox',
  description: '查看当前会话的跨会话待收件箱：列出别的会话投递来、尚未被本条 run 消费的消息。',
  schema: inboxSchema,
  async execute(_input, ctx) {
    if (ctx.sessionQueue === undefined) return fail('当前上下文不支持跨会话收件箱。');
    const sid = ctx.sessionId ?? '';
    const pending = ctx.sessionQueue.peek(sid);
    if (pending.length === 0) return ok('收件箱为空，没有待处理的跨会话消息。');
    const lines = pending.map((m) => `[${m.createdAt}] 来自 ${m.from}\n${m.text}`);
    return ok(lines.join('\n\n---\n\n'));
  },
};

/** 相对时间：刚刚 / N 分钟前 / N 小时前 / N 天前 / 日期。 */
function relativeTime(iso: string, now: number): string {
  const diff = now - new Date(iso).getTime();
  if (diff < 0) return '刚刚';
  const min = 60_000,
    hr = 3_600_000,
    day = 86_400_000;
  if (diff < min) return '刚刚';
  if (diff < hr) return `${Math.floor(diff / min)} 分钟前`;
  if (diff < day) return `${Math.floor(diff / hr)} 小时前`;
  if (diff < 7 * day) return `${Math.floor(diff / day)} 天前`;
  return iso.slice(0, 10);
}

const listSchema = z.object({
  query: z
    .string()
    .optional()
    .describe('标题关键词过滤（子串匹配，不区分大小写）。省略则返回最近更新的会话。'),
  limit: z
    .number()
    .int()
    .min(1)
    .max(50)
    .optional()
    .describe('返回条数上限，默认 20，硬上限 50（防上下文爆炸）。'),
});

/**
 * 列出当前工作目录下的会话（供跨会话投递前定位目标）。
 *
 * 设计约束（来自「几千个 session 会上下文爆炸」的实战教训）：
 * - 默认 limit=20，硬上限 50，超出截断并提示。
 * - 按 updatedAt 倒序（store.list 已保证），模型要的通常是最近的。
 * - 只返回 id + 标题 + 时间，不返回消息内容（够定位，省 token）。
 * - query 做标题子串过滤，让模型按关键词缩小范围而非全量扫描。
 */
export const sessionListTool: ToolDef<z.infer<typeof listSchema>> = {
  name: 'session_list',
  description:
    '列出当前工作目录下的会话（按更新时间倒序），用于跨会话投递前定位目标会话 id。支持按标题关键词过滤。不返回消息内容。',
  schema: listSchema,
  async execute(input, ctx) {
    if (ctx.sessionStore === undefined) return fail('当前上下文不支持会话列表。');
    const q = input.query?.trim().toLowerCase();
    const limit = input.limit ?? 20;
    const now = Date.now();
    let all = ctx.sessionStore.list(ctx.cwd);
    if (q) {
      all = all.filter((s) => {
        const hay = `${s.name ?? ''} ${s.title ?? ''}`.toLowerCase();
        return hay.includes(q);
      });
    }
    const total = all.length;
    const shown = all.slice(0, limit);
    if (shown.length === 0) {
      return ok(q ? `没有匹配「${input.query}」的会话。` : '当前工作目录下没有历史会话。');
    }
    const lines = shown.map((s) => {
      const current = s.id === ctx.sessionId ? ' ← 当前' : '';
      const title = s.name ?? s.title ?? '（无标题）';
      return `${s.id} · ${title} · ${relativeTime(s.updatedAt, now)}${current}`;
    });
    let out = lines.join('\n');
    if (total > shown.length) {
      out += `\n\n（还有 ${total - shown.length} 条未显示，用 query 缩小范围或调高 limit）`;
    }
    return ok(out);
  },
};
