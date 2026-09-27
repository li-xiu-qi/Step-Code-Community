/**
 * 终端图片渲染拆除后的转录渲染测试（2026-09-22）。
 *
 * pi-tui 对 Windows Terminal 恒报 images:null，内联 kitty 序列在 WT alt-screen 下
 * 从未走通（曾按「WT ≥1.22 强制启用 kitty」打过补丁，实测留下大片空白占位）。
 * 终端图片渲染链路已整体拆除，本测试钉住新行为：
 * - 任何输入都不产生 kitty 转义序列；
 * - 用户条目的图片只以文本计数标签存在（[N 张图] 由 PiChat 拼入正文，ItemBlock 只见文本）；
 * - 工具结果的图片提示是结果文本里的一行（PiChat 侧拼入），无独立渲染分支。
 */
import { describe, expect, it } from 'vitest';
import { ItemBlock } from '../../src/tui-pi/blocks.js';
import type { DisplayItem } from '../../src/chat/types.js';

describe('终端图片渲染拆除后的转录渲染', () => {
  it('用户条目只渲染文本，不出现 kitty 转义序列', () => {
    const item: DisplayItem = { kind: 'user', text: '看这张图 [1 张图]', turnNum: 1 };
    const lines = new ItemBlock(item).render(80);
    const joined = lines.join('\n');
    expect(joined).toContain('看这张图 [1 张图]');
    expect(joined).not.toContain('\x1b_G');
  });

  it('纯文本用户消息不受影响', () => {
    const item: DisplayItem = { kind: 'user', text: '纯文本消息', turnNum: 1 };
    const joined = new ItemBlock(item).render(80).join('\n');
    expect(joined).toContain('纯文本消息');
    expect(joined).not.toContain('\x1b_G');
  });

  it('工具结果里的图片提示走普通文本渲染，无转义序列', () => {
    const item: DisplayItem = {
      kind: 'tool',
      id: 't1',
      name: 'read_media',
      input: { path: 'screenshot.png' },
      status: 'ok',
      result: '图片已读取\n（1 张图片结果，终端不显示）',
      resultSize: 20,
    };
    const joined = new ItemBlock(item).render(80).join('\n');
    expect(joined).toContain('read_media');
    expect(joined).toContain('（1 张图片结果，终端不显示）');
    expect(joined).not.toContain('\x1b_G');
  });

  it('无图片提示的普通工具不渲染图片', () => {
    const item: DisplayItem = {
      kind: 'tool',
      id: 't1',
      name: 'bash',
      input: { command: 'ls' },
      status: 'ok',
      result: 'a.txt',
    };
    expect(new ItemBlock(item).render(80).join('\n')).not.toContain('\x1b_G');
  });
});
