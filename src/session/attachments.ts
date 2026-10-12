import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { workdirKey } from './store.js';

/** 附件引用哨兵前缀：StoredMessage 里图片 `source.data` 存 `stepref:<sha256>` 而非 base64。 */
export const STEPREF_PREFIX = 'stepref:';

/**
 * offload 阈值：base64 payload 长度 < 此值的小图不落盘、原样内联（省得为几百字节开文件）。
 * ≥ 此值才卸载成内容寻址附件文件。
 */
export const OFFLOAD_THRESHOLD = 4096;

/** 是否为附件引用哨兵串。 */
export function isStepref(data: string): boolean {
  return data.startsWith(STEPREF_PREFIX);
}

/** media-log.md 单行条目：已交付图片的源文件级登记。 */
export interface MediaLogEntry {
  /** 单调递增序号，模型与文案里称「media #N」。 */
  id: number;
  /** 源文件绝对路径（交付时的路径，模型可凭它再读或做 region 局部读）。 */
  path: string;
  width: number;
  height: number;
  /** 源文件 sha256。与附件文件名同口径（内容寻址）。 */
  sha256: string;
}

/** 从 mediaType 推文件后缀（如 image/png→png）；无从判断时用 bin。 */
function extFor(mediaType: string): string {
  const sub = mediaType.split('/')[1];
  return sub === undefined || sub === '' ? 'bin' : sub;
}

/**
 * 引用式附件存储：图片字节落盘为内容寻址文件，消息里只留 `stepref:<sha256>` 指针。
 *
 * 布局：<baseDir>/<workdirKey>/attachments/<sha256>.<ext>，与 SessionStore 共享 baseDir 与 per-workdir 分桶。
 * 文件名 = 内容 sha256 → 天然去重（同图只存一份，写时撞已存在即跳过）。不建索引/清单文件（会话即索引）。
 */
export class AttachmentStore {
  private readonly baseDir: string;

  constructor(baseDir?: string) {
    this.baseDir = baseDir ?? join(homedir(), '.step-code', 'sessions');
  }

  private dirFor(cwd: string): string {
    return join(this.baseDir, workdirKey(cwd), 'attachments');
  }

  /**
   * 把图片 base64 卸载成附件文件，返回落盘时该图 `source.data` 应存的值：
   * - payload < OFFLOAD_THRESHOLD 的小图：原样返回 base64（内联，不落盘）。
   * - 已是 stepref：原样返回（幂等，不重复卸载）。
   * - 否则：算 sha256 写 attachments/<sha256>.<ext>（撞已存在则跳过，hash 去重），返回 `stepref:<sha256>`。
   */
  offload(cwd: string, base64: string, mediaType: string): string {
    if (isStepref(base64)) return base64;
    if (base64.length < OFFLOAD_THRESHOLD) return base64;
    const hash = createHash('sha256').update(base64).digest('hex');
    const dir = this.dirFor(cwd);
    mkdirSync(dir, { recursive: true });
    const file = join(dir, `${hash}.${extFor(mediaType)}`);
    if (!existsSync(file)) {
      try {
        writeFileSync(file, Buffer.from(base64, 'base64'), { flag: 'wx' });
      } catch (e) {
        // wx 下并发/竞态导致的 EEXIST 无害（内容寻址，字节一致）；其它错误抛出
        if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
      }
    }
    return `${STEPREF_PREFIX}${hash}`;
  }

  /**
   * rehydrate 结果缓存：stepref -> base64。
   *
   * 为什么必须有：resume 出来的会话里图片块全是 `stepref:` 指针，而 toWire 每调一次
   * （runTurn 有 7 个 provider.stream 调用点，外加 advisor）都会把全历史的图片重新读盘转
   * base64。字符串在 V8 里不做内容去重，两次 `readFileSync().toString('base64')` 是两个
   * 独立对象，于是同一张图在堆里出现 N 份。实测（2026-09-26 堆快照，3.2GB 堆）：其中
   * 2688MB 是 base64 图片串，同一张图复制了 431 份，直接把堆推到 80% 水位、逼近 OOM。
   * 内容寻址（文件名 = sha256）让这个缓存天然安全：同一个 stepref 永远对应同一份字节。
   */
  private readonly rehydrateCache = new Map<string, string>();
  /** 缓存条目上限：粗限条数，真正兜底的是下面的字节预算。 */
  private static readonly REHYDRATE_CACHE_MAX_ENTRIES = 64;
  /** 缓存字节预算：超出就淘汰最旧，避免缓存本身变成新的内存大户。 */
  private static readonly REHYDRATE_CACHE_MAX_BYTES = 32 * 1024 * 1024;
  private rehydrateCacheBytes = 0;

  /**
   * 已读媒体索引（设计出处：VISTA 视觉 harness 的「无损视觉记忆 + 主动回看」，
   * 2026-10-12 立项）。read_media 每交付一张图就登记一行，模型可 grep media-log.md
   * 回看「本会话读过哪些图」，read_media 内部用它做源文件级 SHA 去重（重复读同一张
   * 图只回引用、不重复交付视觉块，省 vision token 与上下文体积）。
   *
   * 索引内容：源文件路径 + 源文件 sha256（不是交付副本的 hash——交付会降采样，
   * 副本 hash 对「同一文件重复读」的去重没有判别力）。附件存储本身就是内容寻址的，
   * 这里登记的 sha 与附件文件名同口径，命中时占位符可按 hash 找回交付副本。
   *
   * 布局：<baseDir>/<workdirKey>/media-log.md，与附件分桶同目录，行式 markdown 表，
   * 模型可直接读。内存 Map 懒加载自该文件，进程内追加即写，重启/resume 后索引仍在。
   */
  private readonly mediaLogs = new Map<string, Map<string, MediaLogEntry>>();

  /** media-log 懒加载：workdirKey → sha256 → 条目。文件缺失时返回空 Map 并在首次登记时建文件。 */
  private mediaLogFor(cwd: string): Map<string, MediaLogEntry> {
    const key = workdirKey(cwd);
    const cached = this.mediaLogs.get(key);
    if (cached !== undefined) return cached;
    const map = new Map<string, MediaLogEntry>();
    const file = join(this.baseDir, key, 'media-log.md');
    if (existsSync(file)) {
      for (const line of readFileSync(file, 'utf-8').split(/\r?\n/)) {
        const m = /^\| (\d+) \| ([^|]+) \| (\d+)×(\d+) \| ([0-9a-f]{64}) \|$/.exec(line.trim());
        if (m === null) continue;
        map.set(m[5]!, { id: Number(m[1]), path: m[2]!.trim(), width: Number(m[3]), height: Number(m[4]), sha256: m[5]! });
      }
    }
    this.mediaLogs.set(key, map);
    return map;
  }

  /** 查已读媒体：命中返回条目（含登记时的 media #id 与路径），未命中 undefined。 */
  lookupMedia(cwd: string, sha256: string): MediaLogEntry | undefined {
    return this.mediaLogFor(cwd).get(sha256);
  }

  /**
   * 登记一张已交付的图：内存去重（同 sha 只登一次，重复读走 lookupMedia 拦截），
   * 追加写 media-log.md。id 取当前最大 id + 1，进程重启后从文件续号。
   */
  recordMedia(cwd: string, entry: { path: string; width: number; height: number; sha256: string }): number {
    const map = this.mediaLogFor(cwd);
    const existing = map.get(entry.sha256);
    if (existing !== undefined) return existing.id;
    let maxId = 0;
    for (const e of map.values()) maxId = Math.max(maxId, e.id);
    const id = maxId + 1;
    map.set(entry.sha256, { id, ...entry });
    const file = join(this.baseDir, workdirKey(cwd), 'media-log.md');
    mkdirSync(dirname(file), { recursive: true });
    if (!existsSync(file)) {
      writeFileSync(file, '# 已读媒体索引（read_media 自动登记，模型可 grep 回看）\n\n| # | 源路径 | 尺寸 | sha256 |\n|---|---|---|---|\n', 'utf-8');
    }
    appendFileSync(file, `| ${id} | ${entry.path} | ${entry.width}×${entry.height} | ${entry.sha256} |\n`, 'utf-8');
    return id;
  }

  /**
   * 把 `stepref:<sha256>` 还原成 base64：按 hash 在 attachments/ 下找到附件文件（文件名带 ext，按 hash 前缀匹配）。
   * 文件缺失（被删/未落盘/传入非 stepref）返回 null，由调用方填占位。命中缓存时直接复用同一字符串对象。
   */
  rehydrate(cwd: string, stepref: string): string | null {
    if (!isStepref(stepref)) return null;
    const hash = stepref.slice(STEPREF_PREFIX.length);
    if (hash === '') return null;
    const cached = this.rehydrateCache.get(stepref);
    if (cached !== undefined) return cached;
    const dir = this.dirFor(cwd);
    if (!existsSync(dir)) return null;
    let name: string | undefined;
    try {
      name = readdirSync(dir).find((n) => n === hash || n.startsWith(`${hash}.`));
    } catch {
      return null;
    }
    if (name === undefined) return null;
    let base64: string;
    try {
      base64 = readFileSync(join(dir, name)).toString('base64');
    } catch {
      return null;
    }
    this.cacheRehydrated(stepref, base64);
    return base64;
  }

  /** 写入缓存并淘汰：先按字节预算丢最旧，再按条数丢最旧。 */
  private cacheRehydrated(stepref: string, base64: string): void {
    // 单张就超预算的图不进缓存：进了也会立刻被自己淘汰，白折腾
    if (base64.length > AttachmentStore.REHYDRATE_CACHE_MAX_BYTES) return;
    this.rehydrateCache.set(stepref, base64);
    this.rehydrateCacheBytes += base64.length;
    while (
      this.rehydrateCacheBytes > AttachmentStore.REHYDRATE_CACHE_MAX_BYTES ||
      this.rehydrateCache.size > AttachmentStore.REHYDRATE_CACHE_MAX_ENTRIES
    ) {
      const oldest = this.rehydrateCache.keys().next();
      if (oldest.done === true) break;
      const evicted = this.rehydrateCache.get(oldest.value);
      this.rehydrateCache.delete(oldest.value);
      if (evicted !== undefined) this.rehydrateCacheBytes -= evicted.length;
    }
  }

  /**
   * 贴图落盘路径查询：offload（幂等）后返回附件文件的绝对路径。
   * 小图（<OFFLOAD_THRESHOLD，未落盘、内联在消息里）返回 undefined。
   *
   * 用途：贴图提交时把路径写进发给模型的文本，模型据此可直接 read_media 重读。
   * 没有它，模型被要求「用工具重读图」时对附件位置一无所知，只能翻磁盘
   * （2026-09-13 会话实测：搜了 Pictures/Desktop/剪贴板/output-cache/sessions
   * 六轮，靠 ls 撞见 attachments/ 才找到）。
   */
  pathFor(cwd: string, base64: string, mediaType: string): string | undefined {
    const ref = this.offload(cwd, base64, mediaType);
    if (!isStepref(ref)) return undefined;
    return join(this.dirFor(cwd), `${ref.slice(STEPREF_PREFIX.length)}.${extFor(mediaType)}`);
  }
}
