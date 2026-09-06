/**
 * ACP（Agent Client Protocol，Zed 主导的 editor↔agent JSON-RPC stdio 协议）服务端。
 *
 * 让 IDE / 编辑器（Zed、Neovim、JetBrains 等）通过 stdin/stdout 驱动 step-code。
 * 协议规范：agentclientprotocol.com。协议字段以官方 @agentclientprotocol/sdk
 * 的形状为准（参照 DSH 的 packages/acp 实现），不自行发明字段名。
 *
 * 支持的方法（client → server）：
 * - initialize: 版本协商 + agentInfo / agentCapabilities
 * - authenticate: 占位（step-code 不做 ACP 层鉴权，直接 resolve）
 * - session/new: 创建 agent 会话
 * - session/prompt: 发送任务，跑一轮 agent，流式 session/update 回传
 * - session/cancel（notification）: 取消当前 turn
 * - session/close: 关闭内存中的活动会话
 * - session/list: 列出本工作目录可恢复的持久化会话（需注入 SessionStore）
 * - session/resume: 从持久化恢复一个历史会话（需注入 SessionStore）
 * - session/set_config_option: 会话级切换模型（需注入 SessionStore）
 *
 * server → client：
 * - session/update（notification）: agent_message_chunk / agent_thought_chunk /
 *   tool_call / tool_call_update / usage_update
 * - session/request_permission（request）: 写/执行类工具运行前向编辑器请求一次性授权
 *
 * 设计对齐 DSH：从 agent 事件单向投影成 ACP update；权限只发一次性选项，
 * 客户端报错/断开一律降级为拒绝，绝不从未知响应推断持久授权。
 *
 * 已知边界（诚实声明，不声明对应 capability）：
 * - fs/read_text_file / fs/write_text_file：DSH 也未实现，文件改动经 tool_call 的
 *   content 回传给编辑器渲染，协议无专门 diff 字段，step-code 同样不做。
 * - 会话级 mcpServers 动态挂载：ACP 允许在 session/new 传 mcpServers，但 step-code
 *   的 MCP 走 config.toml / 插件统一管理、在应用启动时装配，不支持向运行中的 agent
 *   会话热挂外部 MCP。传入的 mcpServers 当前不生效（不静默假装）；需要额外工具用
 *   config/插件配置。mcpCapabilities 因此保持空。
 */

import type { Readable, Writable } from 'node:stream';
import { randomUUID } from 'node:crypto';
import type { StepCodeConfig } from '../config/config.js';
import type { ChatProvider } from '../provider/types.js';
import { stored, type StoredMessage } from '../agent/message.js';
import type { LoopHooks, ToolCallRequest, Authorization } from '../agent/hooks.js';
import { isReadOnly } from '../agent/permission/mode.js';
import type { SessionStore } from '../session/store.js';

// ─── JSON-RPC 传输（newline-delimited，server 端） ─────────────────────────

/** 等待客户端响应的 server→client 请求。 */
interface PendingRequest {
  resolve: (result: any) => void;
  reject: (error: Error) => void;
}

/** newline-delimited JSON-RPC server，支持处理 client 请求、发通知、发请求等响应。 */
class JsonRpcServer {
  private buffer = '';
  private readonly pending = new Map<number, PendingRequest>();
  private reqSeq = 1;

  constructor(
    private readonly input: Readable,
    private readonly output: Writable,
    private readonly onRequest: (method: string, params: Record<string, unknown>) => Promise<unknown>,
    private readonly onNotification: (method: string, params: Record<string, unknown>) => void = () => {},
  ) {
    this.input.on('data', (chunk: Buffer) => this.onData(chunk));
    this.input.on('end', () => {
      // 连接断开：拒绝所有在途的 server→client 请求（如未应答的权限弹窗）。
      for (const [, p] of this.pending) p.reject(new Error('client disconnected'));
      this.pending.clear();
    });
  }

  private onData(chunk: Buffer): void {
    this.buffer += chunk.toString();
    let idx: number;
    while ((idx = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, idx).trim();
      this.buffer = this.buffer.slice(idx + 1);
      if (line.length === 0) continue;
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }

      // 入站响应（对应我们发出的 request）：有 id、无 method、带 result/error。
      if (msg.method === undefined && (msg.id !== undefined && msg.id !== null)) {
        const p = this.pending.get(Number(msg.id));
        if (p !== undefined) {
          this.pending.delete(Number(msg.id));
          if (msg.error !== undefined && msg.error !== null) {
            const e = msg.error as { message?: string };
            p.reject(new Error(typeof e.message === 'string' ? e.message : 'request failed'));
          } else {
            p.resolve(msg.result);
          }
        }
        continue;
      }

      // 入站请求或通知。
      if (msg.method === undefined) continue;
      const method = String(msg.method);
      const params = (msg.params as Record<string, unknown>) ?? {};
      if (msg.id === undefined || msg.id === null) {
        this.onNotification(method, params);
        continue;
      }
      const id = msg.id;
      void this.onRequest(method, params)
        .then((result) => this.write({ jsonrpc: '2.0', id, result: result ?? {} }))
        .catch((e: Error) => this.write({ jsonrpc: '2.0', id, error: { code: -32603, message: e.message } }));
    }
  }

  /** server → client notification（无 id，不等响应）。 */
  notify(method: string, params: Record<string, unknown>): void {
    this.write({ jsonrpc: '2.0', method, params });
  }

  /** server → client request（带 id，等客户端回 result）。用于权限请求等。 */
  request(method: string, params: Record<string, unknown>): Promise<any> {
    const id = this.reqSeq++;
    return new Promise<any>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.write({ jsonrpc: '2.0', id, method, params });
    });
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
  /** 会话级模型覆盖（session/set_config_option 设置）；undefined = 用服务器默认。 */
  model?: string;
  /** 已发出 in_progress 通知的工具调用 id（保证 tool_call 先于权限请求到达）。 */
  announcedTools: Set<string>;
}

// ─── ACP Server 主逻辑 ──────────────────────────────────────────────────────

export interface AcpServerOptions {
  config: StepCodeConfig;
  cwd: string;
  provider: ChatProvider;
  model?: string;
  providerName?: string;
  /**
   * 会话持久化。注入后 session/list、session/resume、session/set_config_option 的能力开启，
   * initialize 会声明 sessionCapabilities.list/resume；不注入（如测试）则这些方法报 unsupported。
   */
  store?: SessionStore;
}

export interface AcpServerStreams {
  input: Readable;
  output: Writable;
}

const ACP_PROTOCOL_VERSION = 1;
const AGENT_NAME = 'step-code';
const AGENT_VERSION = '1.0.0';

export async function startAcpServer(
  opts: AcpServerOptions,
  streams?: AcpServerStreams,
): Promise<void> {
  const sessions = new Map<string, AcpSession>();
  const input = streams?.input ?? process.stdin;
  const output = streams?.output ?? process.stdout;
  const hasStore = opts.store !== undefined;

  const server = new JsonRpcServer(
    input,
    output,
    async (method, params) => {
      switch (method) {
        case 'initialize':
          return handleInitialize(params, hasStore);
        case 'authenticate':
          return {};
        case 'session/new':
          return handleSessionNew(params, sessions);
        case 'session/prompt':
          return await handleSessionPrompt(params, sessions, server, opts);
        case 'session/close':
          return handleSessionClose(params, sessions);
        case 'session/list':
          return handleSessionList(params, opts);
        case 'session/resume':
          return handleSessionResume(params, sessions, opts);
        case 'session/set_config_option':
          return handleSetConfigOption(params, sessions);
        default:
          throw new Error(`ACP: unsupported method '${method}'`);
      }
    },
    (method, params) => {
      // 通知：session/cancel 无 id。
      if (method === 'session/cancel') {
        const sessionId = String(params.sessionId ?? '');
        const session = sessions.get(sessionId);
        if (session !== undefined && session.controller !== null) {
          session.controller.abort();
          session.controller = null;
        }
      }
    },
  );

  process.stderr.write(`[acp] server started, protocol v${ACP_PROTOCOL_VERSION}\n`);

  return new Promise<void>((resolve) => {
    input.on('end', () => {
      process.stderr.write('[acp] stdin closed, shutting down\n');
      for (const [, session] of sessions) {
        session.controller?.abort();
      }
      resolve();
    });
  });
}

// ─── 方法处理器 ─────────────────────────────────────────────────────────────

function handleInitialize(_params: Record<string, unknown>, hasStore: boolean): Record<string, unknown> {
  const sessionCapabilities: Record<string, unknown> = { close: {} };
  if (hasStore) {
    sessionCapabilities.list = {};
    sessionCapabilities.resume = {};
  }
  return {
    protocolVersion: ACP_PROTOCOL_VERSION,
    agentInfo: { name: AGENT_NAME, title: 'Step Code', version: AGENT_VERSION },
    agentCapabilities: {
      // step-code 的 MCP 走 config/插件统一管理，不支持会话级热挂（见文件头边界说明）。
      mcpCapabilities: {},
      // 图片输入：模型多为多模态；实际可用性取决于当前 provider/model 是否支持视觉。
      promptCapabilities: { image: true, audio: false, embeddedContext: false },
      sessionCapabilities,
    },
    authMethods: [],
  };
}

function handleSessionNew(
  params: Record<string, unknown>,
  sessions: Map<string, AcpSession>,
): Record<string, unknown> {
  const cwd = typeof params.cwd === 'string' && params.cwd.length > 0 ? params.cwd : process.cwd();
  const sessionId = randomUUID();
  sessions.set(sessionId, { id: sessionId, cwd, messages: [], controller: null, announcedTools: new Set() });
  process.stderr.write(`[acp] session/new: ${sessionId} (cwd=${cwd})\n`);
  // model 配置选项：让编辑器能切换会话模型（值为模型 id 或 [provider, model]）。
  return {
    sessionId,
    configOptions: [
      {
        id: 'model',
        kind: 'select',
        label: 'Model',
        options: [],
      },
    ],
  };
}

function handleSessionClose(
  params: Record<string, unknown>,
  sessions: Map<string, AcpSession>,
): Record<string, unknown> {
  const sessionId = String(params.sessionId ?? '');
  const session = sessions.get(sessionId);
  if (session !== undefined) {
    session.controller?.abort();
    sessions.delete(sessionId);
  }
  return {};
}

function handleSessionList(
  params: Record<string, unknown>,
  opts: AcpServerOptions,
): Record<string, unknown> {
  if (opts.store === undefined) throw new Error('ACP: session/list not supported (no persistence store)');
  const cwd = typeof params.cwd === 'string' && params.cwd.length > 0 ? params.cwd : opts.cwd;
  const limit = typeof params.limit === 'number' ? params.limit : 50;
  const cursor = typeof params.cursor === 'string' ? params.cursor : undefined;
  const page = opts.store.listPaginated(cwd, limit, cursor);
  // 只暴露主会话：过滤掉子 agent 会话（depth/agentType/owner 标记）。
  const sessions = page.items
    .filter((m) => m.depth === undefined && m.agentType === undefined && m.parentId === undefined)
    .map((m) => ({
      sessionId: m.id,
      cwd: m.cwd,
      title: m.name ?? m.title ?? '',
      messageCount: m.messageCount,
      updatedAt: m.updatedAt,
    }));
  return { sessions, nextCursor: page.nextCursor };
}

function handleSessionResume(
  params: Record<string, unknown>,
  sessions: Map<string, AcpSession>,
  opts: AcpServerOptions,
): Record<string, unknown> {
  if (opts.store === undefined) throw new Error('ACP: session/resume not supported (no persistence store)');
  const sessionId = String(params.sessionId ?? '');
  const cwd = typeof params.cwd === 'string' && params.cwd.length > 0 ? params.cwd : opts.cwd;
  const resumed = opts.store.resume(cwd, sessionId);
  if (resumed === null) throw new Error(`ACP: no such session '${sessionId}' in cwd '${cwd}'`);
  // resume() 已重放尾段、闭合悬空 tool_use；载入为活动会话，模型沿用会话持久值。
  sessions.set(sessionId, {
    id: sessionId,
    cwd: resumed.session.cwd,
    messages: resumed.session.messages,
    controller: null,
    model: resumed.session.model,
    announcedTools: new Set(),
  });
  process.stderr.write(`[acp] session/resume: ${sessionId} (${resumed.session.messages.length} messages)\n`);
  return { sessionId, configOptions: [{ id: 'model', kind: 'select', label: 'Model', options: [] }] };
}

function handleSetConfigOption(
  params: Record<string, unknown>,
  sessions: Map<string, AcpSession>,
): Record<string, unknown> {
  const sessionId = String(params.sessionId ?? '');
  const session = sessions.get(sessionId);
  if (session === undefined) throw new Error(`ACP: unknown session '${sessionId}'`);
  const optionId = String(params.id ?? params.optionId ?? '');
  const rawValue = params.value;
  if (optionId === 'model') {
    // 兼容裸 model id 字符串与 DSH 风格 JSON.stringify([provider, model])。
    let model: string | undefined;
    if (typeof rawValue === 'string') {
      model = rawValue;
      if (rawValue.startsWith('[')) {
        try {
          const arr = JSON.parse(rawValue);
          if (Array.isArray(arr) && typeof arr[arr.length - 1] === 'string') model = arr[arr.length - 1];
        } catch {
          // 非 JSON 数组就按裸字符串处理。
        }
      }
    }
    if (model === undefined) throw new Error('ACP: model option requires a string value');
    session.model = model;
    return {};
  }
  throw new Error(`ACP: unsupported config option '${optionId}'`);
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

  // 提取 prompt：text 累积为正文，image block 转成 Anthropic 风格 base64 图片块（多模态）。
  const promptBlocks = Array.isArray(params.prompt) ? params.prompt : [];
  let promptText = '';
  const imageBlocks: any[] = [];
  for (const block of promptBlocks) {
    if (typeof block !== 'object' || block === null) continue;
    const b = block as Record<string, unknown>;
    if (b.type === 'text') {
      promptText += String(b.text ?? '');
    } else if (b.type === 'image') {
      // ACP image：{ type:'image', data: <base64>, mimeType? }（resource_link/url 形态暂不支持）。
      if (typeof b.data === 'string') {
        imageBlocks.push({
          type: 'image',
          source: { type: 'base64', media_type: typeof b.mimeType === 'string' ? b.mimeType : 'image/png', data: b.data },
        });
      }
    }
  }
  if (promptText.trim().length === 0 && imageBlocks.length === 0) {
    throw new Error('ACP: prompt must contain at least one text or image block');
  }

  const userContent: string | any[] = imageBlocks.length > 0
    ? [...(promptText.length > 0 ? [{ type: 'text', text: promptText }] : []), ...imageBlocks]
    : promptText;
  session.messages.push(stored({ role: 'user', content: userContent }, { kind: 'user' }));

  const controller = new AbortController();
  session.controller = controller;

  const { runAgent } = await import('../agent/loop.js');
  const { buildSystemPrompt } = await import('../agent/systemPrompt.js');
  const { allToolNames } = await import('../tools/index.js');

  const system = buildSystemPrompt(session.cwd, { pureMode: true });
  const toolNames = allToolNames();

  // 工具授权：只读放行；写/执行类向编辑器发一次性权限请求。
  const hooks: LoopHooks = {
    async authorizeToolCall(req: ToolCallRequest): Promise<Authorization> {
      // 先确保 tool_call(in_progress) 已建立，权限请求里的 toolCallId 客户端能关联上。
      announceToolCall(server, session, req);
      if (isReadOnly(req.name)) return { decision: 'allow' };
      try {
        const res = await server.request('session/request_permission', {
          sessionId: session.id,
          toolCall: { toolCallId: req.id },
          options: [
            { optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' },
            { optionId: 'reject-once', name: 'Reject', kind: 'reject_once' },
          ],
        });
        const optionId = readOptionId(res);
        if (optionId === 'allow-once') return { decision: 'allow' };
        return { decision: 'deny', reason: `工具 ${req.name} 被用户拒绝（编辑器授权弹窗选择了拒绝）` };
      } catch (e) {
        // 客户端不支持权限请求 / 断开 / 报错：安全降级为拒绝，绝不默认放行。
        return { decision: 'deny', reason: `无法获得编辑器授权（${(e as Error).message}），已拒绝 ${req.name}` };
      }
    },
  };

  let fullText = '';
  const stopReason = 'end_turn';

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
      model: session.model ?? opts.model ?? opts.config.model,
      maxIterations: 50,
      allowedTools: toolNames,
      hooks,
    })) {
      projectEvent(server, session, ev, (t) => { fullText += t; });
    }
  } catch (e: any) {
    fullText += `\n[ACP error: ${e.message}]`;
    server.notify('session/update', {
      sessionId,
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: `\n[error: ${e.message}]` },
    });
  } finally {
    session.controller = null;
  }

  session.messages.push(stored({ role: 'assistant', content: fullText }, { kind: 'injection' }));
  // stopReason：中断由 cancel 通知驱动 abort，这里正常结束回 end_turn；错误已在正文表达。
  return { sessionId, stopReason };
}

// ─── 事件投影：AgentEvent → ACP session/update ──────────────────────────────

/** 发出 tool_call(in_progress)，每个工具调用只发一次。 */
function announceToolCall(server: JsonRpcServer, session: AcpSession, req: ToolCallRequest): void {
  if (session.announcedTools.has(req.id)) return;
  session.announcedTools.add(req.id);
  server.notify('session/update', {
    sessionId: session.id,
    sessionUpdate: 'tool_call',
    toolCallId: req.id,
    title: req.name,
    kind: 'other',
    status: 'in_progress',
    rawInput: req.input,
  });
}

/**
 * 把 agent 事件单向投影成 ACP update。appendText 累积正文（用于落盘 assistant 消息）。
 * 字段形状对齐 DSH updates.ts（官方 sdk 类型）。
 */
function projectEvent(
  server: JsonRpcServer,
  session: AcpSession,
  ev: any,
  appendText: (t: string) => void,
): void {
  const sid = session.id;
  switch (ev.type) {
    case 'text':
      appendText(ev.text);
      server.notify('session/update', {
        sessionId: sid,
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: ev.text },
      });
      break;
    case 'thinking_delta':
      server.notify('session/update', {
        sessionId: sid,
        sessionUpdate: 'agent_thought_chunk',
        content: { type: 'text', text: ev.text },
      });
      break;
    case 'tool_start':
      session.announcedTools.add(ev.id);
      server.notify('session/update', {
        sessionId: sid,
        sessionUpdate: 'tool_call',
        toolCallId: ev.id,
        title: ev.name,
        kind: 'other',
        status: 'in_progress',
        rawInput: ev.input,
      });
      break;
    case 'tool_end':
      server.notify('session/update', {
        sessionId: sid,
        sessionUpdate: 'tool_call_update',
        toolCallId: ev.id,
        status: ev.isError ? 'failed' : 'completed',
        content: [{ type: 'text', text: String(ev.result ?? '') }],
      });
      break;
    case 'usage':
      // size（上下文窗）无可靠值，省略；used 报累计 token。
      if (typeof ev.totalTokens === 'number') {
        server.notify('session/update', {
          sessionId: sid,
          sessionUpdate: 'usage_update',
          used: ev.totalTokens,
        });
      }
      break;
    default:
      // thinking_start/end、tool_forming、tool_args_delta、retry、notice、aborted 等不投影。
      break;
  }
}

/** 从 request_permission_response 里宽容读取 optionId（兼容不同包装形状）。 */
function readOptionId(res: any): string | undefined {
  if (res === null || typeof res !== 'object') return undefined;
  if (typeof res.optionId === 'string') return res.optionId;
  const outcome = res.outcome;
  if (outcome !== null && typeof outcome === 'object' && typeof outcome.optionId === 'string') {
    return outcome.optionId;
  }
  return undefined;
}
