/**
 * 终端 tab 加载动画（OSC 9;4 不确定进度）的能力探测。
 *
 * 序列由 pi-tui 库层的 Terminal.setProgress 发送（\x1b]9;4;3 置真 + 1000ms
 * keepalive，\x1b]9;4;0 置假清定时器），这里只判「这个终端吃不吃这套」。
 * 判据取四类明确声明支持该协议的终端宿主。
 *
 * tmux 一律判不支持，即使外层是支持的宿主也很可能同时有 TMUX 变量：序列在 tmux
 * 内会被吞掉或需要 passthrough，用户看不到动画却以为功能坏了。安静的失败好过
 * 发了没反应。
 */

export function supportsTerminalProgress(env: NodeJS.ProcessEnv = process.env): boolean {
  if ((env['TMUX'] ?? '').length > 0) return false;
  if ((env['WT_SESSION'] ?? '').length > 0) return true;
  if (env['ConEmuANSI'] === 'ON') return true;
  const termProgram = env['TERM_PROGRAM'] ?? '';
  if (termProgram === 'ghostty' || termProgram === 'WezTerm') return true;
  const term = env['TERM'] ?? '';
  return term === 'xterm-ghostty';
}
