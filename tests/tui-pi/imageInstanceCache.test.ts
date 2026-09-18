/**
 * 图片实例去重缓存测试。
 *
 * 去重的单位是 Image 实例（不是 imageId）：pi-tui 的 kitty 去重以实例为界——
 * 实例的行缓存让重复渲染不再重新注册 metadata，imageId 的 generation 不变，
 * TUI 全量重绘时才降级为 placement-only。同内容同尺寸必须拿回同一实例。
 *
 * 断言口径：两个 ItemBlock（模拟会话切换重建）渲染同一张图，产出的 kitty
 * 传输行里的 i= 相同（同一实例 → 同一 id）。
 */
import { afterEach, describe, expect, it } from 'vitest';
import { getCapabilities, resetCapabilitiesCache, setCapabilities } from '@earendil-works/pi-tui';
import { ItemBlock } from '../../src/tui-pi/blocks.js';
import type { DisplayItem } from '../../src/chat/types.js';

const PNG_A = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const PNG_B = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

afterEach(() => {
  resetCapabilitiesCache();
});

/** 从渲染行里抠 kitty 传输序列的 imageId（i=<n>）。 */
function kittyImageId(line: string): string | undefined {
  const m = /(?:^|,)i=(\d+)(?:,|;)/.exec(line);
  return m?.[1];
}

function userItem(png: string): DisplayItem {
  return { kind: 'user', text: '图', images: [{ id: 1, base64: png, mediaType: 'image/png', width: 4, height: 4, placeholder: '[图]' }] };
}

function toolItem(png: string): DisplayItem {
  return {
    kind: 'tool',
    name: 'read_media',
    input: { path: '/x.png' },
    status: 'ok',
    result: 'ok',
    resultImages: [{ mediaType: 'image/png', base64: png }],
  };
}

describe('图片实例去重', () => {
  it('同内容同尺寸：两个 ItemBlock 渲染同一张图，kitty 行带同一 imageId', () => {
    setCapabilities({ images: 'kitty', trueColor: true, hyperlinks: true });
    const a = new ItemBlock(userItem(PNG_A)).render(80).join('\n');
    const b = new ItemBlock(userItem(PNG_A)).render(80).join('\n');
    const idA = kittyImageId(a.split('\n').find((l) => l.includes('\x1b_G')) ?? '');
    const idB = kittyImageId(b.split('\n').find((l) => l.includes('\x1b_G')) ?? '');
    expect(idA).toBeDefined();
    expect(idB).toBeDefined();
    expect(idB).toBe(idA); // 同一实例 → 同一 id，TUI 才能把它降级成 placement
  });

  it('不同内容的图拿不同 id', () => {
    setCapabilities({ images: 'kitty', trueColor: true, hyperlinks: true });
    const a = new ItemBlock(userItem(PNG_A)).render(80).join('\n');
    const b = new ItemBlock(userItem(PNG_B)).render(80).join('\n');
    const idA = kittyImageId(a.split('\n').find((l) => l.includes('\x1b_G')) ?? '');
    const idB = kittyImageId(b.split('\n').find((l) => l.includes('\x1b_G')) ?? '');
    expect(idB).not.toBe(idA);
  });

  it('同一工具结果重建 ItemBlock 后仍是同一 id（会话切换不重传数据）', () => {
    setCapabilities({ images: 'kitty', trueColor: true, hyperlinks: true });
    const first = new ItemBlock(toolItem(PNG_A)).render(80).join('\n');
    // 会话切换 = Transcript 重建、ItemBlock 全新，但图片实例走模块缓存
    const second = new ItemBlock(toolItem(PNG_A)).render(80).join('\n');
    const id1 = kittyImageId(first.split('\n').find((l) => l.includes('\x1b_G')) ?? '');
    const id2 = kittyImageId(second.split('\n').find((l) => l.includes('\x1b_G')) ?? '');
    expect(id1).toBeDefined();
    expect(id2).toBe(id1);
  });

  it('同内容不同渲染尺寸各拿各的 id（placement 控制参数随尺寸走）', () => {
    setCapabilities({ images: 'kitty', trueColor: true, hyperlinks: true });
    // 用户回显（缩进 2）与工具结果（缩进 4）的 maxWidthCells 不同，
    // 同一张图在两个位置本就该有各自的 placement 尺寸
    const userLines = new ItemBlock(userItem(PNG_A)).render(80).join('\n');
    const toolLines = new ItemBlock(toolItem(PNG_A)).render(80).join('\n');
    const idU = kittyImageId(userLines.split('\n').find((l) => l.includes('\x1b_G')) ?? '');
    const idT = kittyImageId(toolLines.split('\n').find((l) => l.includes('\x1b_G')) ?? '');
    expect(idT).not.toBe(idU);
  });

  it('重渲染（宽度不变）产出行完全一致（实例行缓存生效）', () => {
    setCapabilities({ images: 'kitty', trueColor: true, hyperlinks: true });
    const block = new ItemBlock(userItem(PNG_A));
    const first = block.render(80).join('\n');
    block.invalidate();
    const second = block.render(80).join('\n');
    expect(second).toBe(first);
  });

  it('无图片能力的终端仍走占位降级（去重不影响降级路径）', () => {
    setCapabilities({ images: null, trueColor: true, hyperlinks: true });
    const lines = new ItemBlock(userItem(PNG_A)).render(80);
    expect(lines.join('\n')).not.toContain('\x1b_G');
    expect(lines.join('\n')).toMatch(/image\/png|图片|image/i);
  });
});
