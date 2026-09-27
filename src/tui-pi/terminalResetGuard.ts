/**
 * 终端复位兜底：进程退出时同步写一段退出序列，保证终端不被留在污染态。
 *
 * 为什么需要它：`ProcessTerminal.write()` 是 `process.stdout.write`。ConPTY 下应用的 stdout
 * 是**管道**，写是异步排队的；紧随其后的 `process.exit()` 不等 pending I/O（Node 文档明确
 * 这一点）。被截断的正是 alt-screen 退出序列（`?1049l`）、鼠标上报关闭
 * （`?1000l..?1006l`）、自动换行恢复（`?7h`）、光标显示（`?25h`）。
 *
 * 而 `setRawMode` 是同步的 `SetConsoleMode` 调用、不走 stream，所以它照旧落地。两者叠加的
 * 结果就是用户看到的故障形态：**echo 回来了（鼠标序列被当文本打在 shell 提示符后面）、
 * Ctrl+C 只回显 `^C`、应用画面掉到提示符行**。这是 2026-09-27 用四张现场截图定位的，
 * 登记在 step-code-product-design 的「已知问题与待办」#32。
 *
 * 为什么用 `writeSync(1)`：`process.on('exit')` 里只能做同步操作，而 `writeSync` 绕开
 * stream 缓冲直写 fd，是 `process.exit()` 之后唯一还能落地的写法。框架自己的 unmount
 * 清理同样走同步直写 fd。
 *
 * 为什么装在 runApp 最早处：会起 alt-screen 的路径有三条——交互 PiChat、FirstRun 引导
 * （缺 API key / 坏 TOML 恢复）、`--resume` 不带 id 的会话选择器。后两条在交互分支之前，
 * 且成功后都紧跟 `process.exit()`。装在交互分支内会漏掉它们。
 */
import { writeSync } from 'node:fs';

/** 复位序列：退出备用屏 + 关全部鼠标上报 + 恢复自动换行 + 重置 SGR + 显示光标。 */
const TERMINAL_RESET_SEQUENCE =
  '\x1b[?1049l' + // 退出备用屏（alt screen）
  '\x1b[?1006l' + // SGR 鼠标编码
  '\x1b[?1004l' + // focus 上报
  '\x1b[?1003l' + // 全 motion 上报
  '\x1b[?1002l' + // button motion 上报
  '\x1b[?1000l' + // 基础鼠标上报
  '\x1b[?7h' + // 恢复自动换行
  '\x1b[0m' + // 重置 SGR
  '\x1b[?25h'; // 显示光标

let installed = false;

/**
 * 安装退出复位兜底。幂等，重复调用只装一次。
 *
 * @param skip 为 true 时不装。用于 ACP 模式：它的 stdout 是 JSON-RPC 通道，
 *   往里写转义序列会直接污染协议帧。
 */
export function installTerminalResetGuard(skip = false): void {
  if (installed || skip) return;
  installed = true;
  process.on('exit', () => {
    try {
      writeSync(1, TERMINAL_RESET_SEQUENCE);
    } catch {
      // fd 1 已关（终端死了）：无处可写，也不该因此再抛——exit handler 里抛异常
      // 只会让 Node 打一条 unhandled exception，用户看到的是另一段噪声。
    }
  });
}
