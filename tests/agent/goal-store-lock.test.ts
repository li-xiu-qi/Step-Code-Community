import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { GoalStore, timeUsedSeconds } from '../../src/agent/goal/store.js';
import type { GoalRecord } from '../../src/agent/goal/store.js';

function makeRecord(overrides: Partial<GoalRecord> = {}): GoalRecord {
  return {
    id: 'test-goal-1',
    objective: 'test objective',
    status: 'active',
    createdAt: 1000,
    updatedAt: 1000,
    turnsUsed: 0,
    tokensUsed: 0,
    completed: false,
    ...overrides,
  };
}

describe('GoalStore 乐观锁', () => {
  let tempDir: string;
  let store: GoalStore;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'goal-test-'));
    store = new GoalStore(tempDir);
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('首次写入（无现有记录）始终成功', () => {
    const r = makeRecord();
    expect(store.save(r, r.updatedAt)).toBe(true);
    expect(store.load('test-goal-1')).not.toBeNull();
  });

  it('不传 expectedUpdatedAt 时始终成功（向后兼容）', () => {
    store.save(makeRecord({ updatedAt: 1000 }));
    expect(store.save(makeRecord({ updatedAt: 2000 }))).toBe(true);
  });

  it('expectedUpdatedAt 匹配时写入成功', () => {
    const r = makeRecord();
    store.save(r, r.updatedAt);
    const loaded = store.load('test-goal-1')!;
    // 用 save 后的 updatedAt 作为基线
    expect(store.save({ ...r, objective: 'updated' }, loaded.updatedAt)).toBe(true);
  });

  it('expectedUpdatedAt 不匹配时拒绝写入', () => {
    store.save(makeRecord({ updatedAt: 1000 }));
    // 磁盘上的 updatedAt 是 save() 内部 Date.now()，不等于 1000
    expect(store.save(makeRecord({ updatedAt: 2000, objective: 'stale' }), 1000)).toBe(false);
    // 确认磁盘未被覆盖
    const loaded = store.load('test-goal-1')!;
    expect(loaded.objective).toBe('test objective'); // 不是 'stale'
  });

  it('跨 session 模拟：A 写入后 B 用旧基线写入被拒', () => {
    // Session A 写入
    const rA = makeRecord();
    store.save(rA, rA.updatedAt);
    const afterA = store.load('test-goal-1')!;

    // Session B 也用 rA.updatedAt 作为基线（模拟 B 在 A 之后加载的旧快照）
    // 但因为 B 实际没加载，它用的是 A 写入前的快照
    // 这里模拟：B 拿到的是 rA（updatedAt=1000），而磁盘已经是 afterA（updatedAt=Date.now()）
    expect(store.save({ ...rA, objective: 'B的修改' }, 1000)).toBe(false);

    // 磁盘上还是 A 的版本
    const final = store.load('test-goal-1')!;
    expect(final.objective).toBe('test objective');
  });

  it('save() 成功后磁盘 updatedAt 被更新为当前时间', () => {
    const before = Date.now();
    store.save(makeRecord({ updatedAt: 1000 }), 1000);
    const after = Date.now();
    const loaded = store.load('test-goal-1')!;
    expect(loaded.updatedAt).toBeGreaterThanOrEqual(before);
    expect(loaded.updatedAt).toBeLessThanOrEqual(after + 1);
  });
});

describe('GoalStore 预算原子检查', () => {
  let tempDir: string;
  let store: GoalStore;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'goal-budget-'));
    store = new GoalStore(tempDir);
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('turn 预算耗尽 + active → save 自动标 blocked', () => {
    store.save(makeRecord({ id: 'b1', status: 'active', turnBudget: 5, turnsUsed: 5 }));
    const loaded = store.load('b1')!;
    expect(loaded.status).toBe('blocked');
    expect(loaded.terminalReason).toBe('轮次预算耗尽');
  });

  it('token 预算耗尽 + active → save 自动标 blocked', () => {
    store.save(makeRecord({ id: 'b2', status: 'active', tokenBudget: 100, tokensUsed: 100 }));
    const loaded = store.load('b2')!;
    expect(loaded.status).toBe('blocked');
    expect(loaded.terminalReason).toBe('token 预算耗尽');
  });

  it('未超预算 + active → save 保持 active', () => {
    store.save(makeRecord({ id: 'b3', status: 'active', turnBudget: 10, turnsUsed: 5, tokenBudget: 1000, tokensUsed: 500 }));
    const loaded = store.load('b3')!;
    expect(loaded.status).toBe('active');
    expect(loaded.terminalReason).toBeUndefined();
  });

  it('paused / blocked / completed 不受预算检查影响', () => {
    store.save(makeRecord({ id: 'b4', status: 'paused', turnBudget: 1, turnsUsed: 99 }));
    expect(store.load('b4')!.status).toBe('paused');

    store.save(makeRecord({ id: 'b5', status: 'blocked', turnBudget: 1, turnsUsed: 99 }));
    expect(store.load('b5')!.status).toBe('blocked');

    store.save(makeRecord({ id: 'b6', status: 'active', completed: true, turnBudget: 1, turnsUsed: 99 }));
    expect(store.load('b6')!.status).toBe('active'); // completed 不检查
  });
});

describe('timeUsedSeconds', () => {
  it('计算 updatedAt - createdAt 的墙钟秒数', () => {
    expect(timeUsedSeconds(makeRecord({ createdAt: 1000, updatedAt: 5000 }))).toBe(4);
  });

  it('updatedAt < createdAt 时返回 0', () => {
    expect(timeUsedSeconds(makeRecord({ createdAt: 5000, updatedAt: 1000 }))).toBe(0);
  });

  it('同一时刻返回 0', () => {
    expect(timeUsedSeconds(makeRecord({ createdAt: 1000, updatedAt: 1000 }))).toBe(0);
  });
});
