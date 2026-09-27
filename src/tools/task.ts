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
 *
 * 取 30s：默认 300s 曾导致
 * 真实卡死：模型派完后台子 agent 立即 task_wait，一调就是 5 分钟起，撞超时后再
 * 调一次，直到用户手动中断。30s 是「值得为它单独让回合停住的等待」的上界，
 * 更长的时间应该由终态通知唤醒或显式给 timeout_s。
 */
const TASK_WAIT_DEFAULT_S = 30;
/** 单次等待上限（秒）：允许一次等待覆盖完整任务寿命（模型确知任务时长时用）。 */
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
      `单次等待上限（秒），默认 ${TASK_WAIT_DEFAULT_S}，上限 ${TASK_WAIT_MAX_S}。到点未到终态则返回当前进度快照并标记「仍在运行」，任务不中断，可再次调用继续等。确认任务短寿时才给大值，不要用它把无限等待切成多段。`,
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
    `同步等待指定后台任务完成（阻塞到终态或单次等待超时，默认 ${TASK_WAIT_DEFAULT_S}s，可用 timeout_s 调整）。返回任务状态与输出尾部。只在你确实被它的结果卡住、且此刻没有别的有用步骤可做时才用：多数情况下任务终态会自动通知本会话，起了就该先做其他步骤。支持 Esc/Ctrl+C 取消等待。`,
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
    // 确定不完整才标注。running 那条路径不走到这里（它有自己的【未完成】提示语，两者不叠加）。
    // true 与 undefined 都不加：完整是默认预期，不知道则不该伪装成任何一种确定结论。
    if (task.outputComplete === false) {
      lines.push('【输出不完整】执行侧报过中断，上面的输出被切掉过。不要据此判定任何「不存在 / 零命中 / 已清零」。');
    }
    if (task.output) lines.push(task.output.slice(-4000));
    return ok(lines.join('\n'));
  },
};

const outputSchema = z.object({
  task_id: z.string().describe('后台任务 id。'),
});

/**
 * 反轮询提示的上次读取签名：sessionKey → taskId → `status:outputLength`。
 *
 * 连续两次读到同一签名（状态与输出都没变）才注入提示：第一次读取是冷读，不该被
 * 劝阻。判据是同一任务连续两次的状态与输出量都没变。step-code 的
 * task_output 返回内存尾部全量（无游标），签名用「状态 + 输出长度」等价表达
 * 「有无新东西」。模块级而非 BackgroundManager 成员：这是工具面的关注点，
 * 任务生命周期归 manager。
 *
 * 不做「终态即清理」：任务终态后再读到相同签名，恰恰是最该提示别刷的场景
 * （首版在这里清理，导致终态任务第二次读永远检测不到连续读，提示失效）。
 * 无界增长由 MAX_TRACKED_SESSIONS 兜底。
 */
const lastReadSignature = new Map<string, Map<string, string>>();
const MAX_TRACKED_SESSIONS = 128;

function recordReadAndCheckUnchanged(sessionKey: string, taskId: string, signature: string): boolean {
  let perSession = lastReadSignature.get(sessionKey);
  if (perSession === undefined) {
    if (lastReadSignature.size >= MAX_TRACKED_SESSIONS) lastReadSignature.clear();
    perSession = new Map();
    lastReadSignature.set(sessionKey, perSession);
  }
  const previous = perSession.get(taskId);
  perSession.set(taskId, signature);
  return previous === signature;
}

export const taskOutputTool: ToolDef<z.infer<typeof outputSchema>> = {
  name: 'task_output',
  description:
    '查看某个后台任务的输出（内存中保留的尾部）。后台任务到达终态时系统会自动注入完成通知，不要在启动后台任务后立刻用它等待或反复轮询。',
  schema: outputSchema,
  async execute(input, ctx) {
    if (ctx.background === undefined) return fail('当前上下文不支持后台任务。');
    const t = ctx.background.get(input.task_id);
    if (t === undefined) return fail(`未找到后台任务 ${input.task_id}。`);
    // 只在「确定不完整」时标注。true 不加（完整是默认预期，声明它反而稀释信号），
    // undefined 更不加——那表示不知道，不是不完整。
    const note =
      t.outputComplete === false
        ? '\n\n【输出不完整】执行侧报过中断，上面的输出被切掉过。不要据此判定任何「不存在 / 零命中 / 已清零」。'
        : '';
    const sessionKey = ctx.sessionId ?? '';
    const unchanged = recordReadAndCheckUnchanged(sessionKey, input.task_id, `${t.status}:${t.output.length}`);
    const pollHint = unchanged
      ? '\n\n<system>与上一次读取相比，该任务的状态与输出均无变化。不要连续原地轮询：任务到达终态时本会话会自动收到通知。此刻应继续做不依赖它的其他步骤；确被结果卡住且无别的事可做时，用 task_wait 一次给足 timeout_s 等到底。</system>'
      : '';
    return ok(`[${t.status}] ${t.command}\n\n${t.output === '' ? '（暂无输出）' : t.output}${note}${pollHint}`);
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
