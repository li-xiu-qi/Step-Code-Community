/**
 * 终端图片渲染测试：PNG 解码、sixel 量化与打包、协议探测、组件行为。
 *
 * 不跑真实终端渲染（那需要在真机看 sixel 画面），钉住可离线验证的部分：
 * 解码器逐像素正确性与失败降级、量化与打包的结构不变量、探测的覆盖逻辑、
 * 组件在两条协议路径下的网格与缓存行为。协议路径用 STEP_CODE_IMAGE_PROTOCOL
 * 环境变量强制，不依赖测试机的终端环境。
 */
import { afterEach, describe, expect, it } from 'vitest';
import { decode } from 'sixel';
import {
  decodeImage,
  decodePNG,
  detectImageProtocol,
  encodeSixel,
  ImageBlock,
  quantize,
  rehydrateToolImages,
  thumbnailCells,
  type DecodedImage,
} from '../../src/tui-pi/imageBlock.js';

/** 8x6 四色块 PNG：左上红(230,57,70)、右上深蓝(29,53,87)、左下白、右下黑。 */
const PNG_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAgAAAAGCAIAAABxZ0isAAAAJElEQVR4nGN8ZunGAAPmfwThbCY4Cw3glGD8//8/gsPISIFRAFoTBbTJYCKiAAAAAElFTkSuQmCC';

const decoded = (): DecodedImage => decodePNG(Buffer.from(PNG_B64, 'base64'))!;

/** sixel 的 graphics CR（段内回车覆盖），用字符码构造避免工具链对 $ 的特殊处理。 */
const GCR = String.fromCharCode(0x24);

afterEach(() => {
  delete process.env.STEP_CODE_IMAGE_PROTOCOL;
});

describe('decodePNG', () => {
  it('解码 8x6 四色块，四角颜色与尺寸正确', () => {
    const img = decoded();
    expect(img.width).toBe(8);
    expect(img.height).toBe(6);
    expect(img.rgb.length).toBe(8 * 6 * 3);
    const at = (x: number, y: number): number[] => [
      img.rgb[(y * 8 + x) * 3]!,
      img.rgb[(y * 8 + x) * 3 + 1]!,
      img.rgb[(y * 8 + x) * 3 + 2]!,
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

/** 8x6 四色块 JPEG（quality 95）：与 PNG_B64 同构图，JPEG 有损故颜色断言用容差。 */
const JPEG_B64 =
  '/9j/4AAQSkZJRgABAQAAAQABAAD/2wCEAAIBAQEBAQIBAQECAgICAgQDAgICAgUEBAMEBgUGBgYFBgYGBwkIBgcJBwYGCAsICQoKCgoKBggLDAsKDAkKCgoBAgICAgICBQMDBQoHBgcKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCv/AABEIAAYACAMBEQACEQEDEQH/xAGiAAABBQEBAQEBAQAAAAAAAAAAAQIDBAUGBwgJCgsQAAIBAwMCBAMFBQQEAAABfQECAwAEEQUSITFBBhNRYQcicRQygZGhCCNCscEVUtHwJDNicoIJChYXGBkaJSYnKCkqNDU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6g4SFhoeIiYqSk5SVlpeYmZqio6Slpqeoqaqys7S1tre4ubrCw8TFxsfIycrS09TV1tfY2drh4uPk5ebn6Onq8fLz9PX29/j5+gEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoLEQACAQIEBAMEBwUEBAABAncAAQIDEQQFITEGEkFRB2FxEyIygQgUQpGhscEJIzNS8BVictEKFiQ04SXxFxgZGiYnKCkqNTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqCg4SFhoeIiYqSk5SVlpeYmZqio6Slpqeoqaqys7S1tre4ubrCw8TFxsfIycrS09TV1tfY2dri4+Tl5ufo6ery8/T19vf4+fr/2gAMAwEAAhEDEQA/APNv+DpP9mDwD/wTX/4UX/wozV9Y1b/hNP8AhJ/7U/4Sy4in8r7H/ZPleV9nig25+1Sbt27OFxjBzOQxXD3tPq2vPa/Nr8N7Wtbuz7XxE47zfxM+q/2pCnD6vz8vslJX9pyX5uaU725Fa1ut79P/2Q==';

describe('decodeImage', () => {
  it('JPEG 魔数分发：解码 8x6 四色块，尺寸正确、四角颜色近似', () => {
    const img = decodeImage(Buffer.from(JPEG_B64, 'base64'))!;
    expect(img).not.toBeNull();
    expect(img.width).toBe(8);
    expect(img.height).toBe(6);
    expect(img.rgb.length).toBe(8 * 6 * 3);
    const at = (x: number, y: number): number[] => [
      img.rgb[(y * 8 + x) * 3]!,
      img.rgb[(y * 8 + x) * 3 + 1]!,
      img.rgb[(y * 8 + x) * 3 + 2]!,
    ];
    const near = (got: number[], want: number[]): void =>
      want.forEach((v, i) => expect(Math.abs(got[i]! - v)).toBeLessThanOrEqual(40));
    near(at(0, 0), [230, 57, 70]);
    near(at(7, 0), [29, 53, 87]);
    near(at(0, 5), [255, 255, 255]);
    near(at(7, 5), [0, 0, 0]);
  });

  it('PNG 魔数仍走内置解码器，逐像素精确', () => {
    const img = decodeImage(Buffer.from(PNG_B64, 'base64'))!;
    expect(img.width).toBe(8);
    expect(img.rgb[0]).toBe(230);
    expect(img.rgb[1]).toBe(57);
    expect(img.rgb[2]).toBe(70);
  });

  it('截断的 JPEG 返回 null，不抛异常', () => {
    const buf = Buffer.from(JPEG_B64, 'base64');
    expect(decodeImage(buf.subarray(0, 100))).toBeNull();
  });

  it('非图片字节返回 null，不抛异常', () => {
    expect(decodeImage(Buffer.from('definitely not an image'))).toBeNull();
    expect(decodeImage(Buffer.alloc(2))).toBeNull();
  });
});

describe('quantize', () => {
  it('四色图量化后不超过 4 色，且主色保留', () => {
    const quant = quantize(decoded());
    expect(quant.colors).toBeLessThanOrEqual(4);
    expect(quant.indices.length).toBe(8 * 6);
    // 调色板里应能找到接近原四色的条目
    const paletteRgb: number[][] = [];
    for (let i = 0; i < quant.colors; i++) {
      paletteRgb.push([quant.palette[i * 3]!, quant.palette[i * 3 + 1]!, quant.palette[i * 3 + 2]!]);
    }
    for (const target of [[230, 57, 70], [29, 53, 87], [255, 255, 255], [0, 0, 0]]) {
      const nearest = paletteRgb.reduce((best, rgb) => {
        const d = Math.abs(rgb[0]! - target[0]!) + Math.abs(rgb[1]! - target[1]!) + Math.abs(rgb[2]! - target[2]!);
        const bd = Math.abs(best[0]! - target[0]!) + Math.abs(best[1]! - target[1]!) + Math.abs(best[2]! - target[2]!);
        return d < bd ? rgb : best;
      });
      const dist = Math.abs(nearest[0]! - target[0]!) + Math.abs(nearest[1]! - target[1]!) + Math.abs(nearest[2]! - target[2]!);
      expect(dist).toBeLessThan(60); // 中位切分取桶均值，允许小偏差
    }
  });

  it('索引全部落在调色板范围内', () => {
    const quant = quantize(decoded());
    for (const idx of quant.indices) {
      expect(idx).toBeLessThan(quant.colors);
    }
  });
});

describe('encodeSixel', () => {
  /** 展开 sixel RLE：`!<count><char>` 表示 char 重复 count 次。 */
  const expandRle = (body: string): string => {
    let out = '';
    let i = 0;
    while (i < body.length) {
      if (body[i] === '!') {
        let j = i + 1;
        let num = '';
        while (j < body.length && body[j]! >= '0' && body[j]! <= '9') {
          num += body[j];
          j++;
        }
        out += body[j]!.repeat(Number(num));
        i = j + 1;
      } else {
        out += body[i];
        i++;
      }
    }
    return out;
  };

  it('结构：DCS 头、band 数、ST 结尾', () => {
    const quant = quantize(decoded());
    const seq = encodeSixel(quant, 8, 6);
    expect(seq.startsWith('\x1bP0;1;q"1;1;8;6')).toBe(true);
    expect(seq.endsWith('\x1b\\')).toBe(true);
    // TUI 单行输出：序列内不能有换行（会把一行拆多行、破坏光标记账）
    expect(/[\r\n]/.test(seq)).toBe(false);
    // 6 像素高 = 1 个 band：band 分隔符（graphics LF `-`）不出现
    const body = seq.slice(seq.indexOf('6') + 1, -2);
    expect(body.includes('-')).toBe(false);
    // sixel 包按颜色分层绘制：每层一段位图（可短于列数，只画到该颜色最后出现的列），
    // 层数取决于量化结果不固定；逐段验证列数上限与数据字符范围
    const segments = body.replace(/#\d+;2;\d+;\d+;\d+/g, '').split(GCR);
    let total = 0;
    for (const seg of segments) {
      const dataChars = [...expandRle(seg)].filter((ch) => ch >= '\u003f' && ch <= '\u007e');
      if (dataChars.length === 0) continue; // 空段（只剩调色板定义）对渲染无意义
      expect(dataChars.length).toBeLessThanOrEqual(8);
      total += dataChars.length;
    }
    expect(total).toBeGreaterThan(0);
  });

  it('roundtrip：序列解码回像素后四色齐全、不塌缩成单色（防全黑回归）', () => {
    // 全黑故障的形态是整幅图退化为单一暗色：颜色集合塌缩。用 sixel 包的解码器
    // 把序列读回来钉住四色齐全。注意该解码器对合成小图的列对齐不忠实（8 列解回
    // 10 列、角落像素会漂），逐像素坐标不能作判据，色集合覆盖才是稳定判据。
    const quant = quantize(decoded(), 256);
    const seq = encodeSixel(quant, 8, 6);
    const back = decode(seq);
    const hist = new Map<string, number>();
    for (let i = 0; i < back.width * back.height; i++) {
      const key = [back.data8[i * 4]!, back.data8[i * 4 + 1]!, back.data8[i * 4 + 2]!].join(',');
      hist.set(key, (hist.get(key) ?? 0) + 1);
    }
    // 不塌缩：原图四色至少都在（允许抖动/舍入的邻近色）
    expect(hist.size).toBeGreaterThanOrEqual(4);
    for (const want of [[230, 57, 70], [29, 53, 87], [255, 255, 255], [0, 0, 0]]) {
      const hit = [...hist.keys()].some((k) =>
        k.split(',').map(Number).every((v, i) => Math.abs(v - want[i]!) <= 25),
      );
      expect(hit).toBe(true);
    }
    // 不塌缩：黑色占比不能接近 1（全黑故障的形态；小图被解码器补了黑色 padding
    // 列，黑可能成为占比最高的色，但四色仍在、黑占比约五成）
    const total = back.width * back.height;
    const black = hist.get('0,0,0') ?? 0;
    expect(black / total).toBeLessThan(0.6);
  });

  it('调色板定义为合法百分比 RGB', () => {
    const quant = quantize(decoded());
    const seq = encodeSixel(quant, 8, 6);
    const defs = [...seq.matchAll(/#(\d+);2;(\d+);(\d+);(\d+)/g)];
    expect(defs.length).toBeGreaterThan(0);
    for (const d of defs) {
      expect(Number(d[1])).toBeLessThan(quant.colors);
      for (const v of [d[2], d[3], d[4]]) {
        expect(Number(v)).toBeGreaterThanOrEqual(0);
        expect(Number(v)).toBeLessThanOrEqual(100);
      }
    }
  });

  it('行区间：只输出区间内的像素行，raster 高度 = 区间高度', () => {
    const quant = quantize(decoded());
    const full = encodeSixel(quant, 8, 6);
    const top = encodeSixel(quant, 8, 6, 0, 3);
    const bottom = encodeSixel(quant, 8, 6, 3, 6);
    expect(full.startsWith('\x1bP0;1;q"1;1;8;6')).toBe(true);
    expect(top.startsWith('\x1bP0;1;q"1;1;8;3')).toBe(true);
    expect(bottom.startsWith('\x1bP0;1;q"1;1;8;3')).toBe(true);
    for (const seq of [full, top, bottom]) {
      expect(seq.endsWith('\x1b\\')).toBe(true);
      expect(/[\r\n]/.test(seq)).toBe(false);
    }
  });

  it('行区间分带后解码往返：上下两带拼回原图的颜色分布', () => {
    // 每行一条序列是修「占位行被 EL 擦掉」的基础，分带必须像素正确：
    // 若 bit 位算成绝对行号而非区间内行号，两带内容会错位。
    const w = 24;
    const h = 36; // 6px 一个 band，恰好两带
    const rgb = new Uint8Array(w * h * 3);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = (y * w + x) * 3;
        rgb[i] = y < h / 2 ? 230 : 29; // 上半红、下半深蓝
        rgb[i + 1] = y < h / 2 ? 57 : 53;
        rgb[i + 2] = y < h / 2 ? 70 : 87;
      }
    }
    const quant = quantize({ width: w, height: h, rgb });
    const topPx = decode(encodeSixel(quant, w, h, 0, 18));
    const bottomPx = decode(encodeSixel(quant, w, h, 18, 36));
    expect(topPx.height).toBe(18);
    expect(bottomPx.height).toBe(18);
    const px = (img: typeof topPx, x: number, y: number): number[] => [
      img.data8[(y * img.width + x) * 4]!,
      img.data8[(y * img.width + x) * 4 + 1]!,
      img.data8[(y * img.width + x) * 4 + 2]!,
    ];
    // 上带第 5 行（区间中部）仍是红色，下带第 5 行（区间中部）是蓝色：
    // 错位会让下带中部变成红色
    expect(px(topPx, 4, 5)[0]).toBeGreaterThan(px(topPx, 4, 5)[2]);
    expect(px(bottomPx, 4, 5)[2]).toBeGreaterThan(px(bottomPx, 4, 5)[0]);
  });
});

describe('detectImageProtocol', () => {
  it('环境变量强制 sixel / halfblock', () => {
    process.env.STEP_CODE_IMAGE_PROTOCOL = 'sixel';
    expect(detectImageProtocol()).toBe('sixel');
    process.env.STEP_CODE_IMAGE_PROTOCOL = 'halfblock';
    expect(detectImageProtocol()).toBe('halfblock');
  });

  it('off 等价于 halfblock（不渲染协议序列，只出字符画）', () => {
    process.env.STEP_CODE_IMAGE_PROTOCOL = 'off';
    expect(detectImageProtocol()).toBe('halfblock');
  });
});

describe('ImageBlock', () => {
  it('halfblock 路径：字符网格结构正确', () => {
    process.env.STEP_CODE_IMAGE_PROTOCOL = 'halfblock';
    const comp = new ImageBlock(decoded(), 6);
    const lines = comp.render(8);
    expect(lines.length).toBe(3);
    const cellRe = /\x1b\[38;2;(\d+);(\d+);(\d+)m\x1b\[48;2;(\d+);(\d+);(\d+)m\u2580/g;
    for (const line of lines) {
      expect([...line.matchAll(cellRe)].length).toBe(6);
      expect(line.endsWith('\x1b[0m')).toBe(true);
    }
  });

  it('sixel 路径：每行一条只画自己那段的序列，无 moveUp 前缀（位置无关）', () => {
    process.env.STEP_CODE_IMAGE_PROTOCOL = 'sixel';
    const comp = new ImageBlock(decoded(), 6);
    const lines = comp.render(62); // 60 列 * 9px = 540px > 8px，不放大
    expect(lines.length).toBeGreaterThanOrEqual(1);
    for (const line of lines) {
      // 序列行以 DCS 引导段开头：不带 \x1b[NA 上移前缀。带前缀是滚动后重写漂移、
      // 图画到错位区域并残影闪烁的根因。
      expect(line.startsWith('\x1bP0;1;q')).toBe(true);
      expect(/^\x1b\[\d+A/.test(line)).toBe(false);
      expect(line).toContain('\x1b\\');
    }
    // 8x6 的图不缩放：540px 视口下按原尺寸，6px 高配 1 行（6px / 18px 向上取整）
    expect(lines.length).toBe(1);
  });

  it('多行图：每行各自一条序列（行间无像素依赖，重写一行不影响别行）', () => {
    process.env.STEP_CODE_IMAGE_PROTOCOL = 'sixel';
    const w = 100;
    const h = 60;
    const rgb = new Uint8Array(w * h * 3);
    for (let i = 0; i < w * h; i++) {
      rgb[i * 3] = (i * 7) % 256;
      rgb[i * 3 + 1] = (i * 13) % 256;
      rgb[i * 3 + 2] = 90;
    }
    const comp = new ImageBlock({ width: w, height: h, rgb }, 24, 12);
    const lines = comp.render(62);
    expect(lines.length).toBeGreaterThanOrEqual(2);
    expect(lines.length).toBeLessThanOrEqual(12); // 高度上限生效
    // 回归：早先是「首行整图 + 空占位行」，库层全屏重写时占位行的 \x1b[2K 会把
    // 图擦到只剩第一行。现在每一行都必须自带序列，不能再出现空占位行。
    for (const line of lines) {
      expect(line.startsWith('\x1bP0;1;q')).toBe(true);
      expect(line).toContain('\x1b\\');
    }
    expect(lines.some((l) => l === '')).toBe(false);
  });

  it('空视口/极端小宽度不抛异常', () => {
    process.env.STEP_CODE_IMAGE_PROTOCOL = 'halfblock';
    const comp = new ImageBlock(decoded(), 6);
    expect(() => comp.render(0)).not.toThrow();
    expect(() => comp.render(1)).not.toThrow();
  });

  it('同宽度重复 render 返回同一缓存引用', () => {
    process.env.STEP_CODE_IMAGE_PROTOCOL = 'halfblock';
    const comp = new ImageBlock(decoded(), 18);
    const first = comp.render(8);
    expect(comp.render(8)).toBe(first);
  });

  it('invalidate 后重新计算', () => {
    process.env.STEP_CODE_IMAGE_PROTOCOL = 'halfblock';
    const comp = new ImageBlock(decoded(), 6);
    const first = comp.render(8);
    comp.invalidate();
    const second = comp.render(8);
    expect(second).not.toBe(first);
    expect(second).toEqual(first);
  });
});

describe('thumbnailCells', () => {
  it('多图并排：宽 10 格、高 5 格，不超可用宽度', () => {
    expect(thumbnailCells(200, 100, 2, 60)).toEqual({ cols: 10, rows: 5 });
    expect(thumbnailCells(200, 100, 3, 8)).toEqual({ cols: 8, rows: 4 });
  });

  it('横图（宽高比 2）：宽顶格 24，高度按比例', () => {
    const c = thumbnailCells(1000, 500, 1, 60);
    expect(c.cols).toBe(24);
    expect(c.rows).toBe(6);
  });

  it('竖图（宽高比 0.5）：触 12 行上限，宽度按比例收', () => {
    const c = thumbnailCells(500, 1000, 1, 60);
    expect(c.cols).toBe(12);
    expect(c.rows).toBe(12);
  });

  it('超宽图（长截图 1920x414）：24 列宽横条，不塌成竖条', () => {
    // 回归：ratio 方向抄反成高宽比时，这张图会被算成 6x12 竖条（观感「缩得过分」）
    const c = thumbnailCells(1920, 414, 1, 60);
    expect(c.cols).toBe(24);
    expect(c.rows).toBe(3);
  });

  it('超长图（宽高比 <0.25）：宽收窄、高顶格', () => {
    const c = thumbnailCells(40, 4000, 1, 60); // ratio 钳到 0.25
    expect(c.rows).toBe(12);
    expect(c.cols).toBe(6);
  });

  it('方图：24x12', () => {
    expect(thumbnailCells(800, 800, 1, 60)).toEqual({ cols: 24, rows: 12 });
  });

  it('可用宽度小于格数时钳制', () => {
    expect(thumbnailCells(200, 100, 2, 4)).toEqual({ cols: 4, rows: 2 });
    const single = thumbnailCells(1000, 500, 1, 5);
    expect(single.cols).toBe(5);
    expect(single.rows).toBe(1);
  });

  it('零尺寸输入不抛异常、不返回 0', () => {
    const c = thumbnailCells(0, 0, 1, 60);
    expect(c.cols).toBeGreaterThanOrEqual(1);
    expect(c.rows).toBeGreaterThanOrEqual(1);
  });
});


describe('rehydrateToolImages（UI 层还原 stepref 指针）', () => {
  const REAL = Buffer.from(PNG_B64, 'base64').toString('base64');
  const store = (back: string | null, calls: string[] = []) => ({
    rehydrate(cwd: string, stepref: string): string | null {
      calls.push(`${cwd}|${stepref}`);
      return back;
    },
  });

  it('stepref 指针还原为真 base64（渲染层才能解码）', () => {
    const calls: string[] = [];
    const out = rehydrateToolImages(
      [{ mediaType: 'image/png', base64: `stepref:${'a'.repeat(64)}` }],
      store(REAL, calls),
      'C:/work',
    );
    expect(out).toHaveLength(1);
    expect(out![0]!.base64).toBe(REAL);
    expect(calls[0]).toBe(`C:/work|stepref:${'a'.repeat(64)}`);
  });

  it('非 stepref（小图内联未落盘）原样返回、不碰 store', () => {
    const calls: string[] = [];
    const out = rehydrateToolImages([{ mediaType: 'image/png', base64: REAL }], store('SHOULD-NOT-BE-USED', calls), 'C:/work');
    expect(out![0]!.base64).toBe(REAL);
    expect(calls).toHaveLength(0);
  });

  it('还原失败（附件被移走）置空串：渲染层走降级行而不是把指针当图', () => {
    const out = rehydrateToolImages([{ mediaType: 'image/png', base64: 'stepref:dead' }], store(null), 'C:/work');
    expect(out![0]!.base64).toBe('');
  });

  it('store 缺失时置空串，不抛', () => {
    const out = rehydrateToolImages([{ mediaType: 'image/png', base64: 'stepref:x' }], undefined, 'C:/work');
    expect(out![0]!.base64).toBe('');
  });

  it('空数组/undefined 原样返回', () => {
    expect(rehydrateToolImages(undefined, store(REAL), 'C:/work')).toBeUndefined();
    expect(rehydrateToolImages([], store(REAL), 'C:/work')).toEqual([]);
  });

  it('混合输入：stepref 还原、内联直通，顺序保持', () => {
    const out = rehydrateToolImages(
      [
        { mediaType: 'image/png', base64: 'stepref:one' },
        { mediaType: 'image/jpeg', base64: REAL },
      ],
      store(REAL),
      'C:/work',
    );
    expect(out!.map((i) => i.base64)).toEqual([REAL, REAL]);
    expect(out![1]!.mediaType).toBe('image/jpeg');
  });
});
