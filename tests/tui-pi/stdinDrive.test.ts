/**
 * 进程级输入驱动测试：真 spawn dist/main.js（pipe stdio），往 stdin 注入 SGR 鼠标
 * 序列，断言 UI 有响应帧。
 *
 * 存在意义：图片点击预览的链路是「终端上报 → pi-tui 分发 → focus 组件 handleInput
 * → 命中区域表 → 开浮层」。前三段在单测里全部离线绿灯之后，仍出现过真机点击无
 * 反应、只能靠用户截图定位的情况（2026-09-28）。本测试把中段钉在 CI 能跑的
 * 形态：pipe 不是 TTY，但 stdin 的字节一样进 pi-tui 的 data 流，注入的 SGR
 * 序列与真终端上报同形。ready 态无动画，「注入后有新输出」即可判定输入链活着。
 *
 * 不断言画面内容（那是 WT 的职责，属真机项），只守「输入 → 响应」不断裂与
 * 进程存活。依赖 dist/ 已构建，未构建则跳过（与 firstFrameSmoke 同策略）。
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const entry = join(repoRoot, 'dist', 'main.js');
const hasDist = existsSync(entry);

const SGR_PRESS = '\x1b[<0;5;5M'; // 左键 press，第 5 列第 5 行

async function driveApp(inject: string): Promise<{ bytes: number; delta: number; alive: boolean }> {
  const env = { ...process.env };
  delete env['NODE_ENV'];
  delete env['VITEST'];
  delete env['VITEST_WORKER_ID'];

  const child = spawn(process.execPath, [entry], { cwd: repoRoot, env, stdio: ['pipe', 'pipe', 'pipe'] });
  let bytes = 0;
  let exited = false;
  const onData = (chunk: Buffer): void => {
    bytes += chunk.length;
  };
  child.stdout.on('data', onData);
  child.stderr.on('data', onData);
  child.once('exit', () => {
    exited = true;
  });

  // 等首帧（welcome + chrome），ready 态无动画，之后的字节增量只能来自输入响应
  await new Promise<void>((resolve) => {
    const t = setTimeout(resolve, 8000);
    const iv = setInterval(() => {
      if (bytes > 200 || exited) {
        clearInterval(iv);
        clearTimeout(t);
        resolve();
      }
    }, 50);
  });
  const before = bytes;
  child.stdin!.write(inject);
  await new Promise<void>((resolve) => setTimeout(resolve, 1500));
  const delta = bytes - before;
  const alive = !exited;
  child.kill();
  await new Promise<void>((resolve) => child.once('exit', () => resolve()));
  return { bytes, delta, alive };
}

describe.skipIf(!hasDist)('stdin 驱动 TUI（输入链在线）', () => {
  it('注入 SGR 鼠标 press：有响应帧且进程存活', async () => {
    const r = await driveApp(SGR_PRESS);
    expect(r.bytes).toBeGreaterThan(200); // 首帧画出来了
    expect(r.delta).toBeGreaterThan(0); // 注入后有响应（输入链没断）
    expect(r.alive).toBe(true); // 没被注入打崩
  }, 20000);

  it('注入普通字符（非鼠标）：同样有响应、进程存活', async () => {
    const r = await driveApp('x'); // 未绑定字符，编辑器照常收
    expect(r.delta).toBeGreaterThan(0);
    expect(r.alive).toBe(true);
  }, 20000);
});

/** 注入 slash 命令并回收 stdout 全文（断言 hint 文案是否真的画出来）。 */
async function driveAppCapture(inject: string, expected: string): Promise<{ out: string; alive: boolean }> {
  const env = { ...process.env };
  delete env['NODE_ENV'];
  delete env['VITEST'];
  delete env['VITEST_WORKER_ID'];
  const child = spawn(process.execPath, [entry], { cwd: repoRoot, env, stdio: ['pipe', 'pipe', 'pipe'] });
  let out = '';
  let exited = false;
  child.stdout.on('data', (chunk: Buffer) => { out += chunk.toString('utf8'); });
  child.stderr.on('data', (chunk: Buffer) => { out += chunk.toString('utf8'); });
  child.once('exit', () => { exited = true; });
  await new Promise<void>((resolve) => {
    const t = setTimeout(resolve, 8000);
    const iv = setInterval(() => { if (out.length > 200 || exited) { clearInterval(iv); clearTimeout(t); resolve(); } }, 50);
  });
  child.stdin!.write(inject);
  // 轮询等 hint 出现或超时（固定 sleep 在慢机器上会 flaky）
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline && !out.includes(expected)) {
    await new Promise<void>((resolve) => setTimeout(resolve, 100));
  }
  await new Promise<void>((resolve) => setTimeout(resolve, 300));
  const alive = !exited;
  child.kill();
  await new Promise<void>((resolve) => child.once('exit', () => resolve()));
  return { out, alive };
}

describe.skipIf(!hasDist)('stdin 驱动 /rename（输入框可见性回归）', () => {
  it('输入 /rename：hint 行出现在终端输出里，进程存活', async () => {
    const r = await driveAppCapture('/rename\r');
    // 「/rename 后没有输入框」的回归判据：askLine 的提示行（i18n zh-CN）
    // 必须出现在 stdout。dock 布局根 + addChild 旧路径下它完全不渲染。
    expect(r.out).toContain('当前会话新名字');
    expect(r.alive).toBe(true);
  }, 25000);
});
