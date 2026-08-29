import { describe, expect, it } from 'vitest';
import { notifyDedupKeyFromOrigin } from '../../src/agent/wirelog.js';
import type { BackgroundTask, LostTask } from '../../src/agent/background/manager.js';
import {
  buildSettleMessage,
  decideNotifyRoute,
  formatSettleNotification,
  mergeSettleMessages,
  notificationIdFor,
  pendingBatchDeliveredEvents,
} from '../../src/agent/background/notify.js';

function makeTask(over: Partial<BackgroundTask>): BackgroundTask {
  return {
    id: 't123',
    command: 'npm test',
    status: 'completed',
    startedAt: '2026-07-23T00:00:00.000Z',
    output: '',
    ...over,
  };
}

describe('formatSettleNotification XML 信封', () => {
  it('信封结构：id/category/type/source_kind/source_id 属性齐全', () => {
    const text = formatSettleNotification(makeTask({}));
    const open = text.split('\n')[0]!;
    expect(open).toContain('<notification id="task:t123:completed"');
    expect(open).toContain('category="task"');
    expect(open).toContain('type="task.completed"');
    expect(open).toContain('source_kind="background_task"');
    expect(open).toContain('source_id="t123"');
    expect(text.trimEnd().endsWith('</notification>')).toBe(true);
  });

  it('正文：状态 + 命令 + 无需轮询声明；完成带退出码', () => {
    const text = formatSettleNotification(makeTask({ exitCode: 0 }));
    expect(text).toContain('状态：已完成（退出码 0）');
    expect(text).toContain('命令：npm test');
    expect(text).toContain('无需用 task_list 轮询');
  });

  it('失败带退出码；被终止与失联各有专属文案', () => {
    expect(formatSettleNotification(makeTask({ status: 'failed', exitCode: 2 }))).toContain('状态：失败（退出码 2）');
    expect(formatSettleNotification(makeTask({ status: 'killed' }))).toContain('已被终止');
    const lost: LostTask = { ...makeTask({}), status: 'lost' };
    const text = formatSettleNotification(lost);
    expect(text).toContain('type="task.lost"');
    expect(text).toContain('已失联');
  });

  it('落盘任务给 <output-file> 指针（路径 + 字节数），不内嵌输出', () => {
    const text = formatSettleNotification(
      makeTask({ outputPath: '/tmp/x/tasks/t123/output.log', outputBytes: 12345, output: 'tail…' }),
    );
    expect(text).toContain('<output-file path="/tmp/x/tasks/t123/output.log" bytes="12345">');
    expect(text).toContain('task_output');
    expect(text).not.toContain('tail…');
  });

  it('未落盘任务退化为尾部兜底预览；无输出标注（无输出）', () => {
    const out = `head-${'x'.repeat(3000)}-tail`;
    const text = formatSettleNotification(makeTask({ output: out }));
    expect(text).toContain('-tail');
    expect(text).not.toContain('head-');
    expect(formatSettleNotification(makeTask({ output: '' }))).toContain('（无输出）');
  });

  it('命令里的 XML 特殊字符被转义，不破坏信封结构', () => {
    const text = formatSettleNotification(makeTask({ command: 'echo "<a&b>"' }));
    expect(text).toContain('命令：echo &quot;&lt;a&amp;b&gt;&quot;');
    expect(text.trimEnd().endsWith('</notification>')).toBe(true);
  });

  it('agent_id 仅在有来源 agent 时输出', () => {
    expect(formatSettleNotification(makeTask({}))).not.toContain('agent_id=');
    expect(formatSettleNotification(makeTask({ agentId: 'agent-9' }))).toContain('agent_id="agent-9"');
  });
});

describe('buildSettleMessage 结构化 origin', () => {
  it('origin 落 background_task 判别对象，携带 taskId/notificationId/startsPromptTurn', () => {
    const msg = buildSettleMessage(makeTask({}), { startsPromptTurn: true });
    expect(msg.message.role).toBe('user');
    expect(typeof msg.message.content).toBe('string');
    expect(msg.origin).toEqual({
      kind: 'background_task',
      taskId: 't123',
      notificationId: 'task:t123:completed',
      agentId: undefined,
      startsPromptTurn: true,
    });
  });

  it('notificationIdFor 幂等：同任务同终态恒定，异终态不同', () => {
    expect(notificationIdFor(makeTask({}))).toBe('task:t123:completed');
    expect(notificationIdFor(makeTask({}))).toBe(notificationIdFor(makeTask({})));
    expect(notificationIdFor(makeTask({ status: 'failed' }))).not.toBe(notificationIdFor(makeTask({})));
  });
});

describe('decideNotifyRoute', () => {
  it('busy 时入队（留给回合边界 flush），空闲时直接提交', () => {
    expect(decideNotifyRoute(true)).toBe('enqueue');
    expect(decideNotifyRoute(false)).toBe('submit');
  });
});

describe('mergeSettleMessages 批量合成', () => {
  function makeMsg(id: string, status: 'completed' | 'failed' | 'killed' = 'completed'): ReturnType<typeof buildSettleMessage> {
    return buildSettleMessage({
      id,
      command: `cmd-${id}`,
      status,
      startedAt: '2026-08-29T00:00:00.000Z',
      output: '',
    } as BackgroundTask);
  }

  it('单条原样返回：不套 batch 信封', () => {
    const one = makeMsg('a1');
    const merged = mergeSettleMessages([one]);
    expect(merged).toBe(one);
  });

  it('多条合成一条：batch 信封 + 全部正文都在', () => {
    const merged = mergeSettleMessages([makeMsg('a1'), makeMsg('b2', 'failed'), makeMsg('c3', 'killed')]);
    const content = typeof merged.message.content === 'string' ? merged.message.content : '';
    expect(content.split('\n')[0]).toContain('<notification-batch count="3"');
    expect(content).toContain('task_count="3"');
    expect(content).toContain('cmd-a1');
    expect(content).toContain('cmd-b2');
    expect(content).toContain('cmd-c3');
    expect(content.trimEnd().endsWith('</notification-batch>')).toBe(true);
    // 三条信封都在（可被解析出各自的 id）
    expect(content).toContain('source_id="a1"');
    expect(content).toContain('source_id="b2"');
    expect(content).toContain('source_id="c3"');
  });

  it('多条时 origin 的 taskId/notificationId 留空（逐条身份靠 delivered 事件）', () => {
    const merged = mergeSettleMessages([makeMsg('a1'), makeMsg('b2')]);
    expect(merged.origin.kind).toBe('background_task');
    expect(merged.origin.taskId).toBeUndefined();
    expect(merged.origin.notificationId).toBeUndefined();
    expect(merged.origin.startsPromptTurn).toBe(true);
  });

  it('空列表抛错（调用方不应传空）', () => {
    expect(() => mergeSettleMessages([])).toThrow();
  });
});

describe('pendingBatchDeliveredEvents 批量 delivered 事件', () => {
  function makeMsg(id: string): ReturnType<typeof buildSettleMessage> {
    return buildSettleMessage({
      id,
      command: `cmd-${id}`,
      status: 'completed',
      startedAt: '2026-08-29T00:00:00.000Z',
      output: '',
    } as BackgroundTask);
  }

  it('逐条列出全部待落盘事件', () => {
    const events = pendingBatchDeliveredEvents([makeMsg('a1'), makeMsg('b2')], new Set());
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({ taskId: 'a1', status: 'completed', notificationId: 'task:a1:completed' });
    expect(events[1]).toMatchObject({ taskId: 'b2', status: 'completed', notificationId: 'task:b2:completed' });
    // 键形态是 taskId+status+notificationId 拼接（见 wirelog.notifyDedupKey），
    // 与 delivered 事件算出的键同构，对账时才能互相去重。
    expect(notifyDedupKeyFromOrigin('a1', events[0]!.notificationId)).toBe('a1completedtask:a1:completed');
  });

  it('已写过的键跳过（幂等）', () => {
    const events = pendingBatchDeliveredEvents(
      [makeMsg('a1'), makeMsg('b2')],
      new Set([notifyDedupKeyFromOrigin('a1', 'task:a1:completed')]),
    );
    expect(events).toHaveLength(1);
    expect(events[0]!.taskId).toBe('b2');
  });

  it('全部已写则返回空（resume 反复对账不会重复落盘）', () => {
    const events = pendingBatchDeliveredEvents(
      [makeMsg('a1')],
      new Set([notifyDedupKeyFromOrigin('a1', 'task:a1:completed')]),
    );
    expect(events).toEqual([]);
  });
});
