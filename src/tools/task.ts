import { z } from 'zod';
import { fail, ok, type ToolDef } from './types.js';

const listSchema = z.object({});

export const taskListTool: ToolDef<z.infer<typeof listSchema>> = {
  name: 'task_list',
  description: '列出后台任务及其状态（id / 状态 / 命令 / 起止时间）。',
  schema: listSchema,
  async execute(_input, ctx) {
    if (ctx.background === undefined) return fail('当前上下文不支持后台任务。');
    const tasks = ctx.background.list();
    if (tasks.length === 0) return ok('暂无后台任务。');
    const lines = tasks.map(
      (t) => `${t.id}  [${t.status}]  ${t.command}${t.exitCode !== undefined ? `  (exit ${t.exitCode})` : ''}`,
    );
    return ok(lines.join('\n'));
  },
};

const waitSchema = z.object({
  task_id: z.string().describe('后台任务 id。'),
});

/**
 * 同步等待后台任务终态：阻塞直到任务完成/失败/被取消。
 * 用于模型启动后台任务后需要其结果继续推理的场景，
 * 避免依赖回合边界的异步通知投递。
 */
export const taskWaitTool: ToolDef<z.infer<typeof waitSchema>> = {
  name: 'task_wait',
  description:
    '同步等待指定后台任务完成（阻塞直到终态）。返回任务状态与输出尾部。适用于启动后台任务后需要其结果继续推理的场景。支持 Esc/Ctrl+C 取消等待。',
  schema: waitSchema,
  async execute(input, ctx) {
    if (ctx.background === undefined) return fail('当前上下文不支持后台任务。');
    const task = await ctx.background.waitFor(input.task_id, ctx.signal);
    if (task === null) {
      if (ctx.signal?.aborted) return fail('等待被用户取消。');
      return fail(`任务不存在：${input.task_id}`);
    }
    const status = task.status === 'completed' ? '✓ 完成' : task.status === 'failed' ? '✗ 失败' : '⊘ 已终止';
    const lines = [`${status} | ${task.command}`];
    if (task.exitCode !== undefined) lines.push(`exit: ${task.exitCode}`);
    if (task.output) lines.push(task.output.slice(-4000));
    return ok(lines.join('\n'));
  },
};

const outputSchema = z.object({
  task_id: z.string().describe('后台任务 id。'),
});

export const taskOutputTool: ToolDef<z.infer<typeof outputSchema>> = {
  name: 'task_output',
  description:
    '查看某个后台任务的输出（内存中保留的尾部）。后台任务到达终态时系统会自动注入完成通知，不要在启动后台任务后立刻用它等待或反复轮询。',
  schema: outputSchema,
  async execute(input, ctx) {
    if (ctx.background === undefined) return fail('当前上下文不支持后台任务。');
    const t = ctx.background.get(input.task_id);
    if (t === undefined) return fail(`未找到后台任务 ${input.task_id}。`);
    return ok(`[${t.status}] ${t.command}\n\n${t.output === '' ? '（暂无输出）' : t.output}`);
  },
};

export const taskStopTool: ToolDef<z.infer<typeof outputSchema>> = {
  name: 'task_stop',
  description: '终止某个运行中的后台任务。',
  schema: outputSchema,
  async execute(input, ctx) {
    if (ctx.background === undefined) return fail('当前上下文不支持后台任务。');
    // 模型亲手杀的任务抑制终态通知（结果已在本工具返回里，再发「killed」通知是噪音）
    ctx.background.suppressNotification(input.task_id);
    const stopped = ctx.background.stop(input.task_id);
    return stopped
      ? ok(`已终止后台任务 ${input.task_id}。`)
      : fail(`无法终止 ${input.task_id}（不存在或已结束）。`);
  },
};
