import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AttachmentStore, OFFLOAD_THRESHOLD, isStepref, STEPREF_PREFIX } from '../../src/session/attachments.js';
import { workdirKey } from '../../src/session/store.js';

let base: string;
let store: AttachmentStore;
const cwd = 'C:/some/project';

/** 生成长度 ≥ 阈值的规范 base64（可干净往返）。 */
function bigBase64(bytes = 4000): string {
  return Buffer.alloc(bytes, 7).toString('base64');
}

function attachmentsDir(): string {
  return join(base, workdirKey(cwd), 'attachments');
}

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'stepcode-att-'));
  store = new AttachmentStore(base);
});

afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

describe('AttachmentStore', () => {
  it('offload → rehydrate 往返一致', () => {
    const b64 = bigBase64();
    expect(b64.length).toBeGreaterThanOrEqual(OFFLOAD_THRESHOLD);
    const ref = store.offload(cwd, b64, 'image/png');
    expect(isStepref(ref)).toBe(true);
    expect(ref.startsWith(STEPREF_PREFIX)).toBe(true);
    expect(store.rehydrate(cwd, ref)).toBe(b64);
  });

  it('文件按 <sha256>.<ext> 命名，ext 由 mediaType 推', () => {
    const ref = store.offload(cwd, bigBase64(), 'image/png');
    const hash = ref.slice(STEPREF_PREFIX.length);
    const names = readdirSync(attachmentsDir());
    expect(names).toEqual([`${hash}.png`]);
  });

  it('hash 去重：同内容多次 offload 只写一份文件、返回同 stepref', () => {
    const b64 = bigBase64();
    const r1 = store.offload(cwd, b64, 'image/png');
    const r2 = store.offload(cwd, b64, 'image/png');
    expect(r1).toBe(r2);
    expect(readdirSync(attachmentsDir())).toHaveLength(1);
  });

  it('阈值：payload < 4KB 的小图不 offload、原样内联、不建文件', () => {
    const small = Buffer.alloc(100, 1).toString('base64');
    expect(small.length).toBeLessThan(OFFLOAD_THRESHOLD);
    const ref = store.offload(cwd, small, 'image/png');
    expect(ref).toBe(small);
    expect(isStepref(ref)).toBe(false);
    expect(existsSync(attachmentsDir())).toBe(false);
  });

  it('已是 stepref 时 offload 幂等返回', () => {
    const ref = store.offload(cwd, bigBase64(), 'image/png');
    expect(store.offload(cwd, ref, 'image/png')).toBe(ref);
  });

  it('缺失文件 rehydrate 返回 null', () => {
    // 从未 offload 过的 hash
    expect(store.rehydrate(cwd, `${STEPREF_PREFIX}${'a'.repeat(64)}`)).toBeNull();
    // offload 后删掉文件
    const ref = store.offload(cwd, bigBase64(), 'image/png');
    rmSync(attachmentsDir(), { recursive: true, force: true });
    expect(store.rehydrate(cwd, ref)).toBeNull();
  });

  it('非 stepref 输入 rehydrate 返回 null', () => {
    expect(store.rehydrate(cwd, 'not-a-ref')).toBeNull();
    expect(store.rehydrate(cwd, STEPREF_PREFIX)).toBeNull();
  });

  it('per-workdir 分桶：不同 cwd 落到不同附件目录', () => {
    const b64 = bigBase64();
    store.offload(cwd, b64, 'image/png');
    store.offload('D:/other', b64, 'image/png');
    expect(readdirSync(join(base, workdirKey(cwd), 'attachments'))).toHaveLength(1);
    expect(readdirSync(join(base, workdirKey('D:/other'), 'attachments'))).toHaveLength(1);
  });
});

/**
 * rehydrate 缓存（2026-09-27 加）。动机是一次真实事故的堆快照：3.2GB 堆里 2688MB 是
 * base64 图片串，同一张图复制了 431 份。原因是 resume 出来的会话里图片全是 stepref 指针，
 * 而 toWire 每调一次（runTurn 有 7 个 provider.stream 调用点 + advisor）都把全历史的图
 * 重新读盘转 base64；字符串在 V8 里不做内容去重，于是每次调用都产生新的独立字符串对象。
 */
describe('AttachmentStore.rehydrate 缓存', () => {
  it('重复 rehydrate 返回同一个字符串对象（=== 而不只是相等）', () => {
    const ref = store.offload(cwd, bigBase64(), 'image/png');
    const a = store.rehydrate(cwd, ref);
    const b = store.rehydrate(cwd, ref);
    // 这一条就是修复的核心判据：相等不够，必须是同一对象，堆里才不会出现第二份
    expect(a).toBe(b);
    expect(a).toBe(store.rehydrate(cwd, ref));
  });

  it('不同 stepref 互不串味', () => {
    const r1 = store.offload(cwd, bigBase64(4000), 'image/png');
    const r2 = store.offload(cwd, bigBase64(6000), 'image/png');
    expect(store.rehydrate(cwd, r1)).not.toBe(store.rehydrate(cwd, r2));
    expect(store.rehydrate(cwd, r1)).toBe(store.rehydrate(cwd, r1));
  });

  it('文件被外部删掉后：缓存命中仍返回原值，未缓存的返回 null', () => {
    const ref = store.offload(cwd, bigBase64(), 'image/png');
    store.rehydrate(cwd, ref); // 先 warm 缓存
    rmSync(attachmentsDir(), { recursive: true, force: true });
    // 缓存命中不读盘，所以仍拿得到——这正是它省掉重复 IO 的原因
    expect(store.rehydrate(cwd, ref)).not.toBeNull();
    // 没进过缓变的 hash 读不到文件，照旧 null
    expect(store.rehydrate(cwd, `${STEPREF_PREFIX}${'b'.repeat(64)}`)).toBeNull();
  });

  it('缓存有字节预算：塞满后仍能正确返回，不会把缓存本身撑成内存大户', () => {
    // 每张约 5.3KB base64，灌 200 张必然超 32MB 预算，触发多轮淘汰
    const refs: string[] = [];
    for (let i = 0; i < 200; i++) {
      const b64 = Buffer.alloc(4000, i % 251).toString('base64');
      refs.push(store.offload(cwd, b64, 'image/png'));
    }
    for (const r of refs) expect(store.rehydrate(cwd, r)).not.toBeNull();
    // 淘汰之后第一次取会重新读盘，第二次才是同一对象
    const first = store.rehydrate(cwd, refs[0]!);
    expect(store.rehydrate(cwd, refs[0]!)).toBe(first);
  });
});

describe('AttachmentStore.pathFor', () => {
  it('大图 offload 后返回附件绝对路径，且路径存在', () => {
    const b64 = bigBase64();
    const p = store.pathFor(cwd, b64, 'image/png');
    expect(typeof p).toBe('string');
    expect(existsSync(p!)).toBe(true);
    // 路径形如 <base>/<workdirKey>/attachments/<sha256>.png
    expect(p!.endsWith('.png')).toBe(true);
    expect(p!.startsWith(attachmentsDir())).toBe(true);
  });

  it('幂等：同内容两次 pathFor 返回同一路径、不重复写文件', () => {
    const b64 = bigBase64();
    const p1 = store.pathFor(cwd, b64, 'image/png');
    const p2 = store.pathFor(cwd, b64, 'image/png');
    expect(p1).toBe(p2);
    expect(readdirSync(attachmentsDir())).toHaveLength(1);
  });

  it('路径内容与 offload 结果一致：rehydrate(offload) 字节等于 pathFor 落盘文件', () => {
    const b64 = bigBase64(5000);
    const p = store.pathFor(cwd, b64, 'image/jpeg');
    const ref = store.offload(cwd, b64, 'image/jpeg');
    expect(store.rehydrate(cwd, ref)).toBe(b64);
    expect(p!.endsWith('.jpeg')).toBe(true);
    expect(readFileSync(p!).toString('base64')).toBe(b64);
  });

  it('小图（<阈值）返回 undefined、不建目录', () => {
    const small = Buffer.alloc(100, 1).toString('base64');
    expect(store.pathFor(cwd, small, 'image/png')).toBeUndefined();
    expect(existsSync(attachmentsDir())).toBe(false);
  });
});
