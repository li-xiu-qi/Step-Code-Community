/**
 * 回合中进度落盘的接线测试（真 PiChat 进程内）。
 *
 * 背景：2026-10-03 一次闪退的取证——崩溃轮跑了 3.5 分钟、14 次工具调用、10 次
 * 模型请求，但 persist 只在回合末调用，session.json 里这轮只有用户输入一条消息，
 * wire 里只有 tool.settle 遥测（无消息正文），恢复后中间执行过程全部蒸发。
 * 修复：applyEvent 在 attempt_start / tool_end 时调 persistProgress 做回合中落盘。
 *
 * 这里不跑真模型（无 provider 可用），直接把消息塞进 history 后喂事件，
 * 断言磁盘上的会话已包含该消息（store.resume 从快照+尾段重放读回）。
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Terminal } from '@earendil-works/pi-tui';
import { PiChat } from '../../src/tui-pi/PiChat.js';
import { SessionStore } from '../../src/session/store.js';

class FakeTerminal implements Terminal {
  columns = 100;
  rows = 40;
  readonly writes: string[] = [];
  kittyProtocolActive = false;
  private onInput: ((data: string) => void) | undefined;
  start(onInput: (data: string) => void): void { this.onInput = onInput; }
  stop(): void {}
  async drainInput(): Promise<void> {}
  write(data: string): void { this.writes.push(data); }
  moveBy(): void {}
  hideCursor(): void {}
  showCursor(): void {}
  clearLine(): void {}
  clearFromCursor(): void {}
  clearScreen(): void {}
  setTitle(): void {}
  setProgress(): void {}
  send(data: string): void { this.onInput?.(data); }
}

interface Harness {
  chat: PiChat;
  store: SessionStore;
  dir: string;
  cleanup: () => Promise<void>;
}

async function makeChat(): Promise<Harness> {
  const dir = mkdtempSync(join(tmpdir(), 'midturn-persist-'));
  const store = new SessionStore(dir);
  const term = new FakeTerminal();
  const chat = new PiChat({
    provider: {} as never,
    systemPrefix: '',
    agentsMd: '',
    skillsRef: { current: [] as never },
    subagentRegistry: new Map(),
    reloadSkills: () => {},
    ctx: { cwd: dir, capabilities: [] } as never,
    model: 'test-model',
    config: { provider: 'test', tui: {}, compaction: {} } as never,
    initialMode: 'manual',
    store,
    session: {
      id: 'midturn-test',
      cwd: dir,
      messages: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    } as never,
    goalStore: undefined,
    maxContextSize: 100_000,
    hookEngineRef: { current: undefined },
    subagentStore: undefined as never,
  });
  void chat.start();
  await new Promise<void>((r) => setTimeout(r, 50));
  const tuiAny = chat as unknown as { tui: { terminal: Terminal } };
  tuiAny.tui.terminal = term;
  return { chat, store, dir, cleanup: async () => { rmSync(dir, { recursive: true, force: true }); } };
}

/** 往 history 塞一条消息（模拟 loop 在回合中 push），返回消息 id。 */
function pushMessage(chat: PiChat, text: string): void {
  const stored = (chat as unknown as {
    history: { push: (m: unknown) => void };
  });
  stored.history.push({
    message: { role: 'assistant', content: [{ type: 'tool_use', id: 'tu-1', name: 'bash', input: { command: 'ls' } }] },
    origin: { kind: 'assistant' },
    id: `msg-${text}`,
    ts: new Date().toISOString(),
  });
}

describe('回合中进度落盘（闪退不丢执行轨迹）', () => {
  let h: Harness | undefined;
  beforeEach(async () => { h = await makeChat(); });
  afterEach(async () => { await h?.cleanup(); h = undefined; });

  it('attempt_start 触发回合中落盘：history 里的消息此刻已可从磁盘 resume 读回', async () => {
    const { chat, store, dir } = h!;
    pushMessage(chat, 'a');
    (chat as unknown as { applyEvent: (ev: unknown) => void }).applyEvent({ type: 'attempt_start' });
    // 不经过回合末 persist，直接用新 store 实例从磁盘 resume
    const fresh = new SessionStore(dir);
    const resumed = fresh.resume(dir, 'midturn-test');
    expect(resumed).not.toBeNull();
    const texts = resumed!.session.messages.map((m) => m.id);
    expect(texts).toContain('msg-a');
  });

  it('tool_end 触发回合中落盘', async () => {
    const { chat, store, dir } = h!;
    pushMessage(chat, 'b');
    (chat as unknown as { applyEvent: (ev: unknown) => void }).applyEvent({
      type: 'tool_end', id: 'tu-1', name: 'bash', result: 'ok', isError: false,
    });
    const fresh = new SessionStore(dir);
    const resumed = fresh.resume(dir, 'midturn-test');
    expect(resumed!.session.messages.map((m) => m.id)).toContain('msg-b');
  });

  it('节流：1s 窗口内的第二次 attempt_start 不重复写盘', async () => {
    const { chat, dir } = h!;
    pushMessage(chat, 'c');
    const apply = (chat as unknown as { applyEvent: (ev: unknown) => void }).applyEvent.bind(chat);
    apply({ type: 'attempt_start' });
    pushMessage(chat, 'd');
    apply({ type: 'attempt_start' }); // 1s 内：被节流，msg-d 不落盘
    const fresh = new SessionStore(dir);
    const resumed = fresh.resume(dir, 'midturn-test');
    expect(resumed!.session.messages.map((m) => m.id)).toContain('msg-c');
    expect(resumed!.session.messages.map((m) => m.id)).not.toContain('msg-d');
  });
});
