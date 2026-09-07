import { describe, expect, it } from 'vitest';
import { BackgroundManager } from '../../src/agent/background/manager.js';
import { bashTool, prepareCommand } from '../../src/tools/bash.js';
import type { ResolvedShell, ShellFamily } from '../../src/tools/shellResolve.js';

/** 构造指定 family 的 ResolvedShell 桩（args/cmd 不影响 prepareCommand 逻辑）。 */
function shellOf(family: ShellFamily): ResolvedShell {
  return { cmd: 'x', args: (c) => [c], family };
}

describe('prepareCommand 按 family 预处理', () => {
  it('posix：NUL 重定向改写，cwd 原样', () => {
    const r = prepareCommand('echo x >NUL 2>&1', shellOf('posix'), 'C:\\proj');
    expect(r.command).toBe('echo x >/dev/null 2>&1');
    expect(r.cwd).toBe('C:\\proj');
  });

  it('busybox：同样改写 NUL', () => {
    const r = prepareCommand('cmd 2>NUL', shellOf('busybox'), 'C:\\p');
    expect(r.command).toBe('cmd 2>/dev/null');
  });

  it('wsl：命令前拼 cd /mnt 挂载路径 + 改写 NUL，spawn cwd 保持原生 Windows 路径', () => {
    const r = prepareCommand('ls >NUL', shellOf('wsl'), 'C:\\proj\\sub');
    expect(r.command).toBe("cd '/mnt/c/proj/sub' && ls >/dev/null");
    expect(r.cwd).toBe('C:\\proj\\sub'); // wsl.exe 是 Windows 程序，spawn 用原生路径
  });

  it('wsl：winPathToWsl 无法识别的 cwd 时不加 cd 前缀', () => {
    const r = prepareCommand('ls', shellOf('wsl'), 'relative/path');
    expect(r.command).toBe('ls'); // 无 cd 前缀
  });

  it('powershell：命令与 cwd 原样透传，不改 NUL', () => {
    const r = prepareCommand('Get-ChildItem 2>$null', shellOf('powershell'), 'C:\\p');
    expect(r.command).toBe('Get-ChildItem 2>$null');
    expect(r.cwd).toBe('C:\\p');
  });
});

describe('bash 前台执行', () => {
  it('正常命令返回输出（非 error）', async () => {
    const r = await bashTool.execute({ command: 'echo hello' }, { cwd: process.cwd() });
    expect(r.isError).toBe(false);
    expect(r.content).toContain('hello');
  });

  it('非零退出码返回 error 并带退出码', async () => {
    const r = await bashTool.execute({ command: 'exit 3' }, { cwd: process.cwd() });
    expect(r.isError).toBe(true);
    expect(r.content).toContain('退出码：3');
  });

  it('Esc 中断（abort）：杀进程返回中断错误', async () => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 300);
    const r = await bashTool.execute(
      { command: 'sleep 5', timeout: 60 },
      { cwd: process.cwd(), signal: controller.signal, background: new BackgroundManager() },
    );
    expect(r.isError).toBe(true);
    expect(r.content).toContain('用户中断');
  });
});

describe('bash 前台超时自动转后台', () => {
  it('超时后转后台：tool_result 非 error、任务入册、带部分输出', async () => {
    const mgr = new BackgroundManager();
    const r = await bashTool.execute(
      { command: 'echo before; sleep 5', timeout: 1 },
      { cwd: process.cwd(), background: mgr },
    );
    expect(r.isError).toBe(false);
    expect(r.content).toContain('已转为后台任务');
    expect(r.content).toContain('before'); // 已收集的部分输出
    const tasks = mgr.list();
    expect(tasks).toHaveLength(1);
    expect(tasks[0]!.status).toBe('running');
    expect(r.content).toContain(tasks[0]!.id);
    mgr.stop(tasks[0]!.id);
  });

  it('截断输出必须带【未完成】标记，防止被读成「零命中」', async () => {
    // 回归点：2026-08-30 一次全库 grep 超时转后台，拿到「分隔符 + 空区块」的截断输出，
    // 被当成「搜过了，库里没有」并据此下结论。截断输出与零命中在视觉上无法区分，
    // 所以工具层必须显式声明这不是完整结果。
    const mgr = new BackgroundManager();
    const r = await bashTool.execute(
      { command: 'echo before; sleep 5', timeout: 1 },
      { cwd: process.cwd(), background: mgr },
    );
    expect(r.content).toContain('【未完成】');
    expect(r.content).toContain('截断输出');
    expect(r.content).toContain('不要据此判定');
    const id = mgr.list()[0]!.id;
    expect(r.content).toContain(`task_output ${id}`);
    mgr.stop(id);
  });

  it('配置关闭（bashAutoBackgroundOnTimeout=false）时维持超时即杀', async () => {
    const mgr = new BackgroundManager();
    const r = await bashTool.execute(
      { command: 'sleep 5', timeout: 1 },
      { cwd: process.cwd(), background: mgr, bashAutoBackgroundOnTimeout: false },
    );
    expect(r.isError).toBe(true);
    expect(r.content).toContain('命令超时（1s）后被终止');
    expect(mgr.list()).toHaveLength(0);
  });

  it('上下文不支持后台任务时也维持超时即杀', async () => {
    const r = await bashTool.execute({ command: 'sleep 5', timeout: 1 }, { cwd: process.cwd() });
    expect(r.isError).toBe(true);
    expect(r.content).toContain('命令超时（1s）后被终止');
  });

  it('请求超时超过 MAX_TIMEOUT 时会按上限执行并告知模型', async () => {
    const r = await bashTool.execute({ command: 'echo done', timeout: 600 }, { cwd: process.cwd() });
    expect(r.isError).toBe(false);
    expect(r.content).toContain('超时已限制');
    expect(r.content).toContain('600s');
    expect(r.content).toContain(`${300}s`);
  });

  it('转后台的任务由 manager 的后台超时接管', async () => {
    const mgr = new BackgroundManager(10, { taskTimeoutS: 2 });
    const r = await bashTool.execute({ command: 'sleep 30', timeout: 1 }, { cwd: process.cwd(), background: mgr });
    expect(r.isError).toBe(false);
    const id = mgr.list()[0]!.id;
    // 后台超时 2s 到期后应被终止（从收养时点起算）
    await new Promise((resolve) => setTimeout(resolve, 3500));
    expect(mgr.get(id)?.status).toBe('killed');
  }, 10_000);
});

describe('bash 前台任务主动转后台（detach）', () => {
  /** 等前台任务登记完成并返回 id（登记发生在 spawn 之后的同步段，轮询几次即可）。 */
  async function waitForegroundId(mgr: BackgroundManager): Promise<string> {
    for (let i = 0; i < 50; i++) {
      const fg = mgr.listForeground();
      if (fg.length > 0) return fg[0]!.id;
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error('前台任务未登记');
  }

  it('主动 detach：tool_result 正常结算为「已转为后台任务」（无超时措辞），任务在后台继续跑', async () => {
    const mgr = new BackgroundManager();
    const p = bashTool.execute(
      { command: 'echo before; sleep 5', timeout: 60 },
      { cwd: process.cwd(), background: mgr },
    );
    const id = await waitForegroundId(mgr);
    expect(mgr.detach(id)).toBe(true);
    const r = await p;
    expect(r.isError).toBe(false);
    expect(r.content).toContain(`已转为后台任务 ${id}`);
    expect(r.content).not.toContain('超过前台超时');
    expect(mgr.get(id)?.status).toBe('running');
    expect(mgr.activeBackgroundCount()).toBe(1);
    mgr.stop(id);
  });

  it('detach 后再中断（abort）：不杀已转后台的进程，任务独立存活', async () => {
    const mgr = new BackgroundManager();
    const controller = new AbortController();
    const p = bashTool.execute(
      { command: 'sleep 30', timeout: 60 },
      { cwd: process.cwd(), signal: controller.signal, background: mgr },
    );
    const id = await waitForegroundId(mgr);
    expect(mgr.detach(id)).toBe(true);
    const r = await p;
    expect(r.isError).toBe(false); // detach 已正常结算
    controller.abort(); // 回合中断：已转后台的任务不受影响
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(mgr.get(id)?.status).toBe('running');
    mgr.stop(id);
  });

  it('正常结束的前台命令：静默终态——不入待投递队列、不留 running、结果与现状一致', async () => {
    const mgr = new BackgroundManager();
    const r = await bashTool.execute({ command: 'echo hi' }, { cwd: process.cwd(), background: mgr });
    expect(r.isError).toBe(false);
    expect(r.content).toContain('hi');
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(mgr.activeCount()).toBe(0);
    expect(mgr.drainSettled()).toEqual([]);
    expect(mgr.list()[0]?.status).toBe('completed');
  });

  it('登记失败（并发上限被占满）退化为超时即杀', async () => {
    const mgr = new BackgroundManager(1);
    mgr.startTask('占位', new Promise(() => {})); // 占满唯一的并发额度
    const r = await bashTool.execute({ command: 'sleep 5', timeout: 1 }, { cwd: process.cwd(), background: mgr });
    expect(r.isError).toBe(true);
    expect(r.content).toContain('命令超时（1s）后被终止');
    expect(mgr.listForeground()).toEqual([]);
  });

  it('竞争：进程先结束，随后的 detach 为 no-op，结果按正常退出结算', async () => {
    const mgr = new BackgroundManager();
    const r = await bashTool.execute({ command: 'echo fast' }, { cwd: process.cwd(), background: mgr });
    expect(r.isError).toBe(false);
    expect(r.content).toContain('fast');
    await new Promise((resolve) => setTimeout(resolve, 200));
    const task = mgr.list()[0];
    expect(task?.status).toBe('completed');
    expect(mgr.detach(task!.id)).toBe(false); // 已终态，detach 无效
  });

  it('全链路：detach 后进程继续产输出，manager 接管收集，终态通知带完整输出', async () => {
    const settled: string[] = [];
    const mgr = new BackgroundManager(10, { onSettle: (t) => settled.push(t.output) });
    const p = bashTool.execute(
      { command: 'echo before; sleep 2; echo after', timeout: 60 },
      { cwd: process.cwd(), background: mgr },
    );
    const id = await waitForegroundId(mgr);
    // 等 echo before 先到达前台收集缓冲（登记完成 ≠ 首条输出已flush）
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(mgr.detach(id)).toBe(true);
    const r = await p; // 前台等待方应立即结算，不等进程结束
    expect(r.isError).toBe(false);
    expect(r.content).toContain(`已转为后台任务 ${id}`);
    // 进程仍在跑（after 尚未产出）：任务存活，由 manager 的接管监听继续收集
    expect(mgr.get(id)?.status).toBe('running');
    for (let i = 0; i < 60 && mgr.get(id)?.status === 'running'; i++) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    const task = mgr.get(id);
    expect(task?.status).toBe('completed');
    expect(task?.output).toContain('before'); // detach 前的部分输出未丢
    expect(task?.output).toContain('after'); // detach 后的输出被接管方收集到
    expect(settled).toHaveLength(1); // 终态通知恰好一次
    expect(settled[0]).toContain('after');
  }, 20000);

  it('& 起常驻进程后 bash 退出：exit 事件触发即终态，不等管道关闭', async () => {
    // 回归点：2026-09-07 clipmate 启动场景。命令用 & 起了常驻进程（Tauri GUI），
    // 它继承了 bash 的 stdout/stderr 管道写端。bash 自己退出了，但管道写端仍被
    // 孙进程持有，Node.js 的 close 事件永远不触发，task_wait 一直阻塞。
    // 修复：exit 事件在进程退出时立即触发（不等管道关闭），
    // 与 stdout/stderr end 齐了即可 settle。
    const settled: string[] = [];
    const mgr = new BackgroundManager(10, { onSettle: (t) => settled.push(t.id) });

    const r = await bashTool.execute(
      { command: 'echo start; sleep 30 & echo done', timeout: 5 },
      { cwd: process.cwd(), background: mgr },
    );
    // 命令应在 5 秒内返回（不等 sleep 30），且输出完整
    expect(r.isError).toBe(false);
    expect(r.content).toContain('start');
    expect(r.content).toContain('done');
  }, 10000);

  it('& 起常驻进程后转后台：exit 触发即终态，不因管道被孙进程持有而挂起', async () => {
    // 回归点：2026-09-07 clipmate 启动场景（后台路径）。
    // bash 用 & 起了常驻进程，bash 退出后管道写端被孙进程持有，
    // close 事件不来导致后台任务永远不 settle。修复：exit 事件 + 500ms 兜底。
    const settled: string[] = [];
    const mgr = new BackgroundManager(10, { onSettle: (t) => settled.push(t.id) });

    // bash 先 sleep 2 再起后台 sleep 30，确保 bash 本身运行超过 timeout=1
    const r = await bashTool.execute(
      { command: 'echo before; sleep 2; sleep 30 & echo bg', timeout: 1 },
      { cwd: process.cwd(), background: mgr },
    );
    expect(r.content).toContain('已转为后台任务');
    const id = mgr.list()[0]!.id;

    // 关键断言：bash exit 后 500ms 兜底触发 settle，不等 sleep 30 结束
    for (let i = 0; i < 50 && mgr.get(id)?.status === 'running'; i++) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    const task = mgr.get(id);
    expect(task?.status).toBe('completed');
    expect(task?.exitCode).toBe(0);
    expect(settled).toHaveLength(1);
    expect(settled[0]).toBe(id);
  }, 15000);
});
