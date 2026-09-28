/**
 * 终端图片渲染：PNG 解码 + sixel 编码，half-block 字符画兜底。
 *
 * 背景：pi-tui 只实现 kitty graphics 与 iTerm2 inline 两个图片协议，Windows Terminal
 * 两者都不接（实测 APC 序列与 OSC 1337 序列均被静默吞掉），WT 唯一支持的是 sixel
 * （1.22 Preview 引入、1.23 进正式版）。sixel 是像素级渲染，不受字符网格限制，是
 * WT 上的主路径；half-block（Unicode 上半块加 24bit 真彩色）不依赖任何协议，作为
 * 老终端与 sixel 编码失败时的兜底。
 *
 * 协议探测不猜终端支持什么，用两条硬证据：WT_SESSION 存在说明在 Windows Terminal
 * 里，再查 wt 版本 >= 1.22；版本查不到时按 WT_SESSION 存在处理（WT 自动更新默认
 * 开启，2024 年后版本都远超阈值），并用 STEP_CODE_IMAGE_PROTOCOL 环境变量留人工
 * 覆盖口（sixel / halfblock / off）。
 *
 * 解码器只支持 8 位深、RGB/RGBA、非交错的 PNG（截图与常见导出图的形态），其他形态
 * 或解析失败一律降级，不抛异常——渲染路径上的异常会冒泡成 uncaughtException 杀进程。
 */
import { inflateSync } from 'node:zlib';
import { spawnSync } from 'node:child_process';
import { introducer, sixelEncode, FINALIZER } from 'sixel';
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

// ---------- sixel 编码 ----------

/** sixel 调色板与索引图。 */
interface Quantized {
  palette: Uint8Array; // colors * 3
  colors: number;
  indices: Uint8Array; // width * height
}

/**
 * 中位切分量化到最多 256 色。
 *
 * 为什么不用固定调色板（web-safe 216 色）：代码截图、UI 截图这类少色图用固定调色板
 * 会把主题色偏到相邻档，文字边缘发虚；照片类两者都只能近似。中位切分对少色图接近
 * 无损，是多色图也不会比固定调色板差。15bit（5bit/channel）预合并把唯一色收敛到可
 * 枚举的规模，median cut 的桶操作才跑得动。
 */
export function quantize(img: DecodedImage, maxColors = 256): Quantized {
  const { width: w, height: h, rgb } = img;
  // 15bit 键 -> 累加器，唯一色通常几百到几千
  const buckets = new Map<number, { r: number; g: number; b: number; n: number }>();
  for (let i = 0; i < w * h; i++) {
    const r = rgb[i * 3]!;
    const g = rgb[i * 3 + 1]!;
    const b = rgb[i * 3 + 2]!;
    const key = ((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3);
    const acc = buckets.get(key);
    if (acc === undefined) {
      buckets.set(key, { r, g, b, n: 1 });
    } else {
      acc.r += r;
      acc.g += g;
      acc.b += b;
      acc.n += 1;
    }
  }

  type Box = { keys: number[]; rMin: number; rMax: number; gMin: number; gMax: number; bMin: number; bMax: number };
  const entries = [...buckets.entries()];
  const boundsOf = (keys: number[]): Omit<Box, 'keys'> => {
    let rMin = 255, rMax = 0, gMin = 255, gMax = 0, bMin = 255, bMax = 0;
    for (const key of keys) {
      const acc = buckets.get(key)!;
      rMin = Math.min(rMin, acc.r / acc.n);
      rMax = Math.max(rMax, acc.r / acc.n);
      gMin = Math.min(gMin, acc.g / acc.n);
      gMax = Math.max(gMax, acc.g / acc.n);
      bMin = Math.min(bMin, acc.b / acc.n);
      bMax = Math.max(bMax, acc.b / acc.n);
    }
    return { rMin, rMax, gMin, gMax, bMin, bMax };
  };

  let boxes: Box[] = [{ keys: entries.map(([k]) => k), ...boundsOf(entries.map(([k]) => k)) }];
  while (boxes.length < maxColors) {
    // 选最长边的桶切分
    let target = -1;
    let bestRange = 0;
    for (let i = 0; i < boxes.length; i++) {
      const box = boxes[i]!;
      if (box.keys.length < 2) continue;
      const range = Math.max(box.rMax - box.rMin, box.gMax - box.gMin, box.bMax - box.bMin);
      if (range > bestRange) {
        bestRange = range;
        target = i;
      }
    }
    if (target === -1) break; // 没有可切的桶了（唯一色少于 maxColors）
    const box = boxes[target]!;
    const channel = box.rMax - box.rMin >= box.gMax - box.gMin && box.rMax - box.rMin >= box.bMax - box.bMin
      ? 0
      : box.gMax - box.gMin >= box.bMax - box.bMin
        ? 1
        : 2;
    const sorted = [...box.keys].sort((a, b) => {
      const accA = buckets.get(a)!;
      const accB = buckets.get(b)!;
      const vA = channel === 0 ? accA.r / accA.n : channel === 1 ? accA.g / accA.n : accA.b / accA.n;
      const vB = channel === 0 ? accB.r / accB.n : channel === 1 ? accB.g / accB.n : accB.b / accB.n;
      return vA - vB;
    });
    const mid = sorted.length >> 1;
    const left = sorted.slice(0, mid);
    const right = sorted.slice(mid);
    boxes = [...boxes.slice(0, target), ...boxes.slice(target + 1), { keys: left, ...boundsOf(left) }, { keys: right, ...boundsOf(right) }];
  }

  const palette = new Uint8Array(boxes.length * 3);
  const keyToIndex = new Map<number, number>();
  boxes.forEach((box, i) => {
    let r = 0, g = 0, b = 0, n = 0;
    for (const key of box.keys) {
      const acc = buckets.get(key)!;
      r += acc.r;
      g += acc.g;
      b += acc.b;
      n += acc.n;
      keyToIndex.set(key, i);
    }
    palette[i * 3] = Math.round(r / n);
    palette[i * 3 + 1] = Math.round(g / n);
    palette[i * 3 + 2] = Math.round(b / n);
  });

  const indices = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) {
    const r = rgb[i * 3]!;
    const g = rgb[i * 3 + 1]!;
    const b = rgb[i * 3 + 2]!;
    indices[i] = keyToIndex.get(((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3))!;
  }
  return { palette, colors: boxes.length, indices };
}

/** 把量化后的索引图打包成 sixel 序列。
 *
 * 用 sixel npm 包编码：introducer(1) 生成 WT 验证过的引导段
 * （\x1bP0;1;q），sixelEncode 负责 band 数据与调色板定义。此前手写编码器在 WT 上
 * 渲染为全黑（颜色定义格式与 WT 解析器不兼容），换成熟实现消除该风险。
 *
 * sixel 包为可读性在每个 band 末尾插入 \n，但本序列作为 TUI 的单行输出，换行会把
 * 一行拆成多行、破坏光标记账，必须剥掉（band 分隔用标准的 graphics LF `-` 已足够）。
 */
export function encodeSixel(quant: Quantized, width: number, height: number): string {
  const palette: [number, number, number][] = [];
  for (let i = 0; i < quant.colors; i++) {
    palette.push([quant.palette[i * 3]!, quant.palette[i * 3 + 1]!, quant.palette[i * 3 + 2]!]);
  }
  // sixelEncode 收 RGBA8888，内部做最近色映射（含有序抖动），先把索引图还原成 RGBA
  const rgba = new Uint8Array(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    const idx = quant.indices[i]!;
    rgba[i * 4] = quant.palette[idx * 3]!;
    rgba[i * 4 + 1] = quant.palette[idx * 3 + 1]!;
    rgba[i * 4 + 2] = quant.palette[idx * 3 + 2]!;
    rgba[i * 4 + 3] = 255;
  }
  const body = sixelEncode(rgba, width, height, palette);
  return introducer(1) + body.replace(/\r?\n/g, '') + FINALIZER;
}

/**
 * 探测终端图片协议。
 *
 * WT_SESSION 存在即 Windows Terminal；wt 版本 >= 1.22 才有 sixel。版本查询失败
 * （alias 不在 PATH、输出格式变化）时按存在处理：WT 自动更新默认开启，2024 年后的
 * 版本都远高于阈值，宁可尝试也不退回字符画。STEP_CODE_IMAGE_PROTOCOL 可强制覆盖。
 */
export function detectImageProtocol(): 'sixel' | 'halfblock' {
  const override = process.env.STEP_CODE_IMAGE_PROTOCOL;
  if (override === 'sixel' || override === 'halfblock' || override === 'off') return override === 'off' ? 'halfblock' : override;
  if (process.env.WT_SESSION === undefined) return 'halfblock';
  try {
    const r = spawnSync('wt.exe', ['--version'], { encoding: 'utf8', timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'] });
    if (r.error === undefined && r.status === 0 && typeof r.stdout === 'string') {
      const m = /(\d+)\.(\d+)/.exec(r.stdout);
      if (m !== null) {
        const minor = Number.parseInt(m[2]!, 10);
        return minor >= 22 ? 'sixel' : 'halfblock';
      }
    }
  } catch {
    // 查询失败按下面默认处理
  }
  return 'sixel';
}

/**
 * 终端图片组件：sixel 优先，half-block 兜底。
 *
 * sixel 路径按终端像素宽度决定缩放（字符格宽按 9px 计）：591px 的图在 90 列终端
 * （810px）里按原尺寸渲染，不再受字符网格限制。序列占位行数按像素高 / 字符格高
 * （18px）向上取整，前 rows-1 行留空、末行上移后画，与 pi-tui Image 组件的
 * iterm2 分支同一套光标记账方式。
 */
export class ImageBlock implements Component {
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
    const lines = detectImageProtocol() === 'sixel' ? this.renderSixel(width) : this.renderHalfBlock(width);
    this.cachedLines = lines;
    this.cachedWidth = width;
    return lines;
  }

  /** sixel 路径：返回占位行，序列在末行。 */
  private renderSixel(width: number): string[] {
    const { width: w, height: h } = this.image;
    const CELL_W = 9;
    const CELL_H = 18;
    const targetWidthPx = Math.max(1, (Math.max(1, Math.min(width - 2, this.maxWidthCells))) * CELL_W);
    // 只缩不放大：小图按原尺寸，保文字可读；大图缩到终端像素宽
    const scale = Math.min(1, targetWidthPx / w);
    const pxW = Math.max(1, Math.round(w * scale));
    let pxH = Math.max(1, Math.round(h * scale));
    if (pxH % 6 !== 0) pxH += 6 - (pxH % 6); // sixel band 对齐
    const scaled: DecodedImage = scale === 1 ? this.image : resizeNearest(this.image, pxW, pxH);
    const quant = quantize(scaled);
    const sequence = encodeSixel(quant, pxW, pxH);
    const rows = Math.max(1, Math.ceil(pxH / CELL_H));
    const lines: string[] = [];
    for (let i = 0; i < rows - 1; i++) lines.push('');
    const moveUp = rows - 1 > 0 ? `\x1b[${rows - 1}A` : '';
    lines.push(moveUp + sequence);
    return lines;
  }

  /** half-block 兜底路径。 */
  private renderHalfBlock(width: number): string[] {
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
    return lines;
  }
}

/** 最近邻缩放（sixel 路径用：量化前把大图缩到终端像素宽）。 */
function resizeNearest(img: DecodedImage, targetW: number, targetH: number): DecodedImage {
  const { width: w, height: h, rgb } = img;
  const out = new Uint8Array(targetW * targetH * 3);
  for (let y = 0; y < targetH; y++) {
    const sy = Math.min(h - 1, Math.floor((y * h) / targetH));
    for (let x = 0; x < targetW; x++) {
      const sx = Math.min(w - 1, Math.floor((x * w) / targetW));
      const si = (sy * w + sx) * 3;
      const di = (y * targetW + x) * 3;
      out[di] = rgb[si]!;
      out[di + 1] = rgb[si + 1]!;
      out[di + 2] = rgb[si + 2]!;
    }
  }
  return { width: targetW, height: targetH, rgb: out };
}

