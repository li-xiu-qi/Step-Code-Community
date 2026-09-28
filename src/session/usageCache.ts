import { mkdir, open, readdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { bucketStart, type TimeBucketUsage, type UsageTimeBucket } from './usageReport.js';
import { workdirKey } from './store.js';

/**
 * 用量统计的增量缓存（`/usage -d|-w|-m` 的数据层）。
 *
 * 为什么需要它：直接扫 wire.jsonl 全量 parse 在本机实测 22.4 秒（当前工作目录
 * 1004 个事件日志、96.8 万行），命令等同卡死。瓶颈不在 JSON.parse 而在
 * 「读全部字节 + 逐行切分」——预过滤行只省 27%，按 mtime 筛文件最多省 62%，
 * 都没有跳出「每次全量遍历」的量级。
 *
 * 做法：每个 wire 文件记一个字节游标（处理到哪）加按日汇总；再次统计只读
 * 游标之后的新增行。日是最细粒度，周/月由日汇总归组得出，一个缓存服务三种
 * 分桶。缓存落在桶目录的 `_usage-cache.json`，与 `_index.json` 同级。
 *
 * 失效规则（三条，缺一不可）：
 * - 文件字节数小于游标 → 被截断或重写，该文件重读全量；
 * - 缓存有条目但文件没了 → 会话已删，丢弃条目；
 * - 缓存 JSON 损坏或版本不符 → 整体重建（慢一次，之后恢复增量）。
 *
 * 刷新是 async 且每处理完一个文件让出事件循环：首次全量构建要几十秒，
 * 同步跑会把 TUI 冻住，让出后调用方有机会先渲染「正在建索引」的提示。
 */

const CACHE_FILE = '_usage-cache.json';
const CACHE_VERSION = 1;

/** 单日汇总，键是本地时区的 `YYYY-MM-DD`。 */
export interface DayTotals {
  turns: number;
  tokens: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheCreation: number;
}

/** 单个 wire 文件的缓存条目。 */
export interface UsageCacheFileEntry {
  /** 已处理到的字节偏移，落在完整行边界上。 */
  size: number;
  /** 本地日期 → 当日汇总。 */
  days: Record<string, DayTotals>;
}

export interface UsageCache {
  version: number;
  files: Record<string, UsageCacheFileEntry>;
}

export function emptyDay(): DayTotals {
  return { turns: 0, tokens: 0, input: 0, output: 0, cacheRead: 0, cacheCreation: 0 };
}

function emptyCache(): UsageCache {
  return { version: CACHE_VERSION, files: {} };
}

/** 本地时区的 `YYYY-MM-DD`，与 {@link bucketStart} 的 day 口径一致。 */
function dayKey(d: Date): string {
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/**
 * 把一段新增文本里的 model.usage 行累加进 days（就地修改）。
 *
 * 行级预过滤：`includes` 不过的行不 parse。wire 日志里占比最大的是
 * context.append_message（带完整消息正文），它们与用量统计无关，
 * parse 它们是纯粹的浪费。
 *
 * 返回处理到的字节边界（调用方据此更新游标）。文本末尾的残行
 * （写盘途中进程被杀留下的半行）不计入——她的字节数也不前进，
 * 下次与 append 的新行拼上再试；parse 失败的坏行跳过但字节前进，
 * 她永远不会变好，停在她前面只会每轮重读。
 */
export function applyUsageText(days: Record<string, DayTotals>, text: string): number {
  let consumed = 0;
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const lineBytes = Buffer.byteLength(line, 'utf8') + (i < lines.length - 1 ? 1 : 0);
    const isTailFragment = i === lines.length - 1 && !text.endsWith('\n');
    if (isTailFragment) break; // 残行：不处理，字节不前进
    consumed += lineBytes;
    if (!line.includes('"type":"model.usage"')) continue;
    let ev: {
      ts?: string;
      totalTokens?: number;
      inputTokens?: number;
      outputTokens?: number;
      cacheReadTokens?: number;
      cacheCreationTokens?: number;
    };
    try {
      ev = JSON.parse(line) as typeof ev;
    } catch {
      continue; // 坏行：字节前进，内容丢弃
    }
    if (ev.ts === undefined) continue;
    const start = bucketStart(ev.ts, 'day');
    if (start === null) continue;
    const key = dayKey(start);
    const day = (days[key] ??= emptyDay());
    const input = ev.inputTokens ?? 0;
    const output = ev.outputTokens ?? 0;
    const cacheRead = ev.cacheReadTokens ?? 0;
    const cacheCreation = ev.cacheCreationTokens ?? 0;
    day.turns += 1;
    day.input += input;
    day.output += output;
    day.cacheRead += cacheRead;
    day.cacheCreation += cacheCreation;
    day.tokens += ev.totalTokens ?? input + output + cacheRead + cacheCreation;
  }
  return consumed;
}

/** 桶目录：<baseDir>/<workdirKey(cwd)>。 */
function bucketDir(cwd: string, baseDir: string): string {
  return join(baseDir, workdirKey(cwd));
}

function cacheFile(cwd: string, baseDir: string): string {
  return join(bucketDir(cwd, baseDir), CACHE_FILE);
}

/** 读缓存。文件不存在、JSON 损坏、版本不符都返回空缓存（调用方随后全量重建）。 */
export async function loadUsageCache(
  cwd: string,
  baseDir: string = join(homedir(), '.step-code', 'sessions'),
): Promise<UsageCache> {
  try {
    const raw = await readFile(cacheFile(cwd, baseDir), 'utf8');
    const parsed = JSON.parse(raw) as UsageCache;
    if (parsed.version !== CACHE_VERSION || typeof parsed.files !== 'object') return emptyCache();
    return parsed;
  } catch {
    return emptyCache();
  }
}

/** 原子落盘（临时文件 + rename），避免写一半被下一条命令读到。 */
async function saveUsageCache(cwd: string, baseDir: string, cache: UsageCache): Promise<void> {
  const target = cacheFile(cwd, baseDir);
  const tmp = `${target}.tmp`;
  // 桶目录可能不存在（这个 cwd 从没跑过 CLI）：先建再写，否则首次使用直接 ENOENT。
  // 正常路径下目录已在（会话都在里面），mkdir recursive 幂等，不增加开销。
  await mkdir(bucketDir(cwd, baseDir), { recursive: true });
  await writeFile(tmp, JSON.stringify(cache), 'utf8');
  await rename(tmp, target);
}

/**
 * 刷新缓存：对桶内每个 wire 文件做增量合并，返回刷新后的缓存。
 *
 * 每个文件处理完 `await` 一次让出事件循环——首次全量构建要几十秒，
 * 同步跑会把 TUI 冻住；让出后调用方可以先渲染「正在建索引」再拿结果。
 */
export async function refreshUsageCache(
  cwd: string,
  baseDir: string = join(homedir(), '.step-code', 'sessions'),
): Promise<UsageCache> {
  const dir = bucketDir(cwd, baseDir);
  const cache = await loadUsageCache(cwd, baseDir);
  let ids: string[];
  try {
    const entries = await readdir(dir);
    ids = entries.filter((f) => f.endsWith('.wire.jsonl')).map((f) => f.slice(0, -'.wire.jsonl'.length)).sort();
  } catch {
    ids = []; // 桶目录不存在：没有会话，也没有缓存可建
  }

  const live = new Set(ids);
  for (const id of ids) {
    const file = join(dir, `${id}.wire.jsonl`);
    let size: number;
    try {
      size = (await stat(file)).size;
    } catch {
      continue; // 列到了但读不到（并发删除）：跳过，条目留给下次清理
    }
    const entry = cache.files[id];
    if (entry !== undefined && entry.size === size) continue; // 无变化：最常见的路径，零 IO
    const from = entry !== undefined && entry.size < size ? entry.size : 0;
    const days = from === 0 ? {} : entry!.days;
    if (from === 0) delete cache.files[id]; // 截断/重写或新文件：从头来
    try {
      const fh = await open(file, 'r');
      try {
        const len = size - from;
        if (len > 0) {
          const buf = Buffer.alloc(len);
          await fh.read(buf, 0, len, from);
          applyUsageText(days, buf.toString('utf8'));
        }
      } finally {
        await fh.close();
      }
    } catch {
      continue; // 读失败：保留旧条目（若有），不动游标
    }
    cache.files[id] = { size, days };
    await Promise.resolve(); // 让出事件循环
  }

  // 缓存里有、磁盘上没有：会话已删，丢弃条目
  for (const id of Object.keys(cache.files)) {
    if (!live.has(id)) delete cache.files[id];
  }

  await saveUsageCache(cwd, baseDir, cache);
  return cache;
}

/**
 * 从缓存聚合出时间序列（与 {@link aggregateUsageByTime} 同口径，但不读 wire 文件）。
 *
 * 归组在日汇总上进行：week 取该日所在周的周一为键，month 取 `YYYY-MM`。
 * 周/月口径因此与全量路径共用同一套 {@link bucketStart}，两条路结果必须一致
 * （测试里逐分桶对比钉死）。
 */
export function aggregateFromCache(
  cache: UsageCache,
  bucket: UsageTimeBucket,
  limit: number,
): TimeBucketUsage[] {
  const groups = new Map<string, TimeBucketUsage>();
  const keyOf = (day: string): { key: string; start: Date } => {
    const d = new Date(`${day}T00:00:00`);
    if (bucket === 'day') return { key: day, start: d };
    const start = bucketStart(d.toISOString(), bucket === 'week' ? 'week' : 'month')!;
    return { key: dayKey(start), start };
  };

  for (const entry of Object.values(cache.files)) {
    for (const [day, totals] of Object.entries(entry.days)) {
      const { key, start } = keyOf(day);
      let row = groups.get(key);
      if (row === undefined) {
        row = { start, turns: 0, tokens: 0, input: 0, output: 0, cacheRead: 0, cacheCreation: 0 };
        groups.set(key, row);
      }
      row.turns += totals.turns;
      row.tokens += totals.tokens;
      row.input += totals.input;
      row.output += totals.output;
      row.cacheRead += totals.cacheRead;
      row.cacheCreation += totals.cacheCreation;
    }
  }

  return [...groups.values()]
    .sort((a, b) => a.start.getTime() - b.start.getTime())
    .slice(Math.max(0, groups.size - Math.max(1, limit)));
}
