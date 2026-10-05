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
 * 解码走 decodeImage 按魔数分发：PNG（8 位深、RGB/RGBA、非交错）用内置解码器，
 * JPEG 用 jpeg-js（纯 JS 同步）；gif/bmp/webp 暂无解码器。不支持的形态或解析失败
 * 一律降级，不抛异常——渲染路径上的异常会冒泡成 uncaughtException 杀进程。
 */
import { inflateSync } from 'node:zlib';
import { spawnSync } from 'node:child_process';
import { decode as jpegDecode } from 'jpeg-js';
import { introducer, FINALIZER } from 'sixel';
import type { Component } from '@earendil-works/pi-tui';
import { isStepref } from '../session/attachments.js';
import type { ToolResultImage } from '../tools/types.js';

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

/**
 * 解码 JPEG 为 RGB 像素（jpeg-js，纯 JS 同步解码）。失败返回 null 而非抛错。
 *
 * jpeg-js 输出 RGBA（含 alpha 通道），转成 DecodedImage 约定的 RGB 三通道。
 * maxMemoryUsageInMB 防畸形文件骗分配；解码后再过统一的像素/单边预算。
 */
function decodeJPEG(buffer: Buffer): DecodedImage | null {
  try {
    const raw = jpegDecode(buffer, { maxMemoryUsageInMB: 512, formatAsRGBA: true });
    const { width, height, data } = raw;
    if (width === 0 || height === 0) return null;
    if (width > MAX_RENDER_EDGE || height > MAX_RENDER_EDGE) return null;
    if (width * height > MAX_RENDER_PIXELS) return null;
    const rgb = new Uint8Array(width * height * 3);
    for (let px = 0; px < width * height; px++) {
      rgb[px * 3] = data[px * 4]!;
      rgb[px * 3 + 1] = data[px * 4 + 1]!;
      rgb[px * 3 + 2] = data[px * 4 + 2]!;
    }
    return { width, height, rgb };
  } catch {
    return null;
  }
}

/**
 * 按魔数分发解码：PNG（89 50…）走内置解码器，JPEG（FF D8）走 jpeg-js。
 * 不认 mediaType 标注——工具结果图的 mediaType 与实际字节可能不符，魔数才是硬证据。
 * gif/bmp/webp 暂无解码器，返回 null 走降级文本行。
 */
export function decodeImage(buffer: Buffer): DecodedImage | null {
  if (buffer.length < 4) return null;
  if (buffer[0] === 0xff && buffer[1] === 0xd8) return decodeJPEG(buffer);
  return decodePNG(buffer);
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

/**
 * 把量化后的索引图打包成 sixel 序列，可只输出像素行区间 [y0, y1)。
 *
 * 为什么需要行区间（区间契约的来历，改前必读）：一张图在转录区占 N 行。早先实现是
 * 「首行放整图序列、后面 N-1 行空占位」，靠 WT 把序列从首行向下画满 N 行。库层
 * doRender 有个 imagesNeedRedraw 分支：屏幕里任一行含图片序列，且该行与上一帧
 * 不同，就把**所有行**重写一遍（含占位行），每行都以 `\x1b[2K` 开头。WT 的 sixel
 * 像素附着在字符格上，EL 会连格内像素一起销毁（WT PR #18855）。于是先画的整图被
 * 随后写入的占位行逐行擦掉，只剩第一行，症状是缩略图时而正常时而塌成一条
 * （2026-09-29 截图复现；进程内 harness 实证：spanRows=9 时，图片行下移一行的
 * 那一帧写满了全部 40 行）。
 *
 * 触发器不是图片自身变化，而是**图片行的屏幕行号位移**：任何让图片上方内容变高的
 * 操作（spinner 计时、工具耗时、thinking 预览增长、子 agent 计数）都会点亮
 * imagesNeedRedraw，所以这个擦除在活跃会话里必然反复发生。
 *
 * 修法：每行一条序列、每条只画自己那一行（18px）的像素。行与行之间不再有像素
 * 依赖，任何一行被 `\x1b[2K` 重写都只影响自己，擦不掉别的行。代价是同一条调色板
 * 要在每条序列里按需重定义（只定义该行用到的色），以及首帧要写 N 条序列；
 * N 是缩略图高度（≤12），单行像素带只有 18px，序列总量与原单条同级。
 *
 * 结构：DCS 引导段（sixel 包的 introducer(1)，WT 验证过）+ raster 属性声明像素
 * 宽高（高 = 区间高度），调色板只定义区间内用到的色，按 6 像素行一个 band、每个
 * band 内按颜色分层逐列输出位图字符（63 + bits，bit row 对应该列在区间内的第 row
 * 个像素），层间用 graphics CR（$）回车覆盖，band 间用 graphics LF（-）换带，ST
 * 结尾。连续同字符做 RLE（!<count><char>）压缩。
 *
 * 序列内不出现换行：TUI 里它是单行输出，换行会把一行拆多行、破坏光标记账。
 */
export function encodeSixel(
  quant: Quantized,
  width: number,
  height: number,
  y0 = 0,
  y1 = height,
): string {
  const GCR = String.fromCharCode(0x24); // graphics carriage return（层间回车覆盖）
  const startY = Math.max(0, Math.min(height, Math.floor(y0)));
  const endY = Math.max(startY, Math.min(height, Math.ceil(y1)));
  const stripH = endY - startY;
  // 区间内用到的调色板索引（保持首次出现顺序，输出稳定可测）。只定义用得上的色：
  // 每条序列都要自带调色板，全量定义会让 N 条序列各背一份 256 色表。
  const usedColors: number[] = [];
  const seenColor = new Set<number>();

  const firstBand = Math.floor(startY / 6);
  const lastBand = Math.ceil(endY / 6); // exclusive
  const bandParts: string[] = [];
  for (let band = firstBand; band < lastBand; band++) {
    const bandTop = band * 6;
    // 区间可能在 band 中间起止：只输出区间覆盖到的像素行
    const rowFrom = Math.max(startY, bandTop);
    const rowTo = Math.min(endY, bandTop + 6);
    if (rowTo <= rowFrom) continue;
    // 收集本 band 用到的调色板索引（保持首次出现顺序），同时记录每色最后出现的列：
    // 层内位图只画到该列，之后的列不输出（层间 GCR 回车覆盖，截断不影响起点）
    const used: number[] = [];
    const lastX = new Map<number, number>();
    for (let row = rowFrom; row < rowTo; row++) {
      const lineBase = row * width;
      for (let x = 0; x < width; x++) {
        const idx = quant.indices[lineBase + x]!;
        if (!lastX.has(idx)) used.push(idx);
        lastX.set(idx, x);
        if (!seenColor.has(idx)) {
          seenColor.add(idx);
          usedColors.push(idx);
        }
      }
    }
    let bandStr = '';
    for (const color of used) {
      bandStr += '#' + color;
      const layerEnd = lastX.get(color)!;
      let runChar = '';
      let runLen = 0;
      const flush = (): void => {
        if (runLen === 0) return;
        bandStr += runLen > 3 ? '!' + runLen + runChar : runChar.repeat(runLen);
        runLen = 0;
      };
      for (let x = 0; x <= layerEnd; x++) {
        let bits = 0;
        for (let row = rowFrom; row < rowTo; row++) {
          // bit 位是「区间内的第几行」，不是「绝对第几行」：raster 声明的高度是
          // 区间高度，解码端从区间顶部开始数
          if (quant.indices[row * width + x] === color) bits |= 1 << ((row - startY) % 6);
        }
        const ch = String.fromCharCode(63 + bits);
        if (ch === runChar) {
          runLen++;
        } else {
          flush();
          runChar = ch;
          runLen = 1;
        }
      }
      flush();
      bandStr += GCR;
    }
    bandParts.push(bandStr);
  }
  let header = introducer(1) + '"1;1;' + width + ';' + stripH;
  for (const c of usedColors) {
    const r = Math.round((quant.palette[c * 3]! / 255) * 100);
    const g = Math.round((quant.palette[c * 3 + 1]! / 255) * 100);
    const b = Math.round((quant.palette[c * 3 + 2]! / 255) * 100);
    header += '#' + c + ';2;' + r + ';' + g + ';' + b;
  }
  return header + bandParts.join('-') + FINALIZER;
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
 * 缩略图占格计算：转录区里的小图尺寸（点击才进预览看大图）。
 *
 * 策略与对照实现一致：多图并排走小格（10 格宽、半高），单图按宽高比适配
 * （最宽 24 格、最高 12 格，极端长宽比钳在 [0.25, 4] 防退化成细条）。
 * 字符格按 9×18px 计，故格数宽高比与实际像素宽高比换算系数是 2。
 */
export function thumbnailCells(
  imgWidth: number,
  imgHeight: number,
  count: number,
  available: number,
): { cols: number; rows: number } {
  if (count > 1) {
    const cols = Math.max(1, Math.min(10, available));
    return { cols, rows: Math.max(1, Math.round(cols / 2)) };
  }
  // ratio 是**宽高比**（imgWidth/imgHeight，钳 [0.25, 4]），与 dsh-TUI previewSize 同向。
  // 曾把方向抄反成高宽比：超宽图（长截图 1920x414）rows 算出 48 行触 12 行上限后 cols 回缩
  // 到 6，渲染成 6x12 竖条——观感就是「缩得太过分」。正确方向下宽图 cols 顶格、rows 按比例小。
  const ratio = Math.max(0.25, Math.min(4, imgWidth / Math.max(1, imgHeight)));
  const maxCols = Math.max(1, Math.min(24, available));
  const maxRows = 12;
  let cols = maxCols;
  let rows = Math.max(1, Math.round(cols / (2 * ratio)));
  if (rows > maxRows) {
    rows = maxRows;
    cols = Math.max(1, Math.min(maxCols, Math.round(2 * rows * ratio)));
  }
  return { cols, rows };
}

/**
 * 判断一行是否携带图片协议序列（sixel DCS / kitty APC / iTerm2 OSC 1337）。
 *
 * 为什么必须有这个判定：库层的 extractAnsiCode 只认 CSI、OSC、APC 三类转义，**不认
 * DCS**（`ESC P ... ST`）。于是 visibleWidth 会把 sixel 序列的载荷（位图字符、调色板
 * 定义、RLE 计数）全当成可见字符：一条 1794 字节的缩略图序列算出约 1500 列宽，
 * 任何按宽度钳制的路径都会把它截成没有 ST 结尾的残片。进程内实测：尾块的图片行
 * 被 Transcript.render 的 safeTail 一截，1794 字节变 113 字节，序列残缺、图渲染不出来。
 *
 * 尾块是热点场景：工具结果图刚从 read_media 落盘时，图片块就是尾块，正好撞上截断。
 * 所以「按宽度截断」「按宽度补空格」这类操作都必须先过这个判定。
 *
 * 用 includes 而非 startsWith：块渲染器会给图片行加缩进前缀（如两个空格），
 * 序列不在行首。
 */
export function isImageSequenceLine(line: string): boolean {
  return line.includes('\x1bP') || line.includes('\x1b_G') || line.includes('\x1b]1337;');
}

/**
 * UI 层还原工具结果图的 base64。
 *
 * 背景：read_media 等工具回传图片时 offloadMedia 把 base64 换成 stepref:<hash> 附件仓
 * 指针（内存只持指针是附件仓的设计初衷，压缩大图 base64 常驻 history 的问题靠它解）。
 * 但 UI 渲染层不认指针——decodePNG 拿到的是「stepref:...」这串文本的字节，必然
 * 解析失败、转录区显示「[图片无法渲染]」（2026-09-28 真机截图复现）。
 *
 * 在挂到 UI item 之前还原：stepref 走 rehydrate（附件仓自带内容寻址缓存，同一张图
 * 重复渲染不重复读盘）；还原失败（附件文件被移走）置空串，渲染层走降级文本行；
 * 非 stepref（小图内联未落盘）原样返回。
 */

export function rehydrateToolImages(
  images: readonly ToolResultImage[] | undefined,
  store: { rehydrate(cwd: string, stepref: string): string | null } | undefined,
  cwd: string,
): ToolResultImage[] | undefined {
  if (images === undefined) return undefined;
  if (images.length === 0) return [];
  return images.map((im) => {
    if (!isStepref(im.base64)) return im;
    if (store === undefined) return { ...im, base64: '' };
    const back = store.rehydrate(cwd, im.base64);
    return back === null ? { ...im, base64: '' } : { ...im, base64: back };
  });
}

/**
 * 终端图片组件：sixel 优先，half-block 兜底。
 *
 * sixel 路径按终端像素宽度决定缩放（字符格宽按 9px 计）。**序列行必须是位置无关的**：
 * 它作为行数组的首行、后面跟 rows-1 个空占位行，图像从该行所在屏幕位置向下扩展。
 * 曾经的实现是「空行在前、序列行带 \x1b[NA 上移前缀」，序列行的渲染效果依赖它
 * 恰好落在哪一行——pi-tui 的差分渲染滚动后重写该行时光标已在新屏幕位置，上移
 * 落点随之漂移，图画到错误区域且旧图不清，症状是闪烁/黑屏/残影（2026-09-28
 * 用户实测三连）。位置上无关后，差分重写在任意滚动位置都画在该行当前处，成立。
 *
 * 占位契约在 2026-09-29 又翻修过一次：库层 imagesNeedRedraw 会在图片行位移时把
 * 所有行重写，占位行的 `\x1b[2K` 会把首行画出的图逐行擦掉，只剩第一行。现在改成
 * **每行一条只画自己那 18px 的序列**（见 encodeSixel 的行区间说明），行间无像素
 * 依赖，重写任意一行都不影响别行。
 *
 * 占位行数 = 像素高 / 字符格高（18px）向上取整。注意 pi-tui 的 multi-row image
 * 记账只认 kitty APC 的行数声明（extractKittyImageRows），sixel 行走的是普通行
 * 路径，因此这套占位契约是我方自己与 WT 的约定，不依赖库的图片分支。
 */
export class ImageBlock implements Component {
  private cachedLines?: string[];
  private cachedWidth?: number;
  private readonly image: DecodedImage;
  private readonly maxWidthCells: number;
  private readonly maxHeightCells: number;

  constructor(image: DecodedImage, maxWidthCells: number, maxHeightCells = Number.POSITIVE_INFINITY) {
    this.image = image;
    this.maxWidthCells = maxWidthCells;
    this.maxHeightCells = maxHeightCells;
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

  /**
   * sixel 路径：每行一条序列，序列只画该行对应的 18px 像素带。
   *
   * 为什么不再用「首行整图 + 空占位」：库层 imagesNeedRedraw 触发时会把占位行也用
   * `\x1b[2K` 重写，WT 上等于把整图擦到剩一行（2026-09-29 复现，详见 encodeSixel）。
   * 每行自带序列后，行与行之间没有共享像素，重写是幂等的。
   */
  private renderSixel(width: number): string[] {
    const { width: w, height: h } = this.image;
    const CELL_W = 9;
    const CELL_H = 18;
    // 尺寸：宽高同比例缩放，同时不超过 maxWidthCells 与 maxHeightCells（转录区缩略图
    // 传小上限，预览浮层传大上限）。只缩不放大：小图按原尺寸保文字可读。
    const cols = Math.max(1, Math.min(this.maxWidthCells, Math.max(1, width - 2)));
    const rows = Math.max(1, Math.floor(this.maxHeightCells));
    const scale = Math.min(1, (cols * CELL_W) / w, (rows * CELL_H) / h);
    const pxW = Math.max(1, Math.round(w * scale));
    let pxH = Math.max(1, Math.round(h * scale));
    if (pxH % 6 !== 0) pxH += 6 - (pxH % 6); // sixel band 对齐
    const scaled: DecodedImage = scale === 1 ? this.image : resizeNearest(this.image, pxW, pxH);
    const quant = quantize(scaled);
    const usedRows = Math.max(1, Math.ceil(pxH / CELL_H));
    const lines: string[] = [];
    for (let r = 0; r < usedRows; r++) {
      const y0 = r * CELL_H;
      const y1 = Math.min(pxH, y0 + CELL_H);
      lines.push(encodeSixel(quant, pxW, pxH, y0, y1));
    }
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

