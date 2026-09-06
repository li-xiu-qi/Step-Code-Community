/**
 * Monitor 流式监听的集成测试。
 *
 * 纯函数层（monitorBatcher.test.ts）证的是「怎么切行、怎么合并」；
 * 这里证的是「真实进程的 stdout 真的会流到 onStream」——这条链路上有 spawn、
 * pipe data 事件、定时器、close 时序，任何一环断了纯函数都测不出来。
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import { BackgroundManager, type BackgroundTask } from '../../src/agent/background/manager.js';

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

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

describe('Monitor：stdout 流到 onStream', () => {
  it('输出按行切分，200ms 窗口内多行合并为一批', async () => {
    const batches: Array<{ text: string; desc: string }> = [];
    const mgr = new BackgroundManager(10, {
      onStream: (taskId, text, description) => batches.push({ text, desc: description }),
    });
    managers.push(mgr);
    // 一次 echo 三行：pipe data 通常一次到达，应当合成一条
    mgr.start(
      'echo-a-b-c',
      SH,
      // 用 & 分隔而不是 \n：cmd.exe 会把 `echo a\necho b` 里的第二段当成第一段的参数，只输出一行。
      // 真实进程的到达节奏就是分片的——这条断言的是三行最终都到齐，不假定一批收齐。
      shArgs(process.platform === 'win32' ? 'echo one& echo two& echo three' : 'echo one; echo two; echo three'),
      process.cwd(),
      { monitor: true, monitorDescription: 'errors in test.log' },
    );
    await waitUntil(() => batches.some((b) => b.text.includes('three')));
    expect(batches[0]!.desc).toBe('errors in test.log');
    expect(batches[0]!.text).toContain('one');
    expect(batches[0]!.text).toContain('three');
  });

  it('进程退出前把不带换行的残余行也发出去', async () => {
    const batches: string[] = [];
    const mgr = new BackgroundManager(10, {
      onStream: (_id, text) => batches.push(text),
    });
    managers.push(mgr);
    // printf 不带尾换行：残余行必须靠 force flush 出来，否则这条输出永久丢失
    const cmd = process.platform === 'win32' ? '<nul set /p="tail-without-newline"' : 'printf "tail-without-newline"';
    mgr.start('no-trailing-nl', SH, shArgs(cmd), process.cwd(), { monitor: true, monitorDescription: 'x' });
    await waitUntil(() => batches.some((b) => b.includes('tail-without-newline')), 6000);
    expect(batches.join('\n')).toContain('tail-without-newline');
  });

  it('长时间运行的监听能分多批送达（不是只发最后一批）', async () => {
    const batches: string[] = [];
    const mgr = new BackgroundManager(10, {
      onStream: (_id, text) => batches.push(text),
    });
    managers.push(mgr);
    // 每 0.5s 打一行，跑 4 行：200ms 窗口下应分成多批，证明是流式而非终态一次性
    const cmd =
      process.platform === 'win32'
        ? 'for /l %i in (1,1,4) do @(echo line-%i & ping -n 2 127.0.0.1 >nul)'
        : 'for i in 1 2 3 4; do echo "line-$i"; sleep 0.5; done';
    mgr.start('multi-batch', SH, shArgs(cmd), process.cwd(), { monitor: true, monitorDescription: 'stream' });
    await waitUntil(() => batches.length >= 2, 10000);
    expect(batches.length).toBeGreaterThanOrEqual(2);
  });
});

describe('Monitor：与普通后台任务互不影响', () => {
  it('普通后台任务不推事件（onStream 不被调用）', async () => {
    const settled: BackgroundTask[] = [];
    const streamed: string[] = [];
    const mgr = new BackgroundManager(10, {
      onSettle: (t) => settled.push(t),
      onStream: (_id, text) => streamed.push(text),
    });
    managers.push(mgr);
    mgr.start('plain', SH, shArgs('echo hello'), process.cwd());
    await waitUntil(() => settled.length >= 1);
    await sleep(400); // 等过 200ms 窗口，确认真的没推
    expect(streamed).toHaveLength(0);
    expect(settled).toHaveLength(1);
  });

  it('不支持流式的宿主：monitor 退化报错，不影响启动', async () => {
    const mgr = new BackgroundManager(10, { onSettle: () => {} });
    managers.push(mgr);
    // 没有 onStream 时 start 仍然能起（任务照常跑），只是不推事件
    const id = mgr.start('no-stream', SH, shArgs('echo hi'), process.cwd(), {
      monitor: true,
      monitorDescription: 'x',
    });
    expect(id).toBeTruthy();
    expect(mgr.supportsStream()).toBe(false);
  });

  it('output 累积照常供 task_output 事后查（流式与累积互不干扰）', async () => {
    const mgr = new BackgroundManager(10, { onStream: () => {} });
    managers.push(mgr);
    const id = mgr.start('acc', SH, shArgs('echo accumulated-output'), process.cwd(), {
      monitor: true,
      monitorDescription: 'x',
    });
    await waitUntil(() => mgr.get(id)?.status !== 'running');
    expect(mgr.get(id)?.output).toContain('accumulated-output');
  });
});

describe('Monitor：超时与终止', () => {
  it('timeoutS 到期终止并触发 onSettle', async () => {
    const settled: BackgroundTask[] = [];
    const mgr = new BackgroundManager(10, {
      onSettle: (t) => settled.push(t),
      onStream: () => {},
      taskTimeoutS: 0, // 全局不武装，只靠显式 timeoutS
    });
    managers.push(mgr);
    mgr.start('long-mon', SH, shArgs(process.platform === 'win32' ? 'ping -n 60 127.0.0.1 >nul' : 'sleep 50'), process.cwd(), {
      monitor: true,
      monitorDescription: 'x',
      timeoutS: 1,
    });
    await waitUntil(() => settled.length >= 1, 8000);
    expect(settled[0]!.status).toBe('killed');
  });

  it('task_stop 前把残余输出发出去（被杀前最后一行是关键信息）', async () => {
    const batches: string[] = [];
    const mgr = new BackgroundManager(10, {
      onStream: (_id, text) => batches.push(text),
      taskTimeoutS: 0,
    });
    managers.push(mgr);
    // 先打一行（会进缓冲等 200ms flush），紧接着 stop：force flush 必须把它发出来
    const cmd =
      process.platform === 'win32'
        ? 'echo last-word-before-kill& ping -n 60 127.0.0.1 >nul'
        : 'echo last-word-before-kill; sleep 50';
    const id = mgr.start('kill-flush', SH, shArgs(cmd), process.cwd(), { monitor: true, monitorDescription: 'x' });
    await sleep(100); // 让第一行进 pipe，但还没到 200ms flush
    mgr.stop(id);
    // 轮询等 force flush 的回调到位，不用固定 sleep 猜时序（并发/慢设备下固定等待会误报）
    await waitUntil(() => batches.join('\n').includes('last-word-before-kill'), 5000);
    expect(batches.join('\n')).toContain('last-word-before-kill');
  });
});
