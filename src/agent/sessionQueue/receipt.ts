/**
 * 跨会话消息的消费与回执。
 *
 * 为什么单独抽出来：这段逻辑原本内联在 PiChat 的 run 启动路径里，只能驱动整个 PiChat
 * 才能测到。实测把「回执不再产生回执」的判断改成 `if (true)`（制造无限递归），
 * 当时全部测试仍绿——变异测试测不到就等于没测。抽出为纯函数后可直接断言。
 *
 * 需求来源：`session_send` 只回报「已投递」，对方是否真读到完全不知，跨会话交接常断在
 * 这里。接收侧本来已自动（目标会话每次 run 启动即 drain 注入历史，不等模型主动查 inbox），
 * 缺口在发送侧无从知晓。故消费时向投递方回执。
 *
 * 回执的最大风险是递归：A→B 被消费后回执给 A，A 消费回执时若再回执给 B 就无限循环。
 * 因此回执消息可识别（kind='receipt'），且消费方收到回执时不再生成回执。
 */

/** 收件箱条目的最小形态（与 SessionQueueMessage 对应字段）。 */
export interface QueueMessageLike {
  id: string;
  /** 投递方会话 id（回执的去向）。 */
  from: string;
  text: string;
  kind?: 'message' | 'receipt';
}

/** 回执装配所需的依赖（由 PiChat 注入 store，测试注入假实现）。 */
export interface ReceiptSink {
  enqueue(to: string, from: string, text: string, kind: 'message' | 'receipt'): string;
}

/**
 * 消费一批跨会话消息，为其中的普通指令各生成一张回执。
 *
 * @param self 本会话 id（回执的发送方）
 * @param messages 已 drain 出的消息
 * @param sink 回执投递通道
 * @returns 每条被消费消息的回执 id；回执类消息返回空串（不再产生回执）
 */
export function sendReadReceipts(
  self: string,
  messages: readonly QueueMessageLike[],
  sink: ReceiptSink,
): Array<{ messageId: string; receiptId: string; to: string }> {
  const out: Array<{ messageId: string; receiptId: string; to: string }> = [];
  for (const m of messages) {
    // 回执不再产生回执：否则 A→B→A→B 无限递归。回执的语义是「告知」，不需要对方确认已告知。
    if (m.kind === 'receipt') continue;
    const preview = m.text.length > 120 ? `${m.text.slice(0, 120)}…` : m.text;
    const receiptId = sink.enqueue(
      m.from,
      self,
      `[已收到] 你投递给会话 ${self.slice(0, 8)} 的消息已被读取：\n${preview}`,
      'receipt',
    );
    out.push({ messageId: m.id, receiptId, to: m.from });
  }
  return out;
}
