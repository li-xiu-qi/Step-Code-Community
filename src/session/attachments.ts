import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
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
