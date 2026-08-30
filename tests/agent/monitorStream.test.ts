import { describe, it, expect } from 'vitest';
import { formatStreamNotification, buildStreamMessage, shouldDeliverStream } from '../../src/agent/background/monitorStream.js';
import { enqueueStreamEvent, type StreamEvent } from '../../src/agent/background/manager.js';

describe('shouldDeliverStream', () => {
  it('常规心跳不投', () => {
    expect(shouldDeliverStream('INFO: heartbeat ok')).toBe(false);
    expect(shouldDeliverStream('progress 42%')).toBe(false);
    expect(shouldDeliverStream('build started\nbuild finished')).toBe(false);
  });

  it('显式告警词投（大小写不敏感）', () => {
    expect(shouldDeliverStream('ERROR: connection refused')).toBe(true);
    expect(shouldDeliverStream('error: connection refused')).toBe(true);
    expect(shouldDeliverStream('WARN: disk usage 95%')).toBe(true);
    expect(shouldDeliverStream('test FAILED in 1.2s')).toBe(true);
    expect(shouldDeliverStream('CRITICAL: shard down')).toBe(true);
  });

  it('中文告警词投', () => {
    expect(shouldDeliverStream('构建异常：模块未找到')).toBe(true);
    expect(shouldDeliverStream('任务失败，退出码 1')).toBe(true);
    expect(shouldDeliverStream('配置文件错误：缺 timeout 字段')).toBe(true);
  });

  it('告警词出现在批内任意一行都算', () => {
    expect(shouldDeliverStream('line one\nline two\nERROR: bad\nline four')).toBe(true);
  });

  it('不误伤含子串的普通词', () => {
    // "failed" 是词边界匹配，"unfailing"、"failedAttempts" 之类不含独立告警词的不该命中
    expect(shouldDeliverStream('the terracotta warriors are unfailing')).toBe(false);
  });
});

describe('enqueueStreamEvent：队列字符预算', () => {
  const ev = (body: string, taskId = 't'): StreamEvent => ({ taskId, body, description: 'd' });

  it('预算内不丢任何一批', () => {
    const q: StreamEvent[] = [];
    for (let i = 0; i < 5; i++) enqueueStreamEvent(q, ev('x'.repeat(100)), 10000);
    expect(q).toHaveLength(5);
  });

  it('超预算时丢最旧的一批，保留最近的', () => {
    const q: StreamEvent[] = [];
    for (let i = 0; i < 10; i++) enqueueStreamEvent(q, ev(`batch-${i}`), 25);
    // 每批 8 字符，预算 25 → 最多留 3 批（24 字符），第 4 批（32 字符）会挤掉最旧的
    expect(q.length).toBeLessThanOrEqual(3);
    expect(q[q.length - 1]!.body).toBe('batch-9');
    expect(q[0]!.body).not.toBe('batch-0');
  });

  it('单批超过预算也至少保留一批（不丢光）', () => {
    const q: StreamEvent[] = [];
    enqueueStreamEvent(q, ev('x'.repeat(99999)), 100);
    expect(q).toHaveLength(1);
  });

  it('按字符而非批次数守预算', () => {
    // 10 批 × 100 字符 = 1000 字符，预算 500 → 应丢到 5 批以内
    const q: StreamEvent[] = [];
    for (let i = 0; i < 10; i++) enqueueStreamEvent(q, ev('x'.repeat(100)), 500);
    expect(q.length).toBeLessThanOrEqual(5);
  });
});

describe('formatStreamNotification', () => {
  it('type 为 monitor_stream，与终态通知可区分', () => {
    const body = formatStreamNotification('task-abc', 'ERROR: boom', 'build watcher');
    expect(body).toContain('type="task.monitor_stream"');
    expect(body).toContain('source_id="task-abc"');
    expect(body).toContain('<event>ERROR: boom</event>');
    expect(body).toContain('描述：build watcher');
  });

  it('XML 转义自由文本', () => {
    const body = formatStreamNotification('t', '<script>&"</script>', 'd');
    expect(body).not.toContain('<script>');
    expect(body).toContain('&lt;script&gt;');
    expect(body).toContain('&amp;');
    expect(body).toContain('&quot;');
  });
});

describe('buildStreamMessage', () => {
  it('origin 为 monitor_stream，携带 taskId 与 notificationId', () => {
    const msg = buildStreamMessage('t-1', 'body', 'desc');
    expect(msg.origin.kind).toBe('monitor_stream');
    expect(msg.origin.taskId).toBe('t-1');
    expect(msg.origin.notificationId).toBe('task:t-1:monitor_stream');
    // 默认中途注入，不单独开轮
    expect(msg.origin.startsPromptTurn).toBeUndefined();
  });

  it('startsPromptTurn 可显式指定', () => {
    const msg = buildStreamMessage('t-1', 'b', 'd', { startsPromptTurn: true });
    expect(msg.origin.startsPromptTurn).toBe(true);
  });

  it('正文挂在 user 角色下（协议约定），但被判定为系统自撰', () => {
    const msg = buildStreamMessage('t-1', 'b', 'd');
    expect(msg.message.role).toBe('user');
    // 新 kind 默认落进「系统自撰」侧，不会渲染成用户气泡
    expect(msg.origin.kind).not.toBe('user');
  });

  it('有 id 与 ts', () => {
    const msg = buildStreamMessage('t-1', 'b', 'd');
    expect(msg.id).toBeTruthy();
    expect(msg.ts).toBeTruthy();
  });
});
