import { describe, expect, it } from 'vitest';
import {
  stored,
  type MessageOrigin,
} from '../../src/agent/message.js';

describe('stored 的 origin 落形', () => {
  it('origin 一律为对象形态', () => {
    const m = stored({ role: 'assistant', content: 'a' }, { kind: 'assistant' });
    expect(m.origin).toEqual({ kind: 'assistant' });
  });

  it('传对象时保留全部载荷字段', () => {
    const origin: MessageOrigin = {
      kind: 'background_task',
      taskId: 'task-1',
      notificationId: 'n-1',
      agentId: 'agent-1',
      startsPromptTurn: false,
    };
    const m = stored({ role: 'user', content: 'done' }, origin);
    expect(m.origin).toEqual(origin);
  });

  it('startsPromptTurn 缺省即「中途注入」语义，不强制填写', () => {
    const m = stored({ role: 'user', content: 'x' }, { kind: 'injection' });
    expect(m.origin.startsPromptTurn).toBeUndefined();
  });
});

describe('fromSession：跨会话投递的来源标记', () => {
  it('载荷保留：注入时带 fromSession 能原样落进 origin', () => {
    const m = stored({ role: 'user', content: 'x' }, { kind: 'injection', fromSession: 'session-aaa' });
    expect(m.origin.fromSession).toBe('session-aaa');
  });

  it('旧路径兼容：不填时 fromSession 为 undefined，同条 origin 的其它载荷不受影响', () => {
    const m = stored({ role: 'user', content: 'x' }, { kind: 'injection', agentId: 'a-1' });
    expect(m.origin.fromSession).toBeUndefined();
    expect(m.origin.agentId).toBe('a-1');
  });
});
