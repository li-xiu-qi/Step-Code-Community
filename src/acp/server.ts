/**
 * ACP（Agent Client Protocol）服务端。
 *
 * 让 IDE / 外部工具通过 stdin/stdout JSON-RPC 驱动 step-code。
 * 协议规范：agentclientprotocol.com
 *
 * 支持的方法：
 * - initialize: 版本协商
 * - session/new: 创建 agent 会话
 * - session/prompt: 发送文本任务，跑一轮 agent
 * - session/cancel: 取消当前 turn
 * - session/update: 流式通知（server → client）
 */

import type { Readable, Writable } from 'node:stream';
import type { StepCodeConfig } from '../config/config.js';
import type { ChatProvider } from '../provider/types.js';
import { randomUUID } from 'node:crypto';
import { stored, type StoredMessage } from '../agent/message.js';

// ─── JSON-RPC 传输（server 端，newline-delimited） ─────────────────────────

/** newline-delimited JSON-RPC server。 */
class JsonRpcServer {
  private buffer = '';

  constructor(
    private readonly input: Readable,
    private readonly output: Writable,
    private readonly onRequest: (method: string, params: Record<string, unknown>) => Promise<unknown>,
    private readonly onNotification: (method: string, params: Record<string, unknown>) => void = () => {},
  ) {
    this.input.on('data', (chunk: Buffer) => this.onData(chunk));
    this.input.on('end', () => { /* stdin close → shutdown handled by caller */ });
  }

  private onData(chunk: Buffer): void {
    this.buffer += chunk.toString();
    let idx: number;
    while ((idx = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, idx).trim();
      this.buffer = this.buffer.slice(idx + 1);
      if (line.length === 0) continue;
      let msg: Record<string, unknown>;
      try { msg = JSON.parse(line); } catch { continue; }

      if (msg.id === undefined || msg.id === null) {
        this.onNotification(String(msg.method ?? ''), (msg.params as Record<string, unknown>) ?? {});
        continue;
      }

      const id = msg.id;
      void this.onRequest(String(msg.method ?? ''), (msg.params as Record<string, unknown>) ?? {})
        .then((result) => this.write({ jsonrpc: '2.0', id, result: result ?? {} }))
        .catch((e: Error) => this.write({ jsonrpc: '2.0', id, error: { code: -32603, message: e.message } }));
    }
  }

  /** server → client notification。 */
  notify(method: string, params: Record<string, unknown>): void {
    this.write({ jsonrpc: '2.0', method, params });
  }

  private write(obj: Record<string, unknown>): void {
    this.output.write(JSON.stringify(obj) + '\n');
  }
}

// ─── Session 管理 ───────────────────────────────────────────────────────────

interface AcpSession {
  id: string;
  cwd: string;
  messages: StoredMessage[];
  controller: AbortController | null;
}

// ─── ACP Server 主逻辑 ──────────────────────────────────────────────────────

export interface AcpServerOptions {
  config: StepCodeConfig;
  cwd: string;
  provider: ChatProvider;
  model?: string;
  providerName?: string;
}

const ACP_PROTOCOL_VERSION = 1;

export async function startAcpServer(opts: AcpServerOptions): Promise<void> {
  const sessions = new Map<string, AcpSession>();

  const server = new JsonRpcServer(
    process.stdin,
    process.stdout,
    async (method, params) => {
      switch (method) {
        case 'initialize':
          return handleInitialize(params);
        case 'session/new':
          return handleSessionNew(params, sessions, opts);
        case 'session/prompt':
          return handleSessionPrompt(params, sessions, server, opts);
        case 'session/cancel':
          return handleSessionCancel(params, sessions);
        default:
          throw new Error(`ACP: unsupported method '${method}'`);
      }
    },
  );

  process.stderr.write(`[acp] server started, protocol v${ACP_PROTOCOL_VERSION}\n`);

  return new Promise<void>((resolve) => {
    process.stdin.on('end', () => {
      process.stderr.write('[acp] stdin closed, shutting down\n');
      for (const [, session] of sessions) {
        session.controller?.abort();
      }
      resolve();
    });
  });
}

// ─── 方法处理器 ─────────────────────────────────────────────────────────────

function handleInitialize(params: Record<string, unknown>): Record<string, unknown> {
  const clientVersion = typeof params.protocolVersion === 'number' ? params.protocolVersion : 1;
  return {
    protocolVersion: Math.min(clientVersion, ACP_PROTOCOL_VERSION),
    serverInfo: { name: 'step-code', title: 'Step Code', version: '1.0.0' },
    capabilities: {
      imageInput: false,
      audioInput: false,
      streaming: true,
    },
  };
}

function handleSessionNew(
  params: Record<string, unknown>,
  sessions: Map<string, AcpSession>,
  _opts: AcpServerOptions,
): Record<string, unknown> {
  const cwd = typeof params.cwd === 'string' && params.cwd.length > 0 ? params.cwd : process.cwd();
  const sessionId = randomUUID();
  sessions.set(sessionId, { id: sessionId, cwd, messages: [], controller: null });
  process.stderr.write(`[acp] session/new: ${sessionId} (cwd=${cwd})\n`);
  return { sessionId, cwd };
}

async function handleSessionPrompt(
  params: Record<string, unknown>,
  sessions: Map<string, AcpSession>,
  server: JsonRpcServer,
  opts: AcpServerOptions,
): Promise<Record<string, unknown>> {
  const sessionId = typeof params.sessionId === 'string' ? params.sessionId : '';
  const session = sessions.get(sessionId);
  if (session === undefined) throw new Error(`ACP: unknown session '${sessionId}'`);
  if (session.controller !== null) throw new Error(`ACP: session '${sessionId}' already has an in-flight prompt`);

  // 提取 prompt 文本
  const promptBlocks = Array.isArray(params.prompt) ? params.prompt : [];
  let promptText = '';
  for (const block of promptBlocks) {
    if (typeof block === 'object' && block !== null && (block as Record<string, unknown>).type === 'text') {
      promptText += String((block as Record<string, unknown>).text ?? '');
    }
  }
  if (promptText.trim().length === 0) throw new Error('ACP: prompt must contain at least one text block');

  session.messages.push(stored({ role: 'user', content: promptText }, { kind: 'user' }));
  const controller = new AbortController();
  session.controller = controller;

  const { runAgent } = await import('../agent/loop.js');
  const { buildSystemPrompt } = await import('../agent/systemPrompt.js');
  const { allToolNames } = await import('../tools/index.js');

  const system = buildSystemPrompt(session.cwd, { pureMode: true });
  const toolNames = allToolNames();
  let fullText = '';
  let stopReason = 'end_turn';

  try {
    for await (const ev of runAgent({
      provider: opts.provider,
      system,
      ctx: {
        cwd: session.cwd,
        apiKey: opts.config.apiKey,
        baseUrl: opts.config.baseUrl,
        signal: controller.signal,
        depth: 0,
        capabilities: opts.config.capabilities,
      },
      messages: session.messages,
      signal: controller.signal,
      model: opts.model ?? opts.config.model,
      maxIterations: 50,
      allowedTools: toolNames,
    })) {
      if (ev.type === 'text') {
        fullText += ev.text;
        server.notify('session/update', { sessionId, type: 'agent_message_chunk', text: ev.text });
      }
      if (ev.type === 'turn_done') stopReason = 'end_turn';
      if (ev.type === 'aborted') stopReason = 'cancelled';
      if (ev.type === 'error') stopReason = 'error';
    }
  } catch (e: any) {
    stopReason = 'error';
    fullText += `\n[ACP error: ${e.message}]`;
  } finally {
    session.controller = null;
  }

  session.messages.push(stored({ role: 'assistant', content: fullText }, { kind: 'injection' }));
  return { sessionId, stopReason };
}

function handleSessionCancel(
  params: Record<string, unknown>,
  sessions: Map<string, AcpSession>,
): Record<string, unknown> {
  const sessionId = typeof params.sessionId === 'string' ? params.sessionId : '';
  const session = sessions.get(sessionId);
  if (session === undefined) return { cancelled: false };
  if (session.controller !== null) {
    session.controller.abort();
    session.controller = null;
  }
  return { cancelled: true };
}
