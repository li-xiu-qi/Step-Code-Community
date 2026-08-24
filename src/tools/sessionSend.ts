import { z } from 'zod';
import { fail, ok, type ToolDef } from './types.js';

const sendSchema = z.object({
  targetSessionId: z.string().describe('目标会话 id（来自 /sessions 列表）。消息会跨工作目录投递到该会话。'),
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
