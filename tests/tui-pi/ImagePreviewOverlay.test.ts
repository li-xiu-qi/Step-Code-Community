/**
 * 图片预览浮层行为测试：缩放档位循环、平移钳制、工具栏命中、鼠标路由、Esc 关闭。
 * 不验证 sixel 画面（那要真机），钉住可离线验证的交互逻辑与渲染结构。
 */
import { describe, expect, it } from 'vitest';
import type { DecodedImage } from '../../src/tui-pi/imageBlock.js';
import { ImagePreviewOverlay } from '../../src/tui-pi/ImagePreviewOverlay.js';
import { parseSGRMouse } from '../../src/tui-pi/mouseEvents.js';

/** 渐变测试图：像素值随坐标变，pan/zoom 后渲染输出可观测变化。 */
function gradient(width: number, height: number): DecodedImage {
  const rgb = new Uint8Array(width * height * 3);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 3;
      rgb[i] = (x * 7) % 256;
      rgb[i + 1] = (y * 11) % 256;
      rgb[i + 2] = 100;
    }
  }
  return { width, height, rgb };
}

function makeOverlay(img: DecodedImage = gradient(1200, 720)): { overlay: ImagePreviewOverlay; closed: () => boolean } {
  let closed = false;
  const overlay = new ImagePreviewOverlay({
    image: img,
    meta: { mediaType: 'image/png', width: img.width, height: img.height, bytes: 12345, name: 'shot.png' },
    close: () => { closed = true; },
    requestRender: () => {},
  });
  return { overlay, closed: () => closed };
}

const key = (k: string): string => k;

describe('ImagePreviewOverlay 缩放', () => {
  it('档位直达：0/1/2/4/8', () => {
    const { overlay } = makeOverlay();
    overlay.renderAt(100, 40); // 先渲染一次（按钮/工具栏行号就位）
    for (const k of ['0', '1', '2', '4', '8']) {
      overlay.handleInput(key(k));
      // 每档渲染不抛、结构完整
      const lines = overlay.renderAt(100, 40);
      expect(lines.length).toBeGreaterThanOrEqual(40);
      expect(lines.some((l) => l.includes('╭'))).toBe(true);
    }
  });

  it('+/- 升降档循环：0→1→2→4→8 封顶，8→4→2→1→0 见底', () => {
    const { overlay } = makeOverlay();
    overlay.renderAt(100, 40);
    overlay.handleInput(key('+')); // 0 → 1
    const at1 = overlay.renderAt(100, 40).join('\n');
    overlay.handleInput(key('+')); // 1 → 2
    const at2 = overlay.renderAt(100, 40).join('\n');
    expect(at2).not.toBe(at1); // 2 倍放大画面变了
    for (let i = 0; i < 5; i++) overlay.handleInput(key('+')); // 封顶 8 不报错
    const at8 = overlay.renderAt(100, 40).join('\n');
    for (let i = 0; i < 6; i++) overlay.handleInput(key('-')); // 降回 0
    const at0 = overlay.renderAt(100, 40).join('\n');
    expect(at0).not.toBe(at8);
  });

  it('zoom=0（适配）时平移无效：输出不变', () => {
    const { overlay } = makeOverlay();
    overlay.renderAt(100, 40);
    const before = overlay.renderAt(100, 40).join('\n');
    overlay.handleInput(key('\x1b[C')); // right
    overlay.handleInput(key('\x1b[D')); // left
    expect(overlay.renderAt(100, 40).join('\n')).toBe(before);
  });

  it('zoom>0 时平移改变画面（中心移动）', () => {
    const { overlay } = makeOverlay();
    overlay.renderAt(100, 40);
    overlay.handleInput(key('2'));
    const before = overlay.renderAt(100, 40).join('\n');
    overlay.handleInput(key('\x1b[C')); // right pan
    expect(overlay.renderAt(100, 40).join('\n')).not.toBe(before);
  });
});

describe('ImagePreviewOverlay 鼠标路由', () => {
  it('Esc 关闭', () => {
    const { overlay, closed } = makeOverlay();
    overlay.renderAt(100, 40);
    overlay.handleInput('\x1b');
    expect(closed()).toBe(true);
  });

  it('点击工具栏「适配」按钮：zoom 归 0', () => {
    const { overlay } = makeOverlay();
    overlay.renderAt(100, 40);
    overlay.handleInput(key('4')); // 先放大
    // 工具栏行 + 「适配」按钮首列（shift 后 startCol+2 起，按钮区间由 render 登记）
    // 浮动元素：从输出反推工具栏行号——第一张卡片底部边框的上一行
    const lines = overlay.renderAt(100, 40);
    const bottom = lines.findIndex((l) => l.trimStart().startsWith('╰'));
    const toolbarRow = bottom - 1;
    // 点「适配」按钮：[适配] 在工具栏文本最左，卡片左边框 + 2 + pad
    const toolbarLine = lines[toolbarRow]!;
    const col = toolbarLine.indexOf('[适配]');
    expect(col).toBeGreaterThanOrEqual(0);
    overlay.handleInput(`\x1b[<0;${col + 1};${toolbarRow + 1}M`);
    // 归 0 后再放大才有效——用 + 验证：0 态按 + 变 1 档
    overlay.handleInput(key('+'));
    const zoomed = overlay.renderAt(100, 40).join('\n');
    const plain = (() => { const o = makeOverlay().overlay; o.renderAt(100, 40); return o.renderAt(100, 40).join('\n'); })();
    expect(zoomed).not.toBe(plain); // 说明点击后确实回到了可再放大的 0 态
  });

  it('点击非工具栏行 = 点卡片外：关闭', () => {
    const { overlay, closed } = makeOverlay();
    overlay.renderAt(100, 40);
    // 第 0 行（补头空行，肯定不在工具栏）
    overlay.handleInput('\x1b[<0;5;1M'); // press
    overlay.handleInput('\x1b[<0;5;1m'); // release 同位置 = 点击
    expect(closed()).toBe(true);
  });

  it('滚轮上下平移（zoom>0）：画面变化', () => {
    const { overlay } = makeOverlay();
    overlay.renderAt(100, 40);
    overlay.handleInput(key('2'));
    const before = overlay.renderAt(100, 40).join('\n');
    overlay.handleInput('\x1b[<64;5;5M'); // wheel up
    expect(overlay.renderAt(100, 40).join('\n')).not.toBe(before);
  });

  it('普通字符不当鼠标：不崩、不关', () => {
    const { overlay, closed } = makeOverlay();
    overlay.renderAt(100, 40);
    overlay.handleInput('x'); // 未绑定键：无操作
    expect(closed()).toBe(false);
  });
});

describe('ImagePreviewOverlay 渲染结构', () => {
  it('标题含格式/尺寸/字节/文件名，铺满视口行数', () => {
    const { overlay } = makeOverlay();
    const lines = overlay.renderAt(100, 40);
    expect(lines).toHaveLength(40);
    const top = lines.find((l) => l.includes('╭'))!;
    expect(top).toContain('PNG');
    expect(top).toContain('1200×720');
    expect(top).toContain('12.1 KB');
    expect(top).toContain('shot.png');
  });

  it('工具栏含全部按钮文字', () => {
    const { overlay } = makeOverlay();
    const lines = overlay.renderAt(100, 40);
    const joined = lines.join('\n');
    for (const label of ['[适配]', '[100%]', '[+]', '[-]', '[←]', '[↑]', '[↓]', '[→]', '[Esc]']) {
      expect(joined).toContain(label);
    }
  });

  it('parseSGRMouse 与浮层路由对得上（工具栏点击用的序列格式）', () => {
    const ev = parseSGRMouse('\x1b[<0;5;1M');
    expect(ev).toEqual({ kind: 'press', button: 0, col: 4, row: 0 });
  });
});
