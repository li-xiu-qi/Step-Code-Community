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
});
