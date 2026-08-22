/**
 * Codex app-server JSON-RPC 协议适配。
 *
 * 驱动 `codex app-server --stdio` 子进程，通过 JSON-RPC 2.0 newline-delimited 传输层
 * 完成一次性的 task 提交与结果收集。
 *
 * 协议流程：
 *   initialize → initialized → thread/start → turn/start
 *     ← turn/started / item/completed（收集 final_answer）/ turn/completed
 *   turn/interrupt（取消时）
 *
 * 本实现做了精简：只支持一次性 task，无人值守自动应答审批。
 */

import type { Readable, Writable } from 'node:stream';

// ─── Promise.withResolvers polyfill（ES2022 没有，ES2024 才有）─────────────

interface Deferred<T> { promise: Promise<T>; resolve: (v: T) => void; reject: (e: Error) => void; resolved: boolean }
function withResolvers<T>(): Deferred<T> {
  let resolve!: (v: T) => void;
  let reject!: (e: Error) => void;
  let resolved = false;
  const promise = new Promise<T>((res, rej) => { resolve = (v) => { resolved = true; res(v); }; reject = rej; });
  return { promise, resolve, reject, get resolved() { return resolved; } };
}

// ─── JSON-RPC 行传输层 ─────────────────────────────────────────────────────

interface PendingRequest {
  resolve: (result: unknown) => void;
  reject: (error: Error) => void;
}

/** newline-delimited JSON-RPC 传输。 */
class JsonRpcLineTransport {
  private nextId = 1;
  private readonly pending = new Map<number, PendingRequest>();
  private readonly onNotification: (method: string, params: unknown) => void;
  private readonly onRequest: (method: string, params: unknown) => Promise<unknown>;
  private readonly output: Writable;
  private buffer = '';

  constructor(
    input: Readable,
    output: Writable,
    onNotification: (method: string, params: unknown) => void,
    onRequest: (method: string, params: unknown) => Promise<unknown>,
  ) {
    this.output = output;
    this.onNotification = onNotification;
    this.onRequest = onRequest;
    input.on('data', (chunk: Buffer) => this.onData(chunk));
    input.on('error', () => this.failAll(new Error('codex: input stream error')));
    input.on('end', () => this.failAll(new Error('codex: input stream closed')));
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

      if (typeof msg.id === 'number' && msg.method !== undefined) {
        // server → client request
        void this.onRequest(String(msg.method), msg.params)
          .then((result) => this.write({ jsonrpc: '2.0', id: msg.id, result: result ?? {} }))
          .catch((e: Error) => this.write({ jsonrpc: '2.0', id: msg.id, error: { code: -32603, message: e.message } }));
      } else if (typeof msg.id === 'number') {
        // response to our request
        const p = this.pending.get(msg.id);
        if (p !== undefined) {
          this.pending.delete(msg.id);
          if (msg.error !== undefined) {
            const err = msg.error as Record<string, unknown>;
            p.reject(new Error(`JSON-RPC error ${err.code}: ${err.message}`));
          } else {
            p.resolve(msg.result);
          }
        }
      } else if (msg.method !== undefined) {
        this.onNotification(String(msg.method), msg.params);
      }
    }
  }

  private write(obj: Record<string, unknown>): void {
    this.output.write(JSON.stringify(obj) + '\n');
  }

  private failAll(error: Error): void {
    for (const [, p] of this.pending) p.reject(error);
    this.pending.clear();
  }

  /** 发送 JSON-RPC 请求，等待响应。 */
  request(method: string, params: Record<string, unknown>, signal: AbortSignal, timeoutMs = 30_000): Promise<Record<string, unknown>> {
    return new Promise((resolve, reject) => {
      const id = this.nextId++;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`codex: request ${method} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: resolve as (v: unknown) => void,
        reject: (e: Error) => { clearTimeout(timer); reject(e); },
      });
      this.write({ jsonrpc: '2.0', id, method, params });
      signal.addEventListener('abort', () => {
        const p = this.pending.get(id);
        if (p !== undefined) { clearTimeout(timer); this.pending.delete(id); }
        reject(new Error(`codex: request ${method} aborted`));
      }, { once: true });
    });
  }

  /** 发送 JSON-RPC 通知（无需响应）。 */
  notify(method: string, params?: Record<string, unknown>): void {
    const obj: Record<string, unknown> = { jsonrpc: '2.0', method };
    if (params !== undefined) obj.params = params;
    this.write(obj);
  }

  close(): void {
    this.failAll(new Error('codex: transport closed'));
  }
}

// ─── Codex app-server 协议适配 ─────────────────────────────────────────────

function asObject(v: unknown, label: string): Record<string, unknown> {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) throw new Error(`codex: invalid ${label}`);
  return v as Record<string, unknown>;
}

function asString(v: unknown, label: string): string {
  if (typeof v !== 'string' || v.length === 0) throw new Error(`codex: invalid ${label}`);
  return v;
}

/** Codex app-server 协议封装。 */
export class CodexAppServerWire {
  private readonly transport: JsonRpcLineTransport;
  private threadId: string | undefined;
  private turnId: string | undefined;
  private turnCompleted: Deferred<Record<string, unknown>> | undefined;
  private lastFinalAnswer: string | undefined;
  private lastUnphasedAnswer: string | undefined;
  private readonly earlyNotifications: Array<{ method: string; params: Record<string, unknown> }> = [];

  constructor(input: Readable, output: Writable) {
    this.transport = new JsonRpcLineTransport(
      input,
      output,
      (method, params) => this.onNotification(method, params as Record<string, unknown>),
      (method, params) => this.onServerRequest(method, params as Record<string, unknown>),
    );
  }

  /** initialize + initialized 握手。 */
  async initialize(signal: AbortSignal): Promise<void> {
    await this.transport.request('initialize', {
      clientInfo: { name: 'step-code', title: 'Step Code', version: '1.0.0' },
      capabilities: { experimentalApi: false, requestAttestation: false },
    }, signal);
    this.transport.notify('initialized');
  }

  /** 创建 ephemeral thread。 */
  async startThread(cwd: string, signal: AbortSignal): Promise<void> {
    const resp = await this.transport.request('thread/start', { cwd, ephemeral: true }, signal);
    const thread = asObject(asObject(resp, 'thread/start response').thread, 'thread/start thread');
    this.threadId = asString(thread.id, 'thread/start thread id');
  }

  /** 提交 task，等待 turn 完成，返回最终答案。 */
  async runTurn(task: string, signal: AbortSignal): Promise<{ text: string; stopReason: string }> {
    this.turnCompleted = withResolvers<Record<string, unknown>>();

    const resp = await this.transport.request('turn/start', {
      threadId: this.threadId!,
      input: [{ type: 'text', text: task, text_elements: [] }],
    }, signal);
    const turn = asObject(asObject(resp, 'turn/start response').turn, 'turn/start turn');
    this.commitTurnId(asString(turn.id, 'turn/start turn id'));

    signal.addEventListener('abort', () => {
      if (this.turnCompleted !== undefined && !this.turnCompleted.resolved) {
        this.turnCompleted.reject(new Error('codex: run aborted'));
      }
    }, { once: true });

    const terminal = asObject(await this.turnCompleted.promise, 'turn/completed');
    const turnResult = asObject(terminal.turn, 'turn/completed turn');
    const status = turnResult.status;

    if (status === 'completed') {
      const text = this.lastFinalAnswer ?? this.lastUnphasedAnswer;
      if (text === undefined || text.trim().length === 0) throw new Error('codex: turn completed but no final answer');
      return { text, stopReason: 'completed' };
    }
    if (status === 'interrupted') return { text: '', stopReason: 'aborted' };
    const detail = status === 'failed' && turnResult.error !== undefined ? `: ${JSON.stringify(turnResult.error)}` : '';
    throw new Error(`codex: turn ended with status ${String(status)}${detail}`);
  }

  /** 最佳努力取消远程 turn。 */
  interrupt(): void {
    if (this.threadId === undefined || this.turnId === undefined) return;
    this.transport.notify('turn/interrupt', { threadId: this.threadId, turnId: this.turnId });
  }

  close(): void { this.transport.close(); }

  // ─── 内部 ──────────────────────────────────────────────────────────────────

  private commitTurnId(id: string): void {
    this.turnId = id;
    const early = this.earlyNotifications.splice(0);
    for (const n of early) this.onNotification(n.method, n.params);
  }

  private onNotification(method: string, params: Record<string, unknown>): void {
    if (method === 'turn/started') {
      if (asString(params.threadId, 'turn/started threadId') !== this.threadId) return;
      const turn = asObject(params.turn, 'turn/started turn');
      if (this.turnCompleted !== undefined && this.turnId === undefined) {
        this.observePendingTurnId(asString(turn.id, 'turn/started turnId'));
      }
      return;
    }
    if (method === 'item/completed') {
      if (asString(params.threadId, 'item/completed threadId') !== this.threadId) return;
      const turnId = asString(params.turnId, 'item/completed turnId');
      if (this.turnId === undefined) { this.earlyNotifications.push({ method, params }); return; }
      if (turnId !== this.turnId) return;
      const item = asObject(params.item, 'item/completed item');
      if (item.type !== 'agentMessage') return;
      const text = typeof item.text === 'string' ? item.text : undefined;
      if (text === undefined) return;
      if (item.phase === 'final_answer') this.lastFinalAnswer = text;
      else if (item.phase === null) this.lastUnphasedAnswer = text;
      return;
    }
    if (method !== 'turn/completed') return;
    if (asString(params.threadId, 'turn/completed threadId') !== this.threadId) return;
    const turn = asObject(params.turn, 'turn/completed turn');
    const id = asString(turn.id, 'turn/completed turnId');
    if (this.turnId === undefined) { this.earlyNotifications.push({ method, params }); return; }
    if (id !== this.turnId) return;
    if (this.turnCompleted !== undefined && !this.turnCompleted.resolved) {
      this.turnCompleted.resolve(params);
    }
  }

  private observePendingTurnId(_id: string): void {
    // turn id 在 turn/start response 里已经拿到，这里不需要额外处理
  }

  private onServerRequest(method: string, params: Record<string, unknown>): Promise<unknown> {
    switch (method) {
      case 'item/commandExecution/requestApproval':
      case 'item/fileChange/requestApproval': {
        const available = params.availableDecisions;
        const decision = Array.isArray(available) && available.includes('cancel') ? 'cancel' : 'decline';
        return Promise.resolve({ decision });
      }
      case 'item/permissions/requestApproval':
        return Promise.resolve({ permissions: {}, scope: 'turn' });
      case 'item/tool/requestUserInput':
        return Promise.resolve({ answers: {} });
      case 'mcpServer/elicitation/request':
        return Promise.resolve({ action: 'decline', content: null, _meta: null });
      default:
        return Promise.reject(new Error(`codex: unsupported server request ${method}`));
    }
  }
}
