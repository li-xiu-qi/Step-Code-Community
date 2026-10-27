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

/**
 * 单个 subagent 会话的用量累计（按 `subagentSessionId` 分组）。
 * 数据源与 {@link aggregateModelUsage} 相同——父会话 wire log 里带了
 * `subagentSessionId` 标签的 `model.usage` 事件；区别只在分组键。
 */
export interface SubagentUsageStats {
  /** 子 agent 会话持久 id（与 `subagents/<id>.json` 同名，可 join 复盘）。 */
  sessionId: string;
  /** 该子会话的 API 往返轮次数。 */
  turns: number;
  /** 未命中缓存的输入 token（净值，语义同 {@link ModelUsageStats.input}）。 */
  input: number;
  output: number;
  cacheRead: number;
  cacheCreation: number;
  /** 服务端口径总量（四字段之和）。 */
  totalTokens: number;
  /** 计费口径（input + output），与逐轮 `billedTokens` 字段同口径。 */
  billedTokens: number;
  /** 该子会话用过的模型名（去重升序；子会话中途可换模型，保留全部）。 */
  models: string[];
}

/** 子 agent 维度聚合结果：逐会话明细 + 合计行。 */
export interface SubagentUsageReport {
  /** 按计费量降序，便于一眼看到消耗大头。 */
  rows: SubagentUsageStats[];
  /** 合计行，sessionId 为 {@link SUBAGENT_TOTAL_ROW_NAME}。 */
  total: SubagentUsageStats;
}

/** 子 agent 合计行的 sessionId 名。 */
export const SUBAGENT_TOTAL_ROW_NAME = 'SUBAGENT-TOTAL';

function emptySubagentStats(sessionId: string): SubagentUsageStats {
  return {
    sessionId,
    turns: 0,
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheCreation: 0,
    totalTokens: 0,
    billedTokens: 0,
    models: [],
  };
}

/**
 * 从事件流聚合出子 agent 用量（`/usage` 子 agent 维度的数据层）。
 *
 * 只消费带 `subagentSessionId` 的 `model.usage` 事件——主 agent 自己的往返
 * 不带该字段，天然被排除。消费方按「字段在不在」判断归属，这里同理。
 *
 * 与子会话快照里 {@link SessionData.tokensUsed} 的关系：那个字段回答
 * 「这个子会话跑完后一共烧了多少」（交互结束后的唯一来源，因 runner 闭包
 * 里的累计不落盘）；本函数回答「本次统计窗口内逐轮明细按会话加起来是多少」。
 * 同一事实两条路径，复盘时对得上即说明采集链路完整。
 */
export function aggregateSubagentUsage(events: readonly WireEvent[]): SubagentUsageReport {
  const bySession = new Map<string, SubagentUsageStats>();
  const total = emptySubagentStats(SUBAGENT_TOTAL_ROW_NAME);

  for (const ev of events) {
    if (ev.type !== 'model.usage') continue;
    if (ev.subagentSessionId === undefined) continue;
    const key = ev.subagentSessionId;
    let row = bySession.get(key);
    if (row === undefined) {
      row = emptySubagentStats(key);
      bySession.set(key, row);
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
    // totalTokens/billedTokens 缺省时按四字段自补：与 aggregateUsageByTime 同一理由，
    // 旧数据与测试构造事件可能不带，而 NaN/undefined 会让排序与合计失控。
    row.totalTokens += ev.totalTokens ?? input + output + cacheRead + cacheCreation;
    row.billedTokens += ev.billedTokens ?? input + output;
    if (ev.model !== undefined && !row.models.includes(ev.model)) {
      row.models.push(ev.model);
      row.models.sort();
    }

    total.turns += 1;
    total.input += input;
    total.output += output;
    total.cacheRead += cacheRead;
    total.cacheCreation += cacheCreation;
    total.totalTokens += ev.totalTokens ?? input + output + cacheRead + cacheCreation;
    total.billedTokens += ev.billedTokens ?? input + output;
  }

  const rows = [...bySession.values()].sort((a, b) => {
    const diff = b.billedTokens - a.billedTokens;
    // 同量时按 sessionId 稳定排序，避免 Map 插入顺序导致输出抖动。
    return diff !== 0 ? diff : a.sessionId.localeCompare(b.sessionId);
  });

  return { rows, total };
}
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

/**
 * 各粒度默认回看多少个桶：日看两周、周看两月、月看两月。
 *
 * 月的默认值取 2 而不是 6：缓存建立前每次统计都要遍历全部事件日志，
 * 范围越大首次成本越高；而个人 CLI 的用量数据通常只积累几个月，
 * 默认 2 个月覆盖绝大部分「最近干了什么」的查询意图，更长的历史
 * 用 `/usage -m 6` 显式要。缓存就位后这个数字只影响展示行数。
 */
export const DEFAULT_BUCKET_LIMIT: Readonly<Record<UsageTimeBucket, number>> = {
  day: 14,
  week: 8,
  month: 2,
};

/**
 * 事件时间戳 → 所属桶的起始时刻（本地时区）。
 *
 * 时区取本机而不是 UTC：wire 事件的 ts 是 UTC ISO 字符串，而用户说的
 * 「今天」「这周」按本地日历成立。混用会让凌晨的用量归到前一天，
 * 报表与用户感知对不上。Date 的 getFullYear/getMonth/getDate/getDay
 * 本身就是本地时区语义，直接用来重组桶起点即可。
 *
 * 导出供 usageCache 复用：缓存按日汇总再归组周/月，两处必须共用同一套
 * 日历口径，否则缓存路径与全量扫描路径会算出不同的桶边界。
 */
export function bucketStart(ts: string, bucket: UsageTimeBucket): Date | null {
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
