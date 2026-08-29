import { describe, expect, it } from 'vitest';
import { ItemBlock, SUBAGENT_FOLD_THRESHOLD } from '../../src/tui-pi/blocks.js';
import { Transcript } from '../../src/tui-pi/Transcript.js';
import type { DisplayItem } from '../../src/chat/types.js';

/**
 * 并行子 agent 卡片折叠。
 *
 * 锁三件事：达到阈值折成一行、单个/终态不折、折叠不破坏 Ctrl+O 的完整形态。
 * 第三个是这条特性的隐含契约——折叠只改卡片自身的 renderTool 分支，renderExpanded
 * 是另一条路，若哪天有人「顺手统一一下」，用户就再也看不到子工具列表了。
 */
const now = Date.now();
const mk = (over: {
  id?: string;
  status?: 'running' | 'ok' | 'error';
  parallel?: number;
  subagentType?: string;
  description?: string;
  tokens?: number;
  tools?: { name: string; status: 'running' | 'ok' | 'error' }[];
} = {}): DisplayItem =>
  ({
    kind: 'tool',
    id: over.id ?? 'toolu_a',
    name: 'spawn_agent',
    input: { description: '统计 TODO' },
    status: over.status ?? 'running',
    startedAt: now - 12_000,
    subagentType: over.subagentType ?? 'explore',
    description: over.description ?? '统计 TODO',
    subagentParallel: over.parallel,
    subagentTokens: over.tokens,
    subagentToolEvents: over.tools ?? [
      { name: 'web_search', status: 'ok' },
      { name: 'read_file', status: 'running' },
    ],
  }) as DisplayItem;

const plain = (lines: string[]): string => lines.join('\n').replace(/\u001b\[[0-9;]*m/g, '');

describe('并行子 agent 卡片折叠', () => {
  it(`并行数 < 阈值（${SUBAGENT_FOLD_THRESHOLD}）时完整展开`, () => {
    const one = plain(new ItemBlock(mk({ parallel: 1 })).render(80));
    expect(one).toContain('✓ web_search');
    expect(one).toContain('read_file');
    expect(one.split('\n').length).toBeGreaterThan(1);
  });

  it(`并行数 >= 阈值时折成一行`, () => {
    const lines = plain(new ItemBlock(mk({ parallel: SUBAGENT_FOLD_THRESHOLD })).render(80));
    expect(lines.split('\n')).toHaveLength(1);
    // 一行里仍带关键信息：角色、描述、工具数、当前工具
    expect(lines).toContain('explore');
    expect(lines).toContain('统计 TODO');
    expect(lines).toContain('2 tools');
    expect(lines).toContain('read_file');
  });

  it('并行数远超阈值也只出一行', () => {
    const lines = plain(new ItemBlock(mk({ parallel: 20 })).render(80));
    expect(lines.split('\n')).toHaveLength(1);
  });

  it('单个运行中（parallel=1）不折叠——单任务折叠是纯信息损失', () => {
    const lines = new ItemBlock(mk({ parallel: 1 })).render(80);
    expect(plain(lines).split('\n').length).toBeGreaterThan(1);
  });

  it('终态卡片不折叠（回看时要能看清用了哪些工具）', () => {
    const done = plain(new ItemBlock(mk({ status: 'ok', parallel: 9 })).render(80));
    expect(done.split('\n').length).toBeGreaterThan(1);
    expect(done).toContain('2 个子工具调用');
  });

  it('并行数缺省（undefined）不折叠，不当 0 触发', () => {
    const lines = plain(new ItemBlock(mk({})).render(80));
    expect(lines.split('\n').length).toBeGreaterThan(1);
  });

  it('无角色无描述时折叠行仍合法（不出现多余分隔符）', () => {
    const bare = plain(
      new ItemBlock(
        mk({ parallel: 5, subagentType: undefined, description: undefined, tokens: undefined, tools: undefined }),
      ).render(80),
    );
    expect(bare.split('\n')).toHaveLength(1);
    expect(bare).toContain('spawn_agent');
    expect(bare).not.toContain('undefined');
    expect(bare).not.toMatch(/·\s*·/); // 无连续分隔符
  });

  it('renderExpanded 现状：终态 spawn_agent 也只有头部行（子工具列表未接）', () => {
    // 这条锁的是一个**已知缺口**，不是期望行为。renderExpanded 走 renderToolExpanded，
    // 后者只渲染 result 体、从不输出 subagentToolEvents。所以 Ctrl+O 看终态子 agent
    // 也看不到它调过哪些工具——折叠后这个信息在主界面同样只剩一行计数。
    // 要兑现「折叠不丢信息」，得让 renderToolExpanded 也画子工具列表，那是另一个改动。
    // 这里先锁住现状，免得将来有人以为已经支持而写出依赖它的断言。
    const done = mk({ status: 'ok', parallel: 9, tools: [
      { name: 'grep', status: 'ok' },
      { name: 'glob', status: 'ok' },
    ] }) as Extract<DisplayItem, { kind: 'tool' }>;
    const expanded = plain(ItemBlock.renderExpanded(done, 80));
    expect(expanded).toContain('spawn_agent');
    expect(expanded).not.toContain('grep');
  });

  it('窄终端下折叠行被截断到 width，不溢出', () => {
    const lines = new ItemBlock(mk({ parallel: 9 })).render(30);
    expect(lines.every((l) => l.replace(/\u001b\[[0-9;]*m/g, '').length <= 30)).toBe(true);
  });
});

describe('Transcript.setSubagentParallel：广播给所有卡片', () => {
  const card = (id: string): DisplayItem =>
    ({ kind: 'tool', id, name: 'spawn_agent', input: {}, status: 'running', startedAt: now }) as DisplayItem;

  const cards = (t: import('../../src/tui-pi/Transcript.js').Transcript): Record<string, DisplayItem> => {
    const blocks = (t as unknown as { blocks: { getItem: () => DisplayItem }[] }).blocks;
    const out: Record<string, DisplayItem> = {};
    for (const b of blocks) {
      const it = b.getItem();
      if (it.kind === 'tool') out[it.id] = it;
    }
    return out;
  };

  it('并行数写进每一张 spawn_agent 卡片', () => {
    
    const t = new Transcript();
    t.push(card('toolu_a'));
    t.push(card('toolu_b'));
    t.push({ kind: 'note', text: '普通 note' } as DisplayItem);
    t.setSubagentParallel(4);
    const c = cards(t);
    expect((c['toolu_a'] as { subagentParallel?: number }).subagentParallel).toBe(4);
    expect((c['toolu_b'] as { subagentParallel?: number }).subagentParallel).toBe(4);
  });

  it('非 spawn_agent 卡片不被写入该字段', () => {
    
    const t = new Transcript();
    t.push(card('toolu_a'));
    t.push({ kind: 'note', text: '普通 note' } as DisplayItem);
    t.setSubagentParallel(3);
    const c = cards(t);
    expect((c as unknown as Record<string, { subagentParallel?: number }>)['普通 note']).toBeUndefined();
  });

  it('并行数变化递增 structVer（卡片行数变了，前缀必须重算）', () => {
    
    const t = new Transcript();
    t.push(card('toolu_a'));
    t.render(80); // 冷帧，建立前缀缓存
    const ver = (t as unknown as { structVer: number }).structVer;
    t.setSubagentParallel(3);
    expect((t as unknown as { structVer: number }).structVer).toBeGreaterThan(ver);
  });

  it('同值重复调用不递增 structVer（避免每帧无谓重算前缀）', () => {
    
    const t = new Transcript();
    t.push(card('toolu_a'));
    t.setSubagentParallel(3);
    const ver = (t as unknown as { structVer: number }).structVer;
    t.setSubagentParallel(3);
    expect((t as unknown as { structVer: number }).structVer).toBe(ver);
  });

  it('负数钳到 0：不折叠且不抛错', () => {
    // 断言渲染结果而非字段值：卡片初始 subagentParallel 是 undefined，钳到 0 与 undefined
    // 在渲染层等价（?? 0 >= THRESHOLD 同为假）。锁字段值会把实现细节钉死。
    const t = new Transcript();
    t.push(card('toolu_a'));
    t.setSubagentParallel(-3);
    expect(t.runningSubagentCount()).toBe(0);
    expect(plain(new ItemBlock(cards(t)['toolu_a']!).render(80)).split('\n').length).toBeGreaterThan(1);
  });
});
