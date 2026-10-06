#!/usr/bin/env node
/**
 * bin 引导入口。**本文件不得有任何静态 import。**
 *
 * 职责只有一件：在任何应用模块求值之前把 `NODE_ENV` 设好，然后动态加载真实入口
 * `./cli.js`。之所以要单独一个文件来做，是因为静态 import（以及 Ink 时代 tsc JSX
 * transform 自动注入的 `react/jsx-runtime`）都会排在模块体之前执行——赋值写在 cli 里
 * 就已经晚了。
 *
 * 历史：Ink 时代 `react` 与 `react-reconciler` 按 require 时的 `NODE_ENV` 分流成两套
 * 构建，错配时 reconciler 调度静默失效（终端零字节、不抛异常，功能测试全绿）。
 * 2026-08-03 因此确立本引导结构并删除了 `src/env.ts`。M5 移除 Ink 与 react 后那个具体
 * 故障不再可能，结构保留的理由变成「设置点唯一 + 早于一切模块」：依赖里按 NODE_ENV
 * 分支的代码在分发形态下一律走 production，与 bundle 的 esbuild define 折叠一致。
 *
 * 三条分发路径各自的保障：bin（本文件引导）→ 运行时先赋值再动态 import；bundle →
 * esbuild `define` 静态折叠；直跑 `tsx src/cli.ts`（仅开发调试）→ 不设即默认 development。
 *
 * 回归护栏见 tests/env.test.ts（静态断言：本文件无静态 import、先赋值后加载、cli 不设）。
 */

// 不覆盖显式设置：NODE_ENV=development 运行（含 pnpm dev）仍然生效。
//
// 这行与 bundle 脚本的 esbuild `define` 是**两条分发路径各自的手段**，不是重复：
//   - 经 esbuild 的 bundle / SEA：define 在打包期把读取点折叠为常量
//   - tsc 直出 dist/ 与 tsx 直跑开发：不经打包器，只有这行运行时赋值能保证分流正确
//
// esbuild 会为此报 assign-to-define 警告（它看到被 define 的表达式出现在赋值左侧）。
// 该警告在 `scripts/build-bundle.mjs` 里被显式静音，那里记录了完整理由与实测结论。
// **不要为消除警告改写这行的语法**：2026-08-03 实测 `process.env['NODE_ENV']`（方括号）
// 同样被 define 匹配、警告照旧；改用 `const e = process.env; e['NODE_ENV'] ??= ...`
// 虽能消警告，但会让 `tests/env.test.ts` 里防「cli.ts 设置 NODE_ENV」的静态断言失效
// （别名赋值无法可靠地静态识别），等于用一个真实的回归缺口换一条日志的干净。
process.env.NODE_ENV ??= 'production';

// 堆内存保障：长会话（50+ 轮、大 transcript）下 Node.js 默认堆上限（约 1.5GB）不够，
// 会导致 FATAL ERROR: Ineffective mark-compacts near heap limit。
// 检测当前堆上限，若低于目标值则用 execPath 重新拉起进程并附加 --max-old-space-size。
// 无静态 import，走动态 import node:v8 和 node:child_process。
const TARGET_HEAP_MB = Number(process.env.STEP_CODE_MAX_HEAP_MB) || 4096;

Promise.all([
  import('node:v8'),
  import('node:child_process'),
  import('./lifecycle.js'),
]).then(async ([v8, cp, life]) => {
  // V8 致命错误（撞堆上限的 abort、native 崩溃）是 C++ 层直接死，JS 的
  // uncaughtException / exit handler 一个都来不及跑，终端留在污染态且零证据。
  // diagnostic report 是 V8 层自己写的，不经过 JS，是唯一能在这种死法下留现场的
  // 通道。运行时 API 对两条路径（直跑 / re-exec）都生效；reportOnFatalError 覆盖
  // abort 类，heapsnapshot-near-heap-limit 靠 re-exec 参数覆盖（V8 在启动期读取，
  // 运行时 setFlagsFromString 装不上回调）。
  // 落盘到 ~/.step-code 而不是 cwd：快照/报告动辄几百 MB，不能撒到用户的工作目录。
  const diagDir = life.diagDir();
  try {
    process.report.reportOnFatalError = true;
    process.report.directory = diagDir;
  } catch {
    // 老 Node 没有 report API 时不影响启动
  }
  // 生命周期日志：现有取证只覆盖 uncaughtException 与 V8 fatal 两类死法，「干净的
  // process.exit」与「被外部杀死」（关 tab / dwm 连坐）零证据。start/exit 成对
  // 登记后，下次启动能检出上次的非配对 start = 未正常退出。细节见 lifecycle.ts。
  const loadCli = (): void => {
    life.beginLifecycle(diagDir, 'app');
    import('./cli.js').catch((e) => { console.error(e); process.exit(1); });
  };
  const currentHeapMB = v8.default.getHeapStatistics().heap_size_limit / 1024 / 1024;
  if (currentHeapMB >= TARGET_HEAP_MB * 0.9) {
    // 堆够大 → 加载 cli
    loadCli();
    return;
  }
  if (process.env.STEP_CODE_HEAP_REEXEC) {
    // 已是 re-exec 进程但仍不够（系统/容器内存限制压低了 --max-old-space-size）：告警一次，
    // 不静默裸跑、不无限重试。带着现有堆上限继续，让用户在 FATAL ERROR 前有线索。
    console.error(
      `[step] 警告：请求堆上限 ${TARGET_HEAP_MB}MB 未生效（实际约 ${Math.round(currentHeapMB)}MB），` +
        '可能受系统或容器内存限制，长会话存在 OOM 风险。可设 STEP_CODE_MAX_HEAP_MB 调低目标值。',
    );
    loadCli();
    return;
  }
  // 堆不够：re-exec 加 --max-old-space-size。
  // 转发原有 node 标志（--inspect / --enable-source-maps / --import 等），剔除已存在的
  // --max-old-space-size 避免重复冲突——调试与 source-map 不因 re-exec 静默失效。
  const forwarded = process.execArgv.filter((a) => !a.startsWith('--max-old-space-size'));
  life.beginLifecycle(diagDir, 'reexec-parent');
  try {
    cp.execFileSync(
      process.execPath,
      [
        `--max-old-space-size=${TARGET_HEAP_MB}`,
        // 致命错误取证：report 是 compact 现场（JS/native 栈、堆统计），快照是完整证据。
        // 1 份就够——4GB 堆的快照近 1GB，多份只会把磁盘写穿。
        '--report-on-fatalerror',
        '--heapsnapshot-near-heap-limit=1',
        `--diagnostic-dir=${diagDir}`,
        ...forwarded,
        ...process.argv.slice(1),
      ],
      { stdio: 'inherit', env: { ...process.env, STEP_CODE_HEAP_REEXEC: '1' } },
    );
    // 父进程是子进程终态的唯一见证者：子进程被信号杀死/异常退出时 status/signal
    // 都在这里。这一行必须在 process.exit 之前落盘。
    life.recordChildExit(diagDir, 0, null);
    process.exit(0);
  } catch (e: any) {
    life.recordChildExit(diagDir, e?.status ?? null, e?.signal ?? null);
    if (e?.status != null) process.exit(e.status);
    console.error('heap re-exec failed:', e);
    process.exit(1);
  }
});
