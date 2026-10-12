/**
 * C 层 stderr 飞行记录器。
 *
 * 背景：2026-10 第二波闪退（0xC0000409 fail-fast）下 JS 层一个 handler 都跑不了，
 * libuv 断言（senpi#1229 实锤的 fs-event 类）与 V8 fatal 文本只经 fd2 直写终端，
 * 进程一死证据就没了。父进程（re-exec 包装层）把子进程 stderr tee 一份到 diag
 * 日志，是这类死法下唯一能留下文本证据的通道——assertion 文本直接含文件名与
 * 行号，拿到即定位，不用等全量 dump 解析。
 *
 * 只在 re-exec 父进程里用（生产路径必经）；应用进程自身无法 tee 自己的 C 层 fd2。
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { ChildProcess } from 'node:child_process';

/** 日志上限：超 2MB 截到尾部 1MB。stderr 常态安静，只在报错时突发，2MB 足够覆盖。 */
const MAX_BYTES = 2 * 1024 * 1024;
const KEEP_BYTES = 1024 * 1024;

/** 超上限就留尾部。日志是环形证据，不是审计档案，丢早期段落可接受。 */
export function rotateStderrLog(logPath: string): void {
  try {
    if (!existsSync(logPath)) return;
    const size = statSync(logPath).size;
    if (size <= MAX_BYTES) return;
    const buf = readFileSync(logPath);
    writeFileSync(logPath, buf.subarray(size - KEEP_BYTES));
  } catch {
    // 截断失败不阻塞启动：记录仪是附属设施
  }
}

/**
 * 把 child 的 stderr 同时送往终端（透传，行为不变）与日志文件（追加）。
 * 同步写文件：进程死在半路时没有 flush 窗口问题，每个 chunk 落盘即安全。
 */
export function attachStderrRecorder(child: ChildProcess, logPath: string): void {
  if (child.stderr === null) return;
  try {
    mkdirSync(dirname(logPath), { recursive: true });
    rotateStderrLog(logPath);
    appendFileSync(logPath, `\n===== child stderr 记录开始 ${new Date().toISOString()} pid=${child.pid ?? '?'} =====\n`);
  } catch {
    // 日志初始化失败不影响透传
  }
  child.stderr.on('data', (chunk: Buffer | string) => {
    // 透传优先：写终端失败（控制台已死）也不能影响落盘
    try {
      process.stderr.write(chunk);
    } catch {
      // 终端已不可写
    }
    try {
      appendFileSync(logPath, chunk);
    } catch {
      // 落盘失败静默：记录仪不能成为新的崩溃源
    }
  });
}
