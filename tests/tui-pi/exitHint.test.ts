/**
 * 退出恢复提示（step -r <id>）的打印条件测试。
 *
 * 背景：hasContent 只看「退出瞬间的 history 是否非空」，/new 之后 history 清空
 * 归 false——用过内容的会话只要 /new 过，退出时恢复提示和 token 汇总就全没了
 * （2026-10-03 用户报告的「退出显示异常」）。修复：sawContent 粘滞位在
 * 会话出现过内容时置位，/new / /clear / backtrack 不清。
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
}

interface Harness {
  chat: PiChat;
  dir: string;
  cleanup: () => Promise<void>;
}

async function makeChat(): Promise<Harness> {
  const dir = mkdtempSync(join(tmpdir(), 'exit-hint-'));
  const store = new SessionStore(dir);
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
      id: 'exit-hint-test',
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
  const tuiAny = chat as unknown as { tui: { terminal: Terminal } };
  tuiAny.tui.terminal = new FakeTerminal();
  return { chat, dir, cleanup: async () => { rmSync(dir, { recursive: true, force: true }); } };
}

function pushUserMessage(chat: PiChat): void {
  (chat as unknown as { history: { push: (m: unknown) => void } }).history.push({
    message: { role: 'user', content: '你好' },
    origin: { kind: 'user' },
    id: 'msg-1',
    ts: new Date().toISOString(),
  });
}

describe('退出恢复提示的打印条件（sawContent 粘滞位）', () => {
  let h: Harness | undefined;
  beforeEach(async () => { h = await makeChat(); });
  afterEach(async () => { await h?.cleanup(); h = undefined; });

  it('有过内容的会话 /new 后退出：hasContent 仍为 true（恢复提示不丢）', async () => {
    const { chat } = h!;
    const infoP = (chat as unknown as { start: () => Promise<{ hasContent: boolean }> }).start();
    await new Promise<void>((r) => setTimeout(r, 50));
    pushUserMessage(chat);
    (chat as unknown as { newSession: () => void }).newSession();
    // /new 后 history 已清空：旧判据（history.length > 0）在这里就会丢提示
    expect((chat as unknown as { history: unknown[] }).history.length).toBe(0);
    (chat as unknown as { exit: () => void }).exit();
    const info = await infoP;
    expect(info.hasContent).toBe(true);
  }, 15000);

  it('从头空到尾的会话退出：hasContent 为 false（不打无意义的提示）', async () => {
    const { chat } = h!;
    const infoP = (chat as unknown as { start: () => Promise<{ hasContent: boolean }> }).start();
    await new Promise<void>((r) => setTimeout(r, 50));
    (chat as unknown as { exit: () => void }).exit();
    const info = await infoP;
    expect(info.hasContent).toBe(false);
  }, 15000);
});
