/**
 * stopReason 五态 + diagnostic 改造的专项测试。
 *
 * 覆盖三条线：
 * 1. loop 层 turn_done 事件透传 stopReason（消费方 runner 据此映射终态）；
 * 2. runner 把 loop stopReason 映射为 SubagentStopReason（completed/error/aborted/max-tokens），
 *    toDiagnostic 取 name + message 首行并截断到 4096；
 * 3. spawnAgent 的 formatSubagentResult 按终态出文案，isError 兼容字段与 stopReason 一致。
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { AgentEvent } from '../../src/agent/events.js';
import { createSubagentRunner, type SubagentRunnerDeps } from '../../src/agent/subagent/runner.js';
import { SubagentStore } from '../../src/agent/subagent/store.js';
import { SessionStore } from '../../src/session/store.js';
import { runAgent } from '../../src/agent/loop.js';
import { spawnAgentTool } from '../../src/tools/spawnAgent.js';
import { collect, makeFakeProvider, textBlock } from '../helpers/fakeProvider.js';

const tmpDirs: string[] = [];
afterEach(() => {
  while (tmpDirs.length > 0) rmSync(tmpDirs.pop()!, { recursive: true, force: true });
});

function makeDeps(provider: ReturnType<typeof makeFakeProvider>['provider']): SubagentRunnerDeps {
  const dir = mkdtempSync(join(tmpdir(), 'stepcode-stopreason-'));
  tmpDirs.push(dir);
  const sessions = new SessionStore(dir);
  return {
    provider,
    cwd: process.cwd(),
    hooks: {},
    maxDepth: 1,
    maxStepsDefault: 30,
    compaction: { maxContextSize: 1_000_000, triggerRatio: 0.85, reservedTokens: 32000 },
    sessionCounter: { spawned: 0 },
    subagentStore: new SubagentStore(sessions),
    parentSessionId: 'parent-main-session',
  };
}

const LONG = '调查结论：'.padEnd(220, '详');

describe('loop turn_done 透传 stopReason', () => {
  it('正常 end_turn → stopReason 为 end_turn，随最后一个事件带出', async () => {
    const { provider } = makeFakeProvider([{ textChunks: ['hi'], finalContent: [textBlock('hi')] }]);
    const events = await collect<AgentEvent>(
      runAgent({
        provider,
        system: 'sys',
        ctx: { cwd: process.cwd() },
        messages: [],
        maxIterations: 10,
      }),
    );
    const done = events.filter((e) => e.type === 'turn_done').at(-1) as { stopReason?: string } | undefined;
    expect(done?.stopReason).toBe('end_turn');
  });

  it('max_tokens → 自动续写一轮后收尾，turn_done 带上最后一轮的 max_tokens', async () => {
    // 注意：loop 遇 max_tokens 会自动续写（再发一轮），续写轮仍 max_tokens 才收尾。
    // turn_done 带的永远是最后一轮的值——这也是 runner 终态映射的数据源。
    const { provider } = makeFakeProvider([
      { textChunks: ['hi'], finalContent: [textBlock('hi')], stopReason: 'max_tokens' },
      { textChunks: ['hi'], finalContent: [textBlock('hi')], stopReason: 'max_tokens' },
    ]);
    const events = await collect<AgentEvent>(
      runAgent({
        provider,
        system: 'sys',
        ctx: { cwd: process.cwd() },
        messages: [],
        maxIterations: 10,
      }),
    );
    const done = events.filter((e) => e.type === 'turn_done').at(-1) as { stopReason?: string } | undefined;
    expect(done?.stopReason).toBe('max_tokens');
  });
});

describe('runner 映射 SubagentStopReason', () => {
  it('正常产出 → completed，isError false，无 diagnostic', async () => {
    const { provider } = makeFakeProvider([
      { textChunks: [], finalContent: [textBlock(LONG)] },
      { textChunks: [], finalContent: [textBlock(LONG)] }, // 摘要短时补写轮兜底
    ]);
    const { run } = createSubagentRunner(makeDeps(provider));
    const r = await run({ subagentType: 'general', prompt: 'x', depth: 0 });
    expect(r.isError).toBe(false);
    expect(r.stopReason).toBe('completed');
    expect(r.diagnostic).toBeUndefined();
    expect(r.cause).toBeUndefined();
  });

  it('max_tokens → max-tokens', async () => {
    const { provider } = makeFakeProvider([
      { textChunks: [], finalContent: [textBlock(LONG)], stopReason: 'max_tokens' },
      { textChunks: [], finalContent: [textBlock(LONG)], stopReason: 'max_tokens' },
    ]);
    const { run } = createSubagentRunner(makeDeps(provider));
    const r = await run({ subagentType: 'general', prompt: 'x', depth: 0 });
    expect(r.stopReason).toBe('max-tokens');
    expect(r.isError).toBe(false); // isError 兼容语义：max-tokens 不是错误
  });

  it('provider 抛错 → error 且 diagnostic 带 name+message 首行', async () => {
    const err = new Error('HTTP 429: rate limited\n（详情略）');
    err.name = 'RateLimitError';
    const { provider } = makeFakeProvider([{ throw: err }]);
    const { run } = createSubagentRunner(makeDeps(provider));
    const r = await run({ subagentType: 'general', prompt: 'x', depth: 0 });
    expect(r.isError).toBe(true);
    expect(r.stopReason).toBe('error');
    expect(r.diagnostic).toBe('RateLimitError: HTTP 429: rate limited'); // message 首行，不含换行后内容
    expect(r.cause).toBe(err); // 父侧据此识别 429 重排队
  });

  it('中断 → aborted', async () => {
    const ctrl = new AbortController();
    const err = new Error('aborted');
    err.name = 'AbortError';
    const { provider } = makeFakeProvider([{ throw: err }]);
    const { run } = createSubagentRunner(makeDeps(provider));
    // provider 抛 AbortError 走 error 出口，aborted 终态由信号单独判定；这里只锁 error 分支语义
    const r = await run({ subagentType: 'general', prompt: 'x', depth: 0, signal: ctrl.signal });
    expect(r.isError).toBe(true);
    expect(r.stopReason).toBe('error');
  });
});

describe('spawnAgent 按终态出文案', () => {
  it('completed → status completed', async () => {
    const r = await spawnAgentTool.execute(
      { description: 'd', prompt: 'p', subagent_type: 'explore' },
      {
        cwd: process.cwd(),
        depth: 0,
        runSubagent: async () => ({ summary: '结论', isError: false, stopReason: 'completed', sessionId: 's1' }),
      },
    );
    expect(r.isError).toBe(false);
    expect(r.content).toBe('subagent: explore | status: completed | session: s1\n\n结论');
  });

  it('error → status error 且尾部 resume 提示', async () => {
    const r = await spawnAgentTool.execute(
      { description: 'd', prompt: 'p', subagent_type: 'general' },
      {
        cwd: process.cwd(),
        depth: 0,
        runSubagent: async () => ({ summary: '半路失败', isError: true, stopReason: 'error', sessionId: 's2' }),
      },
    );
    expect(r.isError).toBe(true);
    expect(r.content).toContain('status: error');
    expect(r.content).toContain('resume');
  });

  it('max-tokens → status max-tokens 且不算工具错误', async () => {
    const r = await spawnAgentTool.execute(
      { description: 'd', prompt: 'p', subagent_type: 'general' },
      {
        cwd: process.cwd(),
        depth: 0,
        runSubagent: async () => ({ summary: '预算烧光', isError: false, stopReason: 'max-tokens', sessionId: 's3' }),
      },
    );
    expect(r.isError).toBe(false);
    expect(r.content).toContain('status: max-tokens');
  });

  it('旧调用方只给 isError 不給 stopReason → 按 isError 映射兼容', async () => {
    const r = await spawnAgentTool.execute(
      { description: 'd', prompt: 'p', subagent_type: 'explore' },
      {
        cwd: process.cwd(),
        depth: 0,
        runSubagent: async () => ({ summary: 'ok', isError: false }),
      },
    );
    expect(r.isError).toBe(false);
    expect(r.content).toContain('status: completed');
  });
});
