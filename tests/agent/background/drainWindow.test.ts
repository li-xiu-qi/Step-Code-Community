import { spawn } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  BackgroundManager,
  createDrainWindow,
} from '../../../src/agent/background/manager.js';
import { resolveShell } from '../../../src/tools/shellResolve.js';

/**
 * 进程退出后的 stdio 排空窗口。
 *
 * 这个窗口是「确保任务结束时肯定有输出」的落点：Node 的 `close` 要等 stdout/stderr 管道
 * 全部写端关闭才触发，孙进程继承写端时 `close` 与流的 `end` 都可能永不触发，
 * 「等 end 齐了再结算」会永久挂起。所以排空必须是有界的。
 *
 * 下面这些用例里的 idleMs/maxMs 是**自选的任意值**，测的是 helper 的契约
 * （到点才触发、poke 可续空闲闸、硬上限不可续），不是生产阈值。生产阈值由
 * bash.test.ts 的端到端用例覆盖，改 DRAIN_IDLE_MS 时这里不必跟着改。
 *
 * 用假时钟而不是真实 sleep：这几个用例断言的都是「到点才触发」这类时序边界，
 * 真实 sleep 在 16 核并发下会被拖长，表现为每次挂的用例都不同的跨文件漂移。
 */
describe('createDrainWindow 排空窗口双闸', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('未 open 时 poke 是空操作，定时器不武装', () => {
    const onGiveUp = vi.fn();
    const w = createDrainWindow({ idleMs: 250, maxMs: 2_000, onGiveUp });
    w.poke();
    vi.advanceTimersByTime(5_000);
    expect(onGiveUp).not.toHaveBeenCalled();
  });

  it('空闲闸：无数据时 idleMs 到点触发 giveUp', () => {
    const onGiveUp = vi.fn();
    const w = createDrainWindow({ idleMs: 250, maxMs: 2_000, onGiveUp });
    w.open();
    vi.advanceTimersByTime(249);
    expect(onGiveUp).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onGiveUp).toHaveBeenCalledTimes(1);
  });

  it('空闲闸可被 poke 续命：持续有输出时不在 idleMs 收', () => {
    const onGiveUp = vi.fn();
    const w = createDrainWindow({ idleMs: 250, maxMs: 2_000, onGiveUp });
    w.open();
    // 每 100ms 来一次数据，模拟孙进程退出后还在往管道里写
    for (let i = 0; i < 10; i++) {
      vi.advanceTimersByTime(100);
      w.poke();
    }
    expect(onGiveUp).not.toHaveBeenCalled(); // 1s 内一直在出输出，不能被切
    vi.advanceTimersByTime(250);
    expect(onGiveUp).toHaveBeenCalledTimes(1); // 输出停了，250ms 后排空完成
  });

  it('硬上限：输出一直不停时 maxMs 无条件收，poke 不能无限续', () => {
    const onGiveUp = vi.fn();
    const w = createDrainWindow({ idleMs: 250, maxMs: 2_000, onGiveUp });
    w.open();
    for (let i = 0; i < 40; i++) {
      vi.advanceTimersByTime(100);
      w.poke();
    }
    expect(onGiveUp).toHaveBeenCalledTimes(1); // 4s 全程有输出，靠硬上限收住
  });

  it('clear 阻止 giveUp：end 自然到达后窗口不得再误触发', () => {
    const onGiveUp = vi.fn();
    const w = createDrainWindow({ idleMs: 250, maxMs: 2_000, onGiveUp });
    w.open();
    vi.advanceTimersByTime(100);
    w.clear();
    vi.advanceTimersByTime(5_000);
    expect(onGiveUp).not.toHaveBeenCalled();
  });

  it('giveUp 是幂等的：两个闸同时到点只触发一次', () => {
    const onGiveUp = vi.fn();
    const w = createDrainWindow({ idleMs: 250, maxMs: 2_000, onGiveUp });
    w.open();
    vi.advanceTimersByTime(2_000);
    expect(onGiveUp).toHaveBeenCalledTimes(1);
  });

  it('open 幂等：重复 open 不重复武装', () => {
    const onGiveUp = vi.fn();
    const w = createDrainWindow({ idleMs: 250, maxMs: 2_000, onGiveUp });
    w.open();
    w.open();
    vi.advanceTimersByTime(250);
    expect(onGiveUp).toHaveBeenCalledTimes(1);
  });
});

/**
 * 接管发生在进程退出**之后**的场景。
 *
 * 前台超时转后台时，bash 早在 detach 之前就已 exit，`takeOver` 里挂的 `onExit` 监听器
 * 永远不会再触发。若排空窗口只由 `onExit` 武装，接管后就再也没有任何路径能触发结算，
 * 任务只能等孙进程自己结束、管道自然 close——表现为「进程早死了，任务还要再等几秒」。
 *
 * 所以 takeOver 在挂完监听器后要补一次出口检查：已退出就记账并武装窗口（或管道已排空则直接结算）。
 */
/**
 * 接管发生在进程退出**之后**的场景。
 *
 * 前台超时转后台时，bash 早在 detach 之前就已 exit，`takeOver` 里挂的 `onExit` 监听器
 * 永远不会再触发。若排空窗口只由 `onExit` 武装，接管后就再也没有路径能触发结算，
 * 任务只能等孙进程自己结束、管道自然 close——表现为「进程早死了，任务还要再等几秒」。
 *
 * 所以 takeOver 在挂完监听器后要补一次出口检查：已退出就记账，管道已排空则直接结算，
 * 没排空则武装窗口。这里用 registerForeground 直接构造「proc 已 exit 而任务仍 running」。
 */
describe('takeOver 接管已退出的进程', () => {
  const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

  it('进程已退出且管道已排空：接管后立即结算，不挂起', async () => {
    const shell = resolveShell();
    const cmd = 'sleep 0.2 & echo launched';
    const proc = spawn(shell.cmd, shell.args(cmd), {
      cwd: process.cwd(),
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
    });
    let partial = '';
    proc.stdout?.on('data', (c) => { partial += c.toString('utf8'); });
    proc.stderr?.on('data', (c) => { partial += c.toString('utf8'); });
    const mgr = new BackgroundManager(10, { onSettle: () => {} });
    const id = mgr.registerForeground(cmd, proc, () => partial);
    await sleep(1500); // bash 早已 exit，孙进程与管道都已结束
    expect(mgr.get(id)?.status).toBe('running'); // 未 detach，仍登记为前台
    expect(mgr.detach(id, true)).toBe(true);
    expect(mgr.get(id)?.status).toBe('completed');
    expect(mgr.get(id)?.output).toContain('launched');
    mgr.stop(id);
  }, 20000);

  it('注入的假进程（无 exitCode 字段）不得被误判为已退出', async () => {
    // 回归点：接管补检最初的判据写的是 `!== null`，而假进程的 exitCode 是 undefined，
    // undefined !== null 为真，于是假进程被记成已退出。terminate 的 SIGKILL 兜底守卫
    // `task.exited !== true` 被永久跳过，温和终止失败的进程就此变孤儿继续跑。
    // 这条用 terminate 路径验证：超时后 SIGTERM 与 SIGKILL 都必须发出。
    const calls: { proc: unknown; signal: string }[] = [];
    const mgr = new BackgroundManager(10, {
      taskTimeoutS: 0.05,
      killProc: (proc, signal) => calls.push({ proc, signal }),
    });
    const fakeProc = { pid: 99999, on: () => {}, once: () => {}, stdout: null, stderr: null } as never;
    mgr.adopt('sleep 999', fakeProc, '');
    await new Promise((r) => setTimeout(r, 2600));
    expect(calls.find((c) => c.signal === 'SIGTERM'), 'SIGTERM 没发出').toBeDefined();
    expect(calls.find((c) => c.signal === 'SIGKILL'), 'SIGKILL 兜底没发出，进程会变孤儿').toBeDefined();
  }, 20000);

  it('进程已退出但管道仍被孙进程持有：接管后窗口到点强制结算', async () => {
    const shell = resolveShell();
    const cmd = 'for i in $(seq 1 80); do echo "tick-$i"; sleep 0.1; done & echo launched';
    const proc = spawn(shell.cmd, shell.args(cmd), {
      cwd: process.cwd(),
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
    });
    let partial = '';
    proc.stdout?.on('data', (c) => { partial += c.toString('utf8'); });
    proc.stderr?.on('data', (c) => { partial += c.toString('utf8'); });
    const mgr = new BackgroundManager(10, { onSettle: () => {} });
    const id = mgr.registerForeground(cmd, proc, () => partial);
    await sleep(1200); // bash 已 exit，孙进程还在写（总跨度 8s）
    expect(mgr.get(id)?.status).toBe('running');
    expect(mgr.detach(id, true)).toBe(true);
    const t0 = Date.now();
    for (let i = 0; i < 60 && mgr.get(id)?.status === 'running'; i++) {
      await sleep(100);
    }
    const elapsed = Date.now() - t0;
    expect(mgr.get(id)?.status).toBe('completed');
    // 排空窗口硬上限 2s + 轮询余量，远小于孙进程的 8s 寿命
    expect(elapsed).toBeLessThan(5_000);
    mgr.stop(id);
  }, 20000);
});
