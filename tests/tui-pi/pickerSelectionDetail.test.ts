import { describe, expect, it } from 'vitest';
import type { SelectItem } from '@earendil-works/pi-tui';
import { PickerOverlay } from '../../src/tui-pi/pickers.js';

/**
 * PickerOverlay 的「详情随选中项变」能力。
 *
 * 这条是为 /agents 加的通用能力：原来 subtitle 是构造时定死的，表达不了随选项变化的内容。
 * 锁两件事：选中变化会通知消费方；setSubtitle 能改详情行且进入渲染输出。
 */
const strip = (s: string): string => s.replace(/\u001b\[[0-9;]*m/g, '');
const items: SelectItem[] = [
  { value: 'a', label: '第一项', description: '描述 A' },
  { value: 'b', label: '第二项', description: '描述 B' },
  { value: 'c', label: '第三项', description: '描述 C' },
];

const mk = (onSelectionChange?: (item: SelectItem | null) => void): PickerOverlay =>
  new PickerOverlay({
    title: '测试面板',
    items,
    requestRender: () => {},
    onSelect: () => {},
    onCancel: () => {},
    onSelectionChange,
  });

describe('PickerOverlay 选中变化通知', () => {
  it('↑↓ 移动时回调拿到当前选中项', () => {
    const seen: Array<SelectItem | null> = [];
    const ov = mk((item) => seen.push(item));
    ov.handleInput('\x1b[B'); // down
    ov.handleInput('\x1b[B'); // down
    // 每次移动都通知（消费方据此更新详情），最后停在第三项
    expect(seen.length).toBeGreaterThanOrEqual(2);
    expect(seen.at(-1)?.value).toBe('c');
  });

  it('未提供回调时不抛错（既有选择器不受影响）', () => {
    const ov = mk(undefined);
    expect(() => ov.handleInput('\x1b[B')).not.toThrow();
  });

  it('过滤后重建列表也会通知', () => {
    const seen: Array<SelectItem | null> = [];
    const ov = mk((item) => seen.push(item));
    // 逐字符输入（真实键盘路径）：候选收窄到「第二项」
    for (const ch of '二') ov.handleInput(ch);
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.at(-1)?.value).toBe('b');
  });

  it('过滤到空候选时通知 null，不抛错', () => {
    const seen: Array<SelectItem | null> = [];
    const ov = mk((item) => seen.push(item));
    // 逐字符输入：真实键盘是一键一字符，handleInput 的契约也是单字符。
    // （整串传入 SelectList 会静默失效——那是另一个健壮性问题，此处不测。）
    for (const ch of '不存在的词') ov.handleInput(ch);
    expect(seen.at(-1)).toBeNull();
  });
});

describe('PickerOverlay.setSubtitle', () => {
  it('设置的详情行出现在渲染输出里', () => {
    const ov = mk(undefined);
    const out = strip(ov.render(80).join('\n'));
    expect(out).not.toContain('动态详情');
    ov.setSubtitle('动态详情内容');
    expect(strip(ov.render(80).join('\n'))).toContain('动态详情内容');
  });

  it('传 undefined 清掉详情行', () => {
    const ov = mk(undefined);
    ov.setSubtitle('临时详情');
    expect(strip(ov.render(80).join('\n'))).toContain('临时详情');
    ov.setSubtitle(undefined);
    expect(strip(ov.render(80).join('\n'))).not.toContain('临时详情');
  });

  it('消费方在回调里调 setSubtitle 能生效（/agents 的用法）', () => {
    const ov = mk((item) => {
      ov.setSubtitle(item === null ? undefined : `详情：${item.value}`);
    });
    ov.handleInput('\x1b[B'); // down → 第二项
    const out = strip(ov.render(80).join('\n'));
    expect(out).toContain('详情：b');
  });

  it('详情行被截断到 width，不溢出', () => {
    const ov = mk(undefined);
    ov.setSubtitle('x'.repeat(200));
    const lines = ov.render(30);
    expect(lines.every((l) => strip(l).length <= 30)).toBe(true);
  });
});
