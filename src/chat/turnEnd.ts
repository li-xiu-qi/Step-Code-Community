/**
 * 回合收尾决策（纯函数）：submit 回合结束与 /compact 收尾统一走这里。
 *
 * 背景（三条已定罪缺陷）：
 * 1. 旧实现把 continuation（goal 续接 / Stop hook 续行）排在队列排空之前，
 *    continuation 高发场景（goal/全自动）下队列无限饥饿——用户排队消息永远轮不到。
 * 2. 手动 /compact 收尾只 setBusy(false)，剩余队列消息滞留。
 * 3. finally 先 queue.shift() 再 submit，若有 pending 审批/提问/计划弹层，
 *    submit 的守卫静默 return——消息已出队未发出，直接丢失。
 *
 * 优先级：队列优先于续接。
 * queue 与 continuation 同存时分两轮：本轮先发队首，续接由调用方保留到
 * 队列消息回合的收尾再派发。pending 弹层存在时不 shift 不丢弃，消息留队，
 * 等弹层关闭后的下一收尾点。
 *
 * **双队列与通知批量（2026-08-29）**：用户输入与系统注入（后台任务通知）拆成两个队列，
 * 因为两者优先级不同——用户每发一条是一次显式授权，必须逐条按序发出，合并会打乱语义与
 * 权限节奏；通知是系统单方面的事实陈述，一次看完全部模型才能判断准。混在一个队列时
 * 通知会挤占槽位（用户第 2 条要等 N 条通知走完），且 Esc 取回队尾会取到通知。
 *
 * 通知走批量：notifyQueue 非空时一次性全部提交，避免 N 条通知 = N 次模型调用
 * （旧实现实测：3 天会话 resume 后补投 98 条，队列滚雪球且每个回合都要起一次模型调用）。
 *
 * 纯函数，不做副作用——shift 写回、steer 拼装、submit 派发都留给调用方（App 的薄壳）。
 */

export interface TurnEndInput {
  /** 本轮 run 给出的续接文本（goal 续接或 Stop hook 兜底的原始 inject），null 表示无续接 */
  continuation: string | null;
  /**
   * goal 是否 active。当前不改变派发动作（goal 续接与 Stop hook 兜底同优先级），
   * goal 身份只影响调用方的 steer 拼装；保留在契约中供调用方与测试表达场景。
   */
  goalActive: boolean;
  /** 用户输入队列（FIFO，队首为下一条待发）；本函数不修改它 */
  queue: readonly string[];
  /** 系统注入队列（后台任务通知等，批量投递）；本函数不修改它 */
  notifyQueue: readonly string[];
  /** 是否有 pending 审批/提问/计划弹层（此时 submit 会被守卫拦截，不得 shift） */
  hasPendingPrompt: boolean;
}

export interface TurnEndPlan {
  action: 'submit-queue' | 'submit-notify' | 'submit-continuation' | 'idle';
  /** 待提交文本：submit-queue 时为队首用户消息，submit-continuation 时为 continuation，其余为无 */
  text?: string;
  /** 派发后的用户队列余量；未派发（idle / submit-notify / submit-continuation）时与输入 queue 内容一致 */
  queueRemainder: string[];
  /**
   * submit-notify 时一次性全部取走的通知正文；其余 action 为空数组。
   * 调用方据此从 notifyPrepared 取回原消息（带幂等键），合成一条提交给模型。
   */
  notifyBatch: string[];
}

export function planTurnEnd(input: TurnEndInput): TurnEndPlan {
  const { continuation, queue, notifyQueue, hasPendingPrompt } = input;
  // pending 弹层期间不 shift 不派发：消息留队（修复 shift 后被 submit 守卫静默吞掉）
  if (hasPendingPrompt) {
    return { action: 'idle', queueRemainder: [...queue], notifyBatch: [] };
  }
  // 用户队列优先：真人输入是显式授权，逐条按序发出，且不能被通知挤占
  if (queue.length > 0) {
    return { action: 'submit-queue', text: queue[0], queueRemainder: queue.slice(1), notifyBatch: [] };
  }
  // 用户队列空才批量投通知：一次看完全部终态，模型才能判断该 task_output 读哪个
  if (notifyQueue.length > 0) {
    return { action: 'submit-notify', queueRemainder: [], notifyBatch: [...notifyQueue] };
  }
  // 队列空才续接：goal 续接与 Stop hook 兜底派发动作一致
  if (continuation !== null) {
    return { action: 'submit-continuation', text: continuation, queueRemainder: [], notifyBatch: [] };
  }
  return { action: 'idle', queueRemainder: [...queue], notifyBatch: [] };
}
