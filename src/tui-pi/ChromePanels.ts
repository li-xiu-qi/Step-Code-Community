/**
 * 输入框正上方的常驻 chrome 面板：TODO 清单 + 发送队列预览。
 *
 * 常驻 chrome：待办面板 + 队列预览，挂在输入框上方。
 *
 * 1. **不参与高度预算降级。** 常驻不收缩，busy 时也不让位
 *    QueuePreview 再丢 TodoPanel），因为动态区超屏会触发清屏事故。pi-tui 差分渲染没有
 *    这个失效模式，面板按内容决定行数，不需要预算协商。
 * 2. **合并成一个组件。** 两块内容都是「输入框上方的状态区」，行数都由数据决定，
 *    合成一个组件后 TUI 组件链少一个节点，且两块之间的空行归属明确。
 *
 * 空数据时 render 返回空数组，一行都不占。
 */
import { hyperlink, truncateToWidth, type Component } from '@earendil-works/pi-tui';
import type { TodoItem } from '../tools/types.js';
import {
  QUEUE_MAX_ITEMS,
  hiddenTodoCounts,
  previewQueueEntry,
  selectVisibleTodos,
  isBlocked,
} from '../chat/chromePanels.js';
import { c } from './theme.js';
import { t } from '../i18n.js';

export class ChromePanels implements Component {
  private todos: readonly TodoItem[] = [];
  private queue: readonly string[] = [];
  private busy = false;
  /**
   * 待办面板折叠态。清单长的时候展开态要占 7 行以上（标题 + 最多 5 条 + 折叠计数），
   * 把输入区挤到很下面；折叠后只留一行摘要，交互区让回给用户。
   * 默认展开：待办是「正在做什么」的核心信息，收起会让用户漏看进度。
   */
  private todosCollapsed = false;

  setTodos(todos: readonly TodoItem[]): void {
    this.todos = todos;
  }

  /** 切换待办面板折叠态。由 PiChat 处理 step://todo-toggle 点击时调用。 */
  toggleTodos(): void {
    this.todosCollapsed = !this.todosCollapsed;
  }

  setQueue(queue: readonly string[]): void {
    this.queue = queue;
  }

  setBusy(busy: boolean): void {
    this.busy = busy;
  }

  invalidate(): void {
    // 无缓存：数据变了就重排，两块内容都是十几行以内的字符串拼接
  }

  render(width: number): string[] {
    const out: string[] = [];
    out.push(...renderTodos(this.todos, width, this.todosCollapsed));
    out.push(...renderQueue(this.queue, width, this.busy));
    return out;
  }
}

/** 折叠切换的点击目标。scheme 与 step://turn/N 同族，由 PiChat.handleUrlClick 分发。 */
const TODO_TOGGLE_URL = 'step://todo-toggle';

/**
 * TODO 清单。展开态：标题 + 最多 5 条（按状态优先级裁剪）+ 折叠计数行。
 * 折叠态：一行摘要，只报进度不列条目。
 *
 * 两种态的标题/摘要行都包 OSC 8 超链接，点击切换。alt-screen 下终端自己的滚动条被隐藏，
 * 「点一行触发动作」这条路子是转录区的 prompt 跳转（step://turn/N）已经在用的，库侧
 * openUrl 回调也已接到 PiChat，不需要给库加任何鼠标命中判定。
 *
 * 先 truncate 再包 hyperlink：OSC 8 的起止序列必须完整，截断若落在序列中间会让链接
 * 状态泄漏到后续输出。
 */
export function renderTodos(todos: readonly TodoItem[], width: number, collapsed = false): string[] {
  if (todos.length === 0) return [];
  const toggleLine = (plain: string): string[] => [hyperlink(truncateToWidth(plain, width), TODO_TOGGLE_URL)];
  if (collapsed) {
    const done = todos.filter((td) => td.status === 'done').length;
    const inProgress = todos.filter((td) => td.status === 'in_progress').length;
    const pending = todos.filter((td) => td.status === 'pending').length;
    const parts = [t('panel.todo.done', { count: done })];
    if (inProgress > 0) parts.push(t('panel.todo.inProgress', { count: inProgress }));
    if (pending > 0) parts.push(t('panel.todo.pending', { count: pending }));
    return toggleLine(`▸ ${t('panel.todo.title')} · ${parts.join(' · ')}${c.dim(t('panel.todo.clickToExpand'))}`);
  }
  const out = toggleLine(`▾ ${c.toolName(t('panel.todo.title'))}${c.dim(t('panel.todo.clickToCollapse'))}`);
  const visible = selectVisibleTodos(todos);
  for (const td of visible) {
    const idx = todos.indexOf(td);
    const num = idx + 1;
    const mark = td.status === 'done' ? c.ok('✓') : td.status === 'in_progress' ? c.toolName('●') : c.dim('○');
    const title = td.status === 'done' ? c.dim(td.title) : td.status === 'in_progress' ? td.title : c.dim(td.title);
    // 被阻塞的待办标注「等待 #N」（只列未完成的依赖）
    const blockedBy = td.status === 'pending' && isBlocked(todos, idx)
      ? (td.deps ?? []).filter((d) => d >= 1 && d <= todos.length && todos[d - 1]?.status !== 'done').map((d) => `#${d}`)
      : [];
    const depTag = blockedBy.length > 0 ? c.dim(` 等待 ${blockedBy.join(',')}`) : '';
    // 单条截断到一行：面板高度按 1 行/条精确成立，长标题不折行把面板顶高
    out.push(truncateToWidth(`${num}. ${mark} ${title}${depTag}`, width));
  }
  const hidden = hiddenTodoCounts(todos, visible);
  if (hidden.total > 0) {
    const parts: string[] = [];
    if (hidden.inProgress > 0) parts.push(t('panel.todo.inProgress', { count: hidden.inProgress }));
    if (hidden.pending > 0) parts.push(t('panel.todo.pending', { count: hidden.pending }));
    if (hidden.done > 0) parts.push(t('panel.todo.done', { count: hidden.done }));
    out.push(c.dim(truncateToWidth(t('panel.todo.more', { count: hidden.total, parts: parts.join(' · ') }), width)));
  }
  return out;
}

/** 队列预览：标题 + 逐条 ↳ 预览（最多 3 条 × 2 行）+ 折叠计数 + 取回提示。 */
export function renderQueue(queue: readonly string[], width: number, busy = false): string[] {
  if (queue.length === 0) return [];
  const shown = queue.slice(0, QUEUE_MAX_ITEMS);
  const rest = queue.length - shown.length;
  const out = [c.dim(t('panel.queue.title', { count: queue.length }))];
  for (const q of shown) {
    const lines = previewQueueEntry(q).split('\n');
    lines.forEach((line, j) => {
      out.push(c.dim(truncateToWidth(`${j === 0 ? '  ↳ ' : '    '}${line}`, width)));
    });
  }
  if (rest > 0) out.push(c.dim(t('panel.queue.more', { count: rest })));
  // 取回提示分两种态：busy 时 Esc 中断而非取回，改用 ↑ 逐条取回；
  // 空闲时 Esc 把队列合并回输入框。
  out.push(c.dim(busy ? t('panel.queue.recallBusy') : t('panel.queue.recall')));
  return out;
}
