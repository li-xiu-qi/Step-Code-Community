/**
 * 转录区文件路径的可点击化：OSC 8 链接构造、安全门、点击后的系统打开。
 *
 * 链路分三段：渲染层把路径文本包成自定义 scheme 链接（linkPath / linkFilePathArg），
 * PiChat 的 openUrl 回调收到 URL 后解码（fileTargetToPath）按会话 cwd 解析成
 * 本地路径，再交给系统默认程序打开（openWithSystem）。
 *
 * 为什么用自定义 scheme 而不是 file://：载荷必须是「原始展示路径」（可能
 * 相对），点击时才按当前 cwd 解析——长会话里路径要能活过写它时的 cwd。
 * file:/// 的规范要求绝对路径，相对路径进 file:// 在 POSIX 上会被解析成
 * 根下路径（/src/a.ts ≠ cwd/src/a.ts），且终端对 file:// 有自己的白名单
 * 与打开行为。自定义 scheme 的载荷完全由自己定义，没有这两种歧义。
 * 自定义 scheme 的解码与门禁全在自己手里，行为可预期。
 *
 * 安全门（isSafeLinkPath + round-trip 校验）的理由：链接文本来自工具入参，
 * URL 由同一份文本构造，但路径可能被模型输出塑形（含换行、控制字符的伪
 * 路径）。控制字符一律拒绝建链；载荷必须能 encodeURIComponent → decode
 * 精确还原，构造不出合法载荷就不建链，宁可不点也不点开错东西。
 *
 * Windows 打开的两种路径（openWithSystem）来自外部实测记录：
 * 文件走 cmd start（空标题参数防路径含空格被当程序名、windowsVerbatimArguments
 * 防 argv 二次转义）；目录绕开 ShellExecute 走 powershell Shell.Application COM
 * （start / explorer //select 对含特殊字符的目录均失效），该子进程不能
 * detached（DETACHED_PROCESS 下 COM 静默失效）。macOS open / -R，
 * Linux xdg-open。全部 fire-and-forget，失败只返回 false 由调用方 flash。
 */
import { hyperlink } from '@earendil-works/pi-tui';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

/** 自定义 scheme：载荷是 encodeURIComponent 后的原始路径（可能相对）。 */
export const FILE_LINK_SCHEME = 'step-file:';

/** 路径含控制字符或换行 → 不建链（模型输出可塑形链接，这是最基本的形状校验）。 */
export function isSafeLinkPath(path: string): boolean {
  if (path === '') return false;
  return !/[\x00-\x1f\x7f]/.test(path);
}

/**
 * 本地路径（绝对或相对）转自定义 scheme URL：step-file:<encodeURIComponent(path)>。
 * 反斜杠原样保留（载荷是原始路径，不预先统一分隔符——点击时 resolve 会处理）。
 * 返回 undefined 表示不满足建链条件。
 */
export function buildFileUrl(path: string): string | undefined {
  if (!isSafeLinkPath(path)) return undefined;
  let encoded: string;
  try {
    encoded = encodeURIComponent(path);
  } catch {
    return undefined;
  }
  // round-trip 校验：decode 回来必须与原路径一致（防未来改动换编码方式时
  // 造出指向别处的链接）
  if (decodeURIComponent(encoded) !== path) return undefined;
  return `${FILE_LINK_SCHEME}${encoded}`;
}

/** 显示文本包文件链接；路径不可信或构造不出载荷时原样返回。 */
export function linkPath(displayText: string, path: string): string {
  const url = buildFileUrl(path);
  if (url === undefined) return displayText;
  return hyperlink(displayText, url);
}

/**
 * 工具入参的路径摘要包链接。条件：入参有 path/file_path，且摘要来自该字段
 * （pattern/command/query 等高优先级字段均不存在——它们存在时摘要不是路径）。
 * 摘要可能是中间截断形态（…dir/file.ts），链接仍指向完整路径：点击的是
 * 链接目标，不是被截断的显示文本。
 */
export function linkFilePathArg(input: unknown, arg: string): string {
  if (input === null || typeof input !== 'object') return arg;
  const obj = input as Record<string, unknown>;
  for (const key of ['pattern', 'command', 'skill', 'query', 'url', 'task_id', 'mission_id', 'objective', 'subject']) {
    const v = obj[key];
    if (typeof v === 'string' && v.length > 0) return arg;
  }
  const raw = obj.path ?? obj.file_path;
  if (typeof raw !== 'string' || raw === '') return arg;
  return linkPath(arg, raw);
}

/**
 * 自定义 scheme URL 解码回本地路径。载荷是原始展示路径（绝对或相对），
 * 相对路径按 cwd 解析（resolve 处理 POSIX 与 Windows 两种分隔符）。
 * 解码失败（畸形百分号编码）或不是本 scheme 返回 undefined。
 */
export function fileUrlToPath(url: string, cwd: string): string | undefined {
  if (!url.startsWith(FILE_LINK_SCHEME)) return undefined;
  const payload = url.slice(FILE_LINK_SCHEME.length);
  let decoded: string;
  try {
    decoded = decodeURIComponent(payload);
  } catch {
    return undefined;
  }
  if (decoded === '') return undefined;
  return resolve(cwd, decoded);
}

/**
 * 用系统默认方式打开路径。fire-and-forget：不等待 GUI 进程，返回 false 只表示
 * 交付失败（spawn 报错），打开成功与否无法从进程退出码判断（explorer 等
 * 立即返回 0 或不返回）。isDir 决定 Windows 下的打开方式。
 */
export function openWithSystem(path: string, isDir: boolean): boolean {
  if (process.platform === 'win32') {
    if (isDir) {
      // 目录走 Shell.Application COM：start/explorer 对含 & 等特殊字符的目录
      // 路径实测失效（cmd 会把 & 当命令分隔符，explorer 的 //select 同病）。
      // 子进程不 detached：DETACHED_PROCESS 下 COM 初始化静默失效。
      // 路径内的单引号按 PowerShell 字符串规则转义（' → ''）。
      const psPath = path.replace(/'/g, "''");
      const r = spawnSync(
        'powershell.exe',
        ['-NoProfile', '-Command', `(New-Object -ComObject Shell.Application).ShellExecute('${psPath}')`],
        { stdio: 'ignore', timeout: 10_000 },
      );
      return r.status === 0 && r.error === undefined;
    }
    // 文件走 cmd start。空标题参数（""）：start 的首个参数是窗口标题，路径含
    // 空格时不给空标题会被整体当程序名。windowsVerbatimArguments：Node 默认
    // 的 argv 转义会与 cmd 的解析叠加，含引号路径会被双重处理。
    const r = spawnSync('cmd.exe', ['/c', 'start', '', path], {
      stdio: 'ignore',
      timeout: 10_000,
      windowsVerbatimArguments: true,
    });
    return r.error === undefined;
  }
  const cmd = process.platform === 'darwin' ? 'open' : 'xdg-open';
  const r = spawnSync(cmd, [path], { stdio: 'ignore', timeout: 10_000 });
  return r.error === undefined;
}
