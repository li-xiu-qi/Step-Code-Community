import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import http from 'node:http';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * ACP agent 循环集成测试：真实 spawn 构建产物 dist/main.js --acp，驱动完整循环
 *   skill 激活 → tool_search 发现 MCP → MCP 工具执行 → 终答
 * 覆盖三类曾真实踩中的回归：
 *   1. ACP 模式不装配 MCP/skill 时 tool_search 恒回报「懒加载未配置」（composeAcpRuntime 修复）
 *   2. deferred 白名单工具在 prompt 时未注册，被过滤出 toolNames，runTurn allowedSet
 *      拒掉已加载的 MCP 调用（server.ts 白名单 union 补全修复）
 *   3. 名单外工具调用必须被拒（allowedSet 主门）
 * mock LLM 脚本化三轮半：skill → tool_search → mcp 调用 → 名单外工具（应被拒）→ 终答。
 * dist 未构建时跳过（构建：npm run build）。
 */

const REPO_ROOT = resolve(process.cwd());
const DIST_MAIN = join(REPO_ROOT, 'dist', 'main.js');
const LLM_PORT = 18091;
const API_PORT = 19091;

const SKILL_MARKER = 'FIXTURE-SKILL-BODY';
const MCP_MARKER = 'FIXTURE-OK';

const FIXTURE_MCP_SERVER = `#!/usr/bin/env node
const TOOLS = [{
  name: 'echo',
  description: '回声工具（测试夹具）',
  inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
}];
let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  let idx;
  while ((idx = buffer.indexOf('\\n')) >= 0) {
    const line = buffer.slice(0, idx).trim();
    buffer = buffer.slice(idx + 1);
    if (line === '') continue;
    let msg;
    try { msg = JSON.parse(line); } catch { continue; }
    if (msg.method === 'initialize') {
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: {
        protocolVersion: msg.params?.protocolVersion ?? '2024-11-10',
        capabilities: { tools: {} },
        serverInfo: { name: 'fixture', version: '1.0.0' },
      }}) + '\\n');
    } else if (msg.method === 'tools/list') {
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { tools: TOOLS }}) + '\\n');
    } else if (msg.method === 'tools/call') {
      const text = String(msg.params?.arguments?.text ?? '');
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: {
        content: [{ type: 'text', text: '${MCP_MARKER}: ' + text }],
      }}) + '\\n');
    }
  }
});
`;

function sse(obj: unknown): string {
  return `data: ${JSON.stringify(obj)}\n\n`;
}

function toolCallChunk(id: string, name: string, args: unknown): string {
  return sse({
    id: 'chatcmpl-fixture',
    object: 'chat.completion.chunk',
    choices: [
      {
        index: 0,
        delta: {
          tool_calls: [{ index: 0, id, type: 'function', function: { name, arguments: JSON.stringify(args) } }],
        },
        finish_reason: null,
      },
    ],
  });
}

const finishChunk = (reason: string) =>
  sse({
    id: 'chatcmpl-fixture',
    object: 'chat.completion.chunk',
    choices: [{ index: 0, delta: {}, finish_reason: reason }],
  });

describe('ACP agent 循环（skill + MCP + 白名单）', () => {
  let ws = '';
  let llm: http.Server;
  let agent: ReturnType<typeof spawn> | null = null;

  beforeAll(async () => {
    if (!existsSync(DIST_MAIN)) {
      console.warn(`[acp-mcp] dist 未构建，跳过集成测试（npm run build 后重跑）: ${DIST_MAIN}`);
      return;
    }
    // mock LLM：按工具结果分支（step-code 的 openai 适配器把 tool_result 投影成 role:'tool'）。
    llm = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        const parsed = body.length > 0 ? JSON.parse(body) : {};
        const msgs: any[] = Array.isArray(parsed.messages) ? parsed.messages : [];
        const toolTexts = msgs.filter((m) => m.role === 'tool').map((m) => String(m.content ?? '')).join(' ');
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        if (toolTexts.includes(MCP_MARKER) && toolTexts.includes('不可用')) {
          res.end(sse({ choices: [{ index: 0, delta: { content: 'DONE-ANSWER' }, finish_reason: null }] }) + finishChunk('stop') + 'data: [DONE]\n\n');
        } else if (toolTexts.includes(MCP_MARKER)) {
          // MCP 已成功 → 试一个名单外工具（read_file），应被 allowedSet 拒
          res.end(toolCallChunk('call_evil', 'read_file', { path: 'x' }) + finishChunk('tool_calls') + 'data: [DONE]\n\n');
        } else if (toolTexts.includes('已加载')) {
          res.end(toolCallChunk('call_mcp', 'mcp__fixture__echo', { text: 'hi' }) + finishChunk('tool_calls') + 'data: [DONE]\n\n');
        } else if (toolTexts.includes(SKILL_MARKER)) {
          res.end(toolCallChunk('call_search', 'tool_search', { query: 'fixture 回声' }) + finishChunk('tool_calls') + 'data: [DONE]\n\n');
        } else {
          res.end(toolCallChunk('call_skill', 'skill', { skill: 'fixture-skill' }) + finishChunk('tool_calls') + 'data: [DONE]\n\n');
        }
      });
    });
    await new Promise<void>((r) => llm.listen(LLM_PORT, '127.0.0.1', r));

    // 工作区：config.toml（白名单含 deferred 的 mcp__fixture__echo，不含 read_file）
    // + mcp.json（夹具 server）+ 项目级 skill。
    ws = mkdtempSync(join(tmpdir(), 'acp-mcp-ws-'));
    const stepDir = join(ws, '.step-code');
    mkdirSync(join(stepDir, 'skills', 'fixture-skill'), { recursive: true });
    writeFileSync(
      join(stepDir, 'config.toml'),
      [
        'provider = "openai"',
        `base_url = "http://127.0.0.1:${LLM_PORT}/v1"`,
        'model = "fixture-model"',
        'enabled_tools = ["skill", "tool_search", "mcp__fixture__echo"]',
        '',
      ].join('\n'),
    );
    const mcpFixture = join(ws, 'fixture-mcp.mjs');
    writeFileSync(mcpFixture, FIXTURE_MCP_SERVER);
    writeFileSync(
      join(stepDir, 'mcp.json'),
      JSON.stringify({
        mcpServers: {
          fixture: { command: process.execPath, args: [mcpFixture], startupTimeoutMs: 10000 },
        },
      }),
    );
    writeFileSync(
      join(stepDir, 'skills', 'fixture-skill', 'SKILL.md'),
      `---\nname: fixture-skill\ndescription: 测试夹具技能。${SKILL_MARKER}\n---\n\n# 夹具\n\n${SKILL_MARKER}：按协议调用工具。\n`,
    );

    agent = spawn(process.execPath, [DIST_MAIN, '--acp'], {
      cwd: ws,
      env: { ...process.env, HOME: ws, USERPROFILE: ws, STEP_CODE_API_KEY: 'fixture-key' },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  });

  afterAll(async () => {
    try {
      agent?.stdin?.end();
    } catch {
      /* 已断开 */
    }
    // 等 stdio 关闭与 MCP 孙进程退出，再杀进程树（Windows 上句柄不释放会 EPERM）。
    await new Promise<void>((r) => setTimeout(r, 500));
    if (agent?.pid !== undefined && !agent.killed) {
      try {
        spawn('taskkill', ['/pid', String(agent.pid), '/T', '/F']);
      } catch {
        agent.kill();
      }
    }
    llm?.close();
    try {
      if (ws !== '') rmSync(ws, { recursive: true, force: true });
    } catch {
      /* best-effort：句柄偶发未释放时留下临时目录，不阻断测试结果 */
    }
  });

  it('完整循环：skill 激活 → tool_search 发现 MCP → MCP 执行 → 名单外工具被拒 → 终答', async () => {
    if (agent === null) return; // dist 未构建，跳过

    const events: any[] = [];
    let buf = '';
    let seq = 0;
    const pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
    let fullText = '';

    agent.stdout!.setEncoding('utf8');
    agent.stdout!.on('data', (chunk: string) => {
      buf += chunk;
      let idx: number;
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (line === '') continue;
        let msg: any;
        try {
          msg = JSON.parse(line);
        } catch {
          continue;
        }
        if (msg.method === 'session/request_permission') {
          agent!.stdin!.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { optionId: 'allow-once' } }) + '\n');
          continue;
        }
        if (msg.id !== undefined && (msg.result !== undefined || msg.error !== undefined)) {
          const p = pending.get(Number(msg.id));
          if (p !== undefined) {
            pending.delete(Number(msg.id));
            if (msg.error !== undefined && msg.error !== null) p.reject(new Error(msg.error.message));
            else p.resolve(msg.result);
          }
          continue;
        }
        if (msg.method === 'session/update') {
          const p = msg.params ?? {};
          if (p.sessionUpdate === 'agent_message_chunk' && typeof p.content?.text === 'string') {
            fullText += p.content.text;
          } else if (p.sessionUpdate === 'tool_call') {
            events.push({ kind: 'tool_call', title: p.title, rawInput: p.rawInput });
          } else if (p.sessionUpdate === 'tool_call_update') {
            const text = (p.content ?? []).map((b: any) => (b.type === 'text' ? b.text : '')).join('');
            events.push({ kind: 'tool_result', status: p.status, text });
          }
        }
      }
    });

    const request = (method: string, params: Record<string, unknown> = {}) =>
      new Promise<any>((res, rej) => {
        const id = ++seq;
        pending.set(id, { resolve: res, reject: rej });
        agent!.stdin!.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
      });

    const init = await request('initialize', { protocolVersion: 1, clientCapabilities: {} });
    expect(init.protocolVersion).toBe(1);
    agent!.stdin!.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');

    const created = await request('session/new', { cwd: ws });
    const sessionId = String(created.sessionId);

    const result = await request('session/prompt', {
      sessionId,
      prompt: [{ type: 'text', text: '测试问题：fixture 回声怎么说？先激活 fixture-skill 再回答。' }],
    });
    expect(result.stopReason).toBe('end_turn');

    const titles = events.filter((e) => e.kind === 'tool_call').map((e) => e.title);
    // 1. skill 激活（ACP runtime 注入了 skill 注册表）
    expect(titles).toContain('skill');
    // 2. tool_search 发现 MCP 工具（deferred 机制 + compose 等待连接）
    expect(titles).toContain('tool_search');
    const searchResult = events.find((e) => e.kind === 'tool_result' && String(e.text).includes('已加载'));
    expect(searchResult, 'tool_search 应加载到 mcp__fixture__echo').toBeDefined();
    // 3. MCP 工具调用成功执行（白名单 union 补全后 allowedSet 放行）
    expect(titles).toContain('mcp__fixture__echo');
    const mcpResult = events.find((e) => e.kind === 'tool_result' && String(e.text).includes(MCP_MARKER));
    expect(mcpResult?.status).toBe('completed');
    // 4. 名单外工具（read_file）被拒（allowedSet 主门）
    const evilResult = events.find((e) => e.kind === 'tool_result' && e.status === 'failed');
    expect(evilResult, '名单外的 read_file 调用应失败').toBeDefined();
    // 5. 终答到达
    expect(fullText).toContain('DONE-ANSWER');
  }, 60_000);
});
