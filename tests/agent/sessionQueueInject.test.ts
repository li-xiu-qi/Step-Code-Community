import { describe, expect, it } from 'vitest';
import { buildQueueInjection } from '../../src/agent/sessionQueue/inject.js';

const contentOf = (m: { message: { content: unknown } }): string =>
  typeof m.message.content === 'string' ? m.message.content : '';

describe('buildQueueInjection：跨会话消息的注入装配', () => {
  it('origin 带结构化 fromSession，正文带来源前缀', () => {
    const m = buildQueueInjection({ from: 'session-aaa-1111', text: '去调研剪贴板产品' });
    expect(m.origin).toEqual({ kind: 'injection', fromSession: 'session-aaa-1111' });
    const content = contentOf(m);
    expect(content).toContain('[跨会话消息 · 来自会话 session-aaa-1111]');
    expect(content).toContain('去调研剪贴板产品');
  });

  it('来源判定不依赖正文前缀：origin.fromSession 与正文中的 id 一致', () => {
    const m = buildQueueInjection({ from: 'session-bbb-2222', text: 'x' });
    expect(m.origin.fromSession).toBe('session-bbb-2222');
    expect(contentOf(m)).toContain(m.origin.fromSession!);
  });

  it('注入不计轮次：kind 为 injection 而非 user', () => {
    const m = buildQueueInjection({ from: 's-1', text: 'x' });
    expect(m.origin.kind).toBe('injection');
  });
});
