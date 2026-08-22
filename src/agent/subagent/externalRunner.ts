/**
 * 外部 CLI Agent 驱动：spawn Claude Code / Codex 等外部 coding CLI 作为子 agent。
 *
 * - Claude Code：spawn CLI + 解析 stream-json 输出（claude-stream-json driver）
 * - Codex：spawn codex app-server + JSON-RPC 2.0 协议对话（codex driver）
 */

import { spawn, type ChildProcess } from 'node:child_process';
import type { SubagentResult } from './types.js';
import { CodexAppServerWire } from './codexWire.js';

/** 外部 agent 驱动方式。 */
type ExternalDriver = 'claude-stream-json' | 'codex';

/** 外部 agent 配置。 */
export interface ExternalAgentConfig {
  /** CLI 命令名（从 PATH 解析）。 */
  command: string;
  /** 固定参数（不含 prompt）。仅 simple driver 使用。 */
  args: string[];
  /** prompt 传入方式：arg = 最后一个参数；stdin = 写入 stdin。 */
  promptVia: 'arg' | 'stdin';
  /** 驱动方式：claude-stream-json = spawn+解析；codex = JSON-RPC 协议。 */
  driver: ExternalDriver;
  /** 额外环境变量。 */
  env?: Record<string, string>;
  /** 进程清理超时（ms），超时后 SIGKILL。 */
  disposeGraceMs?: number;
}

/** 内置外部 agent 配置。 */
export const EXTERNAL_AGENTS: Record<string, ExternalAgentConfig> = {
  'claude-code': {
    command: 'claude',
    args: ['-p', '--output-format', 'stream-json', '--verbose'],
    promptVia: 'stdin',
    driver: 'claude-stream-json',
    disposeGraceMs: 5000,
  },
  'codex': {
    command: 'codex',
    args: [],
    promptVia: 'stdin',
    driver: 'codex',
    disposeGraceMs: 5000,
  },
};

// ─── Claude Code stream-json 驱动 ──────────────────────────────────────────

/**
 * 从 Claude Code stream-json 输出中提取最终结果。
 * 每行一个 JSON 对象，最后一条 type="result"。
 */
function extractClaudeResult(stdout: string): { text: string; isError: boolean; error?: string } {
  const lines = stdout.split('\n').filter((l) => l.trim().length > 0);
  let lastResult: { text: string; isError: boolean; error?: string } = { text: '', isError: false };

  for (const line of lines) {
    try {
      const obj = JSON.parse(line);
      if (obj.type === 'result') {
        lastResult = {
          text: obj.result ?? '',
          isError: obj.is_error === true,
          error: obj.error ?? undefined,
        };
      }
    } catch { /* 跳过非 JSON 行 */ }
  }
  return lastResult;
}

/** 驱动 Claude Code：spawn + stream-json 解析。 */
function runClaudeCode(
  config: ExternalAgentConfig,
  task: string,
  cwd: string,
  signal?: AbortSignal,
): Promise<SubagentResult> {
  const disposeGrace = config.disposeGraceMs ?? 3000;
  const env = { ...process.env, ...config.env };

  return new Promise<SubagentResult>((resolve) => {
    let settled = false;
    const settle = (result: SubagentResult): void => {
      if (settled) return;
      settled = true;
      resolve(result);
    };

    const args = config.promptVia === 'arg' ? [...config.args, task] : config.args;
    let child: ChildProcess;
    try {
      child = spawn(config.command, args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    } catch (e: any) {
      settle({ summary: `无法启动外部 agent（${config.command}）：${e.message}`, isError: true, cause: e });
      return;
    }

    let stdout = '';
    let stderr = '';

    child.stdout?.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });

    child.on('error', (e) => {
      settle({ summary: `外部 agent 进程错误：${e.message}`, isError: true, cause: e });
    });

    child.on('close', (code) => {
      if (settled) return;
      const result = extractClaudeResult(stdout);
      if (result.isError) { settle({ summary: `Claude Code 返回错误：${result.error ?? result.text}`, isError: true }); return; }
      if (result.text) { settle({ summary: result.text, isError: false }); return; }
      if (code !== 0 && stdout.trim() === '') { settle({ summary: `Claude Code 退出码 ${code}：${stderr.slice(-500)}`, isError: true }); return; }
      settle({ summary: stdout.slice(0, 4000) || stderr.slice(-500), isError: false });
    });

    if (config.promptVia === 'stdin') {
      child.stdin?.write(task);
      child.stdin?.end();
    }

    signal?.addEventListener('abort', () => {
      try { child.kill('SIGTERM'); } catch { /* already exited */ }
      setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* already exited */ } }, disposeGrace);
    });
  });
}

// ─── Codex JSON-RPC 驱动 ────────────────────────────────────────────────────

/** 驱动 Codex app-server：spawn + JSON-RPC 协议对话。 */
async function runCodex(
  config: ExternalAgentConfig,
  task: string,
  cwd: string,
  signal?: AbortSignal,
): Promise<SubagentResult> {
  const disposeGrace = config.disposeGraceMs ?? 3000;

  return new Promise<SubagentResult>((resolve) => {
    let settled = false;
    const settle = (result: SubagentResult): void => {
      if (settled) return;
      settled = true;
      resolve(result);
    };

    let child: ChildProcess;
    try {
      const argv = process.platform === 'win32'
        ? ['cmd.exe', '/d', '/s', '/c', 'codex', 'app-server', '--stdio']
        : ['codex', 'app-server', '--stdio'];
      child = spawn(argv[0]!, argv.slice(1), { cwd, env: { ...process.env, ...config.env }, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    } catch (e: any) {
      settle({ summary: `无法启动 Codex app-server：${e.message}`, isError: true, cause: e });
      return;
    }

    if (child.stdin === null || child.stdout === null) {
      settle({ summary: 'Codex app-server stdio 不可用', isError: true });
      return;
    }

    let stderr = '';
    child.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });

    const wire = new CodexAppServerWire(child.stdout, child.stdin);
    const ac = new AbortController();
    signal?.addEventListener('abort', () => ac.abort(), { once: true });

    let killed = false;
    const killTimer = (): void => {
      if (killed) return;
      killed = true;
      try { child.kill('SIGTERM'); } catch { /* */ }
      setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* */ } }, disposeGrace);
    };
    signal?.addEventListener('abort', killTimer, { once: true });

    (async () => {
      try {
        await wire.initialize(ac.signal);
        await wire.startThread(cwd, ac.signal);
        const result = await wire.runTurn(task, ac.signal);
        if (result.stopReason === 'aborted') {
          settle({ summary: 'Codex 任务被中断。', isError: true });
        } else {
          settle({ summary: result.text, isError: false });
        }
      } catch (e: any) {
        settle({ summary: `Codex 执行失败：${e.message}${stderr ? '\n' + stderr.slice(-300) : ''}`, isError: true, cause: e });
      } finally {
        wire.close();
      }
    })();
  });
}

// ─── 公共入口 ───────────────────────────────────────────────────────────────

/**
 * 驱动外部 CLI agent 执行一次性任务。按 driver 分发。
 */
export async function runExternalAgent(
  config: ExternalAgentConfig,
  task: string,
  cwd: string,
  signal?: AbortSignal,
): Promise<SubagentResult> {
  switch (config.driver) {
    case 'codex':
      return runCodex(config, task, cwd, signal);
    case 'claude-stream-json':
    default:
      return runClaudeCode(config, task, cwd, signal);
  }
}
