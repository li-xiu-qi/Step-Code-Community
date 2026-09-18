import { describe, expect, it } from 'vitest';
import type Anthropic from '@anthropic-ai/sdk';
import { runAgent } from '../../src/agent/loop.js';
import { stored, type StoredMessage } from '../../src/agent/message.js';
import type { AgentEvent } from '../../src/agent/events.js';
import type { ChatProvider } from '../../src/provider/types.js';
import { collect, makeFakeProvider, textBlock, thinkingBlock, toolUseBlock } from '../helpers/fakeProvider.js';

function sm(text: string): StoredMessage {
  return stored({ role: 'user', content: text }, { kind: 'user' });
}

describe('runTurn thinking 事件与历史', () => {
  it('thinking_delta 产生事件，正文 text 事件不受影响（思考先于正文）', async () => {
    const { provider } = makeFakeProvider([
      {
        thinkingChunks: ['先分析', '问题'],
        textChunks: ['答案', '如下'],
        finalContent: [thinkingBlock('先分析问题'), textBlock('答案如下')],
      },
    ]);
    const messages: StoredMessage[] = [sm('问')];
    const events = await collect(
      runAgent({ provider, system: 'sys', ctx: { cwd: process.cwd() }, messages }),
    );

    const stream = events.filter(
      (e) =>
        e.type === 'thinking_start' ||
        e.type === 'thinking_delta' ||
        e.type === 'thinking_end' ||
        e.type === 'text',
    );
    expect(stream).toEqual([
      { type: 'thinking_start' },
      { type: 'thinking_delta', text: '先分析' },
      { type: 'thinking_delta', text: '问题' },
      { type: 'thinking_end' },
      { type: 'text', text: '答案' },
      { type: 'text', text: '如下' },
    ]);
    expect(events.at(-1)!.type).toBe('turn_done');
  });

  it('无痕思考（只吐 signature、无 thinking_delta）仍产出 thinking_start/thinking_end', async () => {
    const { provider } = makeFakeProvider([
      {
        thinkingChunks: [],
        textChunks: ['答案'],
        finalContent: [thinkingBlock('', 'sig-only'), textBlock('答案')],
      },
    ]);
    const messages: StoredMessage[] = [sm('问')];
    const events = await collect(
      runAgent({ provider, system: 'sys', ctx: { cwd: process.cwd() }, messages }),
    );

    // signature_delta 不上抛，故全程零 thinking_delta：UI 只能靠这对边界事件显示「思考中」
    expect(events.filter((e) => e.type === 'thinking_delta')).toEqual([]);
    expect(events.filter((e) => e.type === 'thinking_start' || e.type === 'thinking_end')).toEqual([
      { type: 'thinking_start' },
      { type: 'thinking_end' },
    ]);
    // 边界事件在正文之前，且不妨碍正文
    expect(events.findIndex((e) => e.type === 'thinking_end')).toBeLessThan(
      events.findIndex((e) => e.type === 'text'),
    );
  });

  it('finalMessage 的 thinking 块（带 signature）随 assistant 消息进历史', async () => {
    const { provider } = makeFakeProvider([
      {
        thinkingChunks: ['推理过程'],
        textChunks: ['结论'],
        finalContent: [thinkingBlock('推理过程', 'sig-abc'), textBlock('结论')],
      },
    ]);
    const messages: StoredMessage[] = [sm('问')];
    await collect(runAgent({ provider, system: 'sys', ctx: { cwd: process.cwd() }, messages }));

    const assistant = messages.find((m) => m.origin.kind === 'assistant');
    expect(assistant).toBeDefined();
    expect(assistant!.message.content).toEqual([
      { type: 'thinking', thinking: '推理过程', signature: 'sig-abc' },
      { type: 'text', text: '结论' },
    ]);
  });

  it('thinking + tool_use 回合：思考事件与工具事件都正常，thinking 块随历史保留', async () => {
    const { provider } = makeFakeProvider([
      {
        thinkingChunks: ['需要读文件'],
        textChunks: [],
        finalContent: [thinkingBlock('需要读文件'), toolUseBlock('c1', 'read_file', { path: 'package.json', limit: 1 })],
      },
      { textChunks: ['读完'], finalContent: [textBlock('读完')] },
    ]);
    const messages: StoredMessage[] = [sm('问')];
    const events = await collect(
      runAgent({ provider, system: 'sys', ctx: { cwd: process.cwd() }, messages }),
    );

    // attempt_start 是每次模型响应前的边界标记（供 PreOutput 撤回本次残文），恒为事件流首条；
    // thinking 事件从它之后开始。
    expect(events[0]!.type).toBe('attempt_start');
    expect(events.slice(1, 3)).toEqual([
      { type: 'thinking_start' },
      { type: 'thinking_delta', text: '需要读文件' },
    ]);
    expect(events.some((e) => e.type === 'tool_start')).toBe(true);
    expect(events.at(-1)!.type).toBe('turn_done');
    const assistant = messages.find((m) => m.origin.kind === 'assistant');
    expect((assistant!.message.content as unknown[])[0]).toMatchObject({ type: 'thinking' });
  });

  /**
   * 流被用户中断：吐出若干思考增量后把 signal 置为 aborted（模拟 Esc），
   * 之后 finalMessage() 永不 resolve（真实 SDK 在 abort 后的行为）。
   */
  function makeAbortingProvider(thinkingChunks: string[]) {
    const provider = {
      stream(p: { signal?: AbortSignal }) {
        const s = p.signal;
        let emitted = 0;
        async function* iter(): AsyncGenerator<Anthropic.MessageStreamEvent> {
          yield {
            type: 'content_block_start',
            index: 0,
            content_block: { type: 'thinking', thinking: '', signature: '' },
          } as unknown as Anthropic.MessageStreamEvent;
          for (const chunk of thinkingChunks) {
            if (s?.aborted) return;
            emitted++;
            yield {
              type: 'content_block_delta',
              index: 0,
              delta: { type: 'thinking_delta', thinking: chunk },
            } as unknown as Anthropic.MessageStreamEvent;
          }
        }
        return {
          [Symbol.asyncIterator]: () => iter(),
          finalMessage: () => new Promise<Anthropic.Message>((_r, reject) => {
            // abort 后真实 SDK 的 finalMessage 永不 resolve，此处同样挂住
            s?.addEventListener('abort', () => reject(new Anthropic.APIUserAbortError()), { once: true });
          }),
        };
      },
    } as unknown as ChatProvider;
    return { provider };
  }

  it('中断时已产出的思考落盘进历史，不因 finalMessage 不 resolve 而丢失', async () => {
    const ctrl = new AbortController();
    const { provider } = makeAbortingProvider(['先分析', '这个价值点', '的几种可能']);
    const messages: StoredMessage[] = [stored({ role: 'user', content: '问' }, { kind: 'user' })];

    // 跑 runAgent，但在第一次 thinking_delta 后触发中断
    const gen = runAgent({ provider, system: 'sys', ctx: { cwd: process.cwd() }, messages, signal: ctrl.signal });
    const events: AgentEvent[] = [];
    for await (const ev of gen) {
      events.push(ev);
      if (ev.type === 'thinking_delta' && (ev as { text: string }).text === '这个价值点') ctrl.abort();
    }

    // 思考事件确实产出了（对应故障现场：TUI 上有思考在滚）
    const deltas = events.filter((e) => e.type === 'thinking_delta');
    expect(deltas.length).toBeGreaterThanOrEqual(2);

    // 关键断言：中断后思考进了历史，且是 assistant 角色的 thinking 块
    const assistant = messages.find((m) => m.origin.kind === 'assistant');
    expect(assistant).toBeDefined();
    const content = assistant!.message.content as Array<{ type: string; thinking?: string }>;
    expect(content[0]!.type).toBe('thinking');
    expect(content[0]!.thinking).toContain('先分析');
    expect(content[0]!.thinking).toContain('这个价值点');
  });

  it('中断且从未产出思考时不落盘空 assistant 消息', async () => {
    const ctrl = new AbortController();
    ctrl.abort(); // 进门即中断，一个思考增量都没产出
    const { provider } = makeFakeProvider([
      { thinkingChunks: ['这段思考不该被落盘'], textChunks: [], finalContent: [textBlock('不该出现')] },
    ]);
    const messages: StoredMessage[] = [stored({ role: 'user', content: '问' }, { kind: 'user' })];

    await collect(runAgent({ provider, system: 'sys', ctx: { cwd: process.cwd() }, messages, signal: ctrl.signal }));

    // 零思考增量 → 不产出任何 assistant 消息（避免历史里长出空壳）
    expect(messages.filter((m) => m.origin.kind === 'assistant')).toHaveLength(0);
  });
});
