import { describe, expect, it } from 'vitest';
import type { SessionMeta } from '../../src/session/store.js';
import { agentItems } from '../../src/tui-pi/pickers.js';

/**
 * `/agents` 候选项构造。
 *
 * 锁三件事：状态标记映射、层级缩进、归属标记。这三者是子 agent 列表的辨认基础——
 * 错了不会崩，只会让用户看不出「哪个在跑」「哪个是我能接管的」「哪个是下层的」。
 */
const now = Date.parse('2026-08-29T12:00:00Z');
const mk = (over: Partial<SessionMeta> & { id: string }): SessionMeta =>
  ({
    cwd: '/tmp',
    model: 'm',
    createdAt: '2026-08-29T10:00:00Z',
    updatedAt: '2026-08-29T11:00:00Z',
    messageCount: 5,
    status: 'done',
    ...over,
  }) as SessionMeta;

const plain = (s: string): string => s.replace(/\u001b\[[0-9;]*m/g, '');

describe('agentItems：/agents 候选项', () => {
  it('状态标记映射：running/done/error/aborted/未知', () => {
    const rows = agentItems([
      mk({ id: 'a', status: 'running' }),
      mk({ id: 'b', status: 'done' }),
      mk({ id: 'c', status: 'error' }),
      mk({ id: 'd', status: 'aborted' }),
    ], now).map((it) => plain(it.label));
    expect(rows[0]).toMatch(/^●/);
    expect(rows[1]).toMatch(/^✓/);
    expect(rows[2]).toMatch(/^✗/);
    expect(rows[3]).toMatch(/^○/);
  });

  it('未知状态不崩，落到中性点', () => {
    const [row] = agentItems([mk({ id: 'a', status: undefined })], now);
    expect(plain(row!.label)).toMatch(/^·/);
  });

  it('角色名上色且缺省为 general', () => {
    const [typed, bare] = agentItems([
      mk({ id: 'a', agentType: 'explore' }),
      mk({ id: 'b', agentType: undefined }),
    ], now);
    // 去掉 ANSI 后角色名仍在（上色是装饰，锁可读内容）
    expect(plain(typed!.label)).toContain('explore');
    expect(plain(bare!.label)).toContain('general');
  });

  it('层级缩进：depth 每深一层多 2 空格', () => {
    const rows = agentItems([
      mk({ id: 'top' }),
      mk({ id: 'mid', depth: 1 }),
      mk({ id: 'leaf', depth: 2 }),
    ], now).map((it) => plain(it.label));
    // 去掉状态标记与角色名前缀，比前缀空格数
    const lead = (s: string): number => (s.match(/^ */)?.[0].length ?? 0);
    expect(lead(rows[0]!)).toBe(0);
    expect(lead(rows[1]!)).toBe(2);
    expect(lead(rows[2]!)).toBe(4);
  });

  it('归属标记：user 可接管，agent 只读', () => {
    const [mine, theirs] = agentItems([
      mk({ id: 'a', owner: 'user' }),
      mk({ id: 'b', owner: 'agent' }),
    ], now);
    expect(plain(mine!.description!)).toContain('可接管');
    expect(plain(theirs!.description!)).toContain('只读');
  });

  it('缺省 owner 按只读（默认锁死，不主动放开）', () => {
    const [row] = agentItems([mk({ id: 'a', owner: undefined })], now);
    expect(plain(row!.description!)).toContain('只读');
  });

  it('description 带相对时间、消息数与 id 前缀', () => {
    const [row] = agentItems([mk({ id: 'abcdef123456', messageCount: 42 })], now);
    const d = plain(row!.description!);
    expect(d).toContain('42');
    expect(d).toContain('abcdef12');
  });

  it('标题取 name ?? title ?? preview ?? id 前缀', () => {
    const [named, titled, prev, bare] = agentItems([
      mk({ id: 'id-aaaaaaa1', name: '我的任务' }),
      mk({ id: 'id-bbbbbbb2', title: '派生标题' }),
      mk({ id: 'id-ccccccc3', preview: '首条消息预览内容' }),
      mk({ id: 'id-ddddddd4' }),
    ], now);
    expect(plain(named!.label)).toContain('我的任务');
    expect(plain(titled!.label)).toContain('派生标题');
    expect(plain(prev!.label)).toContain('首条消息预览内容');
    expect(plain(bare!.label)).toContain('id-ddddd');
  });

  it('空列表返回空数组，不抛错', () => {
    expect(agentItems([], now)).toEqual([]);
  });

  it('不修改入参数组', () => {
    const input = [mk({ id: 'a' })];
    agentItems(input, now);
    expect(input).toHaveLength(1);
    expect(input[0]!.id).toBe('a');
  });
});
