/**
 * 控制台护栏测试：TUI 存活期 console.* 与 stderr 直写被路由进 sink，不碰物理终端；
 * 恢复后出口还原；重复安装自动拆除上一层（/new 换会话旧实例没走 exit 的场景）。
 *
 * 所有用例一律 try/finally 恢复：护栏替换的是全局 console，断言抛错若跳过恢复，
 * vitest 后续输出会被一起吞掉。
 */
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { installConsoleGuard } from '../../src/chat/consoleGuard.js';

describe('consoleGuard', () => {
  it('console.* 被拦截进 sink，恢复后还原', () => {
    const got: string[] = [];
    const restore = installConsoleGuard({ onText: (t) => got.push(t) });
    try {
      console.log('hello %s', 'world');
      console.warn('一条警告');
      console.error('x', 1, 2);
    } finally {
      restore();
    }
    expect(got).toEqual(['hello world', '一条警告', 'x 1 2']);
    // 恢复后再装一层能收到，证明出口确实还原（而不是被吞进第一层）
    const got2: string[] = [];
    const restore2 = installConsoleGuard({ onText: (t) => got2.push(t) });
    try {
      console.log('second');
    } finally {
      restore2();
    }
    expect(got2).toEqual(['second']);
  });

  it('stderr 直写（Node warning 同款路径）被拦截且回 true', () => {
    const got: string[] = [];
    const restore = installConsoleGuard({ onText: (t) => got.push(t) });
    let ok = false;
    try {
      ok = process.stderr.write('ExperimentalWarning: something\n');
    } finally {
      restore();
    }
    expect(ok).toBe(true);
    expect(got).toEqual(['ExperimentalWarning: something']);
  });

  it('全量日志 best-effort 落盘', () => {
    const dir = mkdtempSync(join(tmpdir(), 'guard-'));
    const logPath = join(dir, 'console-guard.log');
    const restore = installConsoleGuard({ onText: () => {}, logPath });
    try {
      console.warn('落盘这条');
    } finally {
      restore();
    }
    expect(existsSync(logPath)).toBe(true);
    expect(readFileSync(logPath, 'utf8')).toContain('落盘这条');
  });

  it('重复安装先拆上一层：旧 sink 不再收到、console 不被吞进死实例', () => {
    const gotA: string[] = [];
    const gotB: string[] = [];
    const restoreB = (() => {
      installConsoleGuard({ onText: (t) => gotA.push(t) }); // 故意不恢复，模拟旧 PiChat 没走 exit
      return installConsoleGuard({ onText: (t) => gotB.push(t) });
    })();
    try {
      console.log('只属于 B');
    } finally {
      restoreB();
    }
    expect(gotA).toEqual([]);
    expect(gotB).toEqual(['只属于 B']);
  });

  it('空文本与纯空白不上报', () => {
    const got: string[] = [];
    const restore = installConsoleGuard({ onText: (t) => got.push(t) });
    try {
      process.stderr.write('\n');
      console.log('');
    } finally {
      restore();
    }
    expect(got).toEqual([]);
  });
});
