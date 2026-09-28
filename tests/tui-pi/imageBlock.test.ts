/**
 * 终端图片渲染测试：PNG 解码、sixel 量化与打包、协议探测、组件行为。
 *
 * 不跑真实终端渲染（那需要在真机看 sixel 画面），钉住可离线验证的部分：
 * 解码器逐像素正确性与失败降级、量化与打包的结构不变量、探测的覆盖逻辑、
 * 组件在两条协议路径下的网格与缓存行为。协议路径用 STEP_CODE_IMAGE_PROTOCOL
 * 环境变量强制，不依赖测试机的终端环境。
 */
import { afterEach, describe, expect, it } from 'vitest';
import {
  decodePNG,
  detectImageProtocol,
  encodeSixel,
  ImageBlock,
  quantize,
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

  it('sixel 路径：末行是 sixel 序列，前面是占位空行', () => {
    process.env.STEP_CODE_IMAGE_PROTOCOL = 'sixel';
    const comp = new ImageBlock(decoded(), 6);
    const lines = comp.render(62); // 60 列 * 9px = 540px > 8px，不放大
    expect(lines.length).toBeGreaterThanOrEqual(1);
    const last = lines[lines.length - 1]!;
    expect(last).toContain('\x1bP0;1;q');
    expect(last).toContain('\x1b\\');
    // 8x6 的图不缩放：540px 视口下按原尺寸，占位 1 行（6px / 18px 向上取整）
    expect(lines.slice(0, -1).every((l) => l === '')).toBe(true);
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
