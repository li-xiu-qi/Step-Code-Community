import { describe, expect, it } from 'vitest';
import { BackgroundManager } from '../../src/agent/background/manager.js';
import { taskListTool, taskOutputTool, taskStopTool, taskWaitTool } from '../../src/tools/task.js';

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// 轮询等到位，替代固定 sleep 猜时序：真实子进程的完成/输出捕获受 CPU 争抢影响，
// 固定等待在满载或慢设备上会误报（假阳性）。deadline 给足余量，真挂起一样会超时。
const waitUntil = async (cond: () => boolean, timeoutMs = 10_000): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (!cond() && Date.now() < deadline) await sleep(20);
};

describe('BackgroundManager', () => {
  it('启动后台任务立即返回 id，完成后状态为 completed', async () => {
    const mgr = new BackgroundManager();
    const id = mgr.start('echo hi', process.platform === 'win32' ? 'cmd.exe' : '/bin/sh', process.platform === 'win32' ? ['/c', 'echo hi'] : ['-c', 'echo hi'], process.cwd());
    expect(id).toBeTruthy();
    expect(mgr.get(id)?.status).toBe('running');
    await waitUntil(() => mgr.get(id)?.status === 'completed');
    expect(mgr.get(id)?.status).toBe('completed');
  });

  it('list 返回所有任务', async () => {
    const mgr = new BackgroundManager();
    mgr.start('a', process.platform === 'win32' ? 'cmd.exe' : '/bin/sh', process.platform === 'win32' ? ['/c', 'echo a'] : ['-c', 'echo a'], process.cwd());
    await sleep(300);
    expect(mgr.list().length).toBeGreaterThanOrEqual(1);
  });

  it('stop 终止运行中任务', async () => {
    const mgr = new BackgroundManager();
    const id = mgr.start(
      'sleep',
      process.platform === 'win32' ? 'cmd.exe' : '/bin/sh',
      process.platform === 'win32' ? ['/c', 'ping -n 10 127.0.0.1 >nul'] : ['-c', 'sleep 5'],
      process.cwd(),
    );
    expect(mgr.stop(id)).toBe(true);
    expect(mgr.get(id)?.status).toBe('killed');
  });
});

describe('task 工具', () => {
  it('task_list 无后台管理器时报不支持', async () => {
    const r = await taskListTool.execute({}, { cwd: process.cwd() });
    expect(r.content).toContain('不支持');
  });

  it('task_output / task_stop 查询与终止', async () => {
    const mgr = new BackgroundManager();
    const id = mgr.start('echo hello', process.platform === 'win32' ? 'cmd.exe' : '/bin/sh', process.platform === 'win32' ? ['/c', 'echo hello'] : ['-c', 'echo hello'], process.cwd());
    await waitUntil(() => mgr.get(id)?.status === 'completed');
    const out = await taskOutputTool.execute({ task_id: id }, { cwd: process.cwd(), background: mgr });
    expect(out.content).toContain('hello');
    const stop = await taskStopTool.execute({ task_id: id }, { cwd: process.cwd(), background: mgr });
    expect(stop.isError).toBe(true); // 已完成的任务无法再终止
  });
});

// 起一个「子进程永不退出」的任务：等价于 ssh 起远端常驻进程、远端持有 channel 使 ssh
// 不返回。这类任务的后台绝对超时那条链永不触发（没有 exit、没有 close），
// 唯一能拦住 task_wait 的就是它自身的封顶。
function startNeverExiting(mgr: BackgroundManager): string {
  return mgr.start(
    'sleep-forever',
    process.execPath,
    ['-e', 'setTimeout(() => {}, 60_000)'],
    process.cwd(),
  );
}

describe('task_wait 单次等待封顶', () => {
  it('到点未到终态：返回「仍在运行」而非失败，且不谎报完成', async () => {
    const mgr = new BackgroundManager();
    const id = startNeverExiting(mgr);
    const r = await taskWaitTool.execute(
      { task_id: id, timeout_s: 1 },
      { cwd: process.cwd(), background: mgr },
    );
    expect(r.isError).toBe(false); // 超时不是失败
    expect(r.content).toContain('等待超时（1s）');
    expect(r.content).toContain('仍在后台运行');
    expect(r.content).toContain('task_output'); // 给出续查手段
    expect(r.content).not.toContain('✓ 完成'); // 不得把半截输出当终态
    mgr.stop(id);
  });

  it('不传 timeout_s 时默认封顶为有限值，不是无限阻塞', async () => {
    // 默认 30s 不便真等，改为劫持 waitFor 捕获实参后立即返回 running 快照：
    // 断言工具确实向 manager 传了 30s 这个默认毫秒数，同时不依赖等待真实流逝。
    const mgr = new BackgroundManager();
    const id = startNeverExiting(mgr);
    const seen: unknown[] = [];
    mgr.waitFor = (tid, _signal, maxWaitMs) => {
      seen.push(maxWaitMs);
      return Promise.resolve({ ...mgr.get(tid)!, status: 'running' as const });
    };
    const r = await taskWaitTool.execute({ task_id: id }, { cwd: process.cwd(), background: mgr });
    mgr.stop(id);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toBe(30_000);
    // description 与常量同源：提示词里承诺的默认值必须就是实际用的值
    expect(taskWaitTool.description).toContain('默认 30s');
    // 桩返回 running，工具应按超时路径给出续查手段
    expect(r.content).toContain('仍在后台运行');
  });

  it('task_output 连续两次读到相同状态与输出 → 注入反轮询提示', async () => {
    const mgr = new BackgroundManager();
    const id = mgr.start(
      'echo hello',
      process.platform === 'win32' ? 'cmd.exe' : '/bin/sh',
      process.platform === 'win32' ? ['/c', 'echo hello'] : ['-c', 'echo hello'],
      process.cwd(),
    );
    await waitUntil(() => mgr.get(id)?.status === 'completed');
    const base = { cwd: process.cwd(), background: mgr, sessionId: 'poll-hint-session' };

    const first = await taskOutputTool.execute({ task_id: id }, base);
    expect(first.content).toContain('hello');
    expect(first.content).not.toContain('不要连续原地轮询'); // 首次读取是冷读，不劝阻

    const second = await taskOutputTool.execute({ task_id: id }, base);
    expect(second.content).toContain('不要连续原地轮询');
    expect(second.content).toContain('task_wait'); // 给出唯一的同步等待手段
  });

  it('封顶期间任务自然完成：正常返回终态，封顶不干扰正常路径', async () => {
    const mgr = new BackgroundManager();
    const id = mgr.start(
      'echo hi',
      process.platform === 'win32' ? 'cmd.exe' : '/bin/sh',
      process.platform === 'win32' ? ['/c', 'echo hi'] : ['-c', 'echo hi'],
      process.cwd(),
    );
    const r = await taskWaitTool.execute(
      { task_id: id, timeout_s: 30 },
      { cwd: process.cwd(), background: mgr },
    );
    expect(r.isError).toBe(false);
    expect(r.content).toContain('✓ 完成');
    expect(r.content).toContain('hi');
    expect(r.content).not.toContain('等待超时');
  });

  it('waitFor 超时返回 running 快照后，任务后续 settle 不残留 waiters', async () => {
    const mgr = new BackgroundManager();
    const id = startNeverExiting(mgr);
    // 先等超时
    await taskWaitTool.execute({ task_id: id, timeout_s: 1 }, { cwd: process.cwd(), background: mgr });
    // 再杀它，settle 应正常发生且不因残留 waiter 抛错
    expect(mgr.stop(id)).toBe(true);
    await waitUntil(() => mgr.get(id)?.status === 'killed');
    expect(mgr.get(id)?.status).toBe('killed');
  });
});
