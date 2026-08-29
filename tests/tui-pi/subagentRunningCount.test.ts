import { describe, expect, it } from 'vitest';
import { visibleWidth } from '@earendil-works/pi-tui';
import { Transcript } from '../../src/tui-pi/Transcript.js';
import type { DisplayItem } from '../../src/chat/types.js';

/**
 * 头部并行计数。
 *
 * 锁三件事：≥2 才显示（单个不显示）、计数随 start/end 变化、计数是每帧热变更
 * 不能递增 structVer（否则前缀缓存每帧失效，冻结形同虚设——这是本特性最容易
 * 悄悄搞坏性能的地方，故单独用变异测试验证）。
 */
const W = 80;
const note = (text: string): DisplayItem => ({ kind: 'note', text });
const spawn = (id: string): DisplayItem =>
  ({ kind: 'tool', id, name: 'spawn_agent', input: {}, status: 'running' }) as DisplayItem;

const render = (t: Transcript): string => t.render(W).join('\n');
const structVerOf = (t: Transcript): number =>
  (t as unknown as { structVer: number }).structVer;

describe('Transcript 头部并行子 agent 计数', () => {
  it('0 或 1 个运行中：不显示计数行', () => {
    const t = new Transcript();
    t.push(note('正文'));
    expect(render(t)).not.toContain('并行运行');

    t.setRunningSubagents(1);
    expect(render(t)).not.toContain('并行运行');
  });

  it('≥2 个：显示「并行运行 N 个子 agent」', () => {
    const t = new Transcript();
    t.push(spawn('toolu_a'));
    t.push(spawn('toolu_b'));
    t.setRunningSubagents(2);
    expect(render(t)).toContain('并行运行 2 个子 agent');

    t.setRunningSubagents(5);
    expect(render(t)).toContain('并行运行 5 个子 agent');
  });

  it('计数归零后计数行消失', () => {
    const t = new Transcript();
    t.setRunningSubagents(3);
    expect(render(t)).toContain('并行运行');
    t.setRunningSubagents(0);
    expect(render(t)).not.toContain('并行运行');
  });

  it('负数被钳到 0（事件乱序 / 重复 end 不得压成负数）', () => {
    const t = new Transcript();
    t.setRunningSubagents(-5);
    expect(t.runningSubagentCount()).toBe(0);
    expect(render(t)).not.toContain('并行运行');
  });

  it('计数变化不递增 structVer（保住前缀冻结）', () => {
    const t = new Transcript();
    t.push(spawn('toolu_a'));
    t.push(spawn('toolu_b'));
    // 冷帧建立前缀缓存
    render(t);
    const ver0 = structVerOf(t);
    // 计数热变更：值变了、版本号不能变
    t.setRunningSubagents(2);
    expect(t.runningSubagentCount()).toBe(2);
    expect(structVerOf(t)).toBe(ver0);
    t.setRunningSubagents(4);
    expect(structVerOf(t)).toBe(ver0);
    // 同值重复设置直接返回，也不动版本号
    t.setRunningSubagents(4);
    expect(structVerOf(t)).toBe(ver0);
  });

  it('计数行与折叠提示行共存，不互相覆盖', () => {
    const t = new Transcript();
    t.push(spawn('toolu_a'));
    t.push(spawn('toolu_b'));
    t.setRunningSubagents(3);
    // 模拟已有折叠提示（结构变化产生）
    (t as unknown as { foldedBlocks: number }).foldedBlocks = 2;
    const text = render(t);
    expect(text).toContain('并行运行 3 个子 agent');
    expect(text).toContain('本轮 2 个条目已折叠');
  });

  it('窄终端下计数行被截断到 width，不溢出', () => {
    // 按可见宽度而非字节长度断言：头部行带 ANSI dim 码，\u001b[0m 等占字节不占显示宽度，
    // 按 l.length 算会把「截断正确」误判成溢出（初版就是这么误报的）。
    const t = new Transcript();
    t.setRunningSubagents(9);
    const lines = t.render(20);
    expect(lines.every((l) => visibleWidth(l) <= 20)).toBe(true);
  });
});
