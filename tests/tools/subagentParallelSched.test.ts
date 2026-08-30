import { describe, it, expect } from 'vitest';
import { ToolScheduler } from '../../src/agent/toolScheduler.js';
import { accessConflict } from '../../src/tools/access.js';

/**
 * 用真实调度器验证「多个只读子 agent 能否并行、带写子 agent 是否串行」。
 * 不测函数存在，测实际放行时序：记录每个任务的启动/结束相对时间。
 */
function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

describe('spawn_agent 并行调度（access 视角）', () => {
  it('三个只读子 agent（none）应并行放行', async () => {
    const started: number[] = [];
    const t0 = Date.now();
    const sched = new ToolScheduler(
      [0, 1, 2].map(() => ({
        access: { kind: 'none' } as const,
        needsSubagentSlot: true,
        run: async () => {
          started.push(Date.now() - t0);
          await sleep(60);
        },
      })),
      { maxSubagentConcurrent: 10 },
    );
    sched.start();
    for (let i = 0; i < 3; i++) await sched.waitSettled(i);
    // 并行：三个启动间隔应远小于各自耗时（都接近 0）
    const spread = Math.max(...started) - Math.min(...started);
    expect(spread).toBeLessThan(40);
  });

  it('两个只读 + 一个写（all）：写必须等其他完成', async () => {
    const events: string[] = [];
    const t0 = Date.now();
    const mk = (tag: string, access: 'none' | 'all') => ({
      access: access === 'none' ? ({ kind: 'none' } as const) : ({ kind: 'all' } as const),
      needsSubagentSlot: true,
      run: async () => {
        events.push(`start:${tag}:${Date.now() - t0}`);
        await sleep(80);
        events.push(`end:${tag}:${Date.now() - t0}`);
      },
    });
    const sched = new ToolScheduler(
      [mk('ro1', 'none'), mk('w', 'all'), mk('ro2', 'none')],
      { maxSubagentConcurrent: 10 },
    );
    sched.start();
    for (let i = 0; i < 3; i++) await sched.waitSettled(i);
    const wEnd = events.find((e) => e.startsWith('end:w'))!;
    const ro2Start = events.find((e) => e.startsWith('start:ro2'))!;
    const wEndMs = Number(wEnd.split(':')[2]);
    const ro2StartMs = Number(ro2Start.split(':')[2]);
    // 写的没结束时，只读不能插队（accessConflict 保证）
    expect(ro2StartMs).toBeGreaterThanOrEqual(wEndMs);
  });

  it('accessConflict 直接断言：none 之间不冲突', () => {
    expect(accessConflict({ kind: 'none' }, { kind: 'none' })).toBe(false);
    expect(accessConflict({ kind: 'none' }, { kind: 'all' })).toBe(true);
    expect(accessConflict({ kind: 'all' }, { kind: 'all' })).toBe(true);
  });

  // ─────────────────────────────────────────────────────────────────
  // scope 判定（2026-08-29）：并行判据从「有没有写权限」改为「写的是不是同一个地方」。
  // 旧实现凡有写工具一律 {kind:'all'} 必串行，导致同项目改不同文件的 agent 也只能排队。
  // ─────────────────────────────────────────────────────────────────

  it('accessConflict：write 不同路径不冲突（并行的基础）', () => {
    expect(accessConflict({ kind: 'write', path: '/p/src/a.ts' }, { kind: 'write', path: '/p/src/b.ts' })).toBe(false);
    // 同文件才冲突
    expect(accessConflict({ kind: 'write', path: '/p/src/a.ts' }, { kind: 'write', path: '/p/src/a.ts' })).toBe(true);
    // 父子目录重叠也算冲突（一个改目录、一个改目录里的文件）
    expect(accessConflict({ kind: 'write', path: '/p/src' }, { kind: 'write', path: '/p/src/a.ts' })).toBe(true);
    // 前缀相似但非目录边界不算重叠（/p/src 与 /p/src2 是兄弟）
    expect(accessConflict({ kind: 'write', path: '/p/src' }, { kind: 'write', path: '/p/src2' })).toBe(false);
    // read 与 write 同路径冲突（读时文件可能正在被写，保守互斥——这是既有行为，
    // 2026-08-29 不改：本次只放宽 write-write，不动 read-write）
    expect(accessConflict({ kind: 'read', path: '/p/a.ts' }, { kind: 'write', path: '/p/a.ts' })).toBe(true);
    // read 与 write 不同路径不冲突
    expect(accessConflict({ kind: 'read', path: '/p/a.ts' }, { kind: 'write', path: '/p/b.ts' })).toBe(false);
  });

  it('scope 不重叠的两个写 agent 并行；重叠的串行', async () => {
    const events: string[] = [];
    const t0 = Date.now();
    const mk = (tag: string, path: string) => ({
      access: { kind: 'write', path } as const,
      needsSubagentSlot: true,
      run: async () => {
        events.push(`start:${tag}:${Date.now() - t0}`);
        await sleep(80);
        events.push(`end:${tag}:${Date.now() - t0}`);
      },
    });
    // 两个 agent 改不同文件 → 应并行（启动间隔远小于各自耗时）
    const sched = new ToolScheduler(
      [mk('a', '/p/src/a.ts'), mk('b', '/p/src/b.ts')],
      { maxSubagentConcurrent: 10 },
    );
    sched.start();
    for (let i = 0; i < 2; i++) await sched.waitSettled(i);
    const aStart = Number(events.find((e) => e.startsWith('start:a'))!.split(':')[2]);
    const bStart = Number(events.find((e) => e.startsWith('start:b'))!.split(':')[2]);
    expect(Math.abs(aStart - bStart)).toBeLessThan(40);

    // 两个 agent 改同一文件 → 必须串行（后一个等前一个结束）
    const events2: string[] = [];
    const t1 = Date.now();
    const mk2 = (tag: string) => ({
      access: { kind: 'write', path: '/p/src/same.ts' } as const,
      needsSubagentSlot: true,
      run: async () => {
        events2.push(`start:${tag}:${Date.now() - t1}`);
        await sleep(80);
        events2.push(`end:${tag}:${Date.now() - t1}`);
      },
    });
    const sched2 = new ToolScheduler([mk2('x'), mk2('y')], { maxSubagentConcurrent: 10 });
    sched2.start();
    for (let i = 0; i < 2; i++) await sched2.waitSettled(i);
    const xEnd = Number(events2.find((e) => e.startsWith('end:x'))!.split(':')[2]);
    const yStart = Number(events2.find((e) => e.startsWith('start:y'))!.split(':')[2]);
    expect(yStart).toBeGreaterThanOrEqual(xEnd);
  });
});
