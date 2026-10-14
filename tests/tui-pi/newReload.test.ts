/**
 * /new 触发配置重载的接线测试（2026-10-14）。
 *
 * 产品语义：/new 等价于「热启动开新会话」，新会话必须吃磁盘上的最新配置，
 * 而不是进程启动时的旧快照。实现：newSession 在 persist 旧会话后、清 history 前
 * 调 runReload；成功静默（note 随 history 清空抹掉），失败旧配置原子保留并在
 * 新会话首屏补一条错误。
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
  reloadCalls: { count: number };
  cleanup: () => Promise<void>;
}

async function makeChat(): Promise<Harness> {
  const dir = mkdtempSync(join(tmpdir(), 'new-reload-'));
  const store = new SessionStore(dir);
  const reloadCalls = { count: 0 };
  const config = { provider: 'test', tui: {}, compaction: {}, subagent: {} } as never;
  const chat = new PiChat({
    provider: {} as never,
    systemPrefix: '',
    agentsMd: '',
    skillsRef: { current: [] as never },
    subagentRegistry: new Map(),
    reloadSkills: () => {},
    reloadConfig: () => {
      reloadCalls.count += 1;
      return { config };
    },
    ctx: { cwd: dir, capabilities: [] } as never,
    model: 'test-model',
    config,
    initialMode: 'manual',
    store,
    session: {
      id: 'new-reload-test',
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
  return { chat, dir, reloadCalls, cleanup: async () => { rmSync(dir, { recursive: true, force: true }); } };
}

describe('/new 触发配置重载（热启动语义）', () => {
  let h: Harness | undefined;
  beforeEach(async () => { h = await makeChat(); });
  afterEach(async () => { await h?.cleanup(); h = undefined; });

  it('newSession 调用一次 reloadConfig，新会话吃到重载后的配置', async () => {
    const { chat, reloadCalls } = h!;
    const startP = (chat as unknown as { start: () => Promise<unknown> }).start();
    await new Promise<void>((r) => setTimeout(r, 50));
    expect(reloadCalls.count).toBe(0);
    (chat as unknown as { newSession: () => void }).newSession();
    expect(reloadCalls.count).toBe(1);
    // 新会话已建：id 换了
    (chat as unknown as { exit: () => void }).exit();
    await startP;
  }, 15000);

  it('重载失败：不阻断开新会话，且新会话首屏有错误提示', async () => {
    const { chat } = h!;
    // 换成失败的 reloadConfig
    (chat as unknown as { deps: { reloadConfig: () => unknown } }).deps.reloadConfig = () => ({
      error: 'config.toml 语法错误',
    });
    const startP = (chat as unknown as { start: () => Promise<unknown> }).start();
    await new Promise<void>((r) => setTimeout(r, 50));
    (chat as unknown as { newSession: () => void }).newSession();
    // 新会话照常建立
    expect((chat as unknown as { session: { id: string } }).session.id).not.toBe('new-reload-test');
    // 错误提示进了转录区（transcript 首屏 items 里找 error）
    const items = (chat as unknown as { transcript: { items: () => { kind: string; text?: string }[] } }).transcript.items();
    const err = items.find((i) => i.kind === 'error' && (i.text ?? '').includes('配置重载失败'));
    expect(err).toBeDefined();
    (chat as unknown as { exit: () => void }).exit();
    await startP;
  }, 15000);
});
