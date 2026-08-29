import type Anthropic from '@anthropic-ai/sdk';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { SubagentProgressEvent } from '../../src/agent/events.js';
import type { ToolContext } from '../../src/tools/types.js';
import { runAgent } from '../../src/agent/loop.js';
import { stored, type StoredMessage } from '../../src/agent/message.js';
import { collect, makeFakeProvider, textBlock, toolUseBlock } from '../helpers/fakeProvider.js';
import { Transcript } from '../../src/tui-pi/Transcript.js';
import type { DisplayItem } from '../../src/chat/types.js';

/**
 * 端到端验收：一轮里派 3 个并发 spawn_agent，进度事件能否各自归属到自己的卡片。
 *
 * 这是「用户看到的现象」的直接复现路径，比单测 runner 或单测 updateById 都更接近真实现场：
 * runTurn 注入 tu.id → runner 用 sid 发事件 → 消费方按 ev.id 找卡片。
 * 任一段分叉都会让某些卡片停在无统计段的一行（用户原话：「有的有有的没有」）。
 */
const tmpDirs: string[] = [];
afterEach(() => {
  while (tmpDirs.length > 0) rmSync(tmpDirs.pop()!, { recursive: true, force: true });
});

function sm(text: string): StoredMessage {
  return stored({ role: 'user', content: text }, { kind: 'user' });
}

describe('并发 spawn_agent 进度归属（端到端）', () => {
  it('3 个并行子 agent：事件按 tool_use id 分离，各自卡片拿到自己的 token/工具数', async () => {
    const events: SubagentProgressEvent[] = [];
    // 假 runner：每个子 agent 报一组刻意不同的进度（id 由 runTurn 注入，runner 原样透传）
    const fakeRunSubagent = async (req: { id?: string; subagentType?: string }): Promise<never> => {
      const id = req.id!;
      const type = req.subagentType ?? 'general';
      events.push({ kind: 'start', id, subagentType: type, description: `任务-${id}` });
      events.push({ kind: 'tool', id, name: 'grep' });
      events.push({ kind: 'usage', id, tokens: id === 'c1' ? 111 : id === 'c2' ? 222 : 333 });
      events.push({ kind: 'end', id, isError: false, summary: 'ok', toolUses: 1, durationMs: 1000, sessionId: `sess-${id}` });
      throw new Error('fake runner：只产事件，不返回'); // 让 spawn_agent 走 isError 分支，不影响事件收集
    };

    const { provider } = makeFakeProvider([
      {
        textChunks: [],
        finalContent: [
          toolUseBlock('c1', 'spawn_agent', { subagent_type: 'explore', prompt: 'a', description: '任务A' }),
          toolUseBlock('c2', 'spawn_agent', { subagent_type: 'explore', prompt: 'b', description: '任务B' }),
          toolUseBlock('c3', 'spawn_agent', { subagent_type: 'general', prompt: 'c', description: '任务C' }),
        ],
      },
      { textChunks: ['完成'], finalContent: [textBlock('完成')] },
    ]);

    const dir = mkdtempSync(join(tmpdir(), 'stepcode-e2e-'));
    tmpDirs.push(dir);
    const ctx: ToolContext = { cwd: process.cwd(), runSubagent: fakeRunSubagent as ToolContext['runSubagent'] };
    const agentEvents = await collect(runAgent({ provider, system: 'sys', ctx, messages: [sm('派 3 个')] }));

    // 事件确实产生了，且 id 只有 3 个不同值（撞成同一个 id 就是旧 bug）
    const ids = [...new Set(events.map((e) => e.id))].sort();
    expect(ids).toEqual(['c1', 'c2', 'c3']);

    // 模拟 PiChat 消费侧：按 ev.id 归属到各自卡片
    const transcript = new Transcript();
    for (const ev of agentEvents) {
      if (ev.type === 'tool_start' && ev.name === 'spawn_agent') {
        transcript.push({
          kind: 'tool', id: ev.id, name: ev.name,
          input: ev.input, status: 'running',
          subagentType: (ev.input as { subagent_type?: string })?.subagent_type,
        } as DisplayItem);
      }
      if (ev.type === 'tool_end' && ev.name === 'spawn_agent') {
        transcript.updateById(ev.id, (it) => ({ ...(it as object), status: ev.isError ? 'error' : 'ok' } as DisplayItem));
      }
    }
    // 进度事件逐条按 id 打补丁（与 applySubagentProgress 同构）
    for (const ev of events) {
      if (ev.kind === 'start') {
        transcript.updateById(ev.id, (it) => ({ ...(it as object), subagentType: ev.subagentType, description: ev.description } as DisplayItem));
      } else if (ev.kind === 'usage') {
        transcript.updateById(ev.id, (it) => ({ ...(it as object), subagentTokens: ev.tokens } as DisplayItem));
      } else if (ev.kind === 'tool') {
        transcript.updateById(ev.id, (it) => {
          const cur = (it as { subagentToolEvents?: { name: string }[] }).subagentToolEvents ?? [];
          return { ...(it as object), subagentToolEvents: [...cur, { name: ev.name, status: 'ok' }] } as DisplayItem;
        });
      }
    }

    // 三张卡片各自拿到自己的 token，互不串
    const blocks = (transcript as unknown as { blocks: { getItem: () => DisplayItem }[] }).blocks;
    const cards = blocks.map((b) => b.getItem()).filter((it) => it.kind === 'tool' && (it as { name: string }).name === 'spawn_agent');
    expect(cards.length).toBe(3);
    const byId = Object.fromEntries(cards.map((c) => [c.id, c as { subagentTokens?: number; subagentToolEvents?: unknown[]; subagentType?: string }]));
    expect(byId['c1']!.subagentTokens).toBe(111);
    expect(byId['c2']!.subagentTokens).toBe(222);
    expect(byId['c3']!.subagentTokens).toBe(333);
    expect(byId['c1']!.subagentToolEvents).toHaveLength(1);
    expect(byId['c2']!.subagentToolEvents).toHaveLength(1);
    expect(byId['c3']!.subagentType).toBe('general');
    // 关键：每张卡片都有 token（旧实现下 c1/c2 会是 undefined，进度全堆在最后一张）
    expect(cards.every((c) => (c as { subagentTokens?: number }).subagentTokens !== undefined)).toBe(true);
  });
});
