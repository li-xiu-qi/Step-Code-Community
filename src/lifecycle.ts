/**
 * 进程生命周期日志：回答「上一次运行是怎么没的」。
 *
 * 背景：现有取证网只覆盖三类死法——uncaughtException/unhandledRejection（crash-*.log）、
 * V8 致命错误（report.*.json / heapsnapshot）。2026-10-06 排查 session 97a5f8 的多次
 * 「闪退」时发现三条通道全是空的，说明进程走的是「干净的 process.exit」或「被外部
 * 杀死」（关 tab、dwm 崩溃连坐、conhost 重启），这两类恰好零证据。本模块补上这层：
 * 每次启动/退出都追加一条 JSONL，exit 事件能记下退出码；外部杀死的特点是只有 start
 * 没有 exit——下次启动时检出上一条 start 无配对 exit，即「上次未正常退出」。
 *
 * 落盘：~/.step-code/lifecycle.jsonl（追加写，超 5MB 轮转为 .old）。同步写：
 * exit 事件里只有同步 API 可用。
 */
import { appendFileSync, existsSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export type LifecycleEvent = 'start' | 'exit' | 'child-exit' | 'prev-ungraceful';

export interface LifecycleRecord {
  readonly ts: string;
  readonly ev: LifecycleEvent;
  readonly pid: number;
  /** reexec-parent = 堆上限重拉起的父进程；app = 真正跑应用的进程。 */
  readonly role?: 'app' | 'reexec-parent';
  /** exit / child-exit 的退出码；被信号杀死时为 null。 */
  readonly code?: number | null;
  /** child-exit 的信号名（Windows 上少见）。 */
  readonly signal?: string | null;
  readonly uptimeS?: number;
}

const MAX_BYTES = 5 * 1024 * 1024;

/**
 * 诊断目录解析：默认 ~/.step-code；STEP_CODE_DIAG_DIR 可覆盖。
 * 覆盖口的主要消费者是进程级测试——它们 spawn dist/main.js 后用 SIGTERM 收尾，
 * 子进程来不及写 exit 记录，不隔离的话每跑一轮全量测试，下次真机启动就会
 * 误报「上次未正常退出」。Windows 上 os.homedir() 读 USERPROFILE，测试里设
 * HOME 不起隔离作用，必须显式覆盖。
 */
export function diagDir(): string {
  return process.env.STEP_CODE_DIAG_DIR ?? path.join(os.homedir(), '.step-code');
}

function logFile(dir: string): string {
  return path.join(dir, 'lifecycle.jsonl');
}

/** 追加一条记录。永不抛错：这是取证通道，不能反过来成为崩溃源。 */
export function appendRecord(dir: string, rec: LifecycleRecord): void {
  try {
    const file = logFile(dir);
    if (existsSync(file) && statSync(file).size > MAX_BYTES) {
      renameSync(file, `${file}.old`); // 覆盖旧 .old，只留两代
    }
    appendFileSync(file, `${JSON.stringify(rec)}\n`, 'utf8');
  } catch {
    // 静默：日志写不进去不影响主流程
  }
}

/**
 * 检出「上一次运行未正常退出」：最后一条 start（非本进程）之后没有同 pid 的
 * exit / child-exit 配对。pid 仍存活时不报（并发开的另一个窗口还在跑，不是崩溃）。
 * pid 复用可能带来误报，代价只是多一条提示，可接受。
 */
export function detectPrevUngraceful(dir: string, selfPid: number): { pid: number; ts: string } | null {
  try {
    const file = logFile(dir);
    if (!existsSync(file)) return null;
    const lines = readFileSync(file, 'utf8').split('\n').filter(Boolean);
    const recs: LifecycleRecord[] = [];
    for (const l of lines) {
      try {
        recs.push(JSON.parse(l) as LifecycleRecord);
      } catch {
        // 跳过坏行
      }
    }
    const lastStart = [...recs].reverse().find((r) => r.ev === 'start' && r.pid !== selfPid);
    if (lastStart === undefined) return null;
    const idx = recs.lastIndexOf(lastStart);
    const paired = recs
      .slice(idx + 1)
      .some((r) => (r.ev === 'exit' || r.ev === 'child-exit') && r.pid === lastStart.pid);
    if (paired) return null;
    // re-exec 结构下父进程的 child-exit 记的是父 pid，子进程的 exit 记子 pid；
    // 上面按同 pid 配对已覆盖两种。再查一次 pid 存活防并发窗口误报。
    try {
      process.kill(lastStart.pid, 0);
      return null; // 进程还活着：是并发窗口，不是崩溃
    } catch {
      return { pid: lastStart.pid, ts: lastStart.ts };
    }
  } catch {
    return null;
  }
}

/** 上次未正常退出的标记文件：主进程检出后写入，TUI 启动时读取并删除。 */
export function ungracefulMarkerFile(dir: string): string {
  return path.join(dir, 'last-ungraceful.json');
}

export function writeUngracefulMarker(dir: string, info: { pid: number; ts: string }): void {
  try {
    writeFileSync(ungracefulMarkerFile(dir), JSON.stringify(info), 'utf8');
  } catch {
    // 静默
  }
}

/** TUI 启动时消费标记：读到即删，只提示一次。 */
export function consumeUngracefulMarker(dir: string): { pid: number; ts: string } | null {
  try {
    const file = ungracefulMarkerFile(dir);
    if (!existsSync(file)) return null;
    const info = JSON.parse(readFileSync(file, 'utf8')) as { pid: number; ts: string };
    writeFileSync(file, '', 'utf8'); // 清空而不是删：删文件在某些同步盘上有延迟抖动
    return info;
  } catch {
    return null;
  }
}

/**
 * 启动登记 + 退出/异常日志安装。在任何重量级模块加载前调用（main.ts 引导期）。
 * 返回上次未正常退出的信息（已同时写入标记文件与日志）。
 */
export function beginLifecycle(dir: string, role: 'app' | 'reexec-parent'): { pid: number; ts: string } | null {
  appendRecord(dir, { ts: new Date().toISOString(), ev: 'start', pid: process.pid, role });
  const prev = detectPrevUngraceful(dir, process.pid);
  if (prev !== null) {
    appendRecord(dir, { ts: new Date().toISOString(), ev: 'prev-ungraceful', pid: process.pid, code: prev.pid });
    writeUngracefulMarker(dir, prev);
  }
  process.on('exit', (code) => {
    appendRecord(dir, {
      ts: new Date().toISOString(),
      ev: 'exit',
      pid: process.pid,
      role,
      code,
      uptimeS: Math.round(process.uptime()),
    });
  });
  return prev;
}

/** re-exec 父进程记录子进程终态：clean exit 走 status，信号/杀死走 signal。 */
export function recordChildExit(dir: string, status: number | null, signal: string | null): void {
  appendRecord(dir, {
    ts: new Date().toISOString(),
    ev: 'child-exit',
    pid: process.pid,
    role: 'reexec-parent',
    code: status,
    signal,
    uptimeS: Math.round(process.uptime()),
  });
}
