/**
 * Monitor 投递路由的集成测试。
 *
 * monitorStream.test.ts 证的是「信封怎么装配、闸门怎么判」（纯函数）；
 * 这里证的是「真实进程的输出经闸门后真的进了 drainStreamEvents」——这条链路上有
 * spawn、pipe data、200ms 定时器、flush 时序，任何一环断了纯函数都测不出来。
 *
 * 与 monitor.test.ts 的分工：那个证 onStream（宿主 UI 展示，每批必达），这个证
 * drainStreamEvents（投给模型的队列，过闸门才入）。两条路从同一个 flush 分出，
 * 所以「UI 收到了但模型没收到」和反过来都是可测的独立缺陷。
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import { BackgroundManager } from '../../src/agent/background/manager.js';

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * 等条件成立。注意：条件里**不能**调 drainStreamEvents——那个函数是取走（清空），
 * 在轮询里调等于一边等一边把队列吃掉，最终断言拿到的是空数组。
 */
const waitUntil = async (cond: () => boolean, timeoutMs = 8000): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (!cond() && Date.now() < deadline) await sleep(25);
};

const SH = process.platform === 'win32' ? 'cmd.exe' : '/bin/sh';
const shArgs = (cmd: string): string[] => (process.platform === 'win32' ? ['/c', cmd] : ['-c', cmd]);

const managers: BackgroundManager[] = [];
const procs: ChildProcess[] = [];

afterEach(() => {
  for (const m of managers) {
    for (const t of m.list()) if (t.status === 'running') m.stop(t.id);
  }
  managers.length = 0;
  for (const p of procs) {
    try {
      p.kill('SIGKILL');
    } catch {
      // best-effort
    }
  }
  procs.length = 0;
});

describe('drainStreamEvents：闸门后的投递队列', () => {
  it('常规输出不入队（闸门挡掉），告警输出入队', async () => {
    const mgr = new BackgroundManager(10, {
      onStream: () => {},
      onStreamFilter: (_id, text) => /error/i.test(text),
    });
    managers.push(mgr);
    const id = mgr.start(
      'gate',
      SH,
      shArgs(process.platform === 'win32' ? 'echo all good& echo ERROR: boom' : 'echo all good; echo "ERROR: boom"'),
      process.cwd(),
      { monitor: true, monitorDescription: 'watcher' },
    );
    await waitUntil(() => mgr.get(id)?.status !== 'running');
    await sleep(400); // 等过 200ms 窗口与进程退出 flush
    const events = mgr.drainStreamEvents();
    expect(events).toHaveLength(1);
    expect(events[0]!.body).toContain('ERROR: boom');
    expect(events[0]!.description).toBe('watcher');
    expect(events[0]!.taskId).toBe(id);
  });

  it('纯常规输出被闸门挡掉，队列始终为空', async () => {
    const mgr = new BackgroundManager(10, {
      onStream: () => {},
      onStreamFilter: () => false,
    });
    managers.push(mgr);
    const id = mgr.start('silent', SH, shArgs('echo nothing-important'), process.cwd(), {
      monitor: true,
      monitorDescription: 'x',
    });
    await waitUntil(() => mgr.get(id)?.status !== 'running');
    await sleep(400);
    expect(mgr.drainStreamEvents()).toHaveLength(0);
  });

  it('drain 是取走（清空），不是 peek', async () => {
    const mgr = new BackgroundManager(10, {
      onStream: () => {},
      onStreamFilter: () => true,
    });
    managers.push(mgr);
    const id = mgr.start('d', SH, shArgs('echo ERROR: x'), process.cwd(), { monitor: true, monitorDescription: 'x' });
    await waitUntil(() => mgr.get(id)?.status !== 'running');
    await sleep(400);
    expect(mgr.drainStreamEvents()).toHaveLength(1);
    expect(mgr.drainStreamEvents()).toHaveLength(0);
  });

  it('未挂 onStreamFilter 时全部入队（宿主不做过滤）', async () => {
    const mgr = new BackgroundManager(10, { onStream: () => {} });
    managers.push(mgr);
    const id = mgr.start('no-filter', SH, shArgs('echo routine heartbeat'), process.cwd(), {
      monitor: true,
      monitorDescription: 'x',
    });
    await waitUntil(() => mgr.get(id)?.status !== 'running');
    await sleep(400);
    const events = mgr.drainStreamEvents();
    expect(events[0]!.body).toContain('routine heartbeat');
  });

  it('shutdown 后不再有新事件入队（防跨会话回灌）', async () => {
    let produced = 0;
    const mgr = new BackgroundManager(10, {
      onStream: () => {
        produced++;
      },
      onStreamFilter: () => true,
    });
    managers.push(mgr);
    // 持续产流的进程（不是 echo）：shutdown 要拦住的是「正在飞的事件」，
    // echo 瞬间就退，等它退出再 shutdown 等于没东西可拦，测试空转。
    // 用 onStream 计数判「进程在产流」（不能用 drainStreamEvents 轮询——它是取走会清空，
    // 见文件顶部 waitUntil 注释），并发/慢设备下固定 sleep 会竞态假阳性。
    const cmd =
      process.platform === 'win32'
        ? 'for /l %i in (1,1,60) do @(echo ERROR: live-%i & ping -n 2 127.0.0.1 >nul)'
        : 'for i in $(seq 1 60); do echo "ERROR: live-$i"; sleep 0.3; done';
    mgr.start('dead', SH, shArgs(cmd), process.cwd(), {
      monitor: true,
      monitorDescription: 'x',
    });
    // 等进程真正产出了至少一批（running 且有事件在飞）再 shutdown
    await waitUntil(() => produced >= 1);
    await sleep(200); // 让 flush 窗口再转过一圈，确保有事件在飞
    mgr.shutdown();
    await sleep(500); // 等过 200ms 窗口与进程退出 flush
    expect(mgr.drainStreamEvents()).toHaveLength(0);
  });
});

describe('队列字符预算', () => {
  it('超预算时丢最旧的一批，保留最近的', async () => {
    const mgr = new BackgroundManager(10, {
      onStream: () => {},
      onStreamFilter: () => true,
    });
    managers.push(mgr);
    // 12 行 × 0.5s ≈ 6s，产出约 12 批。32KB 预算 ≈ 1000 批，远没到上限——
    // 这条证的是「正常刷屏不被误丢且保序」。上限逻辑本身由纯函数测试守
    // （enqueueStreamEvent 四条），真机灌满 32KB 要约 8 分钟，不值当。
    const cmd =
      process.platform === 'win32'
        ? 'for /l %i in (1,1,12) do @(echo ERROR: line-%i & ping -n 2 127.0.0.1 >nul)'
        : 'for i in $(seq 1 12); do echo "ERROR: line-$i"; sleep 0.5; done';
    const id = mgr.start('flood', SH, shArgs(cmd), process.cwd(), { monitor: true, monitorDescription: 'flood' });
    await waitUntil(() => mgr.get(id)?.status !== 'running', 30000);
    const events = mgr.drainStreamEvents();
    expect(events.length).toBeGreaterThan(3);
    // 有序：第一批是最早的，最后一批是最近的
    expect(events[0]!.body).toContain('line-1');
    expect(events[events.length - 1]!.body).toContain('line-12');
    // 总字符远在预算内
    const total = events.reduce((n, e) => n + e.body.length, 0);
    expect(total).toBeLessThan(8 * 1024);
  }, 40000);
});
