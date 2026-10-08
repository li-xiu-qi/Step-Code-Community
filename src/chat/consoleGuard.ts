/**
 * TUI 运行期控制台护栏。
 *
 * alt-screen 帧模型的不变量是「屏幕只被 TuiAltScreen 的逐行 diff 写」。任何帧外
 * 直写都会物理改动屏幕而行模型不知情：console.* 走 stdout/stderr，Node 运行时
 * warning（Experimental/Deprecation）走 stderr。被污染的行在模型里「没有变化」，
 * diff 永远不会重写它，形成常驻幽灵帧（2026-10-08 真机现场：busy spinner 的
 * 历史帧固化在转录区，时间戳各不相同，持续数分钟不消）。
 *
 * 护栏在 TUI 存活期接管这些出口：文本路由给 sink（PiChat 节流后推进转录区），
 * 同时全量追加到 diag 日志留证；TUI 退出时恢复原样。崩溃路径（uncaughtException
 * 等）在护栏安装前已写好取证文件，不依赖这两个出口，互不影响。
 */
import { appendFileSync } from 'node:fs';
import { format } from 'node:util';

export interface ConsoleGuardOptions {
  /** 拦截到的一完整条文本（已 format、去尾换行）。 */
  readonly onText: (text: string) => void;
  /** 全量日志路径（best-effort 追加，失败静默）。 */
  readonly logPath?: string;
}

/** 当前生效的护栏恢复函数。/new、/resume 换会话时旧 PiChat 未必走 exit()，
 * 不先恢复旧护栏的话，console 会永远被吞进一个已死实例的 sink。 */
let activeRestore: (() => void) | undefined;

/** 安装护栏，返回恢复函数。重复安装会先恢复上一层，避免嵌套套娃。 */
export function installConsoleGuard(opts: ConsoleGuardOptions): () => void {
  activeRestore?.();
  activeRestore = undefined;
  const originals = {
    log: console.log,
    info: console.info,
    warn: console.warn,
    error: console.error,
    debug: console.debug,
    stderrWrite: process.stderr.write.bind(process.stderr),
  };

  const emit = (text: string): void => {
    const clean = text.replace(/\s+$/u, '');
    if (clean === '') return;
    if (opts.logPath !== undefined) {
      try {
        appendFileSync(opts.logPath, `${new Date().toISOString()} ${clean}\n`);
      } catch {
        // 日志写不进去不阻塞护栏主职责
      }
    }
    try {
      opts.onText(clean);
    } catch {
      // sink 抛错不能回流成二次控制台输出
    }
  };

  const wrap =
    () =>
    (...args: unknown[]): void => {
      emit(format(...args));
    };

  console.log = wrap();
  console.info = wrap();
  console.warn = wrap();
  console.error = wrap();
  console.debug = wrap();
  // Node 运行时 warning 与零星库直写走 stderr。拦截后不回传原 write——回传就把
  // 文本又写回物理屏了。返回值按 Writable 契约给 true（缓冲未满）。
  process.stderr.write = ((chunk: unknown, ...rest: unknown[]): boolean => {
    const text = typeof chunk === 'string' ? chunk : Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk);
    emit(text);
    const cb = rest.find((a): a is () => void => typeof a === 'function');
    cb?.();
    return true;
  }) as typeof process.stderr.write;

  let restored = false;
  const restore = (): void => {
    if (restored) return;
    restored = true;
    if (activeRestore === restore) activeRestore = undefined;
    console.log = originals.log;
    console.info = originals.info;
    console.warn = originals.warn;
    console.error = originals.error;
    console.debug = originals.debug;
    process.stderr.write = originals.stderrWrite;
  };
  activeRestore = restore;
  return restore;
}
