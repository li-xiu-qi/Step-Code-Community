import { mkdtempSync, rmSync, writeFileSync, appendFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SessionStore } from '../../src/session/store.js';
import type { WireEvent } from '../../src/agent/wirelog.js';
import {
  aggregateUsageByTime,
  type TimeBucketUsage,
  type UsageTimeBucket,
} from '../../src/session/usageReport.js';
import {
  aggregateFromCache,
  applyUsageText,
  loadUsageCache,
  refreshUsageCache,
  type DayTotals,
} from '../../src/session/usageCache.js';

let baseDir: string;
const CWD = 'C:/test/project';

beforeEach(() => {
  baseDir = mkdtempSync(join(tmpdir(), 'usage-cache-test-'));
});

afterEach(() => {
  rmSync(baseDir, { recursive: true, force: true });
});

/** 造一条指定本地时刻的 model.usage 事件。 */
function usage(local: Date, input: number, output: number, cacheRead: number): WireEvent {
  return {
    type: 'model.usage',
    ts: local.toISOString(),
    model: 'm',
    totalTokens: input + output + cacheRead,
    billedTokens: input + output,
    inputTokens: input,
    outputTokens: output,
    cacheReadTokens: cacheRead,
    cacheCreationTokens: 0,
    estimatedTokens: 0,
    frameworkTokens: 0,
    measuredLength: 0,
    stopReason: 'end_turn',
  };
}

/** 一批跨天/跨周/跨月的事件，供两条路径对比。 */
function spanningEvents(): WireEvent[] {
  return [
    usage(new Date(2026, 7, 3, 10, 0), 100, 10, 1000), // 8 月（周一）
    usage(new Date(2026, 7, 4, 23, 30), 50, 5, 500), // 8 月，本地深夜
    usage(new Date(2026, 8, 27, 10, 0), 70, 7, 700), // 9 月周日
    usage(new Date(2026, 8, 28, 0, 30), 30, 3, 300), // 9 月周一，本地凌晨
    usage(new Date(2026, 8, 28, 22, 0), 20, 2, 200), // 9 月周一晚
    usage(new Date(2026, 9, 5, 10, 0), 10, 1, 100), // 10 月周一
  ];
}

/** 把 normalize 后的行摆出来对比，失败时 diff 可读。 */
function shape(rows: readonly TimeBucketUsage[]): unknown[] {
  return rows.map((r) => ({
    start: r.start.getTime(),
    turns: r.turns,
    tokens: r.tokens,
    input: r.input,
    output: r.output,
    cacheRead: r.cacheRead,
    cacheCreation: r.cacheCreation,
  }));
}

describe('applyUsageText（纯函数）', () => {
  it('只累加 model.usage 行，其余行不 parse', () => {
    const days: Record<string, DayTotals> = {};
    const text =
      JSON.stringify({ type: 'metadata', version: 1 }) +
      '\n' +
      JSON.stringify({ type: 'context.append_message', message: { id: 'x', role: 'user', content: '很大的正文' } }) +
      '\n' +
      JSON.stringify({ ts: new Date(2026, 8, 28, 10, 0).toISOString(), type: 'model.usage', totalTokens: 111, inputTokens: 1, outputTokens: 10, cacheReadTokens: 100 }) +
      '\n';
    const consumed = applyUsageText(days, text);
    expect(Object.keys(days)).toEqual(['2026-09-28']);
    expect(days['2026-09-28']!.tokens).toBe(111);
    expect(consumed).toBe(Buffer.byteLength(text, 'utf8'));
  });

  it('残行（无结尾换行的尾段）不处理，字节不前进', () => {
    const days: Record<string, DayTotals> = {};
    const full = `${JSON.stringify({ ts: new Date(2026, 8, 28, 10, 0).toISOString(), type: 'model.usage', totalTokens: 5 })}\n`;
    const fragment = '{"type":"model.usage","ts":"2026-09-28T02:0';
    const consumed = applyUsageText(days, full + fragment);
    expect(days['2026-09-28']!.tokens).toBe(5);
    // 只消费到完整行为止；残行留给下次与 append 的新行拼接
    expect(consumed).toBe(Buffer.byteLength(full, 'utf8'));
  });

  it('坏行跳过但字节前进（她永远不会变好，停在她前面只会每轮重读）', () => {
    const days: Record<string, DayTotals> = {};
    const good = `${JSON.stringify({ ts: new Date(2026, 8, 28, 10, 0).toISOString(), type: 'model.usage', totalTokens: 5 })}\n`;
    const bad = '{"type":"model.usage", 坏 JSON\n';
    const consumed = applyUsageText(days, good + bad);
    expect(days['2026-09-28']!.tokens).toBe(5);
    expect(consumed).toBe(Buffer.byteLength(good + bad, 'utf8'));
  });

  it('ts 缺失的行跳过（没有归属日）', () => {
    const days: Record<string, DayTotals> = {};
    applyUsageText(days, `${JSON.stringify({ type: 'model.usage', totalTokens: 9 })}\n`);
    expect(Object.keys(days)).toHaveLength(0);
  });
});

describe('refreshUsageCache 与全量扫描的一致性', () => {
  it('三分桶结果与 aggregateUsageByTime 完全一致', async () => {
    const store = new SessionStore(baseDir);
    const events = spanningEvents();
    store.appendWire(CWD, 's1', events);
    store.appendWire(CWD, 's2', [usage(new Date(2026, 8, 28, 12, 0), 11, 1, 111)]);

    const cache = await refreshUsageCache(CWD, baseDir);
    for (const bucket of ['day', 'week', 'month'] as UsageTimeBucket[]) {
      const full = aggregateUsageByTime(store.loadWire(CWD, 's1').concat(store.loadWire(CWD, 's2')), bucket, 999);
      const cached = aggregateFromCache(cache, bucket, 999);
      expect(shape(cached), `${bucket} 分桶两条路径不一致`).toEqual(shape(full));
    }
  });

  it('追加新行后增量更新，结果仍与全量一致', async () => {
    const store = new SessionStore(baseDir);
    store.appendWire(CWD, 's1', spanningEvents());
    await refreshUsageCache(CWD, baseDir);

    // 模拟又跑了几轮：往同一会话追加
    store.appendWire(CWD, 's1', [usage(new Date(2026, 8, 29, 9, 0), 40, 4, 400)]);
    const cache2 = await refreshUsageCache(CWD, baseDir);

    const all = store.loadWire(CWD, 's1');
    for (const bucket of ['day', 'week', 'month'] as UsageTimeBucket[]) {
      expect(shape(aggregateFromCache(cache2, bucket, 999))).toEqual(
        shape(aggregateUsageByTime(all, bucket, 999)),
      );
    }
  });

  it('第二次刷新零变化时不重复累加', async () => {
    const store = new SessionStore(baseDir);
    store.appendWire(CWD, 's1', spanningEvents());
    const first = await refreshUsageCache(CWD, baseDir);
    const second = await refreshUsageCache(CWD, baseDir);
    expect(shape(aggregateFromCache(second, 'day', 999))).toEqual(
      shape(aggregateFromCache(first, 'day', 999)),
    );
    // 与全量也一致（防止「没变化」实现成「没读到」）
    expect(shape(aggregateFromCache(second, 'day', 999))).toEqual(
      shape(aggregateUsageByTime(store.loadWire(CWD, 's1'), 'day', 999)),
    );
  });
});

describe('失效处理', () => {
  it('文件被截断（size 回退）时重读全量，不保留旧汇总', async () => {
    const store = new SessionStore(baseDir);
    store.appendWire(CWD, 's1', spanningEvents());
    await refreshUsageCache(CWD, baseDir);

    // 覆写成更短的内容（模拟会话被清理重写）
    const file = join(baseDir, 'x', `${'s1'}.wire.jsonl`);
    // 直接定位真实路径：桶目录名是 workdirKey(CWD)
    const { workdirKey } = await import('../../src/session/store.js');
    const real = join(baseDir, workdirKey(CWD), 's1.wire.jsonl');
    writeFileSync(
      real,
      `${JSON.stringify(usage(new Date(2026, 8, 28, 10, 0), 1, 1, 1))}\n`,
      'utf8',
    );
    expect(existsSync(file)).toBe(false); // 确认上面构造的路径不存在，用 real 才是对的

    const cache = await refreshUsageCache(CWD, baseDir);
    const rows = aggregateFromCache(cache, 'day', 999);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.tokens).toBe(3);
  });

  it('会话被删后缓存条目一并清除', async () => {
    const store = new SessionStore(baseDir);
    store.appendWire(CWD, 's1', spanningEvents());
    store.appendWire(CWD, 's2', [usage(new Date(2026, 8, 28, 12, 0), 5, 0, 50)]);
    await refreshUsageCache(CWD, baseDir);

    const { workdirKey } = await import('../../src/session/store.js');
    rmSync(join(baseDir, workdirKey(CWD), 's2.wire.jsonl'));

    const cache = await refreshUsageCache(CWD, baseDir);
    expect(Object.keys(cache.files)).toEqual(['s1']);
  });

  it('缓存 JSON 损坏时整体重建', async () => {
    const store = new SessionStore(baseDir);
    store.appendWire(CWD, 's1', spanningEvents());
    const { workdirKey } = await import('../../src/session/store.js');
    const cachePath = join(baseDir, workdirKey(CWD), '_usage-cache.json');
    writeFileSync(cachePath, '{ 坏 JSON', 'utf8');

    const broken = await loadUsageCache(CWD, baseDir);
    expect(broken.files).toEqual({});

    const cache = await refreshUsageCache(CWD, baseDir);
    expect(shape(aggregateFromCache(cache, 'month', 999))).toEqual(
      shape(aggregateUsageByTime(store.loadWire(CWD, 's1'), 'month', 999)),
    );
  });

  it('桶目录不存在时不炸，返回空缓存', async () => {
    const cache = await refreshUsageCache('C:/nonexistent/project', baseDir);
    expect(cache.files).toEqual({});
  });
});

describe('aggregateFromCache 的 limit', () => {
  it('取最近的 N 个桶', async () => {
    const store = new SessionStore(baseDir);
    const events = [1, 2, 3, 4, 5].map((d) => usage(new Date(2026, 8, 20 + d, 10, 0), 10, 1, 0));
    store.appendWire(CWD, 's1', events);
    const cache = await refreshUsageCache(CWD, baseDir);
    expect(aggregateFromCache(cache, 'day', 2).map((r) => r.start.getDate())).toEqual([24, 25]);
  });
});
