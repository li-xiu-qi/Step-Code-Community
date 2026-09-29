import { describe, it, expect } from 'vitest';
import { Decoder } from 'sixel';
import { quantize, encodeSixel, type DecodedImage } from '../../src/tui-pi/imageBlock.js';

/**
 * 这些用例不靠人眼：把我们生成的 sixel 字节喂给一个独立的真实 sixel 解码器
 * （@xterm/addon-image 同源的 sixel 内核），直接断言解码出的像素。
 *
 * 覆盖的正是真机上「图塌成一条 / 时而正常」的两类根因：
 *  - 每条按行切片的序列必须独立可解码且像素正确（旧的「首行放整图、后续空占位」
 *    设计在某行被 `\x1b[2K` 重写时整图被擦）；
 *  - 每条序列必须带完整 ST，无截断（库层不认 DCS 会按宽度把尾块序列切残）。
 */

function makeQuadImage(): DecodedImage {
  const W = 36;
  const H = 30;
  const rgb = new Uint8Array(W * H * 3);
  const regions = [
    { x0: 0, y0: 0, x1: 18, y1: 15, c: [220, 30, 30] },
    { x0: 18, y0: 0, x1: 36, y1: 15, c: [30, 200, 60] },
    { x0: 0, y0: 15, x1: 18, y1: 30, c: [40, 80, 230] },
    { x0: 18, y0: 15, x1: 36, y1: 30, c: [240, 220, 40] },
  ];
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const r = regions.find((g) => x >= g.x0 && x < g.x1 && y >= g.y0 && y < g.y1)!;
      const i = (y * W + x) * 3;
      rgb[i] = r.c[0];
      rgb[i + 1] = r.c[1];
      rgb[i + 2] = r.c[2];
    }
  }
  return { width: W, height: H, rgb };
}

const CELL_H = 18;

function decodeStrip(seq: string): { w: number; h: number; data: Uint32Array } {
  const d = new Decoder();
  d.init();
  d.decodeString(seq);
  return { w: d.width, h: d.height, data: d.data32 };
}

const rgbOf = (u32: number): [number, number, number] => [
  u32 & 0xff,
  (u32 >>> 8) & 0xff,
  (u32 >>> 16) & 0xff,
];

describe('sixel 像素级往返（独立解码器，非人眼）', () => {
  const img = makeQuadImage();
  const quant = quantize(img);

  it('整图单条序列可解码为原始尺寸，四个色块颜色正确', () => {
    const whole = encodeSixel(quant, img.width, img.height, 0, img.height);
    const c = decodeStrip(whole);
    expect(c.w).toBe(img.width);
    expect(c.h).toBe(img.height);

    const near = (a: number, b: number): boolean => Math.abs(a - b) <= 12;
    const tl = rgbOf(c.data[7 * c.w + 9]!);
    const tr = rgbOf(c.data[7 * c.w + 27]!);
    const bl = rgbOf(c.data[22 * c.w + 9]!);
    const br = rgbOf(c.data[22 * c.w + 27]!);
    expect(tl.every((v, i) => near(v, [220, 30, 30][i]!))).toBe(true);
    expect(tr.every((v, i) => near(v, [30, 200, 60][i]!))).toBe(true);
    expect(bl.every((v, i) => near(v, [40, 80, 230][i]!))).toBe(true);
    expect(br.every((v, i) => near(v, [240, 220, 40][i]!))).toBe(true);
  });

  it('按 18px 字符行切片：每条独立序列解码出自己那段，像素与原图对应位置一致', () => {
    const strips: string[] = [];
    for (let y = 0; y < img.height; y += CELL_H) {
      strips.push(encodeSixel(quant, img.width, img.height, y, Math.min(img.height, y + CELL_H)));
    }
    expect(strips.length).toBe(2);

    const canvases = strips.map(decodeStrip);

    // 带0：上半部分（红/绿），在带内局部坐标 y=7
    const band0 = canvases[0]!;
    expect(rgbOf(band0.data[7 * band0.w + 9]!)[0]).toBeGreaterThan(180); // 红
    expect(rgbOf(band0.data[7 * band0.w + 27]!)[1]).toBeGreaterThan(150); // 绿

    // 带1：下半部分（蓝/黄）
    const band1 = canvases[1]!;
    expect(rgbOf(band1.data[7 * band1.w + 9]!)[2]).toBeGreaterThan(180); // 蓝
    expect(rgbOf(band1.data[7 * band1.w + 27]!)[0]).toBeGreaterThan(200); // 黄
    expect(rgbOf(band1.data[7 * band1.w + 27]!)[1]).toBeGreaterThan(180);
  });

  it('每条切片序列都以 ST 完整结尾，没有被按宽度截断', () => {
    const ST = String.fromCharCode(27) + String.fromCharCode(92);
    for (let y = 0; y < img.height; y += CELL_H) {
      const seq = encodeSixel(quant, img.width, img.height, y, Math.min(img.height, y + CELL_H));
      expect(seq.endsWith(ST)).toBe(true);
    }
  });
});
