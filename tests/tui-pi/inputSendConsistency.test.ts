/**
 * 端到端实验：逐键输入 vs 实际发送内容是否一致。
 *
 * 动机是同事反馈「输入和实际发送不一致」（吞字）。这里不猜，直接驱动真实 Editor，
 * 走完「输入 → 渲染 → 提交」全链路，比对每一环的文本。
 *
 * 关注三个已知高危点：
 * 1. 大段粘贴被折成占位符后，提交时是否还原（getExpandedText）
 * 2. 含括号/引号的内容是否被改写
 * 3. 多行与空行是否保留
 */
import { describe, expect, it } from 'vitest';
import { Editor } from '@earendil-works/pi-tui';
import { editorTheme } from '../../src/tui-pi/theme.js';

const strip = (s: string): string => s.replace(/\x1b\[[0-9;]*m/g, '').replace(/\x1b_pi:c\x07/g, '');

/** 构造一个可驱动的 Editor：拦截 onSubmit 拿到实际发送内容。 */
function harness(): { ed: Editor; sent: () => string | undefined; text: () => string } {
  const ed = new Editor(null as never, editorTheme, {});
  let submitted: string | undefined;
  ed.onSubmit = (t: string) => {
    submitted = t;
  };
  return {
    ed,
    sent: () => submitted,
    text: () => ed.getText(),
  };
}

describe('输入与发送一致性（吞字检查）', () => {
  it('纯 ASCII 短文本：逐键输入后提交，内容一致', () => {
    const h = harness();
    for (const ch of 'hello world') h.ed.handleInput(ch);
    h.ed.handleInput('\r');
    expect(h.sent()).toBe('hello world');
  });

  it('中文逐键输入后提交，内容一致', () => {
    const h = harness();
    for (const ch of '并行派三个子 agent') h.ed.handleInput(ch);
    h.ed.handleInput('\r');
    expect(h.sent()).toBe('并行派三个子 agent');
  });

  it('含括号内容不被改写（同事反馈的场景）', () => {
    const h = harness();
    const src = '(z-library.sk, 1lib.sk, z-lib.sk).epub';
    h.ed.setText(src);
    h.ed.handleInput('\r');
    expect(h.sent()).toBe(src);
  });

  it('含全角括号、方括号、书名号的内容原样保留', () => {
    const h = harness();
    const src = '贺麟中译黑格尔经典著作（小逻辑+精神现象学）([德]黑格尔) 《哲学史讲演录》';
    h.ed.setText(src);
    h.ed.handleInput('\r');
    expect(h.sent()).toBe(src);
  });

  it('多行内容保留换行', () => {
    const h = harness();
    const src = '第一行\n第二行\n第三行';
    h.ed.setText(src);
    h.ed.handleInput('\r');
    expect(h.sent()).toBe(src);
  });

  it('含空行的多行内容不吞空行', () => {
    const h = harness();
    const src = '第一行\n\n第三行';
    h.ed.setText(src);
    h.ed.handleInput('\r');
    expect(h.sent()).toBe(src);
  });

  it('粘贴折叠后提交：内容还原为原文（关键路径）', () => {
    const h = harness();
    const original = '第一行（含括号）\n第二行 [德] 黑格尔\n第三行 (z-library.sk)';
    // 模拟 pi-tui 的大段粘贴折叠：真实内容进 pastes，缓冲区只留标记
    h.ed.pastes.set(1, original);
    (h.ed as unknown as { pasteCounter: number }).pasteCounter = 1;
    (h.ed as unknown as { state: { lines: string[]; cursorLine: number; cursorCol: number } }).state = {
      lines: ['[paste #1 +3 lines]'], cursorLine: 0, cursorCol: 0,
    };
    // 缓冲区里是标记，不是原文
    expect(h.text()).toBe('[paste #1 +3 lines]');
    h.ed.handleInput('\r');
    // 提交时必须还原成原文
    expect(h.sent()).toBe(original);
  });

  it('长路径 + 特殊字符组合不丢内容', () => {
    const h = harness();
    const src = 'C:\\Users\\ke\\0_Inbox\\解码者：珍妮弗·杜德纳（《史蒂夫·乔布斯传》作者艾萨克森全新力作）.epub';
    h.ed.setText(src);
    h.ed.handleInput('\r');
    expect(h.sent()).toBe(src);
  });

  it('超长单行不截断内容（截断只影响显示，不影响发送）', () => {
    const h = harness();
    const src = 'x'.repeat(5000);
    h.ed.setText(src);
    h.ed.handleInput('\r');
    expect(h.sent()).toBe(src);
    expect(h.sent()!.length).toBe(5000);
  });
});
