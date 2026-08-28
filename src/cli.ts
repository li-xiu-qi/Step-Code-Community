#!/usr/bin/env node
/**
 * 轻量入口：只处理 --help/--version 和两个无头子命令（doctor/export-debug-zip），
 * 其余命令动态加载 cli-app.ts（含完整 agent 栈），避免 --help 时加载整棵模块树。
 *
 * 启动性能：`step --help` 只加载 commander + buildInfo（< 1s），
 * 不再触发 44 个静态 import 的全量模块树求值。
 */
import { Command } from 'commander';
import { versionLine } from './buildInfo.js';

const program = new Command();
program
  .name('step')
  .description('Step Code — 终端编码 agent，由阶跃 Step 系列模型驱动')
  .version(versionLine())
  // 允许位置参数（用于 `step sessions [list|show|delete] <id>` 子命令检测）
  .allowExcessArguments(true)
  .allowUnknownOption(true) // doctor config 的 --test-capabilities 是位置参数，不是 commander 选项
  .option('-p, --print [prompt]', '非交互模式：执行单条指令，流式打印结果后退出。prompt 可省略，从 stdin 读取')
  .option('--reflect', '非交互模式：回顾指定/最近会话的完整历史，提炼可复用方法论经验后打印退出')
  .option('-C, --cwd <dir>', '指定工作目录，默认当前目录')
  .option('-y, --yolo', '权限模式 yolo：全部工具放行，从不确认')
  .option('--auto', '权限模式 auto：写文件放行，bash 需确认')
  .option('-c, --continue', '恢复本工作目录下最近的一个会话')
  .option('--session <id>', '恢复指定 id 的会话')
  .option('-r, --resume [id]', '恢复会话：带 id 直接恢复；不带 id 打开交互选择器')
  .option('--fork <id>', '从指定会话分叉出一个新会话（副本），源会话不动')
  .option('--output-format <fmt>', '非交互输出格式：text（默认）、stream-json 或 json', 'text')
  .option('--model <name>', '覆盖模型（config.model）')
  .option('--provider <name>', '覆盖服务商（stepfun|anthropic|openai|openai_responses），未同时指定 model/base_url 时按其预设补默认')
  // pi-tui 前端是默认交互界面，--pi 为旧兼容开关
  .option('--pi', '用 pi-tui 前端渲染交互界面')
  .option('--no-skills', '禁用 skill 清单注入（调试用：排除 skill 路由对模型的干扰）')
  .option('--no-agents-md', '禁用 AGENTS.md 加载（调试用：排除项目约定对模型的干扰）')
  .option('--acp', 'ACP 服务端模式：stdin/stdout JSON-RPC，供 IDE 等外部工具驱动')
  .parse();

// --help / --version 由 commander 在 parse() 内处理并 process.exit，不会执行到此。
// 后续所有命令路径都需要完整 agent 栈，统一委托给 cli-app.ts。
// doctor / export-debug-zip 是无头轻量命令，用动态 import 避免加载 agent 栈。
const args0 = program.args[0];

if (args0 === 'export-debug-zip') {
  const { configureLogger } = await import('./utils/logger.js');
  const { SessionStore } = await import('./session/store.js');
  const { runExportDebugZip } = await import('./session/debugCli.js');
  const { resolve } = await import('node:path');
  configureLogger({ mode: 'headless' });
  const cwd = program.opts().cwd !== undefined ? resolve(program.opts().cwd) : process.cwd();
  const res = await runExportDebugZip({ store: new SessionStore(), cwd, sessionId: program.args[1] });
  if (res.stdout !== undefined) process.stdout.write(res.stdout);
  if (res.stderr !== undefined) process.stderr.write(res.stderr);
  process.exit(res.code);
}

if (args0 === 'doctor') {
  const { configureLogger } = await import('./utils/logger.js');
  const { runDoctorConfig } = await import('./config/doctor.js');
  configureLogger({ mode: 'headless' });
  if (program.args[1] !== 'config') {
    process.stderr.write('usage: step doctor config [path] [--test-capabilities]\n');
    process.exit(1);
  }
  const testCapabilities = program.args.includes('--test-capabilities');
  const res = await runDoctorConfig(program.args[2], { testCapabilities });
  if (res.stdout !== undefined) process.stdout.write(res.stdout);
  if (res.stderr !== undefined) process.stderr.write(res.stderr);
  process.exit(res.code);
}

// 其余所有命令（-p / -r / -c / sessions / subagents / 交互 TUI / ACP）→ 动态加载完整应用
const { runApp } = await import('./cli-app.js');
await runApp(program);
