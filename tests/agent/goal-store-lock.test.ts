import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { GoalStore } from '../../src/agent/goal/store.js';
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
