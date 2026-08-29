/**
 * subagent_trace 的实测覆盖。
 *
 * 这个工具此前零测试，而「接口存在」在这套代码里已经骗过人两次
 * （archiveStaleStandby 零调用方、saveSnapshot 漏写 standby 进索引）。
 * 所以这里不只测代码路径，还测它真能从落盘的历史里读出东西。
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SubagentStore } from '../../src/agent/subagent/store.js';
import { SessionStore } from '../../src/session/store.js';
import { stored } from '../../src/agent/message.js';
import { subagentTraceTool } from '../../src/tools/subagentControl.js';

let base: string;
let cwd: string;
let store: SubagentStore;

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'trace-tool-'));
  cwd = join(base, 'project');
  store = new SubagentStore(new SessionStore(base));
});
afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

/** 造一个带 N 条消息的子会话并落盘。 */
function seedWithMessages(id: string, count: number): void {
  const session = store.create(cwd, { model: 'm', agentType: 'explore', depth: 1 });
  session.id = id;
  const messages = [];
  for (let i = 0; i < count; i++) {
    messages.push(
      stored(
        { role: i % 2 === 0 ? 'user' : 'assistant', content: `第 ${i + 1} 条消息正文` },
        { kind: i % 2 === 0 ? 'user' : 'assistant' },
      ),
    );
  }
  session.messages = messages;
  store.saveSnapshot(session);
  store.appendMessages(cwd, id, messages);
}

function run(input: { id: string; limit?: number; role?: 'user' | 'assistant' | 'tool' }) {
  return subagentTraceTool.execute(input, { cwd, subagentStore: store });
}

describe('subagent_trace', () => {
  it('读出落盘的历史正文', async () => {
    seedWithMessages('sub-t1', 4);
    const r = await run({ id: 'sub-t1' });
    expect(r.isError).not.toBe(true);
    expect(r.content).toContain('第 1 条消息正文');
    expect(r.content).toContain('第 4 条消息正文');
  });

  it('不存在的会话 → 明确报错并提示用 subagent_list', async () => {
    const r = await run({ id: 'sub-nope' });
    expect(r.isError).toBe(true);
    expect(r.content).toContain('subagent_list');
  });

  it('没有消息记录的会话 → 报错而不是返回空成功', async () => {
    // 空成功会让模型以为「这个子 agent 什么都没做」，进而误判任务状态
    const session = store.create(cwd, { model: 'm', agentType: 'general', depth: 1 });
    session.id = 'sub-empty';
    store.saveSnapshot(session);
    const r = await run({ id: 'sub-empty' });
    expect(r.isError).toBe(true);
  });

  it('limit 截断到最近 N 条', async () => {
    seedWithMessages('sub-t2', 10);
    const r = await run({ id: 'sub-t2', limit: 3 });
    expect(r.content).toContain('第 10 条消息正文');
    expect(r.content).not.toContain('第 1 条消息正文');
  });

  it('role 过滤只返回指定角色', async () => {
    seedWithMessages('sub-t3', 4); // user/assistant 交替
    const r = await run({ id: 'sub-t3', role: 'user' });
    expect(r.content).toContain('第 1 条消息正文');
    expect(r.content).not.toContain('第 2 条消息正文');
  });

  it('过滤后无匹配 → 明确告知而不是报错', async () => {
    // 「这个子 agent 没有 tool 消息」是有效信息（说明它没调过工具），不是错误。
    // 报错会让模型以为出了故障，转而重复查询或放弃判断。
    seedWithMessages('sub-t4', 2); // 只有 user 和 assistant
    const r = await run({ id: 'sub-t4', role: 'tool' });
    expect(r.isError).not.toBe(true);
    expect(r.content).toContain('tool');
    expect(r.content).toContain('sub-t4');
  });

  it('上下文缺 subagentStore → 明确报错', async () => {
    const r = await subagentTraceTool.execute({ id: 'sub-x' }, { cwd });
    expect(r.isError).toBe(true);
  });

  it('工具已注册进工具表（没注册则模型根本调不到）', async () => {
    // 与 access 测试同风格：锁「接线存在」而非实现细节
    const { allToolNames } = await import('../../src/tools/index.js');
    expect(allToolNames()).toContain('subagent_trace');
  });
});
