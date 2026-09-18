/**
 * 路径动作菜单背后的三个系统级动作：打开、在文件夹中显示、复制路径。
 *
 * 复制走 OSC 52（终端剪贴板协议）：pi-tui 的选区复制用的就是同一机制，
 * 在 TUI 里它是唯一不依赖外部工具、跨平台的剪贴板写入方式。写入是
 * fire-and-forget——终端收到与否无法回传，WT、iTerm2、kitty 等主流终端均支持。
 *
 * 在文件夹中显示（reveal）的平台差异：
 * - Windows 文件走 explorer /select 直开，不经过 cmd，路径里的 & 等字符不会被
 *   当命令分隔符（cmd start 那条路的已知失效模式）；目录无选中概念，与打开等价。
 * - macOS open -R 在 Finder 里选中文件；Linux 无对应约定，退化为打开父目录。
 * 同样 fire-and-forget，返回 false 只表示交付失败（spawn 报错）。
 */
import { spawnSync } from 'node:child_process';
import { dirname } from 'node:path';
import { openWithSystem } from './fileLink.js';

/**
 * 在系统文件管理器里显示路径。文件在 Windows 上选中它，目录等价于打开。
 * 失败（spawn 报错）返回 false；是否真的弹出了窗口无法从退出码判断。
 */
export function revealInFolder(path: string, isDir: boolean): boolean {
  if (process.platform === 'win32') {
    if (isDir) return openWithSystem(path, true); // 目录没有「选中」概念，与打开等价
    // windowsVerbatimArguments：原样传 /select,<path>，Node 不做 argv 转义，
    // 路径里的空格与特殊字符由 explorer 自己解析（不经过 cmd 就没有 & 截断问题）。
    const r = spawnSync('explorer.exe', [`/select,${path}`], {
      stdio: 'ignore',
      timeout: 10_000,
      windowsVerbatimArguments: true,
    });
    return r.error === undefined;
  }
  if (process.platform === 'darwin') return spawnOk('open', ['-R', path]);
  // Linux 无「选中文件」的跨桌面约定，退化为打开父目录
  return spawnOk('xdg-open', [dirname(path)]);
}

function spawnOk(cmd: string, args: string[]): boolean {
  const r = spawnSync(cmd, args, { stdio: 'ignore', timeout: 10_000 });
  return r.error === undefined;
}

/**
 * OSC 52 写剪贴板：`\x1b]52;c;<base64>\x07`。writer 由调用方注入
 * （PiChat 传 tui.terminal.write），本函数不碰终端，可在测试里用内存 writer 验证。
 */
export function copyTextToClipboard(text: string, write: (data: string) => void): void {
  write(`\x1b]52;c;${Buffer.from(text, 'utf-8').toString('base64')}\x07`);
}
