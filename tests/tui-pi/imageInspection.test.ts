/**
 * 图片预览取景逻辑测试：区域计算（居中/钳制/放大）、cropAndScale 的像素块锐利度。
 */
import { describe, expect, it } from 'vitest';
import type { DecodedImage } from '../../src/tui-pi/imageBlock.js';
import {
  fitImageCells,
  clampCenter,
  cropAndScale,
  inspectionRegion,
  previewViewportPx,
} from '../../src/tui-pi/imageInspection.js';

/** 造一张 width×height 的图：像素值 = (x*10 % 256, y*10 % 256, 128)，可逐点验证裁剪位置。 */
function solidGradient(width: number, height: number): DecodedImage {
  const rgb = new Uint8Array(width * height * 3);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 3;
      rgb[i] = (x * 10) % 256;
      rgb[i + 1] = (y * 10) % 256;
      rgb[i + 2] = 128;
    }
  }
  return { width, height, rgb };
}

const IMG = { left: 0, top: 0, width: 200, height: 100 };

describe('inspectionRegion', () => {
  it('zoom=1：区域即视口大小，中心居中', () => {
    const viewport = { left: 0, top: 0, width: 90, height: 180 };
    const r = inspectionRegion(IMG, viewport, 1, { x: 100, y: 50 });
    expect(r).toEqual({ left: 55, top: 0, width: 90, height: 100 }); // 高度不够图高，取满 100
  });

  it('zoom=2：区域为视口一半，放大 2 倍', () => {
    const viewport = { left: 0, top: 0, width: 90, height: 180 };
    const r = inspectionRegion(IMG, viewport, 2, { x: 100, y: 50 });
    expect(r.width).toBe(45); // 90 / 2
    expect(r.height).toBe(90); // min(图高 100, 180 / 2)
  });

  it('中心贴边时钳在图内（不推出左/上边界）', () => {
    const viewport = { left: 0, top: 0, width: 90, height: 90 };
    const r = inspectionRegion(IMG, viewport, 1, { x: 0, y: 0 });
    expect(r.left).toBe(0);
    expect(r.top).toBe(0);
  });

  it('中心贴右边时钳住（left + width 不超图宽）', () => {
    const viewport = { left: 0, top: 0, width: 90, height: 90 };
    const r = inspectionRegion(IMG, viewport, 1, { x: 200, y: 100 });
    expect(r.left + r.width).toBe(200);
    expect(r.top + r.height).toBe(100);
  });

  it('图比视口小：区域不超过图尺寸', () => {
    const small = { left: 0, top: 0, width: 40, height: 30 };
    const viewport = { left: 0, top: 0, width: 900, height: 900 };
    const r = inspectionRegion(small, viewport, 1, { x: 20, y: 15 });
    expect(r).toEqual({ left: 0, top: 0, width: 40, height: 30 });
  });
});

describe('clampCenter', () => {
  it('pan 后的中心落在区域中心', () => {
    const viewport = { left: 0, top: 0, width: 90, height: 90 };
    const c = clampCenter(IMG, viewport, 1, { x: 5, y: 5 });
    expect(c.x).toBe(45); // 区域 [0,90) 的中心
    expect(c.y).toBe(45);
  });
});

describe('cropAndScale', () => {
  it('1:1 裁剪逐像素复写', () => {
    const img = solidGradient(50, 40);
    const out = cropAndScale(img, { left: 10, top: 5, width: 20, height: 10 }, 20, 10);
    expect(out.width).toBe(20);
    expect(out.height).toBe(10);
    // 输出 (0,0) 对应源 (10,5)
    expect([out.rgb[0], out.rgb[1], out.rgb[2]]).toEqual([(10 * 10) % 256, (5 * 10) % 256, 128]);
    // 输出 (19,9) 对应源 (29,14)
    const last = (9 * 20 + 19) * 3;
    expect([out.rgb[last], out.rgb[last + 1], out.rgb[last + 2]]).toEqual([(29 * 10) % 256, (14 * 10) % 256, 128]);
  });

  it('2 倍放大：每个源像素是 2×2 实心块（最近邻，无渐变）', () => {
    const img = solidGradient(20, 20);
    const out = cropAndScale(img, { left: 0, top: 0, width: 10, height: 10 }, 20, 20);
    // 块 (0,0)-(1,1) 全是源 (0,0)
    for (const [dx, dy] of [[0, 0], [1, 0], [0, 1], [1, 1]] as const) {
      const i = (dy * 20 + dx) * 3;
      expect([out.rgb[i], out.rgb[i + 1], out.rgb[i + 2]]).toEqual([0, 0, 128]);
    }
    // 块 (2,0)-(3,1) 是源 (1,0)
    const i = 2 * 3;
    expect([out.rgb[i], out.rgb[i + 1], out.rgb[i + 2]]).toEqual([10, 0, 128]);
  });

  it('出界区域填黑', () => {
    const img = solidGradient(10, 10);
    const out = cropAndScale(img, { left: 5, top: 5, width: 10, height: 10 }, 10, 10);
    // 源图只有 10×10，区域 [5,15) 右/下半出界
    const i = (9 * 10 + 9) * 3;
    expect([out.rgb[i], out.rgb[i + 1], out.rgb[i + 2]]).toEqual([0, 0, 0]);
  });
});

describe('previewViewportPx', () => {
  it('字符格按 9×18px 折算', () => {
    expect(previewViewportPx(60, 20)).toEqual({ left: 0, top: 0, width: 540, height: 360 });
  });
});

describe('fitImageCells', () => {
  it('宽图：宽度顶格、高度按比例，超高时整体收缩', () => {
    const c = fitImageCells(200, 100, 60, 20); // ratio 0.5
    expect(c.cols).toBe(Math.min(60, Math.round(2 * 20 * 0.5))); // 20
    expect(c.rows).toBe(20);
  });

  it('高图：宽度顶格、高度按比例（不触上限）', () => {
    const c = fitImageCells(100, 200, 60, 20); // ratio 2 → 60 格宽、15 行
    expect(c.cols).toBe(60);
    expect(c.rows).toBe(15);
  });

  it('极端比例被钳：不返回 0 或负数', () => {
    const wide = fitImageCells(4000, 10, 60, 20);
    expect(wide.rows).toBeGreaterThanOrEqual(1);
    expect(wide.cols).toBeLessThanOrEqual(60);
    const tall = fitImageCells(10, 4000, 60, 20);
    expect(tall.cols).toBeGreaterThanOrEqual(1);
    expect(tall.rows).toBeLessThanOrEqual(20);
  });

  it('格宽高比经系数 2 换算后与像素宽高比一致（不变形）', () => {
    const c = fitImageCells(300, 150, 40, 30); // ratio 0.5 → 触 30 行上限
    expect(c.rows).toBe(30);
    expect(c.cols).toBe(Math.min(40, Math.round(2 * 30 * 0.5))); // 30
    expect((c.cols / c.rows) / 2).toBeCloseTo(150 / 300, 1); // 0.5
  });
});
