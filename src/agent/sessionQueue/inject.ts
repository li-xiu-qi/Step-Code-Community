import { stored, type StoredMessage } from '../message.js';

/**
 * 把一条跨会话投递的消息装配为注入历史的消息。
 *
 * 两个出口分开满足：正文带来源前缀（`[跨会话消息 · 来自会话 X]`，给模型读），
 * origin 带结构化 `fromSession`（给代码做来源判定、UI 渲染、回放审计）。判定来源
 * 以 origin 字段为准，不解析正文前缀。
 *
 * 抽成共用函数的动机：agent run 与 TUI 两处消费点各自内联构造时，「漏挂
 * fromSession」没有测试能拦住——内联两行既不可单测，也看不出少了什么。共用本函数后，
 * 注入形态的回归由 tests/agent/sessionQueueInject.test.ts 一条断言钉住。
 */
export function buildQueueInjection(m: { from: string; text: string }): StoredMessage {
  return stored(
    { role: 'user', content: `[跨会话消息 · 来自会话 ${m.from}]\n${m.text}` },
    { kind: 'injection', fromSession: m.from },
  );
}
