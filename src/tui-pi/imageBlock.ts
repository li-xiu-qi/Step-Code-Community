/**
 * 终端图片渲染：PNG 解码 + half-block 字符画。
 *
 * 背景：pi-tui 只实现 kitty graphics 与 iTerm2 inline 两个图片协议，Windows Terminal
 * 两者都不接（实测 APC 序列与 OSC 1337 序列均被静默吞掉），WT 唯一支持的是 sixel
 * （1.22 Preview 引入、1.23 进正式版）。本模块先走不依赖任何图片协议的路线：把 PNG
 * 解码成 RGB 像素，用 Unicode 上半块（U+2580）加 24bit 真彩色合成字符画，任何支持
 * truecolor 的终端（含 WT）都能显示。sixel 作为后续增强，落地后本模块降级为它的
 * 兜底路径。
 *
 * 解码器只支持 8 位深、RGB/RGBA、非交错的 PNG（截图与常见导出图的形态），其他形态
 * 或解析失败一律返回 null，由调用方降级为文本提示，不抛异常——渲染路径上的异常会
 * 冒泡成 uncaughtException 直接杀进程。
 *
 * 采样用双线性插值：字符网格对源图通常是数倍降采样，最近邻在渐变与细边上锯齿明显。
 */
import { inflateSync } from 'node:zlib';
import type { Component } from '@earendil-works/pi-tui';

export interface DecodedImage {
  width: number;
  height: number;
  /** width * height * 3，行优先 RGB。 */
  rgb: Uint8Array;
}

/** 单张图参与渲染的像素上限：超出走文本降级，防解码内存与每帧字符量爆炸。 */
export const MAX_RENDER_PIXELS = 4_000_000;
/** 单边像素上限：防畸形 header 声明巨大尺寸骗分配。 */
const MAX_RENDER_EDGE = 8192;

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

/**
 * 解码 PNG 为 RGB 像素。失败返回 null 而非抛错。
 *
 * 逐行反 filter（None/Sub/Up/Average/Paeth），IDAT 可能分多个 chunk 需拼接后一次
 * inflate。只实现渲染所需的最小集：8bit、colorType 2/6、非交错。
 */
export function decodePNG(buffer: Buffer): DecodedImage | null {
  try {
    const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
    for (let i = 0; i < 8; i++) {
      if (buffer[i] !== sig[i]) return null;
    }
    let offset = 8;
    let width = 0;
    let height = 0;
    let bitDepth = 0;
    let colorType = 0;
    const idat: Buffer[] = [];
    while (offset + 8 <= buffer.length) {
      const length = buffer.readUInt32BE(offset);
      const type = buffer.toString('ascii', offset + 4, offset + 8);
      const data = buffer.subarray(offset + 8, offset + 8 + length);
      if (type === 'IHDR') {
        if (length < 13) return null;
        width = data.readUInt32BE(0);
        height = data.readUInt32BE(4);
        bitDepth = data[8]!;
        colorType = data[9]!;
        if (data[12] !== 0) return null; // 交错式不支持
      } else if (type === 'IDAT') {
        idat.push(Buffer.from(data));
      } else if (type === 'IEND') {
        break;
      }
      offset += 12 + length;
    }
    if (bitDepth !== 8) return null;
    if (colorType !== 2 && colorType !== 6) return null;
    if (width === 0 || height === 0) return null;
    if (width > MAX_RENDER_EDGE || height > MAX_RENDER_EDGE) return null;
    if (width * height > MAX_RENDER_PIXELS) return null;

    const bpp = colorType === 6 ? 4 : 3;
    const raw = inflateSync(Buffer.concat(idat));
    const stride = width * bpp;
    if (raw.length < height * (stride + 1)) return null;
    const rgb = new Uint8Array(width * height * 3);
    const prevLine = new Uint8Array(stride);
    const curLine = new Uint8Array(stride);

    for (let y = 0; y < height; y++) {
      const filter = raw[y * (stride + 1)]!;
      const lineStart = y * (stride + 1) + 1;
      for (let i = 0; i < stride; i++) {
        const x = raw[lineStart + i]!;
        const left = i >= bpp ? curLine[i - bpp]! : 0;
        const up = prevLine[i]!;
        const upLeft = i >= bpp ? prevLine[i - bpp]! : 0;
        let value: number;
        switch (filter) {
          case 0: value = x; break;
          case 1: value = x + left; break;
          case 2: value = x + up; break;
          case 3: value = x + ((left + up) >> 1); break;
          case 4: value = x + paeth(left, up, upLeft); break;
          default: return null;
        }
        curLine[i] = value & 0xff;
      }
      for (let px = 0; px < width; px++) {
        rgb[(y * width + px) * 3] = curLine[px * bpp]!;
        rgb[(y * width + px) * 3 + 1] = curLine[px * bpp + 1]!;
        rgb[(y * width + px) * 3 + 2] = curLine[px * bpp + 2]!;
      }
      prevLine.set(curLine);
    }
    return { width, height, rgb };
  } catch {
    return null;
  }
}

/** 双线性采样源图像素坐标 (fx, fy) 处的颜色。 */
function sampleBilinear(img: DecodedImage, fx: number, fy: number): [number, number, number] {
  const { width: w, height: h, rgb } = img;
  const x0 = Math.max(0, Math.min(w - 1, Math.floor(fx)));
  const y0 = Math.max(0, Math.min(h - 1, Math.floor(fy)));
  const x1 = Math.min(w - 1, x0 + 1);
  const y1 = Math.min(h - 1, y0 + 1);
  const dx = Math.max(0, Math.min(1, fx - x0));
  const dy = Math.max(0, Math.min(1, fy - y0));
  const out: [number, number, number] = [0, 0, 0];
  for (let c = 0; c < 3; c++) {
    const p00 = rgb[(y0 * w + x0) * 3 + c]!;
    const p10 = rgb[(y0 * w + x1) * 3 + c]!;
    const p01 = rgb[(y1 * w + x0) * 3 + c]!;
    const p11 = rgb[(y1 * w + x1) * 3 + c]!;
    const top = p00 + (p10 - p00) * dx;
    const bottom = p01 + (p11 - p01) * dx;
    out[c] = Math.round(top + (bottom - top) * dy);
  }
  return out;
}

/**
 * half-block 图片组件：一个字符行覆盖 2 个像素行，前景色画上半块、背景色透出下半块。
 *
 * 走 pi-tui 的 Component 接口与差分渲染管线，父容器按普通行数组消费。字符网格保持
 * 源图宽高比：1 列 = 1 像素宽，1 字符行 = 2 像素行。
 */
export class HalfBlockImage implements Component {
  private cachedLines?: string[];
  private cachedWidth?: number;
  private readonly image: DecodedImage;
  private readonly maxWidthCells: number;

  constructor(image: DecodedImage, maxWidthCells: number) {
    this.image = image;
    this.maxWidthCells = maxWidthCells;
  }

  /** 父容器内容更换时调用：清行缓存，下次 render 按新宽度重算。 */
  invalidate(): void {
    this.cachedLines = undefined;
    this.cachedWidth = undefined;
  }

  render(width: number): string[] {
    if (this.cachedLines !== undefined && this.cachedWidth === width) return this.cachedLines;

    const { width: w, height: h } = this.image;
    const targetCols = Math.max(1, Math.min(width - 2, this.maxWidthCells));
    let pixelHeight = Math.max(2, Math.round((h * targetCols) / w));
    if (pixelHeight % 2 === 1) pixelHeight += 1; // 偶数才能整对切半块
    const targetRows = pixelHeight / 2;

    const lines: string[] = [];
    for (let row = 0; row < targetRows; row++) {
      const parts: string[] = [];
      for (let col = 0; col < targetCols; col++) {
        // 像素中心对齐的源图坐标，避免采样点系统性偏移半格
        const fx = ((col + 0.5) * w) / targetCols - 0.5;
        const fyTop = ((row * 2 + 0.5) * h) / pixelHeight - 0.5;
        const fyBottom = ((row * 2 + 1.5) * h) / pixelHeight - 0.5;
        const [r1, g1, b1] = sampleBilinear(this.image, fx, fyTop);
        const [r2, g2, b2] = sampleBilinear(this.image, fx, fyBottom);
        parts.push(`\x1b[38;2;${r1};${g1};${b1}m\x1b[48;2;${r2};${g2};${b2}m\u2580`);
      }
      parts.push('\x1b[0m');
      lines.push(parts.join(''));
    }

    this.cachedLines = lines;
    this.cachedWidth = width;
    return lines;
  }
}
