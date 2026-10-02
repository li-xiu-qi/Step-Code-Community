import { beforeEach, describe, expect, it } from 'vitest';

import {
  imageUrlInternHasForTests,
  imageUrlInternSizeForTests,
  internImageUrl,
  messagesToOpenAi,
  resetImageUrlInternForTests,
} from '../../src/provider/openaiCommon.ts';

/**
 * 翻译层图片 url 字符串 intern 的判据。
 *
 * 这些断言锁的是「同一张图的 url 字符串在进程内只有一个对象，且 intern 集合有界」。
 * 没有这个 intern，OpenAI 翻译层每轮请求对含图 history 全量重建一份 url 字符串，
 * 长会话随轮数线性膨胀（2026-09-26 堆快照实测：同一张截图 431 份、图片 base64
 * 占堆 90%）。
 *
 * 淘汰语义的断言查 map 成员而不是引用身份：Node 24 的 V8 对相同内容的模板拼接
 * 字符串会在构造路径上共享引用（实测），「命中复用」路径无法用引用身份探针验证
 * （把 intern 的 get 命中删掉测试依然绿——引擎已经替它共享了），只能以 map 成员
 * 与内容断言为准。
 */
describe('internImageUrl', () => {
  beforeEach(() => resetImageUrlInternForTests());

  it('同 data 同 mediaType 重复调用只 intern 一条，且 url 内容正确', () => {
    const a = internImageUrl('image/png', 'AAAABBBB');
    for (let i = 0; i < 100; i++) internImageUrl('image/png', 'AAAABBBB');
    expect(a).toBe('data:image/png;base64,AAAABBBB');
    expect(imageUrlInternSizeForTests()).toBe(1);
    expect(imageUrlInternHasForTests('image/png', 'AAAABBBB')).toBe(true);
  });

  it('同 data 不同 mediaType 产出不同的 url 内容（MIME 是 key 的一部分）', () => {
    const png = internImageUrl('image/png', 'AAAABBBB');
    const jpeg = internImageUrl('image/jpeg', 'AAAABBBB');
    expect(png.startsWith('data:image/png;base64,')).toBe(true);
    expect(jpeg.startsWith('data:image/jpeg;base64,')).toBe(true);
    expect(imageUrlInternSizeForTests()).toBe(2);
  });

  it('messagesToOpenAi 翻译同一块两次，产出的 url 内容一致且 intern 只有一条', () => {
    const block = {
      role: 'user' as const,
      content: [
        { type: 'image' as const, source: { type: 'base64' as const, media_type: 'image/png', data: 'CCCCDDDD' } },
        { type: 'text' as const, text: '看图' },
      ],
    };
    const first = messagesToOpenAi('', [block], false);
    const second = messagesToOpenAi('', [block], false);
    const urlOf = (msgs: ReturnType<typeof messagesToOpenAi>): string => {
      const parts = (msgs[0]!.content as Array<{ type: string; image_url?: { url: string } }>)
        .filter((p) => p.type === 'image_url');
      return parts[0]!.image_url!.url;
    };
    expect(urlOf(second)).toBe(urlOf(first));
    expect(urlOf(second)).toBe('data:image/png;base64,CCCCDDDD');
    expect(imageUrlInternSizeForTests()).toBe(1);
  });

  it('条数上限 64：第 65 条插入后最旧一条被淘汰', () => {
    internImageUrl('image/png', 'ENTRY_0');
    for (let i = 1; i <= 64; i++) internImageUrl('image/png', `ENTRY_${i}`);
    expect(imageUrlInternSizeForTests()).toBe(64);
    expect(imageUrlInternHasForTests('image/png', 'ENTRY_0')).toBe(false);
    expect(imageUrlInternHasForTests('image/png', 'ENTRY_64')).toBe(true);
  });

  it('字节预算 32MB：插入超预算后最旧被淘汰', () => {
    // JS 字符串按 UTF-16 计（length * 2 字节）。两条 9M 字符 = 36MB，超 32MB 预算。
    const big1 = 'A'.repeat(9 * 1024 * 1024);
    const big2 = 'B'.repeat(9 * 1024 * 1024);
    internImageUrl('image/png', big1);
    internImageUrl('image/png', big2);
    expect(imageUrlInternHasForTests('image/png', big1)).toBe(false);
    expect(imageUrlInternHasForTests('image/png', big2)).toBe(true);
  });

  it('单条就超预算的图不进 intern（避免自己淘汰自己的空转）', () => {
    const huge = 'Z'.repeat(20 * 1024 * 1024); // 40MB，单条超预算
    internImageUrl('image/png', huge);
    expect(imageUrlInternHasForTests('image/png', huge)).toBe(false);
    expect(imageUrlInternSizeForTests()).toBe(0);
  });
});
