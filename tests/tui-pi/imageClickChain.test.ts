/**
 * 图片点击预览的进程内链路测试（真 PiChat 实例，不是复刻逻辑）。
 *
 * 为什么需要：区域登记与命中换算是纯函数层（imageRegions.test.ts 覆盖），
 * 「终端序列 → PiChat.handleTerminalMouse → openImagePreview → 浮层挂载」这条
 * 接线此前没有任何自动化覆盖——真机点击无效时无法自判断在哪环。本文件用
 * FakeTerminal 起一个真 PiChat（deps 最小 mock），把图片推进 transcript，
 * 按区域表算屏幕行注入 SGR press，断言预览浮层真的挂上。
 *
 * 边界说明：本测试证明应用层链路（dock 焦点/坐标换算/区域命中/overlay 挂载）
 * 在进程内闭合；真机若仍无反应，断点在终端投递层（WT 的 SGR 上报/ConPTY
 * 传递），取证用 STEP_CODE_DEBUG_MOUSE 日志（raw/ev/hit 三段）。
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Terminal } from '@earendil-works/pi-tui';
import { PiChat } from '../../src/tui-pi/PiChat.js';
import { SessionStore } from '../../src/session/store.js';
import type { DisplayItem } from '../../src/chat/types.js';

/** 8x6 四色块 PNG（与 imageBlock.test.ts 同图）。 */
const PNG_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAgAAAAGCAIAAABxZ0isAAAAJElEQVR4nGN8ZunGAAPmfwThbCY4Cw3glGD8//8/gsPISIFRAFoTBbTJYCKiAAAAAElFTkSuQmCC';

/** 记录写入并支持注入输入的假终端（askLine-alt-screen 同款模式）。 */
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
  send(data: string): void { if (process.env.IMGCLICK_DEBUG === '1') console.error('[dbg-send]', JSON.stringify(data), !!this.onInput); this.onInput?.(data); }
  allOutput(): string { return this.writes.join(''); }
}

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

interface Harness {
  chat: PiChat;
  term: FakeTerminal;
  cleanup: () => Promise<void>;
}

async function makeChat(): Promise<Harness> {
  const dir = mkdtempSync(join(tmpdir(), 'imgclick-'));
  const store = new SessionStore(dir);
  const term = new FakeTerminal();
  const chat = new PiChat({
    provider: {} as never,
    systemPrefix: '',
    agentsMd: '',
    skillsRef: { current: [] as never },
    subagentRegistry: new Map(),
    reloadSkills: () => {},
    ctx: { cwd: dir, capabilities: ['image_in'] } as never,
    model: 'test-model',
    config: { provider: 'test', tui: {}, compaction: {} } as never,
    initialMode: 'manual',
    store,
    session: {
      id: 'click-test',
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
  // start() 的 Promise 退出时才 resolve，不能 await；同步部分（装配+首帧）已够用
  void chat.start();
  await new Promise<void>((r) => setTimeout(r, 50));
  // PiChat 内部 new ProcessTerminal（pipe 环境下不产输入），测试注入假终端：
  // 换 terminal 引用 + 把 FakeTerminal 的输入回调接到 tui.handleTerminalInput
  const tuiAny = chat as unknown as { tui: { terminal: Terminal; handleTerminalInput: (d: string) => void } };
  tuiAny.tui.terminal = term;
  term.start((data) => tuiAny.tui.handleTerminalInput(data));
  return {
    chat,
    term,
    cleanup: async () => {
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** SGR 左键 press（1006 模式，1-based 行列，parseSGRMouse 内部转 0-based）。 */
const press = (col: number, row: number): string => `\x1b[<0;${col};${row}M`;

/** 往 transcript 推一块内容并同步渲染（区域表要渲染后才汇总）。 */
function pushAndRender(chat: PiChat, item: DisplayItem): void {
  (chat as unknown as { transcript: { push: (i: DisplayItem) => void } }).transcript.push(item);
  const tui = chat as unknown as { tui: { requestRender: () => void; renderNow: (f: boolean) => void } };
  tui.tui.requestRender();
  tui.tui.renderNow(true);
}

describe('图片点击预览链路（真 PiChat 进程内）', () => {
  let h: Harness | undefined;
  beforeEach(async () => { h = await makeChat(); });
  afterEach(async () => { await h?.cleanup(); h = undefined; });

  it('SGR press 命中 tool 结果图：预览浮层挂载且画出工具栏', async () => {
    const { chat, term } = h!;
    pushAndRender(chat, {
      kind: 'tool',
      id: 't1',
      name: 'read_media',
      status: 'ok',
      result: '（图）',
      images: [{ mediaType: 'image/png', base64: PNG_B64 }],
    } as DisplayItem);
    const regions = (chat as unknown as { transcript: { imageRegions: () => { startRow: number }[] } }).transcript.imageRegions();
    expect(regions.length).toBeGreaterThan(0); // 图已登记
    const screenRow = regions[0]!.startRow + 1; // SGR 1-based；dock 下 transcript 贴顶、scrollTop=0

    term.send('x');
    await tick();
    term.send(press(10, screenRow));
    await tick();
    // 预览渲染走 throttle 调度，同步刷一帧让 overlay 落进 writes
    (chat as unknown as { tui: { renderNow: (f: boolean) => void } }).tui.renderNow(true);
    await tick();
    const handle = (chat as unknown as { imagePreviewHandle: unknown }).imagePreviewHandle;
    expect(handle).not.toBeNull();
    expect(term.allOutput()).toContain('适配'); // 浮层工具栏真的画出来了
  }, 20000);

  it('SGR press 命中 user 贴图：预览浮层挂载', async () => {
    const { chat, term } = h!;
    pushAndRender(chat, {
      kind: 'user',
      text: '看图',
      images: [{ id: 1, base64: PNG_B64, mediaType: 'image/png', width: 8, height: 6, placeholder: '[image #1]' }],
    } as DisplayItem);
    const regions = (chat as unknown as { transcript: { imageRegions: () => { startRow: number }[] } }).transcript.imageRegions();
    expect(regions.length).toBeGreaterThan(0);
    term.send(press(10, regions[0]!.startRow + 1));
    await tick();
    expect((chat as unknown as { imagePreviewHandle: unknown }).imagePreviewHandle).not.toBeNull();
  }, 20000);

  it('点非图片区不误开预览', async () => {
    const { chat, term } = h!;
    pushAndRender(chat, { kind: 'note', text: '纯文本，没有图' } as DisplayItem);
    term.send(press(10, 1)); // 第 0 行附近（welcome 区，非图）
    await tick();
    expect((chat as unknown as { imagePreviewHandle: unknown }).imagePreviewHandle).toBeNull();
  }, 20000);
});
