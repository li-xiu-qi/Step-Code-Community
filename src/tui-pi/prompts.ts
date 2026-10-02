/**
 * 审批三桥：工具审批、计划确认、向用户提问。
 *
 * 三者共用 ChoiceBlock 的选项列表交互，各自只提供正文与结果语义。
 */
import { Markdown, matchesKey, truncateToWidth, visibleWidth, wrapTextWithAnsi } from '@earendil-works/pi-tui';
import type { Component } from '@earendil-works/pi-tui';
import type { AskUserQuestion, AskUserRequest, QuestionAnswers } from '../tools/askUser.js';
import { t } from '../i18n.js';
import { ChoiceBlock, type Choice } from './ChoiceBlock.js';
import { c, markdownTheme } from './theme.js';
import { indexFromLineCol, lineColFromIndex, renderMultilineInput, renderScrolledInput } from './scrollInput.js';
import { markdownTransform } from '../chat/markdownPrep.js';

/** 预览折叠行数上限。 */
const PREVIEW_LIMIT = 10;

/** Other 自由输入的可见行数上限（超出纵向开窗滚动）。 */
const OTHER_MAX_LINES = 6;

/**
 * 换行键判定：与 pi-tui Editor 同源（Ctrl+J 发 \n、Alt+Enter 发 \x1b\r、
 * Shift+Enter 在支持 modifyOtherKeys 的终端发 \x1b[13;2~ / kitty 协议 \x1b[27;2;13~）。
 * Enter（\r）保持提交语义，换行全走这组键。
 */
export function isNewlineKey(data: string): boolean {
  return data === '\n' || data === '\x1b\r' || data === '\x1b[13;2~' || data === '\x1b[27;2;13~';
}

/**
 * 按工具定制的审批标题：存 i18n key 而不是文案。
 *
 * 这一层原来是硬编码中文，于是英文 locale 下审批弹层整块不翻译。审批是要用户做决定的
 * 界面，看不懂等于没提示，所以这里的接线优先级高于其它面板。
 */
const TITLE_KEYS: Record<string, string> = {
  bash: 'approval.title.bash',
  write_file: 'approval.title.write',
  edit_file: 'approval.title.edit',
};

/**
 * bash 危险命令模式表（逐条保守匹配）。命中后在命令上方红标一行警告。
 * warn 存 i18n key：危险警告是安全信息，英文看不懂等于警告失效。
 */
const DANGER_PATTERNS: ReadonlyArray<{ pattern: RegExp; warnKey: string }> = [
  {
    pattern:
      /\brm\s+(?:-{1,2}[\w-]+\s+)*(?:-[\w-]*(?:r[\w-]*f|f[\w-]*r)[\w-]*|--recursive\b[^|;]*--force|--force\b[^|;]*--recursive)/,
    warnKey: 'approval.danger.rmRf',
  },
  { pattern: /\bsudo\b/, warnKey: 'approval.danger.sudo' },
  { pattern: /\b(?:curl|wget)\b[^|;]*\|\s*(?:sudo\s+)?(?:ba|z)?sh\b/, warnKey: 'approval.danger.pipeShell' },
  { pattern: /\bdd\b[^|;]*\bof=\/dev\//, warnKey: 'approval.danger.ddDevice' },
  { pattern: /\bmkfs(?:\.\w+)?\b/, warnKey: 'approval.danger.mkfs' },
  { pattern: /\bchmod\s+(?:-\S+\s+)*777\b/, warnKey: 'approval.danger.chmod777' },
  { pattern: />\s*\/dev\/(?:sd|hd|vd|nvme|mmcblk|disk)/, warnKey: 'approval.danger.rawDevice' },
  { pattern: /:\s*\(\s*\)\s*\{[^}]*:\s*\|\s*:\s*&[^}]*\}/, warnKey: 'approval.danger.forkBomb' },
];

export function dangerWarnings(command: string): string[] {
  return DANGER_PATTERNS.filter(({ pattern }) => pattern.test(command)).map(({ warnKey }) => t(warnKey));
}

function bashCommand(name: string, input: unknown): string {
  if (name !== 'bash' || input === null || typeof input !== 'object') return '';
  const v = (input as Record<string, unknown>).command;
  return typeof v === 'string' ? v : '';
}

interface PreviewLine {
  text: string;
  tone?: 'add' | 'del';
}

/** edit_file 的 old/new 逐行对照；write_file 的待写内容。 */
export function buildPreview(name: string, input: unknown): PreviewLine[] | null {
  if (input === null || typeof input !== 'object') return null;
  const obj = input as Record<string, unknown>;
  if (name === 'edit_file' && typeof obj.old_string === 'string' && typeof obj.new_string === 'string') {
    const out: PreviewLine[] = [];
    for (const l of obj.old_string.split('\n')) out.push({ text: `- ${l}`, tone: 'del' });
    for (const l of obj.new_string.split('\n')) out.push({ text: `+ ${l}`, tone: 'add' });
    return out;
  }
  if (name === 'write_file' && typeof obj.content === 'string') {
    // 行号 padStart(3) + │ 分隔符
    return obj.content.split('\n').map((l, i) => ({ text: `${String(i + 1).padStart(3)} │ ${l}` }));
  }
  return null;
}

function argSummary(input: unknown): string {
  if (input === null || typeof input !== 'object') return '';
  const obj = input as Record<string, unknown>;
  for (const key of ['command', 'path', 'pattern']) {
    const v = obj[key];
    if (typeof v === 'string' && v.length > 0) return v.length > 120 ? `${v.slice(0, 120)}…` : v;
  }
  return '';
}

// ------------------------------------------------------------------ 工具审批

export type ApprovalOutcome =
  | { kind: 'allow'; feedback?: string }
  | { kind: 'allow-session' }
  | { kind: 'deny'; feedback?: string };

type ApprovalValue = 'allow' | 'allow-session' | 'allow-feedback' | 'deny' | 'deny-feedback';

/**
 * 工具审批块。五选项：允许一次 / 本会话都允许 / 允许并附言 / 拒绝 / 拒绝并写评论，
 * 对应 y / a / c / n / f 与数字键；Ctrl+E 展开被折叠的预览。
 * 「允许并附言」：批准本次调用的同时给模型带一句话（如「下次先跑测试再改」），
 * 附言由 PiChat 排队为回合后的跟进消息——权限通道只能回 decision，附言走队列。
 */
export class InlineApproval extends ChoiceBlock<ApprovalValue> {
  private readonly toolName: string;
  private readonly input: unknown;
  private readonly done: (outcome: ApprovalOutcome) => void;
  private expanded = false;
  private readonly preview: PreviewLine[] | null;

  constructor(
    toolName: string,
    input: unknown,
    requestRender: () => void,
    done: (outcome: ApprovalOutcome) => void,
  ) {
    const choices: Choice<ApprovalValue>[] = [
      { label: t('approval.option.allowOnce'), hotkeys: ['y'], value: 'allow' },
      { label: t('approval.option.allowSession'), hotkeys: ['a'], value: 'allow-session' },
      { label: t('approval.option.allowWithFeedback'), hotkeys: ['c'], value: 'allow-feedback', requiresFeedback: true },
      { label: t('approval.option.deny'), hotkeys: ['n'], value: 'deny' },
      { label: t('approval.option.denyWithFeedback'), hotkeys: ['f'], value: 'deny-feedback', requiresFeedback: true },
    ];
    super(choices, requestRender);
    this.toolName = toolName;
    this.input = input;
    this.done = done;
    this.preview = buildPreview(toolName, input);
  }

  protected onChoose(value: ApprovalValue, feedback?: string): void {
    if (value === 'allow' || value === 'allow-feedback') return this.done({ kind: 'allow', feedback });
    if (value === 'allow-session') return this.done({ kind: 'allow-session' });
    this.done({ kind: 'deny', feedback });
  }

  protected onCancel(): void {
    this.done({ kind: 'deny' });
  }

  protected override onOtherKey(data: string): void {
    if (matchesKey(data, 'ctrl+e') && this.preview !== null && this.preview.length > PREVIEW_LIMIT) {
      this.expanded = !this.expanded;
      this.render(0);
    }
  }

  protected override hintLine(): string {
    const base = t('approval.hint.select');
    if (this.preview === null || this.preview.length <= PREVIEW_LIMIT) return base;
    const action = t(this.expanded ? 'approval.hint.collapse' : 'approval.hint.expand');
    return base + t('approval.hint.previewToggle', { action });
  }

  protected renderBody(width: number): string[] {
    const out: string[] = [];
    const titleKey = TITLE_KEYS[this.toolName];
    out.push(c.warn(titleKey !== undefined ? t(titleKey) : t('approval.title', { name: this.toolName })));
    for (const warn of dangerWarnings(bashCommand(this.toolName, this.input))) {
      out.push(c.error(`  ⚠ ${warn}`));
    }
    const arg = argSummary(this.input);
    if (arg !== '') {
      for (const line of wrapTextWithAnsi(c.toolArg(arg), Math.max(1, width - 2))) out.push(`  ${line}`);
    }
    if (this.preview !== null && this.preview.length > 0) {
      const shown = this.expanded ? this.preview : this.preview.slice(0, PREVIEW_LIMIT);
      for (const line of shown) {
        const colored = line.tone === 'add' ? c.ok(line.text) : line.tone === 'del' ? c.error(line.text) : c.dim(line.text);
        out.push(`  ${truncateToWidth(colored, Math.max(1, width - 2))}`);
      }
      if (!this.expanded && this.preview.length > PREVIEW_LIMIT) {
        out.push(c.dim(t('approval.preview.more', { rest: this.preview.length - PREVIEW_LIMIT })));
      }
    }
    return out;
  }
}

// ------------------------------------------------------------------ 计划确认

export type PlanOutcome = { approved: boolean; feedback?: string };

type PlanValue = 'approve' | 'reject-feedback' | 'reject';

/** exit_plan_mode 的确认块：正文走 markdown（计划几乎总是 markdown）。 */
export class PlanApproval extends ChoiceBlock<PlanValue> {
  private readonly done: (outcome: PlanOutcome) => void;
  private readonly markdown: Markdown;

  constructor(plan: string, requestRender: () => void, done: (outcome: PlanOutcome) => void) {
    super(
      [
        { label: t('plan.option.approve'), hotkeys: ['y'], value: 'approve' },
        { label: t('plan.option.rejectWithFeedback'), hotkeys: ['f'], value: 'reject-feedback', requiresFeedback: true },
        { label: t('plan.option.reject'), hotkeys: ['n'], value: 'reject' },
      ],
      requestRender,
    );
    this.done = done;
    this.markdown = new Markdown(plan, 0, 0, markdownTheme, undefined, { transform: markdownTransform });
  }

  protected onChoose(value: PlanValue, feedback?: string): void {
    this.done({ approved: value === 'approve', feedback });
  }

  protected onCancel(): void {
    this.done({ approved: false });
  }

  protected override hintLine(): string {
    return t('plan.hint');
  }

  protected renderBody(width: number): string[] {
    return [c.accent(t('plan.confirmTitle')), ...this.markdown.render(Math.max(1, width - 2)).map((l) => `  ${l}`)];
  }
}

// ------------------------------------------------------------------ 单行文本输入

/**
 * 单行文本编辑现场：光标移动、删除、整块插入（粘贴归一 \r\n、剥控制字符）。
 * LineInputPrompt 用；QuestionPrompt 的 Other 编辑逻辑是它的多行超集，暂未回迁。
 */
class LineEditState {
  text: string;
  cursor: number;
  constructor(initial: string) {
    this.text = initial;
    this.cursor = initial.length;
  }
  /** 返回 true 表示按键被消费。提交/取消语义由调用方处理。 */
  applyKey(data: string): boolean {
    if (matchesKey(data, 'left')) {
      if (this.cursor > 0) this.cursor -= 1;
      return true;
    }
    if (matchesKey(data, 'right')) {
      if (this.cursor < this.text.length) this.cursor += 1;
      return true;
    }
    if (matchesKey(data, 'home') || matchesKey(data, 'ctrl+a')) {
      this.cursor = 0;
      return true;
    }
    if (matchesKey(data, 'end') || matchesKey(data, 'ctrl+e')) {
      this.cursor = this.text.length;
      return true;
    }
    if (matchesKey(data, 'ctrl+w')) {
      const before = this.text.slice(0, this.cursor);
      const trimmed = before.replace(/\s*\S*\s*$/, '');
      this.text = trimmed + this.text.slice(this.cursor);
      this.cursor = trimmed.length;
      return true;
    }
    if (matchesKey(data, 'backspace')) {
      if (this.cursor > 0) {
        this.text = this.text.slice(0, this.cursor - 1) + this.text.slice(this.cursor);
        this.cursor -= 1;
      }
      return true;
    }
    if (matchesKey(data, 'delete')) {
      if (this.cursor < this.text.length) {
        this.text = this.text.slice(0, this.cursor) + this.text.slice(this.cursor + 1);
      }
      return true;
    }
    if (!data.startsWith('\x1b')) {
      const insert = data
        .replace(/\r\n|\r/g, '\n')
        .replace(/[\x00-\x1f\x7f]/g, '')
        .replace(/\t/g, '    ');
      if (insert !== '') {
        this.text = this.text.slice(0, this.cursor) + insert + this.text.slice(this.cursor);
        this.cursor += insert.length;
      }
      return true;
    }
    return false;
  }
}

/**
 * 通用单行输入块：/rename 这类「要用户填一个短文本」的交互统一走这里，
 * 挂 showPrompt（inputSlot 内联替换 editor），与审批三桥同一条挂载路径。
 *
 * 取代 askLine 的底部浮层（showOverlay bottom-center）：浮层遮状态栏、盖转录区，
 * 视觉上是突然贴上去的补丁；内联块出现在对话最底部、状态栏之上，不遮挡历史。
 * Enter 提交（回 trim 前原文，调用方自行 trim）、Esc 取消回 null。
 */
export class LineInputPrompt implements Component {
  private readonly edit: LineEditState;
  private settled = false;

  constructor(
    private readonly title: string,
    private readonly done: (value: string | null) => void,
    private readonly requestRender: () => void,
    private readonly opts: { initial?: string; hint?: string; placeholder?: string } = {},
  ) {
    this.edit = new LineEditState(opts.initial ?? '');
  }

  invalidate(): void {
    // 弹层生命周期短，不做缓存
  }

  private settle(value: string | null): void {
    if (this.settled) return;
    this.settled = true;
    this.done(value);
  }

  handleInput(data: string): void {
    if (matchesKey(data, 'escape')) {
      this.settle(null);
      return;
    }
    if (matchesKey(data, 'enter')) {
      this.settle(this.edit.text);
      return;
    }
    if (this.edit.applyKey(data)) this.requestRender();
  }

  render(width: number): string[] {
    const innerWidth = Math.max(10, width - 4); // 边框 2 + padding 2
    const inner: string[] = [c.accent(this.title)];

    const prefix = c.toolName('❯ ');
    const textWidth = Math.max(1, innerWidth - visibleWidth(prefix));
    if (this.edit.text !== '') {
      inner.push(`${prefix}${renderScrolledInput(this.edit.text, this.edit.cursor, textWidth)}`);
    } else {
      const placeholder = this.opts.placeholder ?? '';
      inner.push(`${prefix}\x1b[7m \x1b[27m${c.dim(placeholder)}`);
    }

    inner.push('');
    if (this.opts.hint !== undefined) inner.push(c.dim(this.opts.hint));

    const frameWidth = Math.min(innerWidth, Math.max(...inner.map((l) => Math.min(visibleWidth(l), innerWidth))));
    const out: string[] = [c.accent(`╭${'─'.repeat(frameWidth + 2)}╮`)];
    for (const line of inner) {
      const w = visibleWidth(line);
      const padded = w < frameWidth ? line + ' '.repeat(frameWidth - w) : truncateToWidth(line, frameWidth);
      out.push(`${c.accent('│')} ${padded} ${c.accent('│')}`);
    }
    out.push(c.accent(`╰${'─'.repeat(frameWidth + 2)}╯`));
    out.push('');
    return out;
  }
}

// ------------------------------------------------------------------ 向用户提问

/**
 * ask_user 的提问块：多题逐题问，答完一次性回传 { 问题原文: 答案 }。
 * ↑↓ 移动光标（末项之后是自由输入行）· 空格勾选（多选）· Enter 确认/进下一题
 * ← → 上一题/下一题 · Esc 取消（回空字典）。自由输入项由系统追加。
 */
export class QuestionPrompt {
  private readonly req: AskUserRequest;
  private readonly done: (answers: QuestionAnswers) => void;
  private readonly requestRender: () => void;
  private qIdx = 0;
  private settled = false;
  /** 编辑态：光标在 Other 行时按 Enter 进入，↑↓/Esc 退出。与导航态分离，键位不再争用。 */
  private otherMode = false;
  /** 每题的交互现场：光标、勾选集、自由输入草稿与光标位置（切题保留）。 */
  private readonly slots: { cursor: number; checked: Set<number>; other: string; otherCursor: number }[];
  private readonly answers: QuestionAnswers = {};

  constructor(req: AskUserRequest, requestRender: () => void, done: (answers: QuestionAnswers) => void) {
    this.req = req;
    this.done = done;
    this.requestRender = requestRender;
    this.slots = req.questions.map(() => ({ cursor: 0, checked: new Set<number>(), other: '', otherCursor: 0 }));
  }

  invalidate(): void {
    // 无缓存
  }

  private get question(): AskUserQuestion {
    return this.req.questions[this.qIdx]!;
  }

  private get slot(): { cursor: number; checked: Set<number>; other: string; otherCursor: number } {
    return this.slots[this.qIdx]!;
  }

  /** 自由输入行的光标位置 = 选项数（排在最后一项之后）。 */
  private get otherIndex(): number {
    return this.question.options.length;
  }

  private settle(answers: QuestionAnswers): void {
    if (this.settled) return;
    this.settled = true;
    this.done(answers);
  }

  /** 收下本题答案并推进：跳到第一题未答题（回退改题后跳过已答题），全答完则汇总回传。 */
  private commitAndAdvance(): void {
    const q = this.question;
    const slot = this.slot;
    if (slot.cursor === this.otherIndex) {
      const text = slot.other.trim();
      if (text === '') return; // 自由输入为空时不放行，避免记下空答案
      this.answers[q.question] = q.multi_select === true ? [text] : text;
    } else if (q.multi_select === true) {
      const picked = [...slot.checked].sort((a, b) => a - b).map((i) => q.options[i]!.label);
      const withOther = slot.other.trim() !== '' ? [...picked, slot.other.trim()] : picked;
      if (withOther.length === 0) return; // 多选未勾任何项时不放行
      this.answers[q.question] = withOther;
    } else {
      this.answers[q.question] = q.options[slot.cursor]!.label;
    }
    // 跳过已答题：找任意未答题（非仅 qIdx+1），全答完才 settle。
    // 早前只做 qIdx+1，用户 ← 回退改题后会被逼着重走已答题。
    const next = this.req.questions.findIndex((qq) => this.answers[qq.question] === undefined);
    if (next === -1) {
      this.settle(this.answers);
    } else {
      this.qIdx = next;
      this.requestRender();
    }
  }

  handleInput(data: string): void {
    if (matchesKey(data, 'escape')) {
      this.settle({});
      return;
    }

    // ── 编辑态：Other 行按 Enter 进入，↑↓/Esc 退出 ──
    if (this.otherMode) {
      const slot = this.slot;
      // 换行键先于 Enter 判定：matchesKey('enter') 把 \n（Ctrl+J）也算 enter，不拦就换行变提交
      if (isNewlineKey(data)) {
        this.handleOtherTextEdit(data);
        return;
      }
      if (matchesKey(data, 'enter')) {
        const text = slot.other.trim();
        if (text === '') return; // 空文本不放行
        this.otherMode = false;
        slot.cursor = this.otherIndex;
        this.commitAndAdvance();
        return;
      }
      if (matchesKey(data, 'up')) {
        // 多行文本时光标在文本内上移一行；已在首行才退出编辑态（与主输入框同逻辑）
        const { line, col } = lineColFromIndex(slot.other, slot.otherCursor);
        if (line > 0) {
          slot.otherCursor = indexFromLineCol(slot.other, line - 1, col);
        } else {
          this.otherMode = false;
          slot.cursor = (slot.cursor - 1 + this.rowCount) % this.rowCount;
        }
        this.requestRender();
        return;
      }
      if (matchesKey(data, 'down')) {
        const { line, col } = lineColFromIndex(slot.other, slot.otherCursor);
        const lastLine = slot.other.split('\n').length - 1;
        if (line < lastLine) {
          slot.otherCursor = indexFromLineCol(slot.other, line + 1, col);
        } else {
          this.otherMode = false;
          slot.cursor = (slot.cursor + 1) % this.rowCount;
        }
        this.requestRender();
        return;
      }
      // ←→ 多题时切题（退出编辑态），单题时移动文本光标
      if (matchesKey(data, 'left') && this.req.questions.length > 1 && this.qIdx > 0) {
        this.otherMode = false;
        this.qIdx -= 1;
        this.requestRender();
        return;
      }
      if (matchesKey(data, 'right') && this.req.questions.length > 1 && this.qIdx < this.req.questions.length - 1) {
        this.otherMode = false;
        this.qIdx += 1;
        this.requestRender();
        return;
      }
      this.handleOtherTextEdit(data);
      return;
    }

    // ── 导航态 ──
    const q = this.question;
    const slot = this.slot;
    const last = this.otherIndex;

    if (matchesKey(data, 'up')) {
      slot.cursor = (slot.cursor - 1 + this.rowCount) % this.rowCount;
      this.requestRender();
      return;
    }
    if (matchesKey(data, 'down')) {
      slot.cursor = (slot.cursor + 1) % this.rowCount;
      this.requestRender();
      return;
    }
    // 数字键 1-9 直选实选项：单选直选=确认，多选直选=切换勾选
    if (/^[1-9]$/.test(data)) {
      const n = Number(data) - 1;
      const optionCount = q.options.length;
      if (n < optionCount) {
        if (q.multi_select === true) {
          if (slot.checked.has(n)) slot.checked.delete(n);
          else slot.checked.add(n);
          slot.cursor = n;
        } else {
          slot.cursor = n;
          this.commitAndAdvance();
        }
        this.requestRender();
      }
      return;
    }
    // ←→ 切题（导航态下）
    if (matchesKey(data, 'left') && this.qIdx > 0) {
      this.qIdx -= 1;
      this.requestRender();
      return;
    }
    if (matchesKey(data, 'right') && this.qIdx < this.req.questions.length - 1) {
      this.qIdx += 1;
      this.requestRender();
      return;
    }
    if (data === ' ' && q.multi_select === true) {
      if (slot.checked.has(slot.cursor)) slot.checked.delete(slot.cursor);
      else slot.checked.add(slot.cursor);
      this.requestRender();
      return;
    }
    if (matchesKey(data, 'enter')) {
      if (slot.cursor === last) {
        // 在 Other 行上按 Enter → 进入编辑态
        this.otherMode = true;
        this.requestRender();
      } else {
        this.commitAndAdvance();
      }
      return;
    }
  }

  /** 总行数 = 选项数 + 1（Other 行）。 */
  private get rowCount(): number {
    return this.otherIndex + 1;
  }

  /** 编辑态下的文本编辑处理。支持多行：Ctrl+J / Alt+Enter / Shift+Enter 换行，粘贴整块插入。 */
  private handleOtherTextEdit(data: string): void {
    const slot = this.slot;
    if (matchesKey(data, 'left')) {
      if (slot.otherCursor > 0) { slot.otherCursor -= 1; this.requestRender(); }
      return;
    }
    if (matchesKey(data, 'right')) {
      if (slot.otherCursor < slot.other.length) { slot.otherCursor += 1; this.requestRender(); }
      return;
    }
    if (isNewlineKey(data)) {
      slot.other = slot.other.slice(0, slot.otherCursor) + '\n' + slot.other.slice(slot.otherCursor);
      slot.otherCursor += 1;
      this.requestRender();
      return;
    }
    if (matchesKey(data, 'home') || matchesKey(data, 'ctrl+a')) {
      // Home 到本行行首（多行输入后到家行首才符合直觉），Ctrl+A 仍到全文开头
      if (matchesKey(data, 'ctrl+a')) {
        slot.otherCursor = 0;
      } else {
        const { line } = lineColFromIndex(slot.other, slot.otherCursor);
        slot.otherCursor = indexFromLineCol(slot.other, line, 0);
      }
      this.requestRender();
      return;
    }
    if (matchesKey(data, 'end') || matchesKey(data, 'ctrl+e')) {
      if (matchesKey(data, 'ctrl+e')) {
        slot.otherCursor = slot.other.length;
      } else {
        const { line } = lineColFromIndex(slot.other, slot.otherCursor);
        slot.otherCursor = indexFromLineCol(slot.other, line, Number.MAX_SAFE_INTEGER);
      }
      this.requestRender();
      return;
    }
    if (matchesKey(data, 'ctrl+w')) {
      const before = slot.other.slice(0, slot.otherCursor);
      const after = slot.other.slice(slot.otherCursor);
      const trimmed = before.replace(/\s*\S*\s*$/, '');
      slot.other = trimmed + after;
      slot.otherCursor = trimmed.length;
      this.requestRender();
      return;
    }
    if (matchesKey(data, 'backspace')) {
      if (slot.otherCursor > 0) {
        slot.other = slot.other.slice(0, slot.otherCursor - 1) + slot.other.slice(slot.otherCursor);
        slot.otherCursor -= 1;
        this.requestRender();
      }
      return;
    }
    if (matchesKey(data, 'delete')) {
      if (slot.otherCursor < slot.other.length) {
        slot.other = slot.other.slice(0, slot.otherCursor) + slot.other.slice(slot.otherCursor + 1);
        this.requestRender();
      }
      return;
    }
    // 可打印输入：单字符、emoji（代理对）与多字符粘贴走同一条路。
    // 粘贴的换行统一为 \n，控制字符与转义序列剥掉（tab 渲染宽度不可控，一并丢弃）。
    if (!data.startsWith('\x1b')) {
      const insert = data
        .replace(/\r\n|\r/g, '\n')
        .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '')
        .replace(/\t/g, '    ');
      if (insert !== '') {
        slot.other = slot.other.slice(0, slot.otherCursor) + insert + slot.other.slice(slot.otherCursor);
        slot.otherCursor += insert.length;
        this.requestRender();
      }
    }
  }

  render(width: number): string[] {
    const q = this.question;
    const slot = this.slot;
    const innerWidth = Math.max(10, width - 4); // 边框 2 + padding 2

    // 组装框内内容行
    const inner: string[] = [];

    // 题干行
    const counter = this.req.questions.length > 1 ? `[${this.qIdx + 1}/${this.req.questions.length}] ` : '';
    const header = q.header !== undefined && q.header !== '' ? `[${q.header}] ` : '';
    const multi = q.multi_select === true ? c.dim(t('question.multiHint')) : '';
    const questionLine = `${c.accent(counter)}${c.dim(header)}${c.bold(q.question)}${multi}`;
    inner.push(...wrapTextWithAnsi(questionLine, innerWidth));

    // 选项行
    q.options.forEach((opt, i) => {
      const on = slot.cursor === i;
      const box = q.multi_select === true ? (slot.checked.has(i) ? c.ok('[✓] ') : c.dim('[ ] ')) : '';
      const desc = opt.description !== undefined && opt.description !== '' ? c.dim(`  — ${opt.description}`) : '';
      const label = on ? c.toolName(opt.label) : opt.label;
      const prefix = on ? c.toolName('❯ ') : '  ';
      inner.push(truncateToWidth(`${prefix}${box}[${i + 1}] ${label}${desc}`, innerWidth));
    });

    // 自由输入行：导航态只显示标签（与 ink 版一致），编辑态显示文本 + ▌ 光标
    const onOther = slot.cursor === this.otherIndex;
    const otherLabel = t('question.other');
    const otherPrefix = onOther ? c.toolName('❯ ') : '  ';
    if (this.otherMode) {
      // 编辑态：多行渲染，光标行横向滚动、光标始终在可视区，超 OTHER_MAX_LINES 纵向开窗
      const prefix = `${otherPrefix}[${this.otherIndex + 1}] ${c.toolName(otherLabel)} `;
      const prefixWidth = visibleWidth(prefix);
      const textWidth = Math.max(1, innerWidth - prefixWidth);
      if (slot.other !== '') {
        const ml = renderMultilineInput(slot.other, slot.otherCursor, textWidth, OTHER_MAX_LINES);
        inner.push(`${prefix}${ml[0] ?? ''}`);
        const contPad = ' '.repeat(prefixWidth);
        for (let i = 1; i < ml.length; i++) inner.push(`${contPad}${ml[i]}`);
      } else {
        // 空输入：反显光标 + 暗色占位符
        inner.push(`${prefix}\x1b[7m \x1b[27m${c.dim(t('question.otherPlaceholder'))}`);
      }
    } else {
      // 导航态：只显示标签，不显示文本（视觉上区分导航态和编辑态）
      inner.push(truncateToWidth(`${otherPrefix}[${this.otherIndex + 1}] ${onOther ? c.toolName(otherLabel) : otherLabel}`, innerWidth));
    }

    // 空行分隔
    inner.push('');

    // 提示行
    const hintText = this.req.questions.length > 1 ? t('question.hintMulti') : t('question.hint');
    inner.push(c.dim(hintText));

    // 画边框
    const frameWidth = Math.min(innerWidth, Math.max(...inner.map((l) => Math.min(visibleWidth(l), innerWidth))));
    const out: string[] = [];
    out.push(c.accent(`╭${'─'.repeat(frameWidth + 2)}╮`));
    for (const line of inner) {
      const w = visibleWidth(line);
      const padded = w < frameWidth ? line + ' '.repeat(frameWidth - w) : truncateToWidth(line, frameWidth);
      out.push(`${c.accent('│')} ${padded} ${c.accent('│')}`);
    }
    out.push(c.accent(`╰${'─'.repeat(frameWidth + 2)}╯`));
    out.push('');
    return out;
  }
}
