/**
 * 图片区域登记测试：Transcript 把 sixel 序列行登记成文档行区域表，
 * 供预览浮层把鼠标点击行换算命中。覆盖单图/多图/降级/无图/缓存稳定性。
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { DisplayItem } from '../../src/chat/types.js';
import { Transcript } from '../../src/tui-pi/Transcript.js';

/** 8x6 四色块 PNG（与 imageBlock.test.ts 同图）。 */
const PNG_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAgAAAAGCAIAAABxZ0isAAAAJElEQVR4nGN8ZunGAAPmfwThbCY4Cw3glGD8//8/gsPISIFRAFoTBbTJYCKiAAAAAElFTkSuQmCC';

const image = (id: number) => ({
  id,
  base64: PNG_B64,
  mediaType: 'image/png',
  width: 8,
  height: 6,
  placeholder: `[image #${id}]`,
});

const userWithImages = (text: string, images: DisplayItem extends { images?: infer I } ? I : never): DisplayItem =>
  ({ kind: 'user', text, images } as DisplayItem);

afterEach(() => {
  delete process.env.STEP_CODE_IMAGE_PROTOCOL;
});

const W = 80;

describe('Transcript 图片区域登记', () => {
  it('单图：登记一条区域，占位区与序列行都可命中，区间外不命中', () => {
    const t = new Transcript();
    t.push(userWithImages('看图', [image(1)] as never));
    const lines = t.render(W);
    const regions = t.imageRegions();
    expect(regions).toHaveLength(1);
    const r = regions[0]!;
    // 区域在产物行数范围内
    expect(r.docRow).toBeLessThan(lines.length);
    expect(r.startRow).toBeLessThanOrEqual(r.docRow);
    // 序列行与占位行都命中
    expect(t.imageRegionAt(r.docRow)).toBe(r);
    expect(t.imageRegionAt(r.startRow)).toBe(r);
    // 区间外不命中
    expect(t.imageRegionAt(r.docRow + 1)).toBeUndefined();
    expect(t.imageRegionAt(r.startRow - 1)).toBeUndefined();
  });

  it('命中区域能取回原图：blockIdx/imgIdx 对应 images 数组', () => {
    const t = new Transcript();
    t.push({ kind: 'user', text: '看图', images: [image(7)] } as DisplayItem);
    t.render(W);
    const r = t.imageRegionAt(t.imageRegions()[0]!.docRow)!;
    const item = t.items()[r.blockIdx]!;
    expect(item.kind).toBe('user');
    expect(item.kind === 'user' && item.images![r.imgIdx]!.id).toBe(7);
  });

  it('多图：按文档顺序登记两条区域，imgIdx 各自正确', () => {
    const t = new Transcript();
    t.push({ kind: 'user', text: '两图', images: [image(1), image(2)] } as DisplayItem);
    t.render(W);
    const regions = t.imageRegions();
    expect(regions).toHaveLength(2);
    expect(regions.map((r) => r.imgIdx)).toEqual([0, 1]);
    // 第一条在第二条之前，且不重叠
    expect(regions[0]!.docRow).toBeLessThan(regions[1]!.startRow);
    // 两条各自命中
    expect(t.imageRegionAt(regions[0]!.docRow)!.imgIdx).toBe(0);
    expect(t.imageRegionAt(regions[1]!.docRow)!.imgIdx).toBe(1);
  });

  it('降级图（坏 base64）不进区域表', () => {
    const t = new Transcript();
    t.push({ kind: 'user', text: '坏图', images: [{ ...image(1), base64: 'not-a-png' }] } as DisplayItem);
    t.render(W);
    expect(t.imageRegions()).toHaveLength(0);
  });

  it('无图 user 块与其它块：空表', () => {
    const t = new Transcript();
    t.push({ kind: 'user', text: '纯文本' });
    t.push({ kind: 'note', text: '备注' });
    t.render(W);
    expect(t.imageRegions()).toHaveLength(0);
  });

  it('缓存稳定性：连续两帧 regions 内容一致（前缀/整体缓存不丢区域）', () => {
    const t = new Transcript();
    t.push({ kind: 'user', text: '旧图', images: [image(1)] } as DisplayItem);
    t.push({ kind: 'note', text: '后续内容' });
    t.render(W);
    const first = t.imageRegions();
    t.render(W); // 缓存命中帧
    expect(t.imageRegions()).toEqual(first);
    // 尾块流式更新后再渲：区域仍在
    t.update(-1, { kind: 'note', text: '后续内容2' });
    t.render(W);
    expect(t.imageRegions()).toEqual(first);
  });

  it('sixel 强制路径：序列行含 DCS 引导段（补丁后 isImageLine 识别的那一行）', () => {
    process.env.STEP_CODE_IMAGE_PROTOCOL = 'sixel';
    const t = new Transcript();
    t.push({ kind: 'user', text: '看图', images: [image(1)] } as DisplayItem);
    const lines = t.render(W);
    const r = t.imageRegions()[0]!;
    expect(lines[r.docRow]).toContain('\x1bP0;1;q');
  });
});
