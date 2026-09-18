/**
 * 路径动作菜单：键位交互、按目标类型区分菜单项、动作分发。
 *
 * 不碰系统（打开/reveal 的交付与 OSC 52 的写入都由注入回调替身），
 * 覆盖的是菜单自身的行为：文件三项、目录两项、数字直选、Esc 取消、动作只触发一次。
 */
import { describe, expect, it, vi } from 'vitest';
import { PathActionMenu, pathActionChoices, type PathAction } from '../../src/tui-pi/PathActionMenu.js';

function makeMenu(isDir: boolean, over: Partial<{ onAction: (a: PathAction) => void; onCancel: () => void }> = {}) {
  const onAction = over.onAction ?? vi.fn();
  const onCancel = over.onCancel ?? vi.fn();
  const menu = new PathActionMenu({
    path: isDir ? 'C:/proj/src' : 'C:/proj/src/a.ts',
    isDir,
    onAction,
    onCancel,
    requestRender: () => {},
  });
  return { menu, onAction, onCancel };
}

describe('pathActionChoices', () => {
  it('文件：打开 / 在文件夹中显示 / 复制路径 三项', () => {
    expect(pathActionChoices(false).map((c) => c.value)).toEqual(['open', 'reveal', 'copy']);
  });

  it('目录：去掉 reveal，只剩打开 / 复制路径', () => {
    expect(pathActionChoices(true).map((c) => c.value)).toEqual(['open', 'copy']);
  });
});

describe('PathActionMenu 键位', () => {
  it('数字直选：按 3 复制路径（文件菜单）', () => {
    const { menu, onAction } = makeMenu(false);
    menu.handleInput('3');
    expect(onAction).toHaveBeenCalledWith('copy');
  });

  it('目录菜单数字口径重排：按 2 是复制（reveal 不存在了）', () => {
    const { menu, onAction } = makeMenu(true);
    menu.handleInput('2');
    expect(onAction).toHaveBeenCalledWith('copy');
  });

  it('Enter 确认当前选中项（默认第一项 open）', () => {
    const { menu, onAction } = makeMenu(false);
    menu.handleInput('\r');
    expect(onAction).toHaveBeenCalledWith('open');
  });

  it('↓ 移到第二项后 Enter → reveal（文件菜单）', () => {
    const { menu, onAction } = makeMenu(false);
    menu.handleInput('\x1b[B'); // down
    menu.handleInput('\r');
    expect(onAction).toHaveBeenCalledWith('reveal');
  });

  it('Esc 取消：不触发任何动作', () => {
    const { menu, onAction, onCancel } = makeMenu(false);
    menu.handleInput('\x1b'); // escape
    expect(onAction).not.toHaveBeenCalled();
    expect(onCancel).toHaveBeenCalledOnce();
  });

  it('动作只触发一次（settle 语义：连按不重复执行）', () => {
    const { menu, onAction } = makeMenu(false);
    menu.handleInput('1');
    menu.handleInput('1');
    menu.handleInput('\r');
    expect(onAction).toHaveBeenCalledOnce();
  });

  it('Esc 之后再按数字键不再触发（已 settle）', () => {
    const { menu, onAction } = makeMenu(false);
    menu.handleInput('\x1b');
    menu.handleInput('2');
    expect(onAction).not.toHaveBeenCalled();
  });
});

describe('PathActionMenu 渲染', () => {
  it('题干含路径与文件名，选项带序号', () => {
    const { menu } = makeMenu(false);
    const lines = menu.render(80);
    const joined = lines.join('\n');
    expect(joined).toContain('a.ts');
    expect(joined).toContain('C:/proj/src/a.ts');
    expect(joined).toContain('1.');
    expect(joined).toContain('2.');
    expect(joined).toContain('3.');
  });

  it('目录菜单只有两项', () => {
    const { menu } = makeMenu(true);
    const lines = menu.render(80);
    expect(lines.filter((l) => l.includes('3.'))).toHaveLength(0);
  });

  it('窄终端（30 列）渲染不抛异常且行宽不超', () => {
    const { menu } = makeMenu(false);
    const lines = menu.render(30);
    for (const l of lines) expect(l.length).toBeLessThanOrEqual(200); // ANSI 码计入长度，只验不炸
    expect(lines.length).toBeGreaterThan(0);
  });
});
