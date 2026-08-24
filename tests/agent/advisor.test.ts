/**
 * Advisor reviewer 单元测试。
 *
 * 覆盖：
 * - resolveAdvisorConfig：配置解析（默认关闭、显式启用、model 裁剪）
 * - EmissionGuard：三重过滤（空内容、空洞短语、去重）
 * - runAdvisorReview：端到端（短 transcript 跳过、SILENT 跳过、出错不阻塞、有效建议通过）
 */

import { describe, expect, it } from 'vitest';
import type { StoredMessage } from '../../src/agent/message.js';
import { stored } from '../../src/agent/message.js';
import type { ToolContext } from '../../src/tools/types.js';
import { runAdvisorReview } from '../../src/agent/advisor/advisor.js';
import { EmissionGuard } from '../../src/agent/advisor/guard.js';
import { resolveAdvisorConfig } from '../../src/agent/advisor/config.js';
import { makeFakeProvider, textBlock } from '../helpers/fakeProvider.js';

// ---------------------------------------------------------------------------
// resolveAdvisorConfig
// ---------------------------------------------------------------------------

describe('resolveAdvisorConfig', () => {
  it('非对象 → undefined', () => {
    expect(resolveAdvisorConfig(undefined)).toBeUndefined();
    expect(resolveAdvisorConfig(null)).toBeUndefined();
    expect(resolveAdvisorConfig('string')).toBeUndefined();
    expect(resolveAdvisorConfig(42)).toBeUndefined();
  });

  it('enabled 不为 true → undefined（默认关闭）', () => {
    expect(resolveAdvisorConfig({})).toBeUndefined();
    expect(resolveAdvisorConfig({ enabled: false })).toBeUndefined();
    expect(resolveAdvisorConfig({ enabled: 'yes' })).toBeUndefined();
  });

  it('enabled = true，无 model → 返回配置，model undefined', () => {
    const cfg = resolveAdvisorConfig({ enabled: true });
    expect(cfg).toEqual({ enabled: true, model: undefined });
  });

  it('enabled = true + model → 返回配置，model 修剪空白', () => {
    const cfg = resolveAdvisorConfig({ enabled: true, model: '  step-3.7-flash  ' });
    expect(cfg).toEqual({ enabled: true, model: 'step-3.7-flash' });
  });

  it('model 为空字符串 → model 视为 undefined', () => {
    const cfg = resolveAdvisorConfig({ enabled: true, model: '   ' });
    expect(cfg).toEqual({ enabled: true, model: undefined });
  });
});

// ---------------------------------------------------------------------------
// EmissionGuard
// ---------------------------------------------------------------------------

describe('EmissionGuard', () => {
  it('短内容（< 10 字）被拦截', () => {
    const guard = new EmissionGuard();
    expect(guard.emit('太短')).toBeNull();
    expect(guard.emit('123456789')).toBeNull(); // 9 字符
  });

  it('恰好 10 字符且非空洞 → 通过', () => {
    const guard = new EmissionGuard();
    expect(guard.emit('1234567890')).toBe('1234567890');
  });

  it('空洞短语被拦截（短文本）', () => {
    const guard = new EmissionGuard();
    expect(guard.emit('看起来不错')).toBeNull();
    expect(guard.emit('lgtm')).toBeNull();
    expect(guard.emit('no issues here')).toBeNull();
  });

  it('空洞短语但文本较长 → 不拦截（可能是嵌入在实质建议中）', () => {
    const guard = new EmissionGuard();
    const long = '看起来不错，但是第 15 行有个空指针风险，需要加 null check';
    expect(guard.emit(long)).toBe(long);
  });

  it('重复建议被拦截（去重）', () => {
    const guard = new EmissionGuard();
    const note = '第 42 行存在 SQL 注入风险，参数未转义';
    expect(guard.emit(note)).toBe(note);
    expect(guard.emit(note)).toBeNull(); // 完全相同的第二次 → 拦截
  });

  it('不同建议不互相影响', () => {
    const guard = new EmissionGuard();
    const a = '第 10 行有个竞态条件';
    const b = '第 20 行缺少错误处理';
    expect(guard.emit(a)).toBe(a);
    expect(guard.emit(b)).toBe(b);
  });

  it('maxRecent 限制：超出窗口后重复可再次通过', () => {
    const guard = new EmissionGuard(2); // 只记最近 2 条
    const a = '建议一：修复空指针异常，需加防御判断';
    const b = '建议二：处理数组越界，加长度检查';
    const c = '建议三：补充关键路径的错误日志输出';
    expect(guard.emit(a)).toBe(a);
    expect(guard.emit(b)).toBe(b);
    // 现在窗口是 [a, b]，a 还在 → 重复 a 仍拦截
    expect(guard.emit(a)).toBeNull();
    // 推入 c，窗口变成 [b, c]，a 被挤出 → 重复 a 可通过
    expect(guard.emit(c)).toBe(c);
    expect(guard.emit(a)).toBe(a);
  });
});

// ---------------------------------------------------------------------------
// runAdvisorReview
// ---------------------------------------------------------------------------

/** 造一条足够长的 StoredMessage，确保 transcript 超过 50 字符阈值。 */
function longMsg(role: 'user' | 'assistant', text: string): StoredMessage {
  const origin = role === 'user' ? 'user' : 'assistant';
  return stored({ role, content: text }, origin);
}

const LONG_TRANSCRIPT =
  'I just refactored the auth module to use JWT instead of session tokens. ' +
  'The middleware now validates the token signature and extracts claims. ' +
  'But I noticed the refresh endpoint doesn\'t rotate the token properly.';

function makeCtx(): ToolContext {
  return { cwd: '/tmp/test' };
}

describe('runAdvisorReview', () => {
  it('transcript 过短（< 50 字符）→ 返回 null，不调用 provider', async () => {
    const { provider, streamCalls } = makeFakeProvider([]);
    const guard = new EmissionGuard();
    const messages = [longMsg('assistant', 'hi')]; // 只有 2 字符
    const result = await runAdvisorReview(messages, provider, { enabled: true }, makeCtx(), undefined, guard);
    expect(result).toBeNull();
    expect(streamCalls()).toBe(0);
  });

  it('provider 抛出异常 → 返回 null，不阻塞主循环', async () => {
    const { provider } = makeFakeProvider([{ throw: new Error('API timeout') }]);
    const guard = new EmissionGuard();
    const messages = [longMsg('assistant', LONG_TRANSCRIPT)];
    const result = await runAdvisorReview(messages, provider, { enabled: true }, makeCtx(), undefined, guard);
    expect(result).toBeNull();
  });

  it('回复 SILENT → 返回 null', async () => {
    const { provider } = makeFakeProvider([{ textChunks: ['SILENT'], finalContent: [textBlock('SILENT')] }]);
    const guard = new EmissionGuard();
    const messages = [longMsg('assistant', LONG_TRANSCRIPT)];
    const result = await runAdvisorReview(messages, provider, { enabled: true }, makeCtx(), undefined, guard);
    expect(result).toBeNull();
  });

  it('回复 "null" 字符串 → 返回 null', async () => {
    const { provider } = makeFakeProvider([{ textChunks: ['null'], finalContent: [textBlock('null')] }]);
    const guard = new EmissionGuard();
    const messages = [longMsg('assistant', LONG_TRANSCRIPT)];
    const result = await runAdvisorReview(messages, provider, { enabled: true }, makeCtx(), undefined, guard);
    expect(result).toBeNull();
  });

  it('回复空字符串 → 返回 null', async () => {
    const { provider } = makeFakeProvider([{ textChunks: ['  '], finalContent: [textBlock('  ')] }]);
    const guard = new EmissionGuard();
    const messages = [longMsg('assistant', LONG_TRANSCRIPT)];
    const result = await runAdvisorReview(messages, provider, { enabled: true }, makeCtx(), undefined, guard);
    expect(result).toBeNull();
  });

  it('有效建议通过 EmissionGuard → 返回 note', async () => {
    const advice = 'The refresh endpoint does not rotate the JWT token, which could lead to token reuse attacks.';
    const { provider } = makeFakeProvider([{ textChunks: [advice], finalContent: [textBlock(advice)] }]);
    const guard = new EmissionGuard();
    const messages = [longMsg('assistant', LONG_TRANSCRIPT)];
    const result = await runAdvisorReview(messages, provider, { enabled: true }, makeCtx(), undefined, guard);
    expect(result).not.toBeNull();
    expect(result!.note).toBe(advice);
  });

  it('建议被 EmissionGuard 拦截（太短）→ 返回 null', async () => {
    const { provider } = makeFakeProvider([{ textChunks: ['OK'], finalContent: [textBlock('OK')] }]);
    const guard = new EmissionGuard();
    const messages = [longMsg('assistant', LONG_TRANSCRIPT)];
    const result = await runAdvisorReview(messages, provider, { enabled: true }, makeCtx(), undefined, guard);
    expect(result).toBeNull();
  });

  it('transcript 为空消息列表 → 返回 null', async () => {
    const { provider } = makeFakeProvider([]);
    const guard = new EmissionGuard();
    const result = await runAdvisorReview([], provider, { enabled: true }, makeCtx(), undefined, guard);
    expect(result).toBeNull();
  });

  it('config.model 传递给 provider', async () => {
    const advice = 'Found a potential security issue with the token rotation logic in the refresh handler.';
    const { provider, streamParams } = makeFakeProvider([{ textChunks: [advice], finalContent: [textBlock(advice)] }]);
    const guard = new EmissionGuard();
    const messages = [longMsg('assistant', LONG_TRANSCRIPT)];
    await runAdvisorReview(messages, provider, { enabled: true, model: 'test-model' }, makeCtx(), undefined, guard);
    const params = streamParams();
    expect(params[0]!.model).toBe('test-model');
  });

  it('提取最近 4 条消息的 transcript', async () => {
    const advice = 'The database connection pool is not being closed after error handling, which could exhaust connections.';
    const { provider, streamParams } = makeFakeProvider([{ textChunks: [advice], finalContent: [textBlock(advice)] }]);
    const guard = new EmissionGuard();
    // 7 条消息：advisor 应只取最后 4 条
    const messages = [
      longMsg('user', '旧消息 1 - 应该被忽略'),
      longMsg('assistant', '旧消息 2 - 应该被忽略'),
      longMsg('user', '旧消息 3 - 应该被忽略'),
      longMsg('assistant', LONG_TRANSCRIPT),
      longMsg('user', '最新问题：这个修复是否正确？'),
      longMsg('assistant', '我改了一下错误处理逻辑'),
      longMsg('user', '谢谢，看起来不错'),
    ];
    const result = await runAdvisorReview(messages, provider, { enabled: true }, makeCtx(), undefined, guard);
    expect(result).not.toBeNull();
    // 验证 transcript 不含最早的 3 条消息
    const params = streamParams();
    const messagesJson = JSON.stringify(params[0]!.messages);
    expect(messagesJson).not.toContain('旧消息 1');
    expect(messagesJson).not.toContain('旧消息 3');
  });
});
