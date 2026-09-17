import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type Anthropic from '@anthropic-ai/sdk';
import { describe, expect, it } from 'vitest';
import type { StoredMessage } from '../../src/agent/message.js';
import { stored } from '../../src/agent/message.js';
import { runAgent } from '../../src/agent/loop.js';
import type { ToolContext } from '../../src/tools/types.js';
import {
  UNKNOWN_TOOL_LIMIT,
  checkUnknownToolSafety,
  emptyUnknownToolState,
  recordToolOutcome,
} from '../../src/agent/unknownToolGuard.js';
import { collect, makeFakeProvider, textBlock, toolUseBlock } from '../helpers/fakeProvider.js';

function sm(text: string): StoredMessage {
  return stored({ role: 'user', content: text }, { kind: 'user' });
}

const base = (
  provider: ReturnType<typeof makeFakeProvider>['provider'],
  messages: StoredMessage[],
  over: { ctx?: ToolContext } = {},
) => ({
  provider,
  system: 'sys',
  ctx: over.ctx ?? { cwd: tmpdir() },
  messages,
});

function toolResultBlocks(messages: StoredMessage[]): Anthropic.ToolResultBlockParam[] {
  const out: Anthropic.ToolResultBlockParam[] = [];
  for (const m of messages) {
    if (m.message.role !== 'user' || typeof m.message.content === 'string') continue;
    for (const b of m.message.content) {
      if (b.type === 'tool_result') out.push(b);
    }
  }
  return out;
}

/** 历史里是否存在指定工具名的 tool_use（assistant 侧）。 */
function hasToolUseNamed(messages: StoredMessage[], name: string): boolean {
  for (const m of messages) {
    if (m.message.role !== 'assistant' || typeof m.message.content === 'string') continue;
    for (const b of m.message.content) {
      if (b.type === 'tool_use' && b.name === name) return true;
    }
  }
  return false;
}

/** 历史里 injection origin 的纯文本 user 消息正文（4.1 的说明消息走这个形态）。 */
function injectionTexts(messages: StoredMessage[]): string[] {
  return messages
    .filter((m) => m.origin.kind === 'injection' && typeof m.message.content === 'string')
    .map((m) => m.message.content as string);
}

describe('unknownToolGuard 纯函数', () => {
  it('只对 UNKNOWN_TOOL 计数递增，记下工具名', () => {
    let s = emptyUnknownToolState();
    s = recordToolOutcome(s, 'UNKNOWN_TOOL', 'breadcrumb');
    s = recordToolOutcome(s, 'UNKNOWN_TOOL', 'breadcrumb');
    expect(s).toEqual({ streak: 2, lastName: 'breadcrumb' });
  });

  it('非 UNKNOWN_TOOL 一律清零（含工具存在但执行失败）', () => {
    let s = recordToolOutcome(emptyUnknownToolState(), 'UNKNOWN_TOOL', 'breadcrumb');
    s = recordToolOutcome(s, 'UNKNOWN_TOOL', 'breadcrumb');
    expect(s.streak).toBe(2);
    // 工具存在但失败：合法重试可能，链条必须断
    s = recordToolOutcome(s, undefined, 'read_file');
    expect(s).toEqual({ streak: 0, lastName: '' });
  });

  it('空状态遇非 UNKNOWN_TOOL 返回同一对象（无谓分配）', () => {
    const s = emptyUnknownToolState();
    expect(recordToolOutcome(s, undefined, 'read_file')).toBe(s);
  });

  it('未达上限放行，达上限终止并带上工具名', () => {
    const below = { streak: UNKNOWN_TOOL_LIMIT - 1, lastName: 'breadcrumb' };
    expect(checkUnknownToolSafety(below)).toEqual({ safe: true });

    const at = { streak: UNKNOWN_TOOL_LIMIT, lastName: 'breadcrumb' };
    expect(checkUnknownToolSafety(at)).toEqual({
      safe: false,
      count: UNKNOWN_TOOL_LIMIT,
      lastName: 'breadcrumb',
    });
  });

  it('上限可自定义（供后续调参，不改判据）', () => {
    // streak 2 未达上限 3，放行；上限放宽到 5 仍放行
    const s = { streak: 2, lastName: 'x' };
    expect(checkUnknownToolSafety(s, 3).safe).toBe(true);
    expect(checkUnknownToolSafety(s, 5).safe).toBe(true);
    // 收紧到 2 才终止
    expect(checkUnknownToolSafety(s, 2).safe).toBe(false);
  });
});

describe('runTurn 未知工具循环守卫', () => {
  it('同一工具同参数连续两次正常执行，不触发守卫', async () => {
    const { provider } = makeFakeProvider([
      {
        textChunks: [],
        finalContent: [
          toolUseBlock('c1', 'read_file', { path: 'package.json', limit: 1 }),
          toolUseBlock('c2', 'read_file', { path: 'package.json', limit: 1 }),
        ],
      },
      { textChunks: ['确认完毕'], finalContent: [textBlock('确认完毕')] },
    ]);
    const messages: StoredMessage[] = [sm('读两次确认')];
    const events = await collect(runAgent(base(provider, messages)));

    const blocks = toolResultBlocks(messages);
    expect(blocks).toHaveLength(2);
    // 两次都拿到真实结果，没有任何一条是守卫的说明文案
    expect(blocks.every((b) => !String(b.content).includes('已连续'))).toBe(true);
    expect(events.some((e) => e.type === 'notice' && String((e as { message: string }).message).includes('已连续'))).toBe(false);
  });

  it('连续 3 次未知工具即终止本回合，剩余工具改为说明结果', async () => {
    const { provider } = makeFakeProvider([
      {
        textChunks: [],
        finalContent: [
          toolUseBlock('c1', 'breadcrumb', { x: 0, y: 0 }),
          toolUseBlock('c2', 'breadcrumb', { x: 1, y: 0 }),
          toolUseBlock('c3', 'breadcrumb', { x: 2, y: 0 }),
          toolUseBlock('c4', 'breadcrumb', { x: 3, y: 0 }),
          toolUseBlock('c5', 'breadcrumb', { x: 4, y: 0 }),
        ],
      },
      { textChunks: ['好'], finalContent: [textBlock('好')] },
    ]);
    const messages: StoredMessage[] = [sm('循环场景')];
    const events = await collect(runAgent(base(provider, messages)));

    // 守卫行为不变：notice 照常透出，回合以 tool_use 收尾
    expect(
      events.some((e) => e.type === 'notice' && String((e as { message: string }).message).includes('已连续 3 次调用不存在的工具')),
    ).toBe(true);
    // 4.1：5 个 breadcrumb 的 tool_use/tool_result 对全部移出历史（含守卫中止、拿不到
    // errorCode 的后两个——按名字判并集），换成一条点名说明消息。assistant 被整条掏空移除。
    expect(hasToolUseNamed(messages, 'breadcrumb')).toBe(false);
    expect(toolResultBlocks(messages)).toHaveLength(0);
    const note = injectionTexts(messages);
    expect(note).toHaveLength(1);
    expect(note[0]).toContain('breadcrumb');
    expect(note[0]).toContain('已从对话历史中移除');
    // 没有 aborted：守卫终止不是用户中断
    expect(events.some((e) => e.type === 'aborted')).toBe(false);
  });

  it('中途出现一次真实工具调用即清零计数，不再终止；真实结果保留、无效调用移除', async () => {
    const { provider } = makeFakeProvider([
      {
        textChunks: [],
        finalContent: [
          toolUseBlock('c1', 'breadcrumb', { x: 0, y: 0 }),
          toolUseBlock('c2', 'breadcrumb', { x: 1, y: 0 }),
          toolUseBlock('c3', 'read_file', { path: 'package.json', limit: 1 }),
          toolUseBlock('c4', 'breadcrumb', { x: 2, y: 0 }),
          toolUseBlock('c5', 'breadcrumb', { x: 3, y: 0 }),
        ],
      },
      { textChunks: ['完'], finalContent: [textBlock('完')] },
    ]);
    const messages: StoredMessage[] = [sm('混入真实调用')];
    const events = await collect(runAgent(base(provider, messages)));

    // 守卫不触发：链条在第 3 步已断
    expect(
      events.some((e) => e.type === 'notice' && String((e as { message: string }).message).includes('已连续 3 次')),
    ).toBe(false);
    // 4 个 breadcrumb 移除，read_file 的配对保留（assistant 保留 tool_use、tool_result 保留结果）
    expect(hasToolUseNamed(messages, 'breadcrumb')).toBe(false);
    const blocks = toolResultBlocks(messages);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]!.tool_use_id).toBe('c3');
    // 说明消息点名 breadcrumb，不点名 read_file
    const note = injectionTexts(messages);
    expect(note).toHaveLength(1);
    expect(note[0]).toContain('breadcrumb');
  });

  it('守卫终止不算用户中断：回合以 tool_use 收尾，不产生 aborted 事件', async () => {
    // 恰好 3 个 tool_use：守卫在第 3 个上触发，没有剩余任务可替换，
    // 所以此处只断言收尾形态与 4.1 移除，不断言 halt 说明（那个由上一例覆盖）。
    const { provider } = makeFakeProvider([
      {
        textChunks: [],
        finalContent: [
          toolUseBlock('c1', 'breadcrumb', {}),
          toolUseBlock('c2', 'breadcrumb', {}),
          toolUseBlock('c3', 'breadcrumb', {}),
        ],
      },
      { textChunks: ['换工具'], finalContent: [textBlock('换工具')] },
    ]);
    const messages: StoredMessage[] = [sm('收尾形态')];
    const events = await collect(runAgent(base(provider, messages)));

    // 守卫不是用户中断：不应有 aborted 事件
    expect(events.some((e) => e.type === 'aborted')).toBe(false);
    // 3 个 breadcrumb 全部移出历史
    expect(hasToolUseNamed(messages, 'breadcrumb')).toBe(false);
    // 触发了 notice 透出给用户
    expect(
      events.some((e) => e.type === 'notice' && String((e as { message: string }).message).includes('已连续 3 次调用不存在的工具')),
    ).toBe(true);
  });
});

describe('runTurn 无效工具调用不进历史（4.1）', () => {
  it('单个无效调用：assistant 的 tool_use 与 tool_result 成对移除，换说明消息', async () => {
    const { provider } = makeFakeProvider([
      { textChunks: [], finalContent: [toolUseBlock('c1', 'breadcrumb', { x: 1 })] },
      { textChunks: ['换工具'], finalContent: [textBlock('换工具')] },
    ]);
    const messages: StoredMessage[] = [sm('单发无效调用')];
    await collect(runAgent(base(provider, messages)));

    expect(hasToolUseNamed(messages, 'breadcrumb')).toBe(false);
    expect(toolResultBlocks(messages)).toHaveLength(0);
    const note = injectionTexts(messages);
    expect(note).toHaveLength(1);
    // 保留说明而非静默删除：点名、声明未执行、给出方向
    expect(note[0]).toContain('breadcrumb');
    expect(note[0]).toContain('未执行');
    expect(note[0]).toContain('已从对话历史中移除');
  });

  it('assistant 有正文时只摘 tool_use，正文保留（消息不整条移除）', async () => {
    const { provider } = makeFakeProvider([
      {
        textChunks: [],
        finalContent: [textBlock('我先用 breadcrumb 画个线'), toolUseBlock('c1', 'breadcrumb', {})],
      },
      { textChunks: ['好'], finalContent: [textBlock('好')] },
    ]);
    const messages: StoredMessage[] = [sm('带正文的无效调用')];
    await collect(runAgent(base(provider, messages)));

    // assistant 消息保留正文，tool_use 被摘除（第二条 assistant 是下一轮的「好」回复）
    const assistants = messages.filter((m) => m.message.role === 'assistant');
    expect(assistants.length).toBeGreaterThanOrEqual(1);
    const first = JSON.stringify(assistants[0]!.message.content);
    expect(first).toContain('breadcrumb 画个线');
    expect(first).not.toContain('"name":"breadcrumb"');
    // 无线索进 tool_result 侧
    expect(toolResultBlocks(messages)).toHaveLength(0);
  });

  it('守卫中止且名字未注册的调用也移除（无 errorCode 的路径）', async () => {
    // 5 个未知工具：前 3 个执行拿 UNKNOWN_TOOL，后 2 个守卫中止只拿到 halt 文案。
    // 若判据只认 errorCode，后 2 个会留在历史里继续喂给模型。
    const { provider } = makeFakeProvider([
      {
        textChunks: [],
        finalContent: [
          toolUseBlock('c1', 'breadcrumb', { x: 0 }),
          toolUseBlock('c2', 'breadcrumb', { x: 1 }),
          toolUseBlock('c3', 'breadcrumb', { x: 2 }),
          toolUseBlock('c4', 'breadcrumb', { x: 3 }),
          toolUseBlock('c5', 'breadcrumb', { x: 4 }),
        ],
      },
      { textChunks: ['好'], finalContent: [textBlock('好')] },
    ]);
    const messages: StoredMessage[] = [sm('中止的无效调用')];
    await collect(runAgent(base(provider, messages)));

    // 全部 5 个（含被守卫拦下的 2 个）都不在历史里
    expect(hasToolUseNamed(messages, 'breadcrumb')).toBe(false);
    expect(toolResultBlocks(messages)).toHaveLength(0);
  });

  it('守卫误伤的合法工具不移除：halt 结果保留，模型知道它没执行', async () => {
    // breadcrumb ×3 触发守卫，read_file 排第 4 位被守卫中止（误伤）。
    // 名字已注册 → 保留 tool_use 与 halt 说明结果，只移除 breadcrumb。
    const { provider } = makeFakeProvider([
      {
        textChunks: [],
        finalContent: [
          toolUseBlock('c1', 'breadcrumb', {}),
          toolUseBlock('c2', 'breadcrumb', {}),
          toolUseBlock('c3', 'breadcrumb', {}),
          toolUseBlock('c4', 'read_file', { path: 'package.json', limit: 1 }),
        ],
      },
      { textChunks: ['好'], finalContent: [textBlock('好')] },
    ]);
    const messages: StoredMessage[] = [sm('误伤场景')];
    await collect(runAgent(base(provider, messages)));

    expect(hasToolUseNamed(messages, 'breadcrumb')).toBe(false);
    // read_file 的配对保留，结果是守卫 halt 文案（被误伤中止）
    const blocks = toolResultBlocks(messages);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]!.tool_use_id).toBe('c4');
    expect(String(blocks[0]!.content)).toContain('剩余工具调用已终止');
  });

  it('合法工具的正常失败不进移除范围（errorCode 非 UNKNOWN_TOOL）', async () => {
    // read_file 读不存在的路径：工具存在、执行失败。这是合法失败，必须留在历史里。
    const { provider } = makeFakeProvider([
      {
        textChunks: [],
        finalContent: [toolUseBlock('c1', 'read_file', { path: 'definitely-not-exist-4.1.md' })],
      },
      { textChunks: ['好'], finalContent: [textBlock('好')] },
    ]);
    const messages: StoredMessage[] = [sm('合法失败')];
    await collect(runAgent(base(provider, messages)));

    expect(hasToolUseNamed(messages, 'read_file')).toBe(true);
    const blocks = toolResultBlocks(messages);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]!.is_error).toBe(true);
    // 不产生说明消息
    expect(injectionTexts(messages)).toHaveLength(0);
  });
});
