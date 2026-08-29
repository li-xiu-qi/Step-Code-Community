import { stored, type StoredMessage } from '../message.js';
import { notifyDedupKeyFromOrigin } from '../wirelog.js';
import type { BackgroundTask, LostTask } from './manager.js';

/** 通知里给模型看的输出尾部兜底预览上限（任务未落盘 output.log 时才用，防止长输出无谓占上下文）。 */
const PREVIEW_CHARS = 2000;

/** 可通知的任务视图：常规终态任务或对账恢复的 lost 任务。 */
export type NotifiableTask = BackgroundTask | LostTask;

/**
 * 通知幂等 id：`task:<taskId>:<status>`。
 * 同一任务同一终态的通知 id 恒定，配合幂等键（wirelog.notifyDedupKey）实现去重与补投。
 */
export function notificationIdFor(task: NotifiableTask): string {
  return `task:${task.id}:${task.status}`;
}

/** XML 转义：命令等自由文本进信封正文/属性前必须过一遍。 */
function escapeXml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** 终态的中文文案。lost = resume 对账时发现 running 但进程已不存在（任务随旧进程一起死掉）。 */
function statusText(task: NotifiableTask): string {
  const exit = task.exitCode !== undefined ? `（退出码 ${task.exitCode}）` : '';
  switch (task.status) {
    case 'completed':
      return `已完成${exit}`;
    case 'failed':
      return `失败${exit}`;
    case 'killed':
      return '已被终止';
    case 'lost':
      return '已失联（进程已不存在，会话恢复时按丢失标记）';
    case 'running':
      return '仍在运行';
  }
}

/**
 * 把后台任务终态装配为 XML 信封通知文本（合成 user 消息的正文）。
 *
 * 双通道设计：provider API 只有 user 这一个注入位，「这是系统通知不是用户指令」的语义
 * 拆成两个互不干扰的载体——XML 信封给模型（它在正文里唯一的区分依据），结构化 origin
 * 给代码（见 buildSettleMessage）。无 prompt 侧专门段落，防线 = 信封 + 正文措辞 +
 * 工具文档引导（模型被告知终态会主动到达，无需轮询）。
 *
 * 输出指引：任务落盘了 output.log 时只给 <output-file> 指针（完整输出在磁盘，模型按需
 * 用 task_output 读取）；未落盘（内存态管理器）退化为小尾部兜底预览。
 * 给模型看的文案恒中文，不进 i18n。
 */
export function formatSettleNotification(task: NotifiableTask): string {
  const agentAttr = task.agentId !== undefined ? ` agent_id="${escapeXml(task.agentId)}"` : '';
  const lines: string[] = [
    `<notification id="${escapeXml(notificationIdFor(task))}" category="task" type="task.${task.status}"` +
      ` source_kind="background_task" source_id="${escapeXml(task.id)}"${agentAttr}>`,
    `状态：${statusText(task)}`,
    `命令：${escapeXml(task.command)}`,
  ];
  if (task.outputPath !== undefined) {
    lines.push(
      `<output-file path="${escapeXml(task.outputPath)}" bytes="${task.outputBytes ?? 0}">` +
        '完整输出已落盘，用 task_output 按需读取。</output-file>',
    );
  } else if (task.output === '') {
    lines.push('（无输出）');
  } else {
    const tail =
      task.output.length > PREVIEW_CHARS
        ? task.output.slice(task.output.length - PREVIEW_CHARS)
        : task.output;
    lines.push(`输出尾部预览：\n${escapeXml(tail)}`);
  }
  lines.push('（这是系统主动注入的后台任务终态通知，无需用 task_list 轮询。）');
  lines.push('</notification>');
  return lines.join('\n');
}

/**
 * 把终态通知装配为一条完整的 storage 消息：正文 XML 信封 + 结构化 origin
 * （kind=background_task，携带 taskId/notificationId/agentId）。
 * 下游按 origin 路由：幂等去重、UI 渲染、压缩取舍、fork/undo 边界，无需解析正文。
 *
 * startsPromptTurn 由注入方按路由决定：busy 入队（中途注入，false）/ idle 直投（唤醒新回合，true）。
 */
export function buildSettleMessage(
  task: NotifiableTask,
  opts?: { agentId?: string; startsPromptTurn?: boolean },
): StoredMessage {
  return stored(
    { role: 'user', content: formatSettleNotification(task) },
    {
      kind: 'background_task',
      taskId: task.id,
      notificationId: notificationIdFor(task),
      agentId: opts?.agentId,
      startsPromptTurn: opts?.startsPromptTurn,
    },
  );
}

/** 通知注入路由：busy 时留在管理器待投递队列（runAgent 回合边界 flush），空闲时直接提交触发新回合。 */
export type NotifyRoute = 'enqueue' | 'submit';

export function decideNotifyRoute(busy: boolean): NotifyRoute {
  return busy ? 'enqueue' : 'submit';
}

/**
 * 把多条终态通知合成为一条批量通知消息。
 *
 * 为什么需要：旧实现逐条提交，N 条通知 = N 次模型调用。3 天会话 resume 后补投 98 条
 * = 98 个回合，每个回合模型都可能起新后台任务，新任务 settle 又往队列里加——队列
 * 自我生长，表现为 resume 后 queue 滚雪球。合成一条后通知之间不再隔着模型回合。
 *
 * 单条时原样返回（不套 batch 信封）：那本来就是一条，套壳只会让日志更难读。
 *
 * origin 语义：能确定唯一 taskId/notificationId 时如实记（单条合成仍是 1），多条时
 * 留空。逐条身份不靠 origin 承载，靠调用方逐条落盘的 delivered 事件与幂等键。
 */
export function mergeSettleMessages(messages: readonly StoredMessage[]): StoredMessage {
  if (messages.length === 0) throw new Error('mergeSettleMessages: 空列表无法合成');
  const first = messages[0]!;
  if (messages.length === 1) return first;
  const bodies = messages.map((m) => (typeof m.message.content === 'string' ? m.message.content : ''));
  const taskIds = messages
    .map((m) => m.origin.taskId)
    .filter((t): t is string => t !== undefined);
  const notificationIds = messages
    .map((m) => m.origin.notificationId)
    .filter((n): n is string => n !== undefined);
  const content =
    `<notification-batch count="${messages.length}" task_count="${taskIds.length}">\n` +
    bodies.join('\n\n') +
    '\n</notification-batch>';
  return stored(
    { role: 'user', content },
    {
      kind: 'background_task',
      taskId: taskIds.length === 1 ? taskIds[0] : undefined,
      notificationId: notificationIds.length === 1 ? notificationIds[0] : undefined,
      agentId: first.origin.agentId,
      startsPromptTurn: true,
    },
  );
}

/**
 * 批量通知的 delivered 事件：逐条落盘，返回需要写的 wire 事件载荷。
 *
 * 合成消息只有一条，但补投去重键是单条的（`task:<taskId>:<status>`）。不逐条落盘的话，
 * 下次 resume 对账会把这批重新投一遍——正是「resume 后 queue 暴涨」的另一半成因。
 *
 * alreadyWritten 由调用方维护（PiChat.deliveredWritten），避免重复写同一键。
 */
export function pendingBatchDeliveredEvents(
  messages: readonly StoredMessage[],
  alreadyWritten: ReadonlySet<string>,
): { taskId: string; status: string; notificationId: string }[] {
  const out: { taskId: string; status: string; notificationId: string }[] = [];
  for (const m of messages) {
    const o = m.origin;
    if (o.notificationId === undefined) continue;
    if (alreadyWritten.has(notifyDedupKeyFromOrigin(o.taskId, o.notificationId))) continue;
    out.push({
      taskId: o.taskId ?? '',
      status: /^task:.+:([a-z]+)$/.exec(o.notificationId)?.[1] ?? '',
      notificationId: o.notificationId,
    });
  }
  return out;
}
