import type { WireEvent } from '../agent/wirelog.js';

/**
 * token 与缓存用量聚合（`/usage` 命令的数据层）。
 *
 * 数据源是事件日志里的 `model.usage` 事件——每轮一条，落盘于会话的 `.wire.jsonl`。
 * 选落盘而非内存累加器有三个理由：落盘覆盖完整会话（含 resume 之前的轮次，
 * 而内存累加器在 resume 后从零开始，缓存效果恰恰要看长会话的累计表现）；
 * 无需改动采集侧；与调试包导出共用同一份事实源，两者结论不会打架。
 *
 * 本模块刻意不含任何渲染逻辑与 i18n 依赖，纯函数便于测试；
 * 文本呈现在 tui 层（`tui/usagePanel.ts`）。
 */

/** 单个模型的用量累计。四个 token 字段都是跨轮次求和。 */
export interface ModelUsageStats {
  /** 模型名；事件里 model 缺失时为 {@link UNKNOWN_MODEL}。 */
  model: string;
  /** 该模型的 API 往返轮次数。 */
  turns: number;
  /**
   * 未命中缓存的输入 token。
   * 注意这是**净值**——服务端返回的 input 已扣除缓存命中部分，
   * 故本字段与 cacheRead / cacheCreation 不重叠，三者可直接相加得总输入。
   */
  input: number;
  output: number;
  /** 命中缓存、直接复用的输入 token。 */
  cacheRead: number;
  /** 写入缓存的输入 token（首轮建缓存时出现，通常为 0）。 */
  cacheCreation: number;
}

/** 聚合结果：逐模型明细 + 合计行。 */
export interface UsageReport {
  /** 按总输入量（三字段之和）降序，便于一眼看到消耗大头。 */
  rows: ModelUsageStats[];
  /** 合计行，model 为 {@link TOTAL_ROW_NAME}。 */
  total: ModelUsageStats;
}

/** 事件缺 model 字段时的分组名。 */
export const UNKNOWN_MODEL = 'unknown';

/** 合计行的 model 名。 */
export const TOTAL_ROW_NAME = 'TOTAL';

function emptyStats(model: string): ModelUsageStats {
  return { model, turns: 0, input: 0, output: 0, cacheRead: 0, cacheCreation: 0 };
}

/** 总输入 token（三字段之和），既是排序键也是命中率的分母。 */
export function totalInput(s: ModelUsageStats): number {
  return s.input + s.cacheRead + s.cacheCreation;
}

/**
 * 缓存命中率：`cacheRead / (input + cacheRead + cacheCreation)`。
 *
 * 分母取三项之和而非单取 input，因为服务端返回的 input 已经扣掉了缓存命中部分：
 * 只拿 input 当分母会把命中率算高（极端情况下命中越多、分母越小、比率越接近 1）。
 *
 * 无任何输入时返回 null 而非 0——「没有数据」与「一次都没命中」是两回事，
 * 后者是需要排查的信号，前者不是。
 */
export function cacheHitRate(s: ModelUsageStats): number | null {
  const denom = totalInput(s);
  if (denom <= 0) return null;
  return s.cacheRead / denom;
}

/**
 * 从事件流聚合出用量报告。非 `model.usage` 事件一律忽略。
 *
 * 该事件不参与状态机重放（`applyWireEvent` 不消费它），所以这里自己扫，
 * 不能指望 replay 后的状态里有它。
 */
export function aggregateModelUsage(events: readonly WireEvent[]): UsageReport {
  const byModel = new Map<string, ModelUsageStats>();
  const total = emptyStats(TOTAL_ROW_NAME);

  for (const ev of events) {
    if (ev.type !== 'model.usage') continue;
    // model 是可选字段：缺失时归入 unknown 分组，不丢弃该轮。
    // 丢弃会让合计与逐行之和对不上，而对不上的报表比多一行 unknown 更难排查。
    const key = ev.model ?? UNKNOWN_MODEL;
    let row = byModel.get(key);
    if (row === undefined) {
      row = emptyStats(key);
      byModel.set(key, row);
    }
    const input = ev.inputTokens ?? 0;
    const output = ev.outputTokens ?? 0;
    const cacheRead = ev.cacheReadTokens ?? 0;
    const cacheCreation = ev.cacheCreationTokens ?? 0;

    row.turns += 1;
    row.input += input;
    row.output += output;
    row.cacheRead += cacheRead;
    row.cacheCreation += cacheCreation;

    total.turns += 1;
    total.input += input;
    total.output += output;
    total.cacheRead += cacheRead;
    total.cacheCreation += cacheCreation;
  }

  const rows = [...byModel.values()].sort((a, b) => {
    const diff = totalInput(b) - totalInput(a);
    // 同量时按模型名稳定排序，避免 Map 插入顺序导致输出抖动（测试也依赖这个确定性）。
    return diff !== 0 ? diff : a.model.localeCompare(b.model);
  });

  return { rows, total };
}

/** 时间分桶粒度：自然日 / 周（周一起）/ 自然月。 */
export type UsageTimeBucket = 'day' | 'week' | 'month';

/** 一个时间桶的用量累计。tokens 是服务端口径总量（input + output + cacheRead + cacheCreation）。 */
export interface TimeBucketUsage {
  /** 桶的起始时刻（本地时区）；同粒度的桶按它排序。 */
  start: Date;
  /** 桶内模型往返轮次数。 */
  turns: number;
  /** 服务端 usage 四项相加的总量。 */
  tokens: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheCreation: number;
}

/** 各粒度默认回看多少个桶：日看两周、周看两月、月看半年。 */
export const DEFAULT_BUCKET_LIMIT: Readonly<Record<UsageTimeBucket, number>> = {
  day: 14,
  week: 8,
  month: 6,
};

/**
 * 事件时间戳 → 所属桶的起始时刻（本地时区）。
 *
 * 时区取本机而不是 UTC：wire 事件的 ts 是 UTC ISO 字符串，而用户说的
 * 「今天」「这周」按本地日历成立。混用会让凌晨的用量归到前一天，
 * 报表与用户感知对不上。Date 的 getFullYear/getMonth/getDate/getDay
 * 本身就是本地时区语义，直接用来重组桶起点即可。
 */
function bucketStart(ts: string, bucket: UsageTimeBucket): Date | null {
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return null;
  if (bucket === 'day') return new Date(d.getFullYear(), d.getMonth(), d.getDate());
  if (bucket === 'month') return new Date(d.getFullYear(), d.getMonth(), 1);
  // 周：getDay() 周日为 0，换算成「距周一几天」后回退，得到本周一 00:00。
  // 中文语境一周从周一开始；若从周日切，「周末」会被劈成两半，日报看着像少了一天。
  const mondayOffset = (d.getDay() + 6) % 7;
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() - mondayOffset);
}

function emptyBucket(start: Date): TimeBucketUsage {
  return { start, turns: 0, tokens: 0, input: 0, output: 0, cacheRead: 0, cacheCreation: 0 };
}

/**
 * 按时间分桶聚合用量（`/usage -d|-w|-m` 的数据层）。
 *
 * 与 {@link aggregateModelUsage} 的两点区别：
 * - 分组键是时间桶而非模型，两者可在同一份事件流上分别回答
 *   「哪些模型烧得多」和「什么时候烧得多」；
 * - 只返回**有用量**的桶，不用连续时间轴填空。空桶（一整天没打开 CLI）
 *   填进来会稀释对比基线，而缺失本身在「最近 N 个桶」的标题里已经交代。
 *
 * 返回按时间升序（老 → 新），取最近的 limit 个。升序而不是降序，因为
 * 人读趋势是从左到右，降序要把「最近」放在表格第一行，与时间直觉相反。
 *
 * ts 解析失败的事件被跳过：ts 是 model.usage 的必填字段，解析失败即脏数据，
 * 它没有可信的归属日，硬塞进某个桶会制造出不存在的用量日。
 */
export function aggregateUsageByTime(
  events: readonly WireEvent[],
  bucket: UsageTimeBucket,
  limit: number = DEFAULT_BUCKET_LIMIT[bucket],
): TimeBucketUsage[] {
  const byStart = new Map<number, TimeBucketUsage>();

  for (const ev of events) {
    if (ev.type !== 'model.usage') continue;
    const start = bucketStart(ev.ts, bucket);
    if (start === null) continue;
    const key = start.getTime();
    let row = byStart.get(key);
    if (row === undefined) {
      row = emptyBucket(start);
      byStart.set(key, row);
    }
    const input = ev.inputTokens ?? 0;
    const output = ev.outputTokens ?? 0;
    const cacheRead = ev.cacheReadTokens ?? 0;
    const cacheCreation = ev.cacheCreationTokens ?? 0;
    row.turns += 1;
    row.input += input;
    row.output += output;
    row.cacheRead += cacheRead;
    row.cacheCreation += cacheCreation;
    // totalTokens 缺失时按四字段自补：旧数据与测试构造事件可能不带该字段，
    // 而 NaN 会让整列排序与横条长度失控。
    row.tokens += ev.totalTokens ?? input + output + cacheRead + cacheCreation;
  }

  return [...byStart.values()]
    .sort((a, b) => a.start.getTime() - b.start.getTime())
    .slice(Math.max(0, byStart.size - Math.max(1, limit)));
}
