import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SessionQueueStore } from '../../src/agent/sessionQueue/store.js';
import { sessionSendTool } from '../../src/tools/sessionSend.js';
import type { ToolContext } from '../../src/tools/types.js';

const SELF = 'session-self-0001';
const TARGET = 'session-target-0002';

const tmpDirs: string[] = [];
afterEach(() => {
  while (tmpDirs.length > 0) rmSync(tmpDirs.pop()!, { recursive: true, force: true });
});

function setup(): { queue: SessionQueueStore } {
  const dir = mkdtempSync(join(tmpdir(), 'stepcode-send-'));
  tmpDirs.push(dir);
  return { queue: new SessionQueueStore(dir) };
}

describe('session_send 的身份与投递', () => {
  it('正常投递：from 取运行时会话身份，消息进目标队列', async () => {
    const { queue } = setup();
    const ctx: ToolContext = { cwd: process.cwd(), sessionId: SELF, sessionQueue: queue };
    const r = await sessionSendTool.execute({ targetSessionId: TARGET, message: '去调研' }, ctx);
    expect(r.isError).toBe(false);
    const got = queue.peek(TARGET);
    expect(got).toHaveLength(1);
    expect(got[0]!.from).toBe(SELF);
    expect(got[0]!.text).toBe('去调研');
  });

  it('无会话身份时拒绝投递，队列不落任何消息', async () => {
    const { queue } = setup();
    const ctx: ToolContext = { cwd: process.cwd(), sessionQueue: queue };
    const r = await sessionSendTool.execute({ targetSessionId: TARGET, message: 'x' }, ctx);
    expect(r.isError).toBe(true);
    expect(queue.peek(TARGET)).toHaveLength(0);
  });

  it('会话身份为空串同样拒绝', async () => {
    const { queue } = setup();
    const ctx: ToolContext = { cwd: process.cwd(), sessionId: '', sessionQueue: queue };
    const r = await sessionSendTool.execute({ targetSessionId: TARGET, message: 'x' }, ctx);
    expect(r.isError).toBe(true);
    expect(queue.peek(TARGET)).toHaveLength(0);
  });

  it('未注入队列时返回不支持（既有边界）', async () => {
    const ctx: ToolContext = { cwd: process.cwd(), sessionId: SELF };
    const r = await sessionSendTool.execute({ targetSessionId: TARGET, message: 'x' }, ctx);
    expect(r.isError).toBe(true);
  });

  it('目标 id 与正文为空仍拒绝（既有边界不回退）', async () => {
    const { queue } = setup();
    const ctx: ToolContext = { cwd: process.cwd(), sessionId: SELF, sessionQueue: queue };
    expect((await sessionSendTool.execute({ targetSessionId: '  ', message: 'x' }, ctx)).isError).toBe(true);
    expect((await sessionSendTool.execute({ targetSessionId: TARGET, message: '   ' }, ctx)).isError).toBe(true);
    expect(queue.peek(TARGET)).toHaveLength(0);
  });
});
