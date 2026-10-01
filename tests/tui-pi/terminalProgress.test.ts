import { describe, expect, it } from 'vitest';

import { supportsTerminalProgress } from '../../src/tui-pi/terminalProgress.js';

/**
 * tab 加载动画（OSC 9;4）的能力探测判据。
 *
 * 这些断言锁的是「什么环境发、什么环境不发」。发错环境的后果不是难看，是不支持
 * OSC 9;4 的终端把 \x1b]9;4;3 当普通字节渲染成乱码，或 tmux 把它吞了用户永远
 * 看不到动画。判据取四类明确声明支持该协议的宿主，另加 tmux 一律排除。
 */
describe('supportsTerminalProgress', () => {
  it('Windows Terminal 会话内发', () => {
    expect(supportsTerminalProgress({ WT_SESSION: 'abc-123' } as NodeJS.ProcessEnv)).toBe(true);
  });

  it('ConEmu 发', () => {
    expect(supportsTerminalProgress({ ConEmuANSI: 'ON' } as NodeJS.ProcessEnv)).toBe(true);
  });

  it('Ghostty 与 WezTerm 发（TERM_PROGRAM 与 TERM 两条路都认）', () => {
    expect(supportsTerminalProgress({ TERM_PROGRAM: 'ghostty' } as NodeJS.ProcessEnv)).toBe(true);
    expect(supportsTerminalProgress({ TERM_PROGRAM: 'WezTerm' } as NodeJS.ProcessEnv)).toBe(true);
    expect(supportsTerminalProgress({ TERM: 'xterm-ghostty' } as NodeJS.ProcessEnv)).toBe(true);
  });

  it('空环境一律不发（含 WT_SESSION 为空串这种假阳性）', () => {
    expect(supportsTerminalProgress({} as NodeJS.ProcessEnv)).toBe(false);
    expect(supportsTerminalProgress({ WT_SESSION: '' } as NodeJS.ProcessEnv)).toBe(false);
    expect(supportsTerminalProgress({ TERM_PROGRAM: 'vscode' } as NodeJS.ProcessEnv)).toBe(false);
    expect(supportsTerminalProgress({ TERM: 'xterm-256color' } as NodeJS.ProcessEnv)).toBe(false);
  });

  it('tmux 内不发：WT_SESSION 和 TMUX 同时存在也不发', () => {
    // Windows Terminal 里跑 tmux 是常见叠用。序列会被 tmux 吞掉或需要 passthrough，
    // 用户看到 tab 没动画会以为功能坏了，故 tmux 内一律不发。
    expect(supportsTerminalProgress({ WT_SESSION: 'abc', TMUX: '/tmp/tmux-0/default,123,0' } as NodeJS.ProcessEnv)).toBe(
      false,
    );
  });
});
