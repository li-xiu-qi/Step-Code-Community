import type Anthropic from '@anthropic-ai/sdk';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { SubagentProgressEvent } from '../../src/agent/events.js';
import { createSubagentRunner, type SubagentRunnerDeps } from '../../src/agent/subagent/runner.js';
import { SubagentStore } from '../../src/agent/subagent/store.js';
import { SessionStore } from '../../src/session/store.js';
import { makeFakeProvider, textBlock } from '../helpers/fakeProvider.js';

/**
 * 并行子 agent 进度归属的 id 链路。
 *
 * 测的不是 updateById 本身（那是 Transcript 单测的地盘），而是「事件 id 与卡片 id 同源」这条
 * 链路：PiChat 的 applySubagentProgress 按 ev.id 找卡片，而卡片 id 来自 tool_start 的 tu.id。
 * 两者一旦分叉，归属就退化成 updateLastWhere 的近似（并行时进度互相覆盖）。
 * runTurn 的工具边界负责把 tu.id 注入 runner，本文件锁住的是 runner 侧的契约：
 * 传了 id 就用它，没传退回旧行为（计数器值），不引入第三种命名空间。
 */
const tmpDirs: string[] = [];
afterEach(() => {
  while (tmpDirs.length > 0) rmSync(tmpDirs.pop()!, { recursive: true, force: true });
});

function deps(onEvent?: (id: string | undefined, e: SubagentProgressEvent) => void): SubagentRunnerDeps {
  const dir = mkdtempSync(join(tmpdir(), 'stepcode-idlink-'));
  tmpDirs.push(dir);
  const sessions = new SessionStore(dir);
  return {
    provider: makeFakeProvider([{ textChunks: [], finalContent: [textBlock('完成')] }]).provider,
    cwd: process.cwd(),
    hooks: {},
    maxDepth: 1,
    maxStepsDefault: 10,
    compaction: { maxContextSize: 1_000_000, triggerRatio: 0.85, reservedTokens: 32000 },
    sessionCounter: { spawned: 0 },
    subagentStore: new SubagentStore(sessions),
    parentSessionId: 'parent-main',
    onEvent,
  };
}

const evIds = (events: SubagentProgressEvent[]): string[] =>
  events.map((e) => e.id);

describe('子 agent 进度事件 id 链路', () => {
  it('req.id 传入 → 全部事件携带该 id（与 tool_use id 同源）', async () => {
    const events: SubagentProgressEvent[] = [];
    const run = createSubagentRunner(deps((id, e) => { events.push(e); }));
    await run({ subagentType: 'general', prompt: '干活', depth: 0, id: 'toolu_01ABC123' });

    expect(events.length).toBeGreaterThan(0);
    expect(evIds(events).every((id) => id === 'toolu_01ABC123')).toBe(true);
    // start 事件必须也带 id，否则卡片刚挂上就收不到角色名/描述
    expect(events[0]).toMatchObject({ kind: 'start', id: 'toolu_01ABC123' });
  });

  it('两个并发 req.id 不同 → 事件流按 id 干净分离，无交叉', async () => {
    const eventsA: SubagentProgressEvent[] = [];
    const eventsB: SubagentProgressEvent[] = [];
    // 共用 onEvent 收集，靠 id 分流——模拟 PiChat 消费侧的真实分流方式
    const all: SubagentProgressEvent[] = [];
    const runA = createSubagentRunner(deps((_id, e) => all.push(e)));
    const runB = createSubagentRunner(deps((_id, e) => all.push(e)));

    await Promise.all([
      runA({ subagentType: 'explore', prompt: 'a', depth: 0, id: 'toolu_AAAA' }),
      runB({ subagentType: 'general', prompt: 'b', depth: 0, id: 'toolu_BBBB' }),
    ]);

    for (const e of all) {
      if (e.id === 'toolu_AAAA') eventsA.push(e);
      else if (e.id === 'toolu_BBBB') eventsB.push(e);
      else throw new Error(`事件 id 既不是 A 也不是 B：${e.id}`);
    }
    // 两个 id 都真的产生了事件（不是一边全空——那说明 id 注入失效）
    expect(eventsA.length).toBeGreaterThan(0);
    expect(eventsB.length).toBeGreaterThan(0);
  });

  it('不传 id（旧调用方）→ 退回计数器值，不抛错、不崩溃', async () => {
    const events: SubagentProgressEvent[] = [];
    const run = createSubagentRunner(deps((_id, e) => events.push(e)));
    await run({ subagentType: 'general', prompt: '干活', depth: 0 });

    expect(events.length).toBeGreaterThan(0);
    // 旧行为：id 是计数器字符串。本用例锁的是「不传时行为不回退到 undefined」，
    // 具体值不锁——计数器是递增的，锁值会让这条测试随并发执行顺序漂移。
    expect(events[0]!.id).toMatch(/\S/);
  });
});
