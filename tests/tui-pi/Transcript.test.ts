import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DisplayItem } from '../../src/chat/types.js';
import { ItemBlock } from '../../src/tui-pi/blocks.js';
import { Transcript } from '../../src/tui-pi/Transcript.js';

/** 计数每个块的 render() 被调用次数（非 renderItem），验证前缀是否被重复重渲。 */
let calls: { key: string; n: number }[] = [];
function tag(item: DisplayItem): string {
  return item.kind === 'note' ? item.text : item.kind === 'assistant' ? item.text : item.kind === 'user' ? item.text : '?';
}

beforeEach(() => {
  calls = [];
  const orig = ItemBlock.prototype.render;
  vi.spyOn(ItemBlock.prototype, 'render').mockImplementation(function (this: ItemBlock, width: number) {
    const k = tag(this.getItem());
    let e = calls.find((c) => c.key === k);
    if (e === undefined) { e = { key: k, n: 0 }; calls.push(e); }
    e.n++;
    return orig.call(this, width);
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

const W = 80;
const note = (text: string): DisplayItem => ({ kind: 'note', text });

describe('Transcript 冻结前缀', () => {
  it('冷帧：全部块各渲一次', () => {
    const t = new Transcript();
    t.push(note('a')); t.push(note('b')); t.push(note('c')); t.push(note('d'));
    t.render(W);
    expect(calls.map((c) => c.n)).toEqual([1, 1, 1, 1]);
  });

  it('尾块流式追加：前缀不重渲，仅尾块重渲', () => {
    const t = new Transcript();
    t.push(note('a')); t.push(note('b')); t.push(note('c')); t.push(note('d'));
    t.render(W); // 冷帧
    calls = [];
    t.update(-1, note('d2')); // 流式追加到尾块
    const lines = t.render(W);
    // 前缀 a/b/c 未被再次调用，仅尾块 d 重渲一次
    expect(calls.find((c) => c.key === 'a')?.n ?? 0).toBe(0);
    expect(calls.find((c) => c.key === 'b')?.n ?? 0).toBe(0);
    expect(calls.find((c) => c.key === 'c')?.n ?? 0).toBe(0);
    expect(calls.find((c) => c.key === 'd2')?.n).toBe(1);
    // 输出仍含全部正文
    expect(lines.join('\n')).toContain('d2');
  });

  it('连续多帧无变更：每帧仍只重渲尾块（前缀缓存持续命中）', () => {
    const t = new Transcript();
    t.push(note('a')); t.push(note('b')); t.push(note('c')); t.push(note('d'));
    t.render(W);
    calls = [];
    t.render(W); t.render(W);
    const total = calls.reduce((s, c) => s + c.n, 0);
    expect(total).toBe(2); // 两帧 × 每帧仅尾块 1 次
  });

  it('width 变化：前缀缓存失效，全部块重渲', () => {
    const t = new Transcript();
    t.push(note('a')); t.push(note('b')); t.push(note('c')); t.push(note('d'));
    t.render(W);
    calls = [];
    t.render(W + 20);
    expect(calls.reduce((s, c) => s + c.n, 0)).toBe(4);
  });

  it('非尾块回填：前缀失效，全部块重渲', () => {
    const t = new Transcript();
    t.push(note('a')); t.push(note('b')); t.push(note('c')); t.push(note('d'));
    t.render(W);
    calls = [];
    t.update(0, note('a2')); // 改非尾块
    t.render(W);
    expect(calls.reduce((s, c) => s + c.n, 0)).toBe(4);
  });

  it('push 新块：结构变化使前缀失效', () => {
    const t = new Transcript();
    t.push(note('a')); t.push(note('b')); t.push(note('c')); t.push(note('d'));
    t.render(W);
    calls = [];
    t.push(note('e'));
    t.render(W);
    expect(calls.reduce((s, c) => s + c.n, 0)).toBe(5);
  });

  it('reset 后前缀重建，内容为最新', () => {
    const t = new Transcript();
    t.push(note('a')); t.push(note('b')); t.push(note('c')); t.push(note('d'));
    t.render(W);
    t.reset([note('x'), note('y')]);
    const lines = t.render(W).join('\n');
    expect(lines).toContain('x');
    expect(lines).toContain('y');
    expect(lines).not.toMatch(/[abcd]/); // 旧块内容已被 reset 替换
  });

  it('assistant（Markdown）块在冻结前缀中正常渲染', () => {
    const t = new Transcript();
    t.push(note('a'));
    t.push({ kind: 'assistant', text: '**加粗** 正文' });
    t.push(note('c'));
    const lines = t.render(W).join('\n');
    expect(lines).toContain('正文');
  });
});

describe('Transcript retractFrom（PreOutput 拦截撤回残文）', () => {
  it('撤回从 index 起的块，保留之前的内容', () => {
    const t = new Transcript();
    t.push({ kind: 'user', text: '提问' });
    t.push({ kind: 'thinking', text: '思考' });
    t.push({ kind: 'assistant', text: '带破折号的正文' });
    t.retractFrom(1);
    expect(t.items().map((it) => it.kind)).toEqual(['user']);
  });

  it('撤回后渲染不再含被撤内容（structVer 让冻结前缀缓存失效）', () => {
    const t = new Transcript();
    t.push({ kind: 'user', text: '提问' });
    t.push({ kind: 'assistant', text: '违规正文' });
    t.render(W); // 冷帧，建前缀缓存
    t.retractFrom(1);
    const lines = t.render(W).join('\n');
    expect(lines).toContain('提问');
    expect(lines).not.toContain('违规正文');
  });

  it('越界与负下标为空操作，不抛错', () => {
    const t = new Transcript();
    t.push(note('a'));
    t.retractFrom(99);
    t.retractFrom(-5);
    expect(t.items()).toHaveLength(1);
  });

  it('被撤块被 dispose（释放渲染缓存）', () => {
    const t = new Transcript();
    t.push(note('a'));
    t.push(note('b'));
    const disposes: number[] = [];
    const orig = ItemBlock.prototype.dispose;
    vi.spyOn(ItemBlock.prototype, 'dispose').mockImplementation(function (this: ItemBlock) {
      disposes.push(1);
      orig.call(this);
    });
    t.retractFrom(1);
    expect(disposes).toHaveLength(1);
  });
});
