import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';
import { startAcpServer } from '../../src/acp/server.js';
import { SessionStore } from '../../src/session/store.js';

/**
 * ACP 协议层测试：不跑真实 agent（prompt 端到端依赖 provider/文件系统），
 * 用 PassThrough 双向流驱动 JSON-RPC，验证握手字段、会话生命周期、错误形状。
 * 字段形状对齐官方 Agent Client Protocol（参照 DSH 的 acp 实现）。
 */

interface Harness {
  input: PassThrough;
  output: PassThrough;
  messages: any[];
}

function startHarness(store?: SessionStore): Harness {
  const input = new PassThrough();
  const output = new PassThrough();
  const messages: any[] = [];
  let buf = '';
  output.on('data', (chunk: Buffer) => {
    buf += chunk.toString();
    let idx: number;
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (line.length > 0) messages.push(JSON.parse(line));
    }
  });
  void startAcpServer(
    { config: {} as any, cwd: process.cwd(), provider: {} as any, store },
    { input, output },
  );
  return { input, output, messages };
}

function send(h: Harness, id: number, method: string, params?: Record<string, unknown>): void {
  h.input.write(JSON.stringify({ jsonrpc: '2.0', id, method, params: params ?? {} }) + '\n');
}

function waitFor<T>(h: Harness, pred: (m: any) => boolean, timeoutMs = 2000): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const found = h.messages.find(pred);
    if (found !== undefined) return resolve(found as T);
    const started = Date.now();
    const timer = setInterval(() => {
      const m = h.messages.find(pred);
      if (m !== undefined) {
        clearInterval(timer);
        resolve(m as T);
      } else if (Date.now() - started > timeoutMs) {
        clearInterval(timer);
        reject(new Error('timeout waiting for ACP response'));
      }
    }, 10);
  });
}

describe('ACP server', () => {
  const harnesses: Harness[] = [];
  afterEach(() => {
    for (const h of harnesses) {
      h.input.destroy();
      h.output.destroy();
    }
    harnesses.length = 0;
  });

  it('initialize 返回协议版本、agentInfo 与 agentCapabilities（官方字段名）', async () => {
    const h = startHarness();
    harnesses.push(h);
    send(h, 1, 'initialize', { protocolVersion: 1 });
    const res = await waitFor<any>(h, (m) => m.id === 1);
    expect(res.error).toBeUndefined();
    const r = res.result;
    expect(r.protocolVersion).toBe(1);
    // 旧实现误用 serverInfo；官方字段是 agentInfo。
    expect(r.agentInfo).toMatchObject({ name: 'step-code', title: 'Step Code' });
    expect(r.agentCapabilities).toBeDefined();
    expect(r.agentCapabilities.sessionCapabilities).toMatchObject({ close: {} });
    // 未注入 store 时不声明 list/resume（客户端会据此调用并失败）。
    expect(r.agentCapabilities.sessionCapabilities.list).toBeUndefined();
    expect(r.agentCapabilities.sessionCapabilities.resume).toBeUndefined();
    expect(r.agentCapabilities.promptCapabilities.image).toBe(true);
    expect(r.authMethods).toEqual([]);
  });

  it('注入持久化 store 后 initialize 声明 list/resume capability', async () => {
    const h = startHarness(new SessionStore());
    harnesses.push(h);
    send(h, 1, 'initialize', { protocolVersion: 1 });
    const res = await waitFor<any>(h, (m) => m.id === 1);
    expect(res.result.agentCapabilities.sessionCapabilities).toMatchObject({ list: {}, resume: {} });
  });

  it('未注入 store 时 session/list 返回 error（能力未声明时的诚实失败）', async () => {
    const h = startHarness();
    harnesses.push(h);
    send(h, 1, 'session/list', { cwd: process.cwd() });
    const res = await waitFor<any>(h, (m) => m.id === 1);
    expect(res.error).toBeDefined();
  });

  it('session/new 返回 configOptions（含 model 选择）', async () => {
    const h = startHarness();
    harnesses.push(h);
    send(h, 1, 'session/new', { cwd: process.cwd() });
    const res = await waitFor<any>(h, (m) => m.id === 1);
    const opts = res.result.configOptions;
    expect(Array.isArray(opts)).toBe(true);
    expect(opts.some((o: any) => o.id === 'model')).toBe(true);
  });

  it('持久化会话可经 session/list 列出、session/resume 恢复（真实临时 store）', async () => {
    const { mkdtempSync, rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const dir = mkdtempSync(join(tmpdir(), 'acp-sessions-'));
    const store = new SessionStore(dir);
    try {
      // 造一个持久化会话。
      const cwd = process.cwd();
      const sess = store.create(cwd, 'test-model');
      store.save(sess);

      const h = startHarness(store);
      harnesses.push(h);

      // list 能看到（且不含子 agent 会话过滤逻辑依赖 depth/agentType 字段缺失）。
      send(h, 1, 'session/list', { cwd });
      const list = await waitFor<any>(h, (m) => m.id === 1);
      expect(list.error).toBeUndefined();
      expect(Array.isArray(list.result.sessions)).toBe(true);
      expect(list.result.sessions.some((s: any) => s.sessionId === sess.id)).toBe(true);

      // resume 能恢复并返回 sessionId。
      send(h, 2, 'session/resume', { cwd, sessionId: sess.id });
      const resumed = await waitFor<any>(h, (m) => m.id === 2);
      expect(resumed.error).toBeUndefined();
      expect(resumed.result.sessionId).toBe(sess.id);

      // 未知会话 resume 报错。
      send(h, 3, 'session/resume', { cwd, sessionId: 'nope' });
      const bad = await waitFor<any>(h, (m) => m.id === 3);
      expect(bad.error).toBeDefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('initialize 版本协商：客户端版本更高时回落到服务器支持的版本', async () => {
    const h = startHarness();
    harnesses.push(h);
    send(h, 1, 'initialize', { protocolVersion: 99 });
    const res = await waitFor<any>(h, (m) => m.id === 1);
    expect(res.result.protocolVersion).toBe(1);
  });

  it('authenticate 直接 resolve（ACP 层不做鉴权）', async () => {
    const h = startHarness();
    harnesses.push(h);
    send(h, 2, 'authenticate');
    const res = await waitFor<any>(h, (m) => m.id === 2);
    expect(res.error).toBeUndefined();
  });

  it('session/new 返回会话 id，session/close 正常关闭', async () => {
    const h = startHarness();
    harnesses.push(h);
    send(h, 1, 'session/new', { cwd: process.cwd() });
    const created = await waitFor<any>(h, (m) => m.id === 1);
    const sessionId: string = created.result.sessionId;
    expect(typeof sessionId).toBe('string');
    expect(sessionId.length).toBeGreaterThan(0);

    send(h, 2, 'session/close', { sessionId });
    const closed = await waitFor<any>(h, (m) => m.id === 2);
    expect(closed.error).toBeUndefined();
  });

  it('未知方法返回 JSON-RPC error，而不是挂起', async () => {
    const h = startHarness();
    harnesses.push(h);
    send(h, 1, 'session/bogus');
    const res = await waitFor<any>(h, (m) => m.id === 1);
    expect(res.error).toBeDefined();
    expect(res.error.code).toBe(-32603);
  });

  it('session/prompt 未知会话返回 error', async () => {
    const h = startHarness();
    harnesses.push(h);
    send(h, 1, 'session/prompt', { sessionId: 'does-not-exist', prompt: [] });
    const res = await waitFor<any>(h, (m) => m.id === 1);
    expect(res.error).toBeDefined();
  });
});
