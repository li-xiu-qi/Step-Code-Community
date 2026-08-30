import { stored, type StoredMessage } from '../message.js';

/** XML 转义：monitor 输出是任意进程文本，进信封正文/属性前必须过一遍。 */
function escapeXml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * 把一次 Monitor 流式事件装配为 XML 信封通知文本（合成 user 消息的正文）。
 *
 * 与终态通知（notify.ts）同形态不同 type：`task.monitor_stream`，正文用 `<event>`
 * 包裹批次文本。模型据此区分「这件事发生了」与「任务结束了」——两者的处置动作不同，
 * 终态要收尾（task_output 读全文 / 起下一个），流式只决定要不要惊动用户。
 *
 * 给模型看的文案恒中文，不进 i18n。
 */
export function formatStreamNotification(
  taskId: string,
  body: string,
  description: string,
): string {
  return [
    `<notification id="${escapeXml(`task:${taskId}:monitor_stream`)}" category="task"` +
      ` type="task.monitor_stream" source_kind="background_task" source_id="${escapeXml(taskId)}">`,
    `状态：监听事件`,
    `描述：${escapeXml(description)}`,
    `<event>${escapeXml(body)}</event>`,
    '（这是 Monitor 监听任务的实时事件，无需回复；仅在值得用户立即知晓时再转告。）',
    '</notification>',
  ].join('\n');
}

/**
 * 把一次流式事件装配为完整的 storage 消息：正文 XML 信封 + 结构化 origin
 * （kind=monitor_stream，携带 taskId）。下游按 origin 路由：UI 渲染、压缩取舍、
 * fork/undo 边界，无需解析正文。
 *
 * startsPromptTurn 由投递方决定：step 边界中途注入=false（对应 claude code 的
 * `priority:"next"`，不打断正在执行的工具），idle 唤醒新回合=true。
 */
export function buildStreamMessage(
  taskId: string,
  body: string,
  description: string,
  opts?: { startsPromptTurn?: boolean },
) {
  return stored(
    {
      role: 'user',
      content: formatStreamNotification(taskId, body, description),
    },
    {
      kind: 'monitor_stream',
      taskId,
      notificationId: `task:${taskId}:monitor_stream`,
      startsPromptTurn: opts?.startsPromptTurn,
    },
  );
}

/**
 * 单个 Monitor 事件是否已值得投给模型。
 *
 * 这一步不重复缓冲器的四道闸（那四道只管合并与截断，见 monitorBatcher.ts），
 * 只管「这一批要不要占模型上下文」。判据两条：
 *
 * 1. 批内行数 ≥ 1 恒过——单批由缓冲器产出时已保证非空，空批是调用方的 bug；
 * 2. 正文含显式告警词（ERROR/WARN/FAIL/CRITICAL/异常/失败/错误，大小写不敏感）
 *    或命令本身已退出（exit 事件）——这两种情况模型必须看到。
 *
 * 其余常规输出（进度、心跳、INFO）不投：它们进了上下文也只是噪声，且 200ms 一批的
 * 频率下逐批投递等于每 200ms 消耗一次 prompt cache。这与 claude code 的系统提示词
 * 约束同源——「Routine or benign output doesn't need one.」过滤责任在模型侧，
 * 但调用方先挡掉明显的噪声能让模型不必为每批心跳做判断。
 */
const SIGNAL_PATTERN = /\b(error|warn(?:ing)?|fail(?:ed|ure)?|critical|fatal)\b|异常|失败|错误/i;

export function shouldDeliverStream(body: string): boolean {
  return SIGNAL_PATTERN.test(body);
}

/**
 * 把多条 Monitor 流式事件合成为一条 storage 消息（idle 唤醒回合时用）。
 *
 * 为什么不走终态通知的批量合成（notify.ts mergeSettleMessages）：那条路是为 resume
 * 补投去重服务的，每条都带 taskId/notificationId 供对账寻址，并写
 * background.notify_delivered wire 事件。流式事件不参与 resume 补投（对账按终态任务走，
 * stream 队列不落盘），也没有去重需求——一次唤醒就是把队列里攒的全部事件给模型看，
 * 合成一条只是省回合数。套 notification-batch 信封反而让正文更难读。
 *
 * 单条时原样返回第一条（不套壳）。
 */
export function mergeStreamMessages(messages: readonly StoredMessage[]): StoredMessage {
  if (messages.length === 0) throw new Error('mergeStreamMessages: 空列表无法合成');
  const first = messages[0]!;
  if (messages.length === 1) return first;
  const bodies = messages.map((m) => (typeof m.message.content === 'string' ? m.message.content : ''));
  const content =
    `<monitor-stream-batch count="${messages.length}">\n` +
    bodies.join('\n\n') +
    '\n</monitor-stream-batch>';
  return stored({ role: 'user', content }, { kind: 'monitor_stream', startsPromptTurn: true });
}
