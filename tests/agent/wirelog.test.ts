import { appendFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { stored } from '../../src/agent/message.js';
import {
  applyWireEvent,
  closeDanglingToolUse,
  emptyWireReplayState,
  notifyDedupKey,
  notifyDedupKeyFromOrigin,
  parseWireLine,
  pendingDeliveredEvents,
  replayWireEvents,
  WIRE_FORMAT_VERSION,
  type WireEvent,
} from '../../src/agent/wirelog.js';
import { SessionStore, workdirKey } from '../../src/session/store.js';

const TS = '2026-08-01T00:00:00.000Z';

describe('replayWireEvents 纯函数重放', () => {
  it('append_message 按序重建消息历史；非消息事件各自落到对应状态字段', () => {
    const events: WireEvent[] = [
      { type: 'metadata', version: 1, sessionId: 's1', createdAt: TS },
      { type: 'context.append_message', ts: TS, message: stored({ role: 'user', content: 'hi' }, { kind: 'user' }) },
      { type: 'turn.prompt', ts: TS },
      { type: 'permission.set_mode', ts: TS, mode: 'yolo' },
      { type: 'plan_mode.set', ts: TS, enabled: true },
      { type: 'think.set', ts: TS, override: 'high' },
      {
        type: 'goal.update',
        ts: TS,
        goal: { objective: '写报告', status: 'active', turnsUsed: 0, tokensUsed: 0, createdAt: 1 },
      },
      { type: 'context.append_message', ts: TS, message: stored({ role: 'assistant', content: 'ok' }, { kind: 'assistant' }) },
    ];
    const state = replayWireEvents(events);
    expect(state.messages).toHaveLength(2);
    expect(state.turnCount).toBe(1);
    expect(state.mode).toBe('yolo');
    expect(state.planMode).toBe(true);
    expect(state.thinkOverride).toBe('high');
    expect(state.goal?.objective).toBe('写报告');
  });

  it('apply_compaction 整体替换已重建的消息历史（日志不截断，内存在该事件处折叠）', () => {
    const old = [1, 2, 3].map((i) => stored({ role: 'user', content: `m${i}` }, { kind: 'user' }));
    const survivors = [stored({ role: 'user', content: '摘要' }, { kind: 'compaction_summary' })];
    const events: WireEvent[] = [
      ...old.map((m): WireEvent => ({ type: 'context.append_message', ts: TS, message: m })),
      { type: 'context.apply_compaction', ts: TS, messages: survivors },
      { type: 'context.append_message', ts: TS, message: stored({ role: 'user', content: 'm4' }, { kind: 'user' }) },
    ];
    const state = replayWireEvents(events);
    expect(state.messages.map((m) => m.message.content)).toEqual(['摘要', 'm4']);
  });

  it('goal.update 携带空 goal = 清除；think.set 缺省 override = 清除覆盖', () => {
    const state = emptyWireReplayState();
    applyWireEvent(state, {
      type: 'goal.update',
      ts: TS,
      goal: { objective: 'x', status: 'active', turnsUsed: 0, tokensUsed: 0, createdAt: 1 },
    });
    applyWireEvent(state, { type: 'think.set', ts: TS, override: 'low' });
    applyWireEvent(state, { type: 'goal.update', ts: TS });
    applyWireEvent(state, { type: 'think.set', ts: TS });
    expect(state.goal).toBeUndefined();
    expect(state.thinkOverride).toBeUndefined();
  });

  it('重放无副作用：同一事件序列重放两次结果一致，且不修改输入事件', () => {
    const events: WireEvent[] = [
      { type: 'context.append_message', ts: TS, message: stored({ role: 'user', content: 'a' }, { kind: 'user' }) },
      { type: 'permission.set_mode', ts: TS, mode: 'auto' },
    ];
    const snapshot = JSON.stringify(events);
    const s1 = replayWireEvents(events);
    const s2 = replayWireEvents(events);
    expect(s1.messages.map((m) => m.id)).toEqual(s2.messages.map((m) => m.id));
    expect(s1.mode).toBe(s2.mode);
    expect(JSON.stringify(events)).toBe(snapshot);
  });

  it('已送达集合双通道回填：delivered 事件与 background_task 消息算出相同幂等键', () => {
    const note = stored(
      { role: 'user', content: '<notification/>' },
      { kind: 'background_task', taskId: 'task-1', notificationId: 'task:task-1:completed' },
    );
    const fromMessage = replayWireEvents([{ type: 'context.append_message', ts: TS, message: note }]);
    const fromEvent = replayWireEvents([
      { type: 'background.notify_delivered', ts: TS, taskId: 'task-1', status: 'completed', notificationId: 'task:task-1:completed' },
    ]);
    const key = notifyDedupKey('task-1', 'completed', 'task:task-1:completed');
    expect(fromMessage.deliveredNotifications.has(key)).toBe(true);
    expect(fromEvent.deliveredNotifications.has(key)).toBe(true);
    // 两通道算出的键必须一致，否则去重失效
    expect([...fromMessage.deliveredNotifications]).toEqual([...fromEvent.deliveredNotifications]);
  });

  it('background.task_settle 事件按任务 id 记录终态', () => {
    const state = replayWireEvents([
      {
        type: 'background.task_settle',
        ts: TS,
        task: { id: 'task-1', command: 'npm test', status: 'completed', startedAt: TS, output: '' },
      },
    ]);
    expect(state.settledTasks.get('task-1')?.status).toBe('completed');
  });
});

describe('notifyDedupKeyFromOrigin', () => {
  it('规范 notificationId（task:<taskId>:<status>）拆出的键与显式三段键一致', () => {
    expect(notifyDedupKeyFromOrigin('task-1', 'task:task-1:failed')).toBe(
      notifyDedupKey('task-1', 'failed', 'task:task-1:failed'),
    );
  });

  it('缺 taskId 时从 notificationId 回取；非规范 id 时 status 落空串但键仍稳定', () => {
    expect(notifyDedupKeyFromOrigin(undefined, 'task:task-9:killed')).toBe(
      notifyDedupKey('task-9', 'killed', 'task:task-9:killed'),
    );
    const odd = notifyDedupKeyFromOrigin('task-1', 'custom-id');
    expect(odd).toBe(notifyDedupKey('task-1', '', 'custom-id'));
    expect(notifyDedupKeyFromOrigin('task-1', 'custom-id')).toBe(odd); // 幂等
  });
});

describe('pendingDeliveredEvents（待办 #17：delivered 与消息本体同刻落盘）', () => {
  const note = (taskId: string, status: string) =>
    stored(
      { role: 'user', content: `<notification id="task:${taskId}:${status}">…</notification>` },
      { kind: 'background_task', taskId, notificationId: `task:${taskId}:${status}` },
    );

  it('为历史中的通知消息生成 delivered 事件，幂等键去重不重复写', () => {
    const written = new Set<string>();
    const messages = [
      stored({ role: 'user', content: 'hi' }, { kind: 'user' }),
      note('t1', 'completed'),
      note('t2', 'failed'),
    ];
    const first = pendingDeliveredEvents(messages, written, TS);
    expect(first).toHaveLength(2);
    expect(first[0]).toMatchObject({
      type: 'background.notify_delivered',
      taskId: 't1',
      status: 'completed',
      notificationId: 'task:t1:completed',
    });
    // 同一 written 集再次扫描：已写过的不再生成（persist 每轮都调，防 wire 膨胀）
    expect(pendingDeliveredEvents(messages, written, TS)).toHaveLength(0);
    // 新通知出现后只补写新的那条
    const third = pendingDeliveredEvents([...messages, note('t3', 'killed')], written, TS);
    expect(third).toHaveLength(1);
    expect(third[0]).toMatchObject({ taskId: 't3', status: 'killed' });
  });

  it('非通知消息与无 notificationId 的 origin 不产生事件', () => {
    const written = new Set<string>();
    const messages = [
      stored({ role: 'user', content: 'hi' }, { kind: 'user' }),
      stored({ role: 'assistant', content: 'yo' }, { kind: 'assistant' }),
    ];
    expect(pendingDeliveredEvents(messages, written, TS)).toHaveLength(0);
  });
});

describe('parseWireLine', () => {
  it('正常行解析为事件；空行/损坏行/崩溃截断尾行返回 null', () => {
    const event: WireEvent = { type: 'permission.set_mode', ts: TS, mode: 'yolo' };
    expect(parseWireLine(JSON.stringify(event))).toEqual(event);
    expect(parseWireLine('')).toBeNull();
    expect(parseWireLine('   ')).toBeNull();
    expect(parseWireLine('{"type":"permission.set_mode","ts":"2026')).toBeNull(); // 截断
    expect(parseWireLine('not json')).toBeNull();
    expect(parseWireLine('42')).toBeNull();
  });
});

describe('closeDanglingToolUse 悬空 tool_use 闭合', () => {
  it('末尾 assistant 带 tool_use：合成 is_error 的 tool_result 闭合，不假装成功', () => {
    const messages = [
      stored({ role: 'user', content: '跑一下' }, { kind: 'user' }),
      stored(
        {
          role: 'assistant',
          content: [
            { type: 'text', text: '好' },
            { type: 'tool_use', id: 'tu-1', name: 'bash', input: { command: 'ls' } },
          ],
        },
        { kind: 'assistant' },
      ),
    ];
    const result = closeDanglingToolUse(messages);
    expect(result.closed).toBe(true);
    expect(result.closedToolUseIds).toEqual(['tu-1']);
    const closure = result.messages.at(-1)!;
    expect(closure.origin.kind).toBe('tool');
    expect(closure.message.role).toBe('user');
    const blocks = closure.message.content as { type: string; tool_use_id: string; is_error: boolean }[];
    expect(blocks).toHaveLength(1);
    expect(blocks[0]!.type).toBe('tool_result');
    expect(blocks[0]!.tool_use_id).toBe('tu-1');
    expect(blocks[0]!.is_error).toBe(true);
    // 原数组不被修改
    expect(messages).toHaveLength(2);
  });

  it('末尾 assistant 有多个 tool_use：全部闭合', () => {
    const messages = [
      stored(
        {
          role: 'assistant',
          content: [
            { type: 'tool_use', id: 'tu-1', name: 'a', input: {} },
            { type: 'tool_use', id: 'tu-2', name: 'b', input: {} },
          ],
        },
        { kind: 'assistant' },
      ),
    ];
    const result = closeDanglingToolUse(messages);
    expect(result.closedToolUseIds).toEqual(['tu-1', 'tu-2']);
    expect(result.messages.at(-1)!.message.content).toHaveLength(2);
  });

  it('末尾不是悬空 tool_use（纯文本/已有 tool_result/user 消息/空历史）：不闭合', () => {
    const textTail = [stored({ role: 'assistant', content: 'done' }, { kind: 'assistant' })];
    expect(closeDanglingToolUse(textTail).closed).toBe(false);
    const userTail = [stored({ role: 'user', content: 'q' }, { kind: 'user' })];
    expect(closeDanglingToolUse(userTail).closed).toBe(false);
    expect(closeDanglingToolUse([]).closed).toBe(false);
    const noToolUse = [
      stored({ role: 'assistant', content: [{ type: 'text', text: '想完了' }] }, { kind: 'assistant' }),
    ];
    expect(closeDanglingToolUse(noToolUse).closed).toBe(false);
  });
});

describe('tool.settle 事件（loop 执行轨迹持久化）', () => {
  it('applyWireEvent 记账到 toolEvents，字段完整', () => {
    const state = emptyWireReplayState();
    applyWireEvent(state, {
      type: 'tool.settle',
      ts: '2026-09-28T15:00:00.000Z',
      id: 'tu_1',
      name: 'dynamic_workflow',
      isError: false,
      resultBytes: 2048,
      durationMs: 749000,
    });
    expect(state.toolEvents).toHaveLength(1);
    expect(state.toolEvents[0]).toMatchObject({
      id: 'tu_1',
      name: 'dynamic_workflow',
      isError: false,
      resultBytes: 2048,
      durationMs: 749000,
    });
  });

  it('resultFile 可选：缺省不出现在重放态里', () => {
    const state = emptyWireReplayState();
    applyWireEvent(state, { type: 'tool.settle', ts: 't', id: 'x', name: 'bash', isError: true, resultBytes: 10 });
    expect('resultFile' in state.toolEvents[0]!).toBe(false);
  });

  it('多次调用按序累积（loop 轨迹的顺序就是执行顺序）', () => {
    const state = emptyWireReplayState();
    for (const [i, name] of ['bash', 'read_media', 'edit'].entries()) {
      applyWireEvent(state, { type: 'tool.settle', ts: `t${i}`, id: `tu_${i}`, name, isError: false, resultBytes: 0 });
    }
    expect(state.toolEvents.map((t) => t.name)).toEqual(['bash', 'read_media', 'edit']);
  });

  it('截断容忍：末行半个 JSON 被丢弃，前面的事件全部保留', () => {
    const dir = mkdtempSync(join(tmpdir(), 'wire-trunc-'));
    try {
      const store = new SessionStore(dir);
      // 不预置 metadata：appendWire 首写会自动带头（再手传一条会双头）
      store.appendWire(dir, 's1', [
        { type: 'tool.settle', ts: 't1', id: 'tu_1', name: 'bash', isError: false, resultBytes: 100 },
        { type: 'tool.settle', ts: 't2', id: 'tu_2', name: 'edit', isError: false, resultBytes: 200 },
      ] as never);
      // 手工把半行坏 JSON 追加进去（模拟崩溃写在 flush 中途）
      const file = join(dir, workdirKey(dir), 's1.wire.jsonl');
      appendFileSync(file, '{"type":"tool.settle","ts":"t3","id":"tu_3"');
      const loaded = store.loadWire(dir, 's1');
      expect(loaded).toHaveLength(3); // 坏行被容忍丢弃，不炸
      const state = emptyWireReplayState();
      for (const e of loaded) applyWireEvent(state, e);
      expect(state.toolEvents).toHaveLength(2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
