/**
 * lifecycle.ts 测试：start/exit 配对登记、上轮未正常退出检出、标记文件消费。
 *
 * 不测真崩溃（那需要杀进程），钉住的是记录与检出逻辑：配对关系、并发窗口
 * 的 pid 存活豁免、标记只提示一次。
 */
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  appendRecord,
  beginLifecycle,
  consumeUngracefulMarker,
  detectPrevUngraceful,
  clearHeartbeat,
  readHeartbeat,
  recordChildExit,
  writeHeartbeat,
  ungracefulMarkerFile,
  type LifecycleRecord,
} from '../src/lifecycle.js';

let dirs: string[] = [];

const mk = (): string => {
  const d = mkdtempSync(path.join(tmpdir(), 'lifecycle-test-'));
  dirs.push(d);
  return d;
};

const readAll = (dir: string): LifecycleRecord[] =>
  readFileSync(path.join(dir, 'lifecycle.jsonl'), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as LifecycleRecord);

/** 一个几乎确定不存活的 pid（远超 Windows/Linux 常规 pid 范围）。 */
const DEAD_PID = 4194300;

afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
});

describe('appendRecord / detectPrevUngraceful', () => {
  it('start 有配对 exit：不报异常退出', () => {
    const dir = mk();
    appendRecord(dir, { ts: '2026-10-06T08:00:00Z', ev: 'start', pid: DEAD_PID, role: 'app' });
    appendRecord(dir, { ts: '2026-10-06T09:00:00Z', ev: 'exit', pid: DEAD_PID, code: 0 });
    expect(detectPrevUngraceful(dir, 12345)).toBeNull();
  });

  it('start 无配对 exit 且 pid 已死：检出上轮异常退出', () => {
    const dir = mk();
    appendRecord(dir, { ts: '2026-10-06T08:00:00Z', ev: 'start', pid: DEAD_PID, role: 'app' });
    const hit = detectPrevUngraceful(dir, 12345);
    expect(hit).toEqual({ pid: DEAD_PID, ts: '2026-10-06T08:00:00Z' });
  });

  it('start 无配对但 pid 仍存活（并发窗口）：不报', () => {
    const dir = mk();
    appendRecord(dir, { ts: '2026-10-06T08:00:00Z', ev: 'start', pid: process.pid, role: 'app' });
    // selfPid 传另一个值，使该 start 参与判定；pid 是测试进程本身，活着
    expect(detectPrevUngraceful(dir, 12345)).toBeNull();
  });

  it('re-exec 结构：父 child-exit 记录也算配对', () => {
    const dir = mk();
    appendRecord(dir, { ts: '2026-10-06T08:00:00Z', ev: 'start', pid: DEAD_PID, role: 'reexec-parent' });
    appendRecord(dir, { ts: '2026-10-06T09:00:00Z', ev: 'child-exit', pid: DEAD_PID, code: 0, signal: null });
    expect(detectPrevUngraceful(dir, 12345)).toBeNull();
  });

  it('日志文件不存在 / 空文件：返回 null 不抛错', () => {
    const dir = mk();
    expect(detectPrevUngraceful(dir, 12345)).toBeNull();
  });

  it('坏行被跳过，不影响其余记录解析', () => {
    const dir = mk();
    appendRecord(dir, { ts: '2026-10-06T08:00:00Z', ev: 'start', pid: DEAD_PID, role: 'app' });
    appendRecord(dir, { ts: 'not json at all' as unknown as string, ev: 'exit' } as unknown as LifecycleRecord);
    expect(detectPrevUngraceful(dir, 12345)).not.toBeNull();
  });
});

describe('beginLifecycle / recordChildExit', () => {
  it('登记 start 并安装 exit 钩子；检出上轮异常时写 prev-ungraceful 与标记文件', () => {
    const dir = mk();
    appendRecord(dir, { ts: '2026-10-06T08:00:00Z', ev: 'start', pid: DEAD_PID, role: 'app' });
    const prev = beginLifecycle(dir, 'app');
    expect(prev).toEqual({ pid: DEAD_PID, ts: '2026-10-06T08:00:00Z' });
    const recs = readAll(dir);
    expect(recs.some((r) => r.ev === 'start' && r.pid === process.pid)).toBe(true);
    expect(recs.some((r) => r.ev === 'prev-ungraceful' && r.code === DEAD_PID)).toBe(true);
    expect(existsSync(ungracefulMarkerFile(dir))).toBe(true);
    // 标记可消费且只提示一次
    expect(consumeUngracefulMarker(dir)).toEqual({ pid: DEAD_PID, ts: '2026-10-06T08:00:00Z' });
    expect(consumeUngracefulMarker(dir)).toBeNull();
  });

  it('上轮正常退出时不写标记文件', () => {
    const dir = mk();
    appendRecord(dir, { ts: '2026-10-06T08:00:00Z', ev: 'start', pid: DEAD_PID, role: 'app' });
    appendRecord(dir, { ts: '2026-10-06T09:00:00Z', ev: 'exit', pid: DEAD_PID, code: 0 });
    beginLifecycle(dir, 'app');
    expect(existsSync(ungracefulMarkerFile(dir))).toBe(false);
  });

  it('recordChildExit 记录 status 与 signal', () => {
    const dir = mk();
    recordChildExit(dir, null, 'SIGTERM');
    const recs = readAll(dir);
    expect(recs[0]).toMatchObject({ ev: 'child-exit', code: null, signal: 'SIGTERM' });
  });
});

describe('心跳（heartbeat）', () => {
  it('写入后可读回；清除只认自己的 pid', () => {
    const dir = mk();
    writeHeartbeat(dir, { pid: DEAD_PID, sessionId: 's-1', cwd: '/x' });
    expect(readHeartbeat(dir)).toMatchObject({ pid: DEAD_PID, sessionId: 's-1', cwd: '/x' });
    // 别的 pid 来清：不清
    clearHeartbeat(dir, 9999);
    expect(readHeartbeat(dir)).not.toBeNull();
    // 自己清：清空
    clearHeartbeat(dir, DEAD_PID);
    expect(readHeartbeat(dir)).toBeNull();
  });

  it('坏内容/不存在：readHeartbeat 返回 null 不抛错', () => {
    const dir = mk();
    expect(readHeartbeat(dir)).toBeNull();
  });

  it('心跳 pid 与死者一致 → 提示可据此给恢复指针（消费端契约）', () => {
    const dir = mk();
    // 模拟：实例写了心跳后被外部杀死（无 exit 记录）
    writeHeartbeat(dir, { pid: DEAD_PID, sessionId: '20261006-abc', cwd: '/vault' });
    const hit = detectPrevUngraceful(dir, 12345);
    // 注：本用例没有 start 记录，detect 返回 null；契约是「有 start 无 exit + 心跳 pid 一致」
    // 这里钉住的是心跳文件本身在死者消失后仍可读（恢复指针的数据源存活）
    expect(hit).toBeNull();
    expect(readHeartbeat(dir)).toMatchObject({ pid: DEAD_PID, sessionId: '20261006-abc' });
  });
});
