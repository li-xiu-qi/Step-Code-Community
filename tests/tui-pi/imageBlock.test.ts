/**
 * 终端图片渲染测试：PNG 解码器与 half-block 组件。
 *
 * 不跑真实终端渲染（那需要在真机看字符画），钉住可离线验证的部分：
 * 解码器的逐像素正确性与失败降级、组件的网格结构与缓存行为。
 */
import { describe, expect, it } from 'vitest';
import { decodePNG, HalfBlockImage } from '../../src/tui-pi/imageBlock.js';

/** 8x6 四色块 PNG：左上红(230,57,70)、右上深蓝(29,53,87)、左下白、右下黑。 */
const PNG_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAgAAAAGCAIAAABxZ0isAAAAJElEQVR4nGN8ZunGAAPmfwThbCY4Cw3glGD8//8/gsPISIFRAFoTBbTJYCKiAAAAAElFTkSuQmCC';

describe('decodePNG', () => {
  it('解码 8x6 四色块，四角颜色与尺寸正确', () => {
    const img = decodePNG(Buffer.from(PNG_B64, 'base64'));
    expect(img).not.toBeNull();
    expect(img!.width).toBe(8);
    expect(img!.height).toBe(6);
    expect(img!.rgb.length).toBe(8 * 6 * 3);
    const at = (x: number, y: number): number[] => [
      img!.rgb[(y * 8 + x) * 3]!,
      img!.rgb[(y * 8 + x) * 3 + 1]!,
      img!.rgb[(y * 8 + x) * 3 + 2]!,
    ];
    expect(at(0, 0)).toEqual([230, 57, 70]);
    expect(at(7, 0)).toEqual([29, 53, 87]);
    expect(at(0, 5)).toEqual([255, 255, 255]);
    expect(at(7, 5)).toEqual([0, 0, 0]);
  });

  it('非 PNG 输入返回 null，不抛异常', () => {
    expect(decodePNG(Buffer.from('this is not a png at all'))).toBeNull();
  });

  it('截断的 PNG 返回 null，不抛异常', () => {
    const buf = Buffer.from(PNG_B64, 'base64');
    expect(decodePNG(buf.subarray(0, 40))).toBeNull();
  });

  it('空 buffer 返回 null', () => {
    expect(decodePNG(Buffer.alloc(0))).toBeNull();
  });
});

describe('HalfBlockImage', () => {
  const decoded = decodePNG(Buffer.from(PNG_B64, 'base64'))!;

  it('字符网格保持宽高比，每行 cell 数一致', () => {
    const comp = new HalfBlockImage(decoded, 6);
    const lines = comp.render(8); // width - 2 = 6 列
    expect(lines.length).toBe(3); // 8x6 缩到 6 列 -> 6 像素高 -> 3 字符行
    const cellRe = /\x1b\[38;2;(\d+);(\d+);(\d+)m\x1b\[48;2;(\d+);(\d+);(\d+)m\u2580/g;
    for (const line of lines) {
      const cells = [...line.matchAll(cellRe)];
      expect(cells.length).toBe(6);
      expect(line.endsWith('\x1b[0m')).toBe(true);
    }
  });

  it('左上区域前景偏红、右下区域背景偏黑', () => {
    const comp = new HalfBlockImage(decoded, 6);
    const lines = comp.render(8);
    const firstCell = /\x1b\[38;2;(\d+);(\d+);(\d+)m/.exec(lines[0]!)!;
    const r = Number(firstCell[1]);
    const g = Number(firstCell[2]);
    expect(r).toBeGreaterThan(180);
    expect(g).toBeLessThan(100);
    const lastLine = lines[lines.length - 1]!;
    const cells = [...lastLine.matchAll(/\x1b\[48;2;(\d+);(\d+);(\d+)m/g)];
    const lastBg = cells[cells.length - 1]!;
    expect(Number(lastBg[1])).toBeLessThan(60); // 右下角是黑色块
  });

  it('同宽度重复 render 返回同一缓存引用', () => {
    const comp = new HalfBlockImage(decoded, 6);
    const first = comp.render(8);
    const second = comp.render(8);
    expect(second).toBe(first);
  });

  it('宽度变化时重新计算', () => {
    const comp = new HalfBlockImage(decoded, 18);
    const narrow = comp.render(8); // 6 列
    const wide = comp.render(20); // 18 列
    expect(wide).not.toBe(narrow);
    expect(wide.length).toBeGreaterThan(narrow.length);
  });
});
