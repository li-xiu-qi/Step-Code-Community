/**
 * stderrRecorder 测试：C 层 stderr 飞行记录器。
 * 钉三件事：透传终端不丢、落盘完整（fail-fast 前的断言文本必须留住）、超上限轮转。
 */
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { attachStderrRecorder, rotateStderrLog } from '../src/stderrRecorder.js';

let base: string;

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'stderr-rec-'));
});

afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

describe('attachStderrRecorder', () => {
  it('子进程 stderr 全量落盘（含进程异常退出前的输出）', async () => {
    const logPath = join(base, 'crash-stderr.log');
    // 用 process.abort() 模拟 C 层死亡：stderr 文本打完后进程立刻没，正是取证场景
    const child = spawn(process.execPath, ['-e', 'process.stderr.write("Assertion failed: demo, file src\\\\win\\\\fs-event.c, line 72"); process.abort()'], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    attachStderrRecorder(child, logPath);
    await new Promise<void>((resolve) => child.on('close', () => resolve()));

    const content = readFileSync(logPath, 'utf8');
    expect(content).toContain('Assertion failed: demo');
    expect(content).toContain('记录开始');
  });

  it('stderr 为空时也写会话头，不产生其他内容', async () => {
    const logPath = join(base, 'crash-stderr.log');
    const child = spawn(process.execPath, ['-e', ''], { stdio: ['ignore', 'pipe', 'pipe'] });
    attachStderrRecorder(child, logPath);
    await new Promise<void>((resolve) => child.on('close', () => resolve()));

    const content = readFileSync(logPath, 'utf8');
    expect(content).toContain('记录开始');
    expect(content.trim().split('\n')).toHaveLength(1); // trim 后只剩会话头一行
  });

  it('child.stderr 为 null（未开管道）时安静跳过', () => {
    const child = spawn(process.execPath, ['-e', ''], { stdio: ['ignore', 'pipe', 'inherit'] });
    expect(() => attachStderrRecorder(child, join(base, 'x.log'))).not.toThrow();
    child.kill();
  });
});

describe('rotateStderrLog', () => {
  it('超 2MB 截到尾部约 1MB', () => {
    const logPath = join(base, 'big.log');
    writeFileSync(logPath, Buffer.alloc(3 * 1024 * 1024, 65)); // 3MB 的 'A'
    rotateStderrLog(logPath);
    const size = statSync(logPath).size;
    expect(size).toBeLessThanOrEqual(1024 * 1024);
    expect(size).toBeGreaterThan(0);
  });

  it('小文件不动、文件不存在不抛', () => {
    const logPath = join(base, 'small.log');
    writeFileSync(logPath, 'hello');
    rotateStderrLog(logPath);
    expect(readFileSync(logPath, 'utf8')).toBe('hello');
    expect(existsSync(join(base, 'none.log'))).toBe(false);
    expect(() => rotateStderrLog(join(base, 'none.log'))).not.toThrow();
  });
});
