import { describe, expect, it } from 'vitest';
import type { DisplayItem } from '../../src/chat/types.js';
import { Transcript } from '../../src/tui-pi/Transcript.js';

const W = 80;

/** 造一张运行中的 spawn_agent 卡片（与 tool_start 事件的产物同形）。 */
function card(id: string, type: string): DisplayItem {
  return { kind: 'tool', id, name: 'spawn_agent', input: { subagent_type: type }, status: 'running', subagentType: type } as DisplayItem;
}

describe('Transcript.updateById：并行子 agent 进度归属', () => {
  it('按 id 命中目标卡片，不动其他卡片', () => {
    const t = new Transcript();
    t.push(card('toolu_a', 'explore'));
    t.push(card('toolu_b', 'reverse-engineer'));
    t.push(card('toolu_c', 'general'));

    const hit = t.updateById('toolu_b', (it) => ({ ...it, subagentTokens: 1234 } as DisplayItem));

    expect(hit).toBe(true);
    // 直接读块：命中目标拿到 token，两张旁观卡片原样未动
    const blocks = (t as unknown as { blocks: { getItem: () => DisplayItem }[] }).blocks;
    expect(blocks.map((b) => b.getItem().kind === 'tool' ? (b.getItem() as { subagentTokens?: number }).subagentTokens : null))
      .toEqual([undefined, 1234, undefined]);
  });

  it('id 不存在时返回 false，不抛错、不改动任何块', () => {
    const t = new Transcript();
    t.push(card('toolu_a', 'explore'));
    const blocks = (t as unknown as { blocks: { getItem: () => DisplayItem }[] }).blocks;
    const before = blocks[0]!.getItem();

    const hit = t.updateById('toolu_missing', (it) => ({ ...it, subagentTokens: 999 } as DisplayItem));

    expect(hit).toBe(false);
    expect(blocks[0]!.getItem()).toBe(before);
  });

  it('只按 tool 卡片匹配，同名 id 的 note 块不被误改', () => {
    const t = new Transcript();
    t.push(card('toolu_a', 'explore'));
    t.push({ kind: 'note', text: 'x' } as DisplayItem);

    const hit = t.updateById('x', (it) => ({ ...it, text: '改坏了' } as DisplayItem));

    expect(hit).toBe(false);
    const blocks = (t as unknown as { blocks: { getItem: () => DisplayItem }[] }).blocks;
    expect((blocks[1]!.getItem() as { text: string }).text).toBe('x');
  });

  it('并发交错写入：每个 id 只累积自己的进度', () => {
    const t = new Transcript();
    t.push(card('toolu_a', 'explore'));
    t.push(card('toolu_b', 'general'));

    // 模拟交错：a 用两次工具、b 用一次，然后各自的 usage
    t.updateById('toolu_a', (it) => ({ ...it, subagentToolEvents: [{ name: 'web_search', status: 'ok' }] } as DisplayItem));
    t.updateById('toolu_b', (it) => ({ ...it, subagentToolEvents: [{ name: 'bash', status: 'ok' }] } as DisplayItem));
    t.updateById('toolu_a', (it) => ({ ...it, subagentToolEvents: [...(it as { subagentToolEvents: unknown[] }).subagentToolEvents, { name: 'read_file', status: 'ok' }] } as DisplayItem));
    t.updateById('toolu_b', (it) => ({ ...it, subagentTokens: 500 } as DisplayItem));
    t.updateById('toolu_a', (it) => ({ ...it, subagentTokens: 800 } as DisplayItem));

    const blocks = (t as unknown as { blocks: { getItem: () => DisplayItem }[] }).blocks;
    const a = blocks[0]!.getItem() as { subagentToolEvents: { name: string }[]; subagentTokens?: number };
    const b = blocks[1]!.getItem() as { subagentToolEvents: { name: string }[]; subagentTokens?: number };
    expect(a.subagentToolEvents.map((e) => e.name)).toEqual(['web_search', 'read_file']);
    expect(a.subagentTokens).toBe(800);
    expect(b.subagentToolEvents.map((e) => e.name)).toEqual(['bash']);
    expect(b.subagentTokens).toBe(500);
  });
});
