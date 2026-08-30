/**
 * monitor：流式监听工具。
 *
 * 与 bash 的 run_in_background 的分工：后台任务是「起个活，干完了叫我」（终态语义），
 * monitor 是「挂只耳朵，有事叫我」（流式语义）。同一套进程管理，差别只在输出消费——
 * 后台任务累积到 settle 一次性发，monitor 运行中按行切分、200ms 窗口合并持续发。
 *
 * 机制与四个常数（1MB 缓冲 / 200ms flush / 单行 500 / 整批 3000）逆向自
 * claude-code-win32-x64@2.1.251，不是拍脑袋。设计依据见产品设计文档
 * `交互设计/20260830-Monitor流式事件监听设计.md`。
 *
 * 工具层不做输出过滤：grep 的责任在调用方的命令里（`grep --line-buffered ERROR`），
 * 工具加过滤等于替模型决定什么重要。
 */
import { z } from 'zod';
import { fail, ok, type ToolContext, type ToolDef } from './types.js';
import { resolveShell } from './shellResolve.js';

const inputSchema = z.object({
  command: z.string().describe('要持续监听的 shell 命令。每行 stdout 是一个事件；命令退出则监听结束。'),
  description: z.string().describe('监听内容的简短描述，会显示在事件通知里。写成"errors in deploy.log"这种能一眼认出的形式。'),
  timeout_ms: z
    .number()
    .int()
    .positive()
    .optional()
    .describe('到这个毫秒数自动终止。与 persistent 互斥，给了就忽略 persistent。'),
  persistent: z
    .boolean()
    .optional()
    .describe('为真则活到会话结束（不设超时），用于 PR 跟踪、日志 tail 这类会话级监听。停用 task_stop。默认 false。'),
});

export const monitorTool: ToolDef<z.infer<typeof inputSchema>> = {
  name: 'monitor',
  description:
    '持续监听一个 shell 命令的输出，有输出就以事件形式推送，进程安静时不消耗任何东西。' +
    '用于长任务的中途信号（测试跑到一半失败、dev server 编译报错、盯日志找错误），' +
    '不是用来跑会结束的命令——那种用 bash 的 run_in_background，结束时你会收到通知。' +
    '典型命令形如 `tail -f app.log | grep --line-buffered ERROR`：过滤写在命令里，工具本身不过滤。',
  schema: inputSchema,
  async execute(input: unknown, ctx: ToolContext) {
    const { command, description, timeout_ms, persistent } = inputSchema.parse(input);
    const bg = ctx.background;
    if (bg === undefined) {
      return fail('当前上下文不支持监听任务。');
    }
    if (bg.supportsStream() === false) {
      // 宿主没接流式通道（-p 模式等）：起普通后台任务而不是报错，
      // 输出照常累积可供 task_output 查，只是中途不推事件。
      return fail('当前宿主不支持流式监听事件，已按普通后台任务启动，用 task_output 查看输出。');
    }
    try {
      const shell = resolveShell();
      const timeoutS = timeout_ms !== undefined ? Math.max(1, Math.ceil(timeout_ms / 1000)) : undefined;
      const id = bg.start(command, shell.cmd, shell.args(command), ctx.cwd, {
        monitor: true,
        monitorDescription: description,
        timeoutS,
      });
      const horizon = timeoutS !== undefined ? `${timeoutS}s 后自动终止` : persistent === true ? '会话结束前持续运行' : '命令退出即结束';
      return ok(
        `已启动监听 ${id}（${description}）。${horizon}。\n` +
        `有输出时你会收到事件通知，不要起了就反复等待。用 task_list 看状态、` +
        `task_output 看累积输出、task_stop 终止。`,
      );
    } catch (e) {
      return fail((e as Error).message);
    }
  },
};
