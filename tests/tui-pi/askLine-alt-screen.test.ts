/**
 * askLine 在生产用的 TuiAltScreen 下的回归测试。
 *
 * e2a8ec6 的焦点恢复测试只覆盖 TuiMainScreen，但 PiChat 早已迁移到
 * TuiAltScreen（PiChat.ts:541）。两者输入投递/焦点模型未必一致，
 * 这条把「输入 + Enter resolve + 焦点恢复 + Esc 取消」搬到生产用的
 * TuiAltScreen 验证，填补原测试盲区。
 *
 * 背景：2026-08-18 /rename 卡死修复（e2a8ec6）后曾回归，一度怀疑是
 * TuiMainScreen→TuiAltScreen 迁移引入。实测本条全绿，askLine 链路在
 * TuiAltScreen 下正常；console.log 保留作诊断输出。
 */
import { describe, expect, it } from 'vitest';
import { TuiAltScreen, Text, VStack } from '@earendil-works/pi-tui';
import type { Terminal } from '@earendil-works/pi-tui';
import { askLine, PickerOverlay } from '../../src/tui-pi/pickers.js';

const ESC = '\x1b';
const ENTER = '\r';

class FakeTerminal implements Terminal {
  columns = 80;
  rows = 24;
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
  allOutput(): string { return this.writes.join(''); }
  reset(): void { this.writes.length = 0; }
}

describe('askLine 在 TuiAltScreen 下（生产链路验证）', () => {
  const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));
  function mk(): { term: FakeTerminal; tui: TuiAltScreen } {
    const term = new FakeTerminal();
    const tui = new TuiAltScreen(term);
    tui.start();
    return { term, tui };
  }

  it('Enter 输入 + resolve + 焦点恢复', async () => {
    const { term, tui } = mk();
    const editor = new PickerOverlay({ title: 'test', items: [], onSelect: () => {} });
    tui.addChild(editor);
    tui.setFocus(editor);
    expect(tui.getFocusedComponent()).toBe(editor);

    const p = askLine(tui, '输入名称');
    await tick();
    console.log('[焦点] askLine 后 focused =', tui.getFocusedComponent()?.constructor?.name);
    console.log('[焦点] 还是 editor?', tui.getFocusedComponent() === editor);

    term.send('新名字');
    term.send(ENTER);
    let result: string | null = 'UNRESOLVED';
    try { result = await Promise.race([p, tick().then(() => 'TIMEOUT_NO_RESOLVE')]); }
    catch (e) { result = 'THREW:' + String(e); }
    console.log('[结果] askLine resolve =', JSON.stringify(result));

    expect(tui.getFocusedComponent()).toBe(editor);
  });

  it('Esc 取消 + resolve null', async () => {
    const { term, tui } = mk();
    const p = askLine(tui, '输入名称');
    await tick();
    term.send(ESC);
    let result: string | null = 'UNRESOLVED';
    try { result = await Promise.race([p, tick().then(() => 'TIMEOUT_NO_RESOLVE')]); }
    catch (e) { result = 'THREW:' + String(e); }
    console.log('[结果] Esc resolve =', JSON.stringify(result));
  });
});

describe('askLine 在 dock 布局根下的可见性（/rename 无输入框回归）', () => {
  const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

  it('布局根存在时，askLine 的提示行仍出现在渲染输出里', async () => {
    const term = new FakeTerminal();
    const tui = new TuiAltScreen(term);
    tui.start();
    // 模拟主界面的 dock 布局根（PiChat.setLayoutRoot 的那一层）
    tui.setLayoutRoot(new VStack([{ component: new Text('主界面内容'), grow: 1, shrink: 1 }]));
    await tick();
    term.reset();

    const p = askLine(tui, '输入会话新名称');
    await tick();
    // 手动触发一帧渲染，收集终端写出的字节
    tui.renderNow(true);
    const out = term.allOutput();

    // 修复前（addChild 平铺）：hint 完全不出现——dock 下 children 不参与渲染
    expect(out).toContain('输入会话新名称');
    // Esc 收尾防 promise 悬挂
    term.send(ESC);
    await Promise.race([p, tick()]);
  });

  it('提交后输入框从渲染输出里消失（不残留）', async () => {
    const term = new FakeTerminal();
    const tui = new TuiAltScreen(term);
    tui.start();
    tui.setLayoutRoot(new VStack([{ component: new Text('主界面内容'), grow: 1, shrink: 1 }]));
    await tick();

    const p = askLine(tui, '输入会话新名称');
    await tick();
    term.send(' session-2');
    term.send('\r');
    const result = await Promise.race([p, tick().then(() => 'TIMEOUT' as const)]);
    expect(result).toBe('session-2');

    term.reset();
    tui.renderNow(true);
    // hint 与输入内容都不再出现（overlay 已 hide）
    expect(term.allOutput()).not.toContain('输入会话新名称');
    expect(term.allOutput()).not.toContain('session-2');
  });
});
