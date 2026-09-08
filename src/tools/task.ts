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

/**
 * task_wait 单次等待的默认上限（秒）。
 * 模型忘传 timeout_s 时也不至于把整个回合无限期挂住：命令让子进程永不退出时
 * （远端常驻进程持有 channel、ssh 不返回），后台任务绝对超时那条链永不触发，
 * 唯一能救回合的就是这里的封顶。到点返回的是「仍在运行」的进度快照，不是失败。
 */
const TASK_WAIT_DEFAULT_S = 300;
/** 单次等待上限（秒）：对齐后台任务默认超时量级，允许一次等待覆盖完整任务寿命。 */
const TASK_WAIT_MAX_S = 3600;

const waitSchema = z.object({
  task_id: z.string().describe('后台任务 id。'),
  timeout_s: z
    .number()
    .int()
    .positive()
    .max(TASK_WAIT_MAX_S)
    .optional()
    .describe(
      `单次等待上限（秒），默认 ${TASK_WAIT_DEFAULT_S}，上限 ${TASK_WAIT_MAX_S}。到点未到终态则返回当前进度快照并标记「仍在运行」，任务不中断，可再次调用继续等。`,
    ),
});

/**
 * 同步等待后台任务终态：阻塞到任务完成/失败/被杀，或单次等待超时。
 * 用于模型启动后台任务后需要其结果继续推理的场景，
 * 避免依赖回合边界的异步通知投递。
 *
 * 超时不是失败：返回里会明确写「仍在运行」并带当前输出尾部，
 * 模型据此继续用 task_output 查进度或再次等待，不会把半截输出当成最终结果。
 */
export const taskWaitTool: ToolDef<z.infer<typeof waitSchema>> = {
  name: 'task_wait',
  description:
    `同步等待指定后台任务完成（阻塞到终态或单次等待超时，默认 ${TASK_WAIT_DEFAULT_S}s，可用 timeout_s 调整）。返回任务状态与输出尾部。适用于启动后台任务后需要其结果继续推理的场景。支持 Esc/Ctrl+C 取消等待。`,
  schema: waitSchema,
  async execute(input, ctx) {
    if (ctx.background === undefined) return fail('当前上下文不支持后台任务。');
    const waitS = Math.min(input.timeout_s ?? TASK_WAIT_DEFAULT_S, TASK_WAIT_MAX_S);
    const task = await ctx.background.waitFor(input.task_id, ctx.signal, waitS * 1000);
    if (task === null) {
      if (ctx.signal?.aborted) return fail('等待被用户取消。');
      return fail(`任务不存在：${input.task_id}`);
    }
    const tail = task.output === '' ? '' : `\n\n${task.output.slice(-4000)}`;
    // running 只有一种来路：单次等待超时。此时任务仍在后台跑，必须与终态分开表述，
    // 否则模型会把进度快照当成完整结果往下推（截断输出与「零命中」在视觉上无法区分）。
    if (task.status === 'running') {
      return ok(
        `⊘ 等待超时（${waitS}s），任务仍在后台运行，未到达终态。这不是失败。` +
          `继续用 task_output ${input.task_id} 查进度，或再次调用 task_wait 续等；确需终止用 task_stop。` +
          `\n\n[${task.status}] ${task.command}${tail}`,
      );
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
