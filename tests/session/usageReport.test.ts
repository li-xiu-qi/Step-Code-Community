import { describe, expect, it } from 'vitest';
import type { WireEvent } from '../../src/agent/wirelog.js';
import {
  aggregateModelUsage,
  aggregateUsageByTime,
  cacheHitRate,
  DEFAULT_BUCKET_LIMIT,
  totalInput,
  TOTAL_ROW_NAME,
  UNKNOWN_MODEL,
  type ModelUsageStats,
  type UsageTimeBucket,
} from '../../src/session/usageReport.js';

const TS = '2026-08-04T00:00:00.000Z';

/** 造一条 model.usage 事件。model 传 undefined 模拟旧数据缺字段。 */
function usage(
  model: string | undefined,
  input: number,
  output: number,
  cacheRead: number,
  cacheCreation = 0,
): WireEvent {
  return {
    type: 'model.usage',
    ts: TS,
    ...(model !== undefined ? { model } : {}),
    totalTokens: input + output + cacheRead + cacheCreation,
    billedTokens: input + output,
    inputTokens: input,
    outputTokens: output,
    cacheReadTokens: cacheRead,
    cacheCreationTokens: cacheCreation,
    estimatedTokens: 0,
    frameworkTokens: 0,
    measuredLength: 0,
    stopReason: 'end_turn',
  };
}

function rowOf(events: readonly WireEvent[], model: string): ModelUsageStats {
  const row = aggregateModelUsage(events).rows.find((r) => r.model === model);
  expect(row).toBeDefined();
  return row!;
}

/**
 * 造一条指定本地时刻的 model.usage 事件。
 *
 * 入参按本地时间语义传（与 wire 里 ts 是 UTC 字符串这一事实之间的转换
 * 由 toISOString 完成），这样测试写的「本地 9 月 28 日凌晨半点」就是
 * 用户感知的那半个钟头，不随运行机器的时区漂移。
 */
function usageAt(
  local: Date,
  input: number,
  output: number,
  cacheRead: number,
  cacheCreation = 0,
  totalTokens?: number,
): WireEvent {
  return {
    type: 'model.usage',
    ts: local.toISOString(),
    model: 'm',
    totalTokens: totalTokens ?? input + output + cacheRead + cacheCreation,
    billedTokens: input + output,
    inputTokens: input,
    outputTokens: output,
    cacheReadTokens: cacheRead,
    cacheCreationTokens: cacheCreation,
    estimatedTokens: 0,
    frameworkTokens: 0,
    measuredLength: 0,
    stopReason: 'end_turn',
  };
}

/** 桶起始日的 MM-DD，与 usagePanel 的标签同口径，便于断言。 */
function labelOf(b: { start: Date }): string {
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${pad(b.start.getMonth() + 1)}-${pad(b.start.getDate())}`;
}

describe('aggregateModelUsage', () => {
  it('按模型分组，四个 token 字段跨轮累加', () => {
    const report = aggregateModelUsage([
      usage('step-explore', 100, 10, 0),
      usage('step-explore', 200, 20, 50),
      usage('step-router-v1', 300, 30, 700),
    ]);
    const explore = rowOf(
      [usage('step-explore', 100, 10, 0), usage('step-explore', 200, 20, 50)],
      'step-explore',
    );
    expect(explore.turns).toBe(2);
    expect(explore.input).toBe(300);
    expect(explore.output).toBe(30);
    expect(explore.cacheRead).toBe(50);
    expect(report.rows).toHaveLength(2);
  });

  it('合计行等于各行之和，且 turns 为总轮次', () => {
    const report = aggregateModelUsage([
      usage('a', 100, 10, 5, 1),
      usage('b', 200, 20, 6, 2),
      usage('a', 300, 30, 7, 3),
    ]);
    const sum = (pick: (r: ModelUsageStats) => number): number =>
      report.rows.reduce((acc, r) => acc + pick(r), 0);
    expect(report.total.model).toBe(TOTAL_ROW_NAME);
    expect(report.total.turns).toBe(3);
    expect(report.total.input).toBe(sum((r) => r.input));
    expect(report.total.output).toBe(sum((r) => r.output));
    expect(report.total.cacheRead).toBe(sum((r) => r.cacheRead));
    expect(report.total.cacheCreation).toBe(sum((r) => r.cacheCreation));
  });

  it('model 缺失归入 unknown 分组，不丢弃该轮（合计与逐行之和必须一致）', () => {
    const report = aggregateModelUsage([usage('step-explore', 100, 10, 0), usage(undefined, 400, 40, 0)]);
    const unknown = report.rows.find((r) => r.model === UNKNOWN_MODEL);
    expect(unknown).toBeDefined();
    expect(unknown!.input).toBe(400);
    expect(report.total.turns).toBe(2);
    expect(report.total.input).toBe(500);
  });

  it('忽略非 model.usage 事件', () => {
    const report = aggregateModelUsage([
      { type: 'metadata', version: 1, sessionId: 's', createdAt: TS },
      { type: 'permission.set_mode', ts: TS, mode: 'auto' },
      usage('step-explore', 100, 10, 0),
    ]);
    expect(report.rows).toHaveLength(1);
    expect(report.total.turns).toBe(1);
  });

  it('空事件流：rows 为空、合计全零', () => {
    const report = aggregateModelUsage([]);
    expect(report.rows).toEqual([]);
    expect(report.total.turns).toBe(0);
    expect(report.total.input).toBe(0);
  });

  it('按总输入量降序排，同量按模型名稳定排序', () => {
    const report = aggregateModelUsage([
      usage('small', 10, 1, 0),
      usage('big', 1000, 1, 0),
      usage('mid', 100, 1, 0),
    ]);
    expect(report.rows.map((r) => r.model)).toEqual(['big', 'mid', 'small']);

    const tie = aggregateModelUsage([usage('zeta', 100, 1, 0), usage('alpha', 100, 1, 0)]);
    expect(tie.rows.map((r) => r.model)).toEqual(['alpha', 'zeta']);
  });

  it('缺省的 token 字段按 0 计（不产生 NaN）', () => {
    const report = aggregateModelUsage([
      { type: 'model.usage', ts: TS, model: 'm', totalTokens: 0, billedTokens: 0, estimatedTokens: 0, frameworkTokens: 0, measuredLength: 0, stopReason: 'end_turn' },
    ]);
    const row = report.rows[0]!;
    expect(row.input).toBe(0);
    expect(row.cacheRead).toBe(0);
    expect(Number.isNaN(row.input)).toBe(false);
  });
});

describe('cacheHitRate 口径', () => {
  it('分母是 input + cacheRead + cacheCreation 三者之和，不是单取 input', () => {
    // 这条钉死口径：服务端返回的 input 已扣除缓存部分，两者不重叠。
    // 若误取 input 作分母，900/100 会得出 9（900%），命中越多反而越离谱。
    const stats: ModelUsageStats = {
      model: 'm',
      turns: 1,
      input: 100,
      output: 0,
      cacheRead: 900,
      cacheCreation: 0,
    };
    expect(totalInput(stats)).toBe(1000);
    expect(cacheHitRate(stats)).toBeCloseTo(0.9, 10);
  });

  it('cacheCreation 参与分母', () => {
    const stats: ModelUsageStats = {
      model: 'm',
      turns: 1,
      input: 100,
      output: 0,
      cacheRead: 100,
      cacheCreation: 800,
    };
    expect(cacheHitRate(stats)).toBeCloseTo(0.1, 10);
  });

  it('无任何输入返回 null 而非 0（「没数据」与「一次没命中」要能区分）', () => {
    const empty: ModelUsageStats = {
      model: 'm',
      turns: 0,
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheCreation: 0,
    };
    expect(cacheHitRate(empty)).toBeNull();

    const neverHit: ModelUsageStats = { ...empty, turns: 3, input: 5000 };
    expect(cacheHitRate(neverHit)).toBe(0);
  });
});

describe('aggregateUsageByTime', () => {
  // 2026-09-28 是周一，2026-09-27 是周日；2026-10-01 是下个月。
  const mon = new Date(2026, 8, 28, 10, 0);
  const sun = new Date(2026, 8, 27, 10, 0);
  const nextMon = new Date(2026, 9, 5, 10, 0);
  const lastDayOfSep = new Date(2026, 8, 30, 10, 0);

  it('按日分桶：同一天的多轮归一桶，跨天分开', () => {
    const rows = aggregateUsageByTime(
      [usageAt(mon, 100, 10, 0), usageAt(new Date(2026, 8, 28, 22, 0), 50, 5, 0), usageAt(sun, 70, 7, 0)],
      'day',
    );
    expect(rows.map((r) => labelOf(r))).toEqual(['09-27', '09-28']);
    expect(rows[0]!.turns).toBe(1);
    expect(rows[1]!.turns).toBe(2);
    expect(rows[1]!.tokens).toBe(100 + 10 + 50 + 5);
  });

  it('按本地日历分日，不按 UTC：本地凌晨归当天而非前一天', () => {
    // 本地 00:30 在 UTC+8 下换算成 UTC 是前一天 16:30。若误按 UTC 分桶，
    // 这一轮会被算进 09-27，「今天凌晨跑的那批」从日报里消失。
    const earlyMorning = new Date(2026, 8, 28, 0, 30);
    const rows = aggregateUsageByTime([usageAt(earlyMorning, 10, 1, 0)], 'day');
    expect(rows.map((r) => labelOf(r))).toEqual(['09-28']);
  });

  it('按周分桶：周一起算，周日与下周一分属两周', () => {
    const rows = aggregateUsageByTime(
      [usageAt(sun, 10, 1, 0), usageAt(mon, 10, 1, 0), usageAt(nextMon, 10, 1, 0)],
      'week',
    );
    // 周日是一周的尾巴、下周一是新一周的开头，周一起算下两者必然分家；
    // 若从周日切，「周末」会被劈成两半，两边都看不全。
    expect(rows).toHaveLength(3);
    expect(labelOf(rows[0]!)).toBe('09-21');
    expect(labelOf(rows[1]!)).toBe('09-28');
    expect(labelOf(rows[2]!)).toBe('10-05');
  });

  it('按月分桶：跨月分开，桶起点为当月 1 号', () => {
    const rows = aggregateUsageByTime([usageAt(lastDayOfSep, 10, 1, 0), usageAt(nextMon, 10, 1, 0)], 'month');
    expect(rows.map((r) => r.start.getDate())).toEqual([1, 1]);
    expect(rows.map((r) => r.start.getMonth())).toEqual([8, 9]);
  });

  it('时间升序返回，便于从左到右读趋势', () => {
    const rows = aggregateUsageByTime(
      [usageAt(nextMon, 10, 1, 0), usageAt(sun, 10, 1, 0), usageAt(mon, 10, 1, 0)],
      'day',
    );
    expect(rows.map((r) => labelOf(r))).toEqual(['09-27', '09-28', '10-05']);
  });

  it('limit 取最近的 N 个桶', () => {
    const events = [1, 2, 3, 4, 5].map((d) => usageAt(new Date(2026, 8, 20 + d, 10, 0), 10, 1, 0));
    const rows = aggregateUsageByTime(events, 'day', 3);
    expect(rows.map((r) => labelOf(r))).toEqual(['09-23', '09-24', '09-25']);
  });

  it('不填空洞桶：没有用量的日期不出现在结果里', () => {
    const rows = aggregateUsageByTime([usageAt(mon, 10, 1, 0), usageAt(nextMon, 10, 1, 0)], 'day');
    expect(rows).toHaveLength(2);
  });

  it('空事件流返回空数组', () => {
    expect(aggregateUsageByTime([], 'day')).toEqual([]);
    expect(aggregateUsageByTime([], 'week')).toEqual([]);
    expect(aggregateUsageByTime([], 'month')).toEqual([]);
  });

  it('忽略非 model.usage 事件', () => {
    const rows = aggregateUsageByTime(
      [{ type: 'metadata', version: 1, sessionId: 's', createdAt: TS }, usageAt(mon, 10, 1, 0)],
      'day',
    );
    expect(rows).toHaveLength(1);
  });

  it('ts 不可解析的事件跳过（脏数据没有可信归属日）', () => {
    const rows = aggregateUsageByTime(
      [
        { ...usageAt(mon, 10, 1, 0), ts: 'not-a-date' },
        usageAt(mon, 10, 1, 0),
      ],
      'day',
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.turns).toBe(1);
  });

  it('totalTokens 缺省时按四字段自补，不产生 NaN', () => {
    const rows = aggregateUsageByTime([usageAt(mon, 100, 10, 50, 5, undefined)], 'day');
    expect(rows[0]!.tokens).toBe(165);
    expect(Number.isNaN(rows[0]!.tokens)).toBe(false);
  });

  it('各粒度默认回看量：日两周、周两月、月半年', () => {
    expect(DEFAULT_BUCKET_LIMIT.day).toBe(14);
    expect(DEFAULT_BUCKET_LIMIT.week).toBe(8);
    expect(DEFAULT_BUCKET_LIMIT.month).toBe(6);
  });
});
