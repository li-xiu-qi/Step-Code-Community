import { describe, expect, it } from 'vitest';
import { planTurnEnd } from '../../src/chat/turnEnd.js';

/** 默认输入：未指定的字段按「无续接、无弹层」构造，各用例只覆盖关心的字段。 */
function input(over: {
  continuation?: string | null;
  goalActive?: boolean;
  queue?: readonly string[];
  notifyQueue?: readonly string[];
  hasPendingPrompt?: boolean;
}) {
  return {
    continuation: over.continuation ?? null,
    goalActive: over.goalActive ?? false,
    queue: over.queue ?? [],
    notifyQueue: over.notifyQueue ?? [],
    hasPendingPrompt: over.hasPendingPrompt ?? false,
  };
}

describe('planTurnEnd 回合收尾决策', () => {
  it('队列优先于 goal 续接：queue 非空时先 submit-queue', () => {
    const plan = planTurnEnd(input({
      continuation: '继续推进目标',
      goalActive: true,
      queue: ['第一条', '第二条'],
    }));
    expect(plan.action).toBe('submit-queue');
    expect(plan.text).toBe('第一条');
    expect(plan.queueRemainder).toEqual(['第二条']);
  });

  it('队列优先于 Stop hook 续行（无 active goal 同样让位）', () => {
    const plan = planTurnEnd(input({ continuation: 'hook 要求继续', queue: ['排队消息'] }));
    expect(plan.action).toBe('submit-queue');
    expect(plan.text).toBe('排队消息');
    expect(plan.queueRemainder).toEqual([]);
  });

  it('queue 空时 goal 续接正常派发（submit-continuation）', () => {
    const plan = planTurnEnd(input({ continuation: '继续推进目标', goalActive: true }));
    expect(plan.action).toBe('submit-continuation');
    expect(plan.text).toBe('继续推进目标');
    expect(plan.queueRemainder).toEqual([]);
  });

  it('queue 空时 Stop hook 兜底续行正常派发', () => {
    const plan = planTurnEnd(input({ continuation: 'hook 要求继续' }));
    expect(plan.action).toBe('submit-continuation');
    expect(plan.text).toBe('hook 要求继续');
  });

  it('pending 弹层时不 shift 不丢弃：队列原样留队，action 为 idle', () => {
    const plan = planTurnEnd(input({ queue: ['消息A', '消息B'], hasPendingPrompt: true }));
    expect(plan.action).toBe('idle');
    expect(plan.text).toBeUndefined();
    expect(plan.queueRemainder).toEqual(['消息A', '消息B']);
    expect(plan.notifyBatch).toEqual([]);
  });

  it('pending 弹层时 continuation 也不派发（等弹层关闭后的下一收尾点）', () => {
    const plan = planTurnEnd(input({ continuation: '继续推进目标', goalActive: true, queue: ['消息A'], hasPendingPrompt: true }));
    expect(plan.action).toBe('idle');
    expect(plan.queueRemainder).toEqual(['消息A']);
  });

  it('queue 与 continuation 同存时分两轮：先 queue 后 continuation', () => {
    // 第一轮：queue 优先
    const round1 = planTurnEnd(input({ continuation: '继续推进目标', goalActive: true, queue: ['排队消息'] }));
    expect(round1.action).toBe('submit-queue');
    expect(round1.text).toBe('排队消息');
    // 第二轮：队列消息回合收尾，queue 已空，续接（由调用方保留）再派发
    const round2 = planTurnEnd(input({ continuation: '继续推进目标', goalActive: true, queue: round1.queueRemainder }));
    expect(round2.action).toBe('submit-continuation');
    expect(round2.text).toBe('继续推进目标');
  });

  it('多条队列逐条排空：每轮只发队首，余量正确', () => {
    const r1 = planTurnEnd(input({ queue: ['a', 'b', 'c'] }));
    expect(r1).toMatchObject({ action: 'submit-queue', text: 'a', queueRemainder: ['b', 'c'] });
    const r2 = planTurnEnd(input({ queue: r1.queueRemainder }));
    expect(r2).toMatchObject({ action: 'submit-queue', text: 'b', queueRemainder: ['c'] });
    const r3 = planTurnEnd(input({ queue: r2.queueRemainder }));
    expect(r3).toMatchObject({ action: 'submit-queue', text: 'c', queueRemainder: [] });
    const r4 = planTurnEnd(input({ queue: r3.queueRemainder }));
    expect(r4.action).toBe('idle');
  });

  it('/compact 收尾排空：无 continuation 时队列非空照样发下一条', () => {
    const plan = planTurnEnd(input({ queue: ['压缩后排队的消息'] }));
    expect(plan.action).toBe('submit-queue');
    expect(plan.text).toBe('压缩后排队的消息');
    expect(plan.queueRemainder).toEqual([]);
  });

  it('全空（无队列无续接无弹层）为 idle', () => {
    const plan = planTurnEnd(input({}));
    expect(plan.action).toBe('idle');
    expect(plan.text).toBeUndefined();
    expect(plan.queueRemainder).toEqual([]);
    expect(plan.notifyBatch).toEqual([]);
  });

  it('不修改输入 queue（纯函数）', () => {
    const queue = ['x', 'y'];
    planTurnEnd(input({ continuation: 'c', goalActive: true, queue }));
    expect(queue).toEqual(['x', 'y']);
  });

  // ─────────────────────────────────────────────────────────────────
  // 双队列与通知批量（2026-08-29）：用户输入与系统注入拆成两个队列。
  // 旧实现二者混在一个 queue 里，通知会挤占槽位（用户第 2 条要等 N 条通知走完），
  // 且 Esc 取回队尾会取到通知。批量投递解决 N 条通知 = N 次模型调用的问题。
  // ─────────────────────────────────────────────────────────────────

  it('notifyQueue 非空时批量投递：submit-notify，notifyBatch 含全部通知', () => {
    const plan = planTurnEnd(input({ notifyQueue: ['通知1', '通知2', '通知3'] }));
    expect(plan.action).toBe('submit-notify');
    expect(plan.text).toBeUndefined();
    expect(plan.queueRemainder).toEqual([]);
    expect(plan.notifyBatch).toEqual(['通知1', '通知2', '通知3']);
  });

  it('用户队列优先于通知：queue 非空时先发用户输入，通知留在队列', () => {
    const plan = planTurnEnd(input({
      queue: ['用户消息'],
      notifyQueue: ['通知1', '通知2'],
    }));
    expect(plan.action).toBe('submit-queue');
    expect(plan.text).toBe('用户消息');
    expect(plan.queueRemainder).toEqual([]);
    expect(plan.notifyBatch).toEqual([]);
  });

  it('用户队列与通知队列同存时，用户队列先排空，通知最后批量投', () => {
    // 第一轮：用户队列非空，发队首，通知不动
    const r1 = planTurnEnd(input({ queue: ['u1', 'u2'], notifyQueue: ['n1', 'n2'] }));
    expect(r1).toMatchObject({ action: 'submit-queue', text: 'u1', queueRemainder: ['u2'] });
    expect(r1.notifyBatch).toEqual([]);
    // 第二轮：用户队列还有一条，继续发
    const r2 = planTurnEnd(input({ queue: r1.queueRemainder, notifyQueue: ['n1', 'n2'] }));
    expect(r2).toMatchObject({ action: 'submit-queue', text: 'u2', queueRemainder: [] });
    // 第三轮：用户队列空了，通知一次性全部投出
    const r3 = planTurnEnd(input({ queue: r2.queueRemainder, notifyQueue: ['n1', 'n2'] }));
    expect(r3.action).toBe('submit-notify');
    expect(r3.notifyBatch).toEqual(['n1', 'n2']);
  });

  it('continuation 让位于通知：通知未投完前不发 goal 续接', () => {
    const plan = planTurnEnd(input({
      continuation: '继续推进目标',
      goalActive: true,
      notifyQueue: ['通知1'],
    }));
    expect(plan.action).toBe('submit-notify');
    expect(plan.text).toBeUndefined();
    expect(plan.notifyBatch).toEqual(['通知1']);
  });

  it('pending 弹层时不投通知：通知原样留队', () => {
    const plan = planTurnEnd(input({ notifyQueue: ['通知1', '通知2'], hasPendingPrompt: true }));
    expect(plan.action).toBe('idle');
    expect(plan.notifyBatch).toEqual([]);
  });

  // ─────────────────────────────────────────────────────────────────
  // submit() 的 fromQueue 语义契约（ behavioural contract ）：
  //
  // planTurnEnd 返回 submit-queue 后，调用方通过 submit(text, { fromQueue: true })
  // 告知 submit：这是队列自动发送，不得 setInput('')——用户可能正在输入框里编辑草稿。
  //
  // 对应修复：submit 非 busy 分支的 setInput('')  guarded by !opts?.fromQueue。
  // settleHandler 空闲路径同样传 fromQueue: true（系统合成注入，不清草稿）。
  //
  // 用户主动提交（Enter / busy 时入队）不走 fromQueue，setInput('') 正常执行。
  // cronFire / skillInject 走 silent 路径在 busy 分支 return，不进入非 busy 分支，
  // 因此不受 fromQueue 影响，行为不变。
  // ─────────────────────────────────────────────────────────────────
});
