/**
 * 视口滚动键位的归属测试。
 *
 * 背景：Ctrl+End / Ctrl+↑ / Ctrl+Home 原本实现在 ChatEditor.handleInput 里。
 * 审批、计划确认、用户提问三类弹层都会 setFocus 抢走焦点，而 pi-tui 的键盘只投给
 * focused component，于是弹层一弹出这三个键就静默失效（2026-08-30 用户实测报告：
 * ask_user 运行时 Ctrl+End 与 Ctrl+↑ 无反应）。
 *
 * 修法是把它们从编辑器层移到 altScreen 全局键位层。这里钉住的是「必须待在全局层」
 * 这一条，因为搬回编辑器不会有任何编译错误或单测失败，只会在真机上静默失效——
 * 那种回归单测拦不住，只有断言配置本身拦得住。
 */
import { describe, expect, it, beforeEach } from 'vitest';
import { getKeybindings } from '@earendil-works/pi-tui';
import { VIEWPORT_KEYBINDINGS } from '../../src/tui-pi/PiChat.js';

// getKeybindings() 是全局单例，setUserBindings 的副作用跨测试留存。
// 每个用例前重置为空，否则上一个用例的绑定会串到下一个。
beforeEach(() => {
  getKeybindings().setUserBindings({});
});

/** getResolvedBindings 单键时返回裸字符串、多键才返回数组；这里归一化成数组再断言。
 *  不归一化的话 toContain 会退化成子串匹配，'ctrl+home' 会被判成含 'home'。 */
function keysOf(v: unknown): string[] {
  if (Array.isArray(v)) return v as string[];
  if (typeof v === 'string') return [v];
  return [];
}

describe('视口滚动键位', () => {
  it('三个键都绑在 altScreen 全局层，不依赖编辑器持有焦点', () => {
    getKeybindings().setUserBindings({ ...VIEWPORT_KEYBINDINGS });
    const r = getKeybindings().getResolvedBindings();

    // Ctrl+End → 会话流底部
    expect(keysOf(r['tui.altScreen.bottom'])).toContain('ctrl+end');
    // Ctrl+Home → 会话流顶部
    expect(keysOf(r['tui.altScreen.top'])).toContain('ctrl+home');
    // Ctrl+↑ → 上一个 prompt（ctrl+shift+up 是 pi-tui 原默认，一并保留）
    expect(keysOf(r['tui.altScreen.previousPrompt'])).toContain('ctrl+up');
    expect(keysOf(r['tui.altScreen.previousPrompt'])).toContain('ctrl+shift+up');
  });

  it('plain Home/End 不触发 viewport 滚动，留给编辑器做光标导航', () => {
    getKeybindings().setUserBindings({ ...VIEWPORT_KEYBINDINGS });
    const r = getKeybindings().getResolvedBindings();

    expect(keysOf(r['tui.altScreen.top'])).not.toContain('home');
    expect(keysOf(r['tui.altScreen.bottom'])).not.toContain('end');
  });

  it('与 pi-tui 编辑器光标键同键，属有意劫持而非意外碰撞', () => {
    // tui.editor.cursorLineStart/End 的 defaultKeys 含 home/ctrl+home、end/ctrl+end。
    // 全局层先于 focused component 处理，所以 Ctrl+Home/Ctrl+End 被我们截走。
    // 这条断言把「同键」显式记下来：将来若有人给这两个编辑器绑定改键位，会先看到这里。
    expect(getKeybindings().getDefinition('tui.editor.cursorLineStart')?.defaultKeys).toContain('ctrl+home');
    expect(getKeybindings().getDefinition('tui.editor.cursorLineEnd')?.defaultKeys).toContain('ctrl+end');
  });

  it('Ctrl+↓ 半屏滚动不在此表（pi-tui 与编辑器的行数口径不一致）', () => {
    // pi-tui 的 halfPageDown 按 viewportHeight/2 算，ChatEditor 按 terminal.rows/2 算。
    // 后者更大（含 chrome），移过去会让滚动距离变短，属行为变更而非等价搬迁。
    const r = getKeybindings().getResolvedBindings();
    expect(keysOf(r['tui.altScreen.halfPageDown'])).toEqual([]);
  });
});
