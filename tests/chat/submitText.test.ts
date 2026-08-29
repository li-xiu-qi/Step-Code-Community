import { describe, expect, it } from 'vitest';
import { resolveSubmitText } from '../../src/chat/submitText.js';

/**
 * 提交文本规范化。
 *
 * 这条锁的是「粘贴占位符必须还原」：pi-tui Editor 把大段粘贴折成 `[paste #N +X lines]`，
 * getText() 拿到的是标记。若提交走 getText，模型只会看到标记——用户以为发了一大段，
 * 实际只发了一行占位符。这是「输入与实际发送不一致」最典型的形态。
 *
 * 变异验证：把实现里的 getExpandedText 换成 getText，下面「占位符必须还原」那条必红。
 * （此前这段逻辑内联在 PiChat.onSubmit 里，同样的变异测试全绿，故抽出成纯函数。）
 */
const src = (text: string, expanded: string): { getText(): string; getExpandedText(): string } => ({
  getText: () => text,
  getExpandedText: () => expanded,
});

describe('resolveSubmitText：提交文本规范化', () => {
  it('占位符必须还原为原文（关键用例）', () => {
    const original = '第一行（含括号）\n第二行 [德] 黑格尔\n第三行 (z-library.sk)';
    const out = resolveSubmitText(src('[paste #1 +3 lines]', original), '[paste #1 +3 lines]');
    expect(out).toBe(original);
  });

  it('普通短文本原样通过', () => {
    expect(resolveSubmitText(src('hello', 'hello'), 'hello')).toBe('hello');
  });

  it('中文原样通过', () => {
    expect(resolveSubmitText(src('并行派三个子 agent', '并行派三个子 agent'), '并行派三个子 agent')).toBe('并行派三个子 agent');
  });

  it('末尾多余换行被 trim 掉', () => {
    expect(resolveSubmitText(src('hello\n', 'hello\n'), 'hello\n')).toBe('hello');
  });

  it('首尾空白被 trim 掉', () => {
    expect(resolveSubmitText(src('  hello  ', '  hello  '), '  hello  ')).toBe('hello');
  });

  it('内部空行保留（trim 只去首尾）', () => {
    const inner = '第一行\n\n第三行';
    expect(resolveSubmitText(src(inner, inner), inner)).toBe(inner);
  });

  it('多行内容完整保留', () => {
    const multi = 'a\nb\nc';
    expect(resolveSubmitText(src(multi, multi), multi)).toBe(multi);
  });

  it('展开文本为空时退回 onSubmit 入参', () => {
    // 边界：编辑器已清空但 onSubmit 入参还在（极窄窗口），取入参不丢内容
    expect(resolveSubmitText(src('', ''), '兜底内容')).toBe('兜底内容');
  });

  it('超长内容不截断', () => {
    const long = 'x'.repeat(50_000);
    expect(resolveSubmitText(src(long, long), long)).toBe(long);
  });

  it('含各种括号与引号的内容不改写', () => {
    const tricky = '()[]{}' + String.fromCharCode(39) + String.fromCharCode(39) + String.fromCharCode(34) + String.fromCharCode(34) + String.fromCharCode(39) + String.fromCharCode(39) + String.fromCharCode(0x2018, 0x2019, 0x201C, 0x201D, 0xFF08, 0xFF09, 0x3010, 0x3011, 0x300A, 0x300B);
    expect(resolveSubmitText(src(tricky, tricky), tricky)).toBe(tricky);
  });

  it('占位符形态下忽略 getText 的折叠值', () => {
    // 两个 getter 返回不同时，必须信 getExpandedText
    const out = resolveSubmitText(src('[paste #1 +120 lines]', '真实的长内容…'), '[paste #1 +120 lines]');
    expect(out).toBe('真实的长内容…');
    expect(out).not.toContain('[paste #');
  });

  it('空输入返回空串', () => {
    expect(resolveSubmitText(src('', ''), '')).toBe('');
    expect(resolveSubmitText(src('   ', '   '), '   ')).toBe('');
  });
});
