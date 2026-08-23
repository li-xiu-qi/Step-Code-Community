import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ChatEditor } from '../../src/tui-pi/ChatEditor.js';
import { editorTheme } from '../../src/tui-pi/theme.js';

/**
 * 集成测试：验证 auto-pair 落到真实编辑器状态上——光标是否真被放到配对中间、
 * type-over 是否真右移。纯逻辑已在 autoPair.test.ts 覆盖，这里只验「决策 → 编辑器状态」接线。
 *
 * ChatEditor 继承 pi-tui Editor，构造只存 tui（不摸 tty），故传 stub TUI 即可实例化。
 * 方向键用标准 CSI（\x1b[D/\x1b[C），pi-tui 的 keys 表同时认这两组，终端差异不影响。
 */
const stubTui = { requestRender: () => {} } as any;

let editor: ChatEditor;
beforeEach(() => {
  editor = new ChatEditor(stubTui, editorTheme, { paddingX: 2 });
});
afterEach(() => {
  vi.restoreAllMocks();
});

const type = (data: string): void => editor.handleInput(data);
const text = (): string => editor.getText();
const col = (): number => editor.getCursor().col;
const left = (): void => editor.handleInput('\x1b[D');
const right = (): void => editor.handleInput('\x1b[C');
const bs = (): void => editor.handleInput('\x7f');

describe('ChatEditor 自动配对集成', () => {
  it('键入 ( 插入 () 且光标在中间', () => {
    type('(');
    expect(text()).toBe('()');
    expect(col()).toBe(1);
  });

  it('键入 [ 与 { 同理', () => {
    type('[');
    expect(text()).toBe('[]');
    expect(col()).toBe(1);
    editor.setText('');
    type('{');
    expect(text()).toBe('{}');
    expect(col()).toBe(1);
  });

  it('光标在 (|) 再按 ) 右移越过，不重复插入', () => {
    type('('); // () 光标 1
    type(')'); // type-over
    expect(text()).toBe('()');
    expect(col()).toBe(2);
  });

  it('括号后继续打字落在配对中间', () => {
    type('(');
    type('a');
    expect(text()).toBe('(a)');
    expect(col()).toBe(2);
  });

  it('引号在行尾配对', () => {
    type('"');
    expect(text()).toBe('""');
    expect(col()).toBe(1);
  });

  it('撇号后接字母不配对（dont 场景）', () => {
    editor.setText('dont');
    left(); // 光标到 't' 前（col 3），charAtCursor='t'
    type("'");
    expect(text()).toBe("don't");
    expect(col()).toBe(4);
  });

  it('普通字母不触发配对', () => {
    type('a');
    expect(text()).toBe('a');
    expect(col()).toBe(1);
  });

  it('kitty 编码的 ( 也能配对', () => {
    type('\x1b[40u');
    expect(text()).toBe('()');
    expect(col()).toBe(1);
  });

  it('type-over 后再打字替换离开配对', () => {
    type('('); // () 光标 1
    type(')'); // 越过 → 光标 2
    type('x'); // 末尾追加
    expect(text()).toBe('()x');
    expect(col()).toBe(3);
  });

  it('配对内退格整对删除：(|) 按退格 → 空', () => {
    type('('); // () 光标 1
    bs();
    expect(text()).toBe('');
    expect(col()).toBe(0);
  });

  it('配对内退格保留外部内容：()x 光标在 ( 后按退格 → 只剩 x', () => {
    type('('); // ()
    type(')'); // type-over → 光标 2
    type('x'); // ()x 光标 3
    left(); left(); // 回到 ( 与 ) 之间，光标 1
    bs();
    expect(text()).toBe('x');
    expect(col()).toBe(0);
  });

  it('非配对退格走正常逻辑：ab 末尾退格 → a', () => {
    type('a');
    type('b');
    bs();
    expect(text()).toBe('a');
    expect(col()).toBe(1);
  });
});
