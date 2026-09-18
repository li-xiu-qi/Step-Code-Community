/**
 * 终端图片渲染的两段测试：WT 能力修正、贴图回显进转录。
 *
 * 不跑真实图片协议（需要 kitty 终端），用 setCapabilities 强制两条路径：
 * kitty 开（应出现 kitty 转义序列）与全关（应降级为文本占位）。
 */
import { afterEach, describe, expect, it } from 'vitest';
import { getCapabilities, resetCapabilitiesCache, setCapabilities } from '@earendil-works/pi-tui';
import { ItemBlock } from '../../src/tui-pi/blocks.js';
import type { DisplayItem } from '../../src/chat/types.js';
import type { ImageAttachment } from '../../src/chat/imageAttachment.js';

/** 1x1 红色 PNG（最小合法 base64）。 */
const PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

function att(id: number, w = 800, h = 600): ImageAttachment {
  return { id, base64: PNG_B64, mediaType: 'image/png', width: w, height: h, placeholder: `[image #${id} (${w}×${h})]` };
}

describe('贴图回显进转录', () => {
  afterEach(() => {
    resetCapabilitiesCache();
  });

  it('无图片能力的终端：降级为文本占位，不出现 kitty 序列', () => {
    setCapabilities({ images: null, trueColor: true, hyperlinks: true });
    const item: DisplayItem = { kind: 'user', text: '看这张图', images: [att(1)] };
    const lines = new ItemBlock(item).render(80);
    const joined = lines.join('\n');
    expect(joined).toContain('看这张图');
    expect(joined).not.toContain('\x1b_G'); // kitty 前缀
    // 降级文本含文件名/类型提示（imageFallback 的输出）
    expect(joined).toMatch(/image\/png|图片|image/i);
  });

  it('有 kitty 能力：图片行出现 kitty graphics 转义', () => {
    setCapabilities({ images: 'kitty', trueColor: true, hyperlinks: true });
    const item: DisplayItem = { kind: 'user', text: '看图', images: [att(1)] };
    const lines = new ItemBlock(item).render(80);
    const joined = lines.join('\n');
    expect(joined).toContain('\x1b_G');
    // 文本仍在前，图片行追加在后
    expect(lines.findIndex((l) => l.includes('看图'))).toBeLessThan(lines.findIndex((l) => l.includes('\x1b_G')));
  });

  it('无 images 字段的普通消息不受影响', () => {
    setCapabilities({ images: 'kitty', trueColor: true, hyperlinks: true });
    const item: DisplayItem = { kind: 'user', text: '纯文本消息', turnNum: 1 };
    const lines = new ItemBlock(item).render(80);
    expect(lines.join('\n')).not.toContain('\x1b_G');
    expect(lines.join('\n')).toContain('纯文本消息');
  });

  it('多张图都渲染', () => {
    setCapabilities({ images: 'kitty', trueColor: true, hyperlinks: true });
    const item: DisplayItem = { kind: 'user', text: '两张', images: [att(1), att(2)] };
    const lines = new ItemBlock(item).render(80).join('\n');
    expect(lines.match(/\x1b_G/g)?.length ?? 0).toBeGreaterThanOrEqual(2);
  });

  it('恢复能力状态（防止污染后续测试）', () => {
    resetCapabilitiesCache();
    // 默认探测结果存在即可，具体值随环境
    expect(getCapabilities()).toBeDefined();
  });
});

describe('read_media 工具结果内联', () => {
  afterEach(() => {
    resetCapabilitiesCache();
  });

  const img = { mediaType: 'image/png', base64: PNG_B64 };

  it('read_media 结果带图：kitty 开时结果下方出现图片序列', () => {
    setCapabilities({ images: 'kitty', trueColor: true, hyperlinks: true });
    const item: DisplayItem = {
      kind: 'tool',
      id: 't1',
      name: 'read_media',
      input: { path: 'screenshot.png' },
      status: 'ok',
      result: '图片已读取（1920×1080）',
      resultImages: [img],
    };
    const lines = new ItemBlock(item).render(80);
    const joined = lines.join('\n');
    expect(joined).toContain('read_media');
    expect(joined).toContain('\x1b_G');
    // 图在结果文本之后
    expect(lines.findIndex((l) => l.includes('已读取'))).toBeLessThan(lines.findIndex((l) => l.includes('\x1b_G')));
  });

  it('无图片协议：降级为占位文本，不出转义序列', () => {
    setCapabilities({ images: null, trueColor: true, hyperlinks: true });
    const item: DisplayItem = {
      kind: 'tool',
      id: 't1',
      name: 'read_media',
      input: { path: 'screenshot.png' },
      status: 'ok',
      result: '图片已读取',
      resultImages: [img],
    };
    const joined = new ItemBlock(item).render(80).join('\n');
    expect(joined).not.toContain('\x1b_G');
    expect(joined).toMatch(/image\/png|图片|image/i);
  });

  it('展开态（Ctrl+O）同样内联图片', () => {
    setCapabilities({ images: 'kitty', trueColor: true, hyperlinks: true });
    const item: DisplayItem = {
      kind: 'tool',
      id: 't1',
      name: 'read_media',
      input: { path: 'screenshot.png' },
      status: 'ok',
      result: '图片已读取',
      resultImages: [img],
    };
    const expanded = ItemBlock.renderExpanded(item as never, 80).join('\n');
    expect(expanded).toContain('\x1b_G');
  });

  it('无 resultImages 的普通工具不渲染图片', () => {
    setCapabilities({ images: 'kitty', trueColor: true, hyperlinks: true });
    const item: DisplayItem = {
      kind: 'tool',
      id: 't1',
      name: 'bash',
      input: { command: 'ls' },
      status: 'ok',
      result: 'a.txt',
    };
    expect(new ItemBlock(item).render(80).join('\n')).not.toContain('\x1b_G');
  });
});
