import { t } from '../i18n.js';
import {
  cacheHitRate,
  DEFAULT_BUCKET_LIMIT,
  totalInput,
  TOTAL_ROW_NAME,
  type ModelUsageStats,
  type TimeBucketUsage,
  type UsageReport,
  type UsageTimeBucket,
} from '../session/usageReport.js';
import { formatCount } from './duration.js';

/**
 * `/usage` 的文本呈现。
 *
 * 展示分层的取舍：缓存指标只在本命令里给，**不进主状态栏**。
 * 状态栏那个 `context: N%` 表达的是「上下文物理占用」，混入缓存命中会让
 * 这个数字的语义变浑；而缓存命中率在单轮尺度上抖动很大（首轮建缓存必然是 0%），
 * 按会话累计才有意义，因此适合按需触发的命令、不适合常驻显示。
 */

/** 命中率告警的输入量下限：低于此量样本太小，比率没有意义。 */
export const LOW_HIT_INPUT_FLOOR = 1_000_000;

/** 命中率告警的上限：正常长会话应远高于此值，取保守下界避免误报。 */
export const LOW_HIT_RATE_CEIL = 0.2;

const COL = { turns: 6, tokens: 10, rate: 8 } as const;

function formatRate(rate: number | null): string {
  return rate === null ? '—' : `${(rate * 100).toFixed(1)}%`;
}

function renderRow(s: ModelUsageStats, nameWidth: number): string {
  return [
    '  ',
    s.model.padEnd(nameWidth),
    String(s.turns).padStart(COL.turns),
    formatCount(s.input).padStart(COL.tokens),
    formatCount(s.cacheRead).padStart(COL.tokens),
    formatRate(cacheHitRate(s)).padStart(COL.rate),
  ].join('');
}

function renderHeader(nameWidth: number): string {
  return [
    '  ',
    'model'.padEnd(nameWidth),
    'turns'.padStart(COL.turns),
    'input'.padStart(COL.tokens),
    'cached'.padStart(COL.tokens),
    'hit%'.padStart(COL.rate),
  ].join('');
}

/**
 * `/usage -d|-w|-m` 的文本呈现：一行一个时间桶，末尾跟一条按量归一的横条。
 *
 * 选表格加横条而不是 donut：环形图回答「构成」，而日/周/月要回答「趋势」，
 * 趋势用长度编码比用角度编码好读；终端里也没有真正的图形能力，
 * 方块字符近似出的环形在等宽字体下边缘是锯齿的，收益不抵成本。
 *
 * 横条只做长度归一，不上色：本模块与 {@link formatUsageReport} 一样是
 * 纯文本层，颜色交给 transcript 的 note 块统一处理，避免两处各着一半
 * 在同一块输出里撞色。
 */
const BAR_MAX = 16;
const BAR_CHAR = '▇';

/** 桶标签：日 MM-DD、周 MM-DD~MM-DD（周一起算）、月 YYYY-MM。 */
function bucketLabel(b: TimeBucketUsage, bucket: UsageTimeBucket): string {
  const pad = (n: number): string => String(n).padStart(2, '0');
  if (bucket === 'month') {
    return `${b.start.getFullYear()}-${pad(b.start.getMonth() + 1)}`;
  }
  const from = `${pad(b.start.getMonth() + 1)}-${pad(b.start.getDate())}`;
  if (bucket === 'day') return from;
  // 周：start 是周一，+6 天即周日。用 new Date 加法而不是算毫秒，
  // 跨月与夏令时都不会错。
  const end = new Date(b.start.getFullYear(), b.start.getMonth(), b.start.getDate() + 6);
  return `${from}~${pad(end.getMonth() + 1)}-${pad(end.getDate())}`;
}

/** 横条长度：按本组最大值归一，至少 1 格（tokens > 0 才调用）。 */
function bar(tokens: number, max: number): string {
  if (tokens <= 0 || max <= 0) return '';
  const cells = Math.max(1, Math.round((tokens / max) * BAR_MAX));
  return BAR_CHAR.repeat(cells);
}

/**
 * 渲染时间维度用量报告。
 *
 * @param rows {@link aggregateUsageByTime} 的结果，时间升序。
 * @param bucket 粒度，用于标签格式与默认回看量的文案。
 * @param scopeLabel 统计范围描述（本工作目录全部会话）。
 */
export function formatUsageByTime(
  rows: readonly TimeBucketUsage[],
  bucket: UsageTimeBucket,
  scopeLabel: string,
): string {
  if (rows.length === 0) {
    return t('app.usage.timeNone', {
      bucket: t(`app.usage.bucket.${bucket}`),
      limit: String(DEFAULT_BUCKET_LIMIT[bucket]),
    });
  }

  const labelWidth = Math.max(...rows.map((r) => bucketLabel(r, bucket).length));
  const max = Math.max(...rows.map((r) => r.tokens));
  const totalTokens = rows.reduce((acc, r) => acc + r.tokens, 0);
  const totalTurns = rows.reduce((acc, r) => acc + r.turns, 0);

  const lines: string[] = [
    t('app.usage.timeHeader', {
      scope: scopeLabel,
      bucket: t(`app.usage.bucket.${bucket}`),
      turns: String(totalTurns),
      tokens: formatCount(totalTokens),
    }),
    '',
    // 列间固定两空格：turns 是 padStart(6) 的定宽列，数字恰好 6 位时
    // 若只靠 padEnd(labelWidth) 分隔会与标签贴在一起（月标签 2026-08 就是 7 字符满列宽）。
    [
      '  ',
      'time'.padEnd(labelWidth),
      '  ',
      'turns'.padStart(6),
      '  ',
      'tokens'.padStart(12),
      '  ',
      'share'.padStart(7),
    ].join(''),
  ];
  for (const r of rows) {
    const share = totalTokens > 0 ? `${((r.tokens / totalTokens) * 100).toFixed(1)}%` : '—';
    lines.push(
      [
        '  ',
        bucketLabel(r, bucket).padEnd(labelWidth),
        '  ',
        String(r.turns).padStart(6),
        '  ',
        formatCount(r.tokens).padStart(12),
        '  ',
        share.padStart(7),
        '  ',
        bar(r.tokens, max),
      ].join(''),
    );
  }

  return lines.join('\n');
}

/** 命中率低到值得提示的模型（输入量够大才算，避免小样本误报）。 */
export function lowHitModels(report: UsageReport): ModelUsageStats[] {
  return report.rows.filter((r) => {
    const rate = cacheHitRate(r);
    return rate !== null && totalInput(r) >= LOW_HIT_INPUT_FLOOR && rate < LOW_HIT_RATE_CEIL;
  });
}

/**
 * 渲染用量报告。
 *
 * @param scopeLabel 统计范围的描述（单会话或多会话汇总），由调用方按 i18n 组装。
 */
export function formatUsageReport(report: UsageReport, scopeLabel: string): string {
  if (report.total.turns === 0) return t('app.usage.none');

  const nameWidth = Math.max(
    'model'.length,
    TOTAL_ROW_NAME.length,
    ...report.rows.map((r) => r.model.length),
  );
  const lines: string[] = [
    t('app.usage.header', { scope: scopeLabel, turns: String(report.total.turns) }),
    '',
    renderHeader(nameWidth),
  ];
  for (const row of report.rows) lines.push(renderRow(row, nameWidth));
  // 分隔线按表格实际宽度画，避免宽窄不一
  lines.push('  ' + '─'.repeat(nameWidth + COL.turns + COL.tokens * 2 + COL.rate));
  lines.push(renderRow(report.total, nameWidth));

  // cache_creation 通常恒为 0，不为它常设一列；真的不为 0 时补一行说明，
  // 否则「分母里多出一块看不见的量」会让人怀疑命中率算错了。
  const withCreation = report.rows.filter((r) => r.cacheCreation > 0);
  if (withCreation.length > 0) {
    lines.push('');
    lines.push(
      t('app.usage.cacheCreateNote', {
        detail: withCreation.map((r) => `${r.model} ${formatCount(r.cacheCreation)}`).join('、'),
      }),
    );
  }

  const low = lowHitModels(report);
  if (low.length > 0) {
    lines.push('');
    for (const r of low) {
      lines.push(
        t('app.usage.lowHit', {
          model: r.model,
          rate: formatRate(cacheHitRate(r)),
        }),
      );
    }
  }

  return lines.join('\n');
}
