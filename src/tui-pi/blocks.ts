/**
 * 转录区的消息块组件：把 DisplayItem 渲染成行数组。
 * 行级差分渲染下，未变化的行不重画，所以定稿块与在途块共用同一组件。
 * 每个块自带缓存（width 未变则复用上次行数组），render() 是取缓存 + 拼接。
 */
import { Markdown, truncateToWidth, visibleWidth, wrapTextWithAnsi, sliceByColumn, hyperlink } from '@earendil-works/pi-tui';
import type { Component } from '@earendil-works/pi-tui';
import { basename } from 'node:path';
import type { DisplayItem, WelcomeData } from '../chat/types.js';
import { decodePNG, ImageBlock, thumbnailCells } from './imageBlock.js';
import { offloadIfNeeded as offloadLargeResult, readCachedOutput } from '../agent/outputCache.js';

/** Braille 转圈帧序列，供 running 状态动态 spinner。 */
const BRAILLE_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
/** spinner 帧间隔，与 PiChat 的 spinnerTimer 节拍共用同一个常量。
 *  80ms（12.5fps）刻意放慢到 200ms（5fps）：长任务下慢节奏的转圈动画不与流式
 *  token 渲染抢慢终端的帧预算。副作用是尾块失效频率降到 1/5——running
 *  工具卡的首列字形取自 spinnerFrame()，帧变一次尾块缓存就失效一次。 */
export const SPINNER_FRAME_MS = 200;

/** OSC 133 A — 语义化 prompt 起始标记。pi-tui 的 scrollToPrompt 用此标记定位用户 prompt 位置，
 *  支持 Ctrl+Shift+↑/↓ 跳转到前/后一个 prompt。 */
const PROMPT_MARKER = '\x1b]133;A\x1b\\';

/** 字节大小格式化。 */
function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** braille 帧游标：由 spinnerTimer 每拍推进一格，不从墙钟派生。
 *  墙钟派生（Math.floor(Date.now()/80)）与 setInterval 各自漂移，会出现「重渲了但 frame
 *  没变」的空刷帧——定时器白跑一次完整 doRender。计数器推进后帧与重渲严格一一对应，
 *  且多个工具行读同一个游标，帧天然同步。 */
let spinnerIndex = 0;

/** spinner 定时器每拍调用一次，推进一格帧。 */
export function tickSpinner(): void {
  spinnerIndex = (spinnerIndex + 1) % BRAILLE_FRAMES.length;
}

/** 当前 braille 帧。 */
function spinnerFrame(): string {
  return BRAILLE_FRAMES[spinnerIndex] ?? BRAILLE_FRAMES[0]!;
}
import { THINKING_FOLD_LINES } from '../chat/expandable.js';
import { c, dimAll, markdownTheme, thinkingMarkdownTheme } from './theme.js';
import { markdownTransform } from '../chat/markdownPrep.js';
import { formatDuration } from '../chat/duration.js';
import { formatCount } from './StatusLine.js';
import { t } from '../i18n.js';
import {
  ERROR_PREVIEW_LINES,
  DIFF_MAX_LINES,
  MAX_INLINE_CHARS,
  RESULT_PREVIEW_LINES,
  getToolRenderer,
  summarizeResult,
  summarizeToolInput,
  outputStats,
} from './resultRenderers.js';
import { linkPath, linkFilePathArg } from './fileLink.js';
import { linkifyAbsolutePaths } from './textPaths.js';

// 顶部 logo：FIGlet "Small" 风格的 S（紧凑双线）。
const LOGO_LINES = [' ___ ', '/ __|', '\\__ \\', '|___/'];

/**
 * 启动欢迎框：圆角边框 + 蓝色 logo，右侧标题/帮助提示，下方 Directory/Session/Model/Version
 * 四行。手绘边框行（pi-tui 没有边框容器；Box 组件只有 padding 和背景色）。
 * 内容超宽时各值截断到框内，边框随内容宽收缩但不超 width。
 */
export function renderWelcome(data: WelcomeData, width: number): string[] {
  const row = (label: string, value: string): string => `${c.dim(label.padEnd(11))}${value}`;
  const inner: string[] = [
    ...LOGO_LINES.map((line, i) => {
      const right =
        i === 1 ? `  ${c.bold(t('welcome.title'))}` : i === 2 ? `  ${c.dim(t('welcome.helpHint'))}` : '';
      return `${c.logo(line)}${right}`;
    }),
    '',
    row('Directory:', data.cwd),
    row('Session:', data.sessionId),
    row('Model:', data.model),
    row('Version:', data.version),
  ];
  // 框宽 = min(内容最宽行, width - 4)，内容行截断或补齐到框宽
  const frameWidth = Math.min(Math.max(...inner.map((l) => visibleWidth(l)), 20), Math.max(20, width - 4));
  const body = inner.map((l) => {
    const w = visibleWidth(l);
    const clipped = w > frameWidth ? truncateToWidth(l, frameWidth) : l + ' '.repeat(frameWidth - w);
    return `${c.dim('│')} ${clipped} ${c.dim('│')}`;
  });
  const top = c.dim(`╭${'─'.repeat(frameWidth + 2)}╮`);
  const bottom = c.dim(`╰${'─'.repeat(frameWidth + 2)}╯`);
  return [top, ...body, bottom, ''];
}

/**
 * 能被 Ctrl+B 转后台的工具：它们跑起来会在 BackgroundManager 里留前台任务，
 * applyCtrlB 一次性把这些全转后台。集中成常量而不是散在条件里，是因为将来新增
 * 可后台化的工具时，忘了改这里的表现就是「功能能用但用户不知道」。
 */
const CTRL_B_TOOLS = new Set(['bash', 'spawn_agent', 'dynamic_workflow']);

/**
 * 并行子 agent 卡片折叠阈值：同时运行中的 spawn_agent 达到此数时，每张卡片折成一行。
 *
 * 取 3 而非 2：两张卡片共 10 行，终端（常见 40 行）装得下，完整信息比省空间有用；
 * 三张 15 行开始挤。也不做「始终折叠」——`max_concurrent` 默认 4，用户日常常只跑一两个，
 * 单任务时折叠是纯粹的信息损失。
 *
 * 阈值由 PiChat 经 setSubagentParallel 写入卡片字段（Transcript 不反向扫描块：O(N)/帧）。
 */
export const SUBAGENT_FOLD_THRESHOLD = 3;

/** 工具入参的单行摘要（折叠态标题行与 Ctrl+O 条目标题共用）。字段顺序即优先级。 */
export function summarizeInput(input: unknown): string {
  if (input === null || typeof input !== 'object') return '';
  const obj = input as Record<string, unknown>;
  for (const key of [
    'pattern',
    'command',
    'skill',
    'query',
    'url',
    'task_id',
    'mission_id',
    'objective',
    'subject',
  ]) {
    const v = obj[key];
    if (typeof v === 'string' && v.length > 0) {
      return v.length > 80 ? `${v.slice(0, 80)}…` : v;
    }
  }
  for (const key of ['path', 'file_path']) {
    const v = obj[key];
    if (typeof v === 'string' && v.length > 0) {
      return truncatePathMiddle(v, 80);
    }
  }
  return '';
}

/** edit_file 输出的 diff 数据行：4 位行号 + 空格 + 标记（+/-/空格）。formatRow 格式。 */
const DIFF_ROW_RE = /^(\s*\d+) ([+\-]) /;

/**
 * 结果体是否是 diff：unified diff（@@/---/+++ 头）或 edit_file 的摘要头（前两行命中 +N -M path）。
 * 早前只认 unified diff 头，edit_file 真实输出（首行中文 summary + 第二行 +N -M path）被漏识别，
 * 永远走折叠分支——diff 铺开展示从未对真实 edit 结果生效过。
 */
export function looksLikeDiff(lines: readonly string[]): boolean {
  if (lines.some((l) => l.startsWith('@@') || l.startsWith('--- ') || l.startsWith('+++ '))) return true;
  // edit_file 摘要头 `+N -M path` 在第二行（首行是「已编辑…」中文 summary），扫前两行
  return lines.slice(0, 2).some((l) => /^[+-]\d+ /.test(l));
}

/**
 * diff 行着色：按行内容识别 diff 语义上色，覆盖两种格式。
 * - formatRow（`   1 +code`）：行号 + 标记 → + 绿 / - 红
 * - 省略/截断提示行（`     …`）：暗色
 * - edit_file 摘要头（`+N -M path`）：accent 色
 * - unified diff（`+`/`-`/`@@` 前缀）：+ 绿 / - 红 / @@ accent
 * - 其余（中文 summary 行等）：暗色
 */
function colorDiffLine(line: string): string {
  const row = DIFF_ROW_RE.exec(line);
  if (row !== null) return row[2] === '+' ? c.ok(line) : c.error(line);
  if (/^\s*…/.test(line)) return c.dim(line);
  if (/^[+-]\d+ /.test(line)) return c.accent(line);
  if (line.startsWith('+') && !line.startsWith('+++')) return c.ok(line);
  if (line.startsWith('-') && !line.startsWith('---')) return c.error(line);
  if (line.startsWith('@@')) return c.accent(line);
  return c.dim(line);
}

/**
 * 一行文本按宽度折行；空串返回单个空行（保住段间空行）。
 *
 * 安全网：`wrapTextWithAnsi` 只按空格/换行折行，长 URL / base64 / 无空格代码串不会被断开，
 * 单行可能远超终端宽度。pi-tui doRender 检测到 visibleWidth > width 就直接 throw。
 * 2026-08-17 两次因此崩溃（line 19 w=89>87、line 399 w=992>67）。
 * 折行后逐行 `truncateToWidth` 钳到 width，是组件层最后一道防线。
 */
function wrap(text: string, width: number): string[] {
  if (text === '') return [''];
  const w = Math.max(1, width);
  const out: string[] = [];
  for (const raw of text.split('\n')) {
    if (raw === '') {
      out.push('');
      continue;
    }
    out.push(...wrapTextWithAnsi(raw, w).map((l) => truncateToWidth(l, w)));
  }
  return out;
}

/** 给一段行加统一缩进前缀（每行都加，用于引用式竖线）。 */
function indent(lines: readonly string[], prefix: string): string[] {
  return lines.map((l) => prefix + l);
}

/** 悬挂缩进：首行带标记前缀，续行用等宽空格对齐（多行提示不会每行都顶一个圆点）。 */
function hanging(lines: readonly string[], prefix: string, plainWidth: number): string[] {
  const pad = ' '.repeat(plainWidth);
  return lines.map((l, i) => (i === 0 ? prefix : pad) + l);
}

// ---- 扩展截断策略 ----

function truncateStartToWidth(text: string, maxWidth: number): string {
  if (text === '') return '';
  const w = Math.max(1, maxWidth);
  if (visibleWidth(text) <= w) return text;
  const totalWidth = visibleWidth(text);
  const keepW = Math.max(1, w - visibleWidth('…'));
  return '…' + sliceByColumn(text, totalWidth - keepW, keepW, true);
}

function truncatePathMiddle(path: string, maxLength: number): string {
  if (visibleWidth(path) <= maxLength) return path;
  const lastSep = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
  if (lastSep === -1) return truncateToWidth(path, maxLength);
  const dir = path.substring(0, lastSep);
  const sep = path[lastSep]!;
  const base = path.substring(lastSep + 1);
  const ellipsisW = visibleWidth('…');
  const sepW = visibleWidth(sep);
  const baseW = visibleWidth(base);
  const avail = Math.max(3, maxLength - ellipsisW - sepW - baseW);
  const truncatedDir = truncateStartToWidth(dir, avail);
  return truncatedDir + sep + '…' + base;
}

export function truncateEndToWidth(text: string, maxWidth: number): string {
  if (text === '') return '';
  const w = Math.max(1, maxWidth);
  if (visibleWidth(text) <= w) return text;
  const keepW = Math.max(1, w - visibleWidth('…'));
  return truncateToWidth(text.slice(0, keepW), w) + '…';
}

/**
 * 子 agent 统计段：`N tools · 时长[ · X tok]`。
 * 运行中用现算时长（startedAt），终态用 runner 回传的定格值（subagentDurationMs）。
 * tok 为 0 或缺省时不显示——开头一片「0 tok」只是噪音。
 */
export function subagentStats(it: Extract<DisplayItem, { kind: 'tool' }>, now = Date.now()): string {
  if (it.name !== 'spawn_agent') return '';
  const toolCount = it.subagentToolUses ?? it.subagentToolEvents?.length;
  const durMs =
    it.subagentDurationMs ?? (it.status === 'running' && it.startedAt !== undefined ? Math.max(0, now - it.startedAt) : undefined);
  const parts: string[] = [];
  if (toolCount !== undefined && toolCount > 0) parts.push(`${toolCount} tools`);
  if (durMs !== undefined) parts.push(formatDuration(durMs));
  if (it.subagentTokens !== undefined && it.subagentTokens > 0) parts.push(`${formatCount(it.subagentTokens)} tok`);
  return parts.join(' · ');
}

/** 单条 DisplayItem 的渲染组件。 */
/**
 * 正文渲染的 transform 链：markdownTransform（软换行合并 + 不安全链接降级）
 * 之后接绝对路径建链。顺序不可换——软换行合并要把 URL 折断的两行拼回去，
 * 拼完才有完整 URL 给路径扫描判前导字符。
 */
function mdTransformWithPaths(md: string): string {
  return linkifyAbsolutePaths(markdownTransform(md));
}

/** sixel 序列行在块产物中的本地行号 + 图片信息（预览浮层命中用）。 */
export interface ImageSeqRow {
  /** 序列行的本地行号（占位区的末行）。 */
  readonly row: number;
  /** 该图在 user 块 images 数组中的下标。 */
  readonly imgIdx: number;
  /** 该图占位的总行数（含前面的空占位行），命中区 = [row - rows + 1, row]。 */
  readonly rows: number;
}

export class ItemBlock implements Component {
  private item: DisplayItem;
  private cachedWidth = -1;
  private cachedLines: string[] | undefined;
  /** sixel 序列行在本块产物中的本地行号（user 块图片，预览浮层点击命中用）。 */
  private lastImageRows: readonly ImageSeqRow[] = [];
  /** assistant / thinking 正文交给 pi-tui 的 Markdown 组件渲染（它自带解析缓存）。 */
  private markdown: Markdown | undefined;
  /**
   * 流式增量渲染的冻结点：frozenText 是已确认渲染好的前缀文本，frozenLines 是它的渲染结果。
   * 判据是「markdown 顶层 token 边界」而不是空行，因为代码块内部也有空行，用 \n\n 切会
   * 把 fence 切断导致前缀与尾部分别渲染时配对错乱。
   */
  private frozenText = "";
  private frozenLines: string[] = [];
  private frozenWidth = -1;
  private frozenDim = false;

  constructor(item: DisplayItem) {
    this.item = item;
  }

  getItem(): DisplayItem {
    return this.item;
  }

  /** 换内容（流式追加、工具状态变更都走这里）：清缓存，下次 render 重排。 */
  setItem(item: DisplayItem): void {
    this.item = item;
    this.invalidate();
  }

  invalidate(): void {
    this.cachedLines = undefined;
    // 注意：不清冻结点（frozenText/frozenLines/frozenLineCount）。流式追加走
    // setItem -> invalidate，若在这里清掉冻结点，每帧都会退回「全量自证 + tail」
    // 两次渲染，比全量还慢一倍。冻结点由 renderMarkdownStreaming 自己判失效：
    // 宽度/主题变化，或 text 不再以 frozenText 开头（内容被替换而非追加）。
    this.markdown?.invalidate();
  }

  /**
   * 显式释放渲染资源：清缓存行 + 丢弃 Markdown 实例。
   *
   * 与 invalidate() 的区别：invalidate 只清 cachedLines、保留 markdown 实例（下次 render 复用）；
   * dispose 连 markdown 实例一起丢弃——Transcript 折叠旧块时对被替换的块调用，让 pi-tui Markdown
   * 的解析缓存随块一起被 GC。只 invalidate 不 dispose，折叠等于没释放（OOM 第二道防线的前提）。
   * dispose 后该块不应再 render；若误用，render 会按 markdown===undefined 分支重新建实例。
   */
  dispose(): void {
    this.cachedLines = undefined;
    this.markdown = undefined;
  }

  render(width: number): string[] {
    if (this.cachedLines !== undefined && this.cachedWidth === width) return this.cachedLines;
    const lines = this.renderItem(width);
    this.cachedLines = lines;
    this.cachedWidth = width;
    return lines;
  }

  /** 最近一次 render 产物中 sixel 序列行的本地行号（仅 user 块非空，缓存命中时为上次值）。 */
  imageRows(): readonly ImageSeqRow[] {
    return this.lastImageRows;
  }

  private renderMarkdown(text: string, width: number, dim: boolean): string[] {
    if (this.markdown === undefined) {
      this.markdown = new Markdown(text, 0, 0, dim ? thinkingMarkdownTheme : markdownTheme, undefined, { transform: mdTransformWithPaths });
    } else {
      this.markdown.setText(text);
    }
    // 安全网：Markdown 组件内部 wrapTextWithAnsi 对长 URL/base64/无空格串不折行，
    // 可能产出宽于 width 的行，触发 pi-tui doRender 的宽度断言。逐行钳到 width。
    const w = Math.max(1, width);
    return this.markdown.render(w).map((l) => truncateToWidth(l, w));
  }

  /**
   * 流式增量的 markdown 渲染：已闭合的前缀段落冻结，每帧只重算尾部。
   *
   * 为什么需要：pi-tui 的 Markdown.render 每帧对整份 growing 文本跑 lexer + 逐 token
   * render，是 O(total)/帧。实测流式输出一个含 200 行代码块的回答，单帧成本从
   * 4.3ms 涨到 23.4ms（5.4x），7254 字符时 45.6ms，远超 16ms 的 60fps 预算，
   * 这就是流式输出时一卡一卡的来源。改增量后同场景增长降到 1.07x。
   *
   * 做法：前缀永不重解析，尾部只重绕未闭合部分。
   *
   * 不变量（改过错两次，记下来）：
   * - frozenText 必须始终是**前缀文本**，frozenLines 是它的渲染行。曾把 frozenText
   *   存成整份文本，结果下一帧 tail 只含新增片段，中间段被整段丢弃（行数 7 vs 23）。
   * - 不能在 invalidate() 里清冻结点。流式追加走 setItem -> invalidate，清了就每帧
   *   退回「全量自证 + tail」两次渲染，比全量还慢一倍。
   * - 冻结点由 renderMarkdownStreaming 自己判失效：宽度/主题变化，或 text 不再以
   *   frozenText 开头（内容被替换而非追加）。
   *
   * 边界安全性：空行分隔不总等于顶层块边界，代码块内部也有空行。所以找边界时要先确认
   * 该位置不在未闭合的 fence 内（fenceBeforeIsClosed）。
   */
  private renderMarkdownStreaming(text: string, width: number, dim: boolean): string[] {
    const w = Math.max(1, width);
    // 失效：宽度或主题变化，或文本不是追加（变短/被替换）
    if (this.frozenWidth !== w || this.frozenDim !== dim || !text.startsWith(this.frozenText)) {
      return this.resetFrozenPrefix(text, w, dim);
    }
    let tailText = text.slice(this.frozenText.length);
    // 冻结点前移：tail 里出现了新的闭合段落，就把它并入冻结前缀（一次性成本）
    const boundary = this.lastSafeBlockBoundary(tailText);
    if (boundary > 0) {
      const newlyFrozen = tailText.slice(0, boundary);
      const newlyFrozenLines = this.renderMarkdown(newlyFrozen, w, dim);
      // 整段赋值而不是 `this.frozenText += newlyFrozen`：`+=` 在 V8 里生成 ConsString，
      // 而上面第 371 行的 `text.startsWith(this.frozenText)` 每帧都要把整条 rope 展平
      // （分配一份全前缀副本），稳态下同时驻留 rope + 展平串两份，且 CPU 是 O(前缀长)/帧。
      // 整段赋值直接拿到 `text` 的切片引用，前缀展平只发生一次。
      this.frozenText = text.slice(0, this.frozenText.length + boundary);
      this.frozenLines = [...this.frozenLines, ...newlyFrozenLines];
      tailText = tailText.slice(boundary);
    }
    if (tailText === "")
      return this.frozenLines;
    const tail = this.renderMarkdown(tailText, w, dim);
    return [...this.frozenLines, ...tail];
  }

  /** 首帧或冻结点失效：全量渲染，并尝试立即建立一个冻结点。 */
  private resetFrozenPrefix(text: string, w: number, dim: boolean): string[] {
    const all = this.renderMarkdown(text, w, dim);
    this.frozenWidth = w;
    this.frozenDim = dim;
    const boundary = this.lastSafeBlockBoundary(text);
    if (boundary > 0) {
      this.frozenText = text.slice(0, boundary);
      this.frozenLines = this.renderMarkdown(this.frozenText, w, dim);
    } else {
      this.frozenText = "";
      this.frozenLines = [];
    }
    return all;
  }

  /**
   * 找 text 中最后一个可安全冻结的块边界（返回边界后一个字符的偏移），找不到返回 -1。
   * 安全性要求：该空行不在未闭合的代码块内。
   */
  private lastSafeBlockBoundary(text: string): number {
    let idx = text.lastIndexOf("\n\n");
    while (idx >= 0) {
      const boundary = idx + 2;
      if (boundary < text.length &&
          text.slice(boundary, boundary + 2) !== "\n\n" &&
          this.fenceBeforeIsClosed(text, idx)) {
        return boundary;
      }
      idx = text.lastIndexOf("\n\n", idx - 1);
    }
    return -1;
  }

  /** text 中 offset 之前的 ``` fence 是否全部闭合（偶数个 fence 行）。 */
  private fenceBeforeIsClosed(text: string, offset: number): boolean {
    const before = text.slice(0, offset);
    const fences = before.split("\n").filter((l) => /^\s*```/.test(l)).length;
    return fences % 2 === 0;
  }

  /**
   * 渲染一条展开内容（查看器复用）：去掉主界面的折叠提示，全文铺开。
   * 与 render 路径共用同一个 Markdown 实例没必要——查看器是低频操作，新建一个即可。
   */
  static renderExpanded(item: Extract<DisplayItem, { kind: 'tool' | 'thinking' | 'monitor' }>, width: number): string[] {
    if (item.kind === 'thinking') {
      const md = new Markdown(item.text, 0, 0, thinkingMarkdownTheme, undefined, { transform: markdownTransform });
      // 压灰同主界面：查看器里也不该出现半灰半白
      const w = Math.max(1, width - 2);
      return dimAll(md.render(w).map((l) => truncateToWidth(l, w)));
    }
    if (item.kind === 'monitor') {
      // Monitor 区块展开：显示全部批次，每批之间空行分隔
      const w = Math.max(1, width - 2);
      const text = item.batches.join('\n\n');
      return wrap(text, w).map((l) => c.dim(l));
    }
    return renderToolExpanded(item, width);
  }


  /** 用户条目的图片渲染：解码 PNG 后用 half-block 字符画追加在正文之后。
   *  解码失败或超出像素预算时降级为一行 dim 文本，不抛异常——渲染路径上的异常会冒泡成
   *  uncaughtException 直接杀进程。缩进两空格，与正文的 '│ ' 前缀视觉对齐。
   *
   *  同时返回每张 sixel 图的序列行在产物中的本地行号（seqRows）：sixel 序列行是该图
   *  占位区的末行（前面 rows-1 行是空占位），预览浮层的点击命中与文档行区域登记用它。
   *  降级文本行不进 seqRows（点了也没有原图可预览）。 */
  /**
   * 内联图片区（user 贴图与 read_media 工具结果图共用）：缩略图 + 序列行登记。
   *
   * 同时返回每张 sixel 图的序列行在产物中的本地行号（seqRows）：sixel 序列行是该图
   * 占位区的首行（后面 rows-1 行是空占位），预览浮层的点击命中与文档行区域登记用它。
   * 降级文本行不进 seqRows（点了也没有原图可预览）。
   */
  private renderInlineImages(
    images: readonly { base64: string; mediaType: string }[],
    width: number,
  ): { lines: string[]; seqRows: ImageSeqRow[] } {
    if (images.length === 0) return { lines: [], seqRows: [] };
    const out: string[] = [];
    const seqRows: ImageSeqRow[] = [];
    // 缩略图化：转录区里只放小图（单图 ≤24×12 格、多图 10 格宽），点击进预览看
    // 全尺寸。大图直接全宽渲染既占屏幕又让 100KB 级序列进入差分重绘路径（滚动
    // 时反复重画，闪烁与卡顿的来源之一）。并排布局未做，多张纵向排列。
    const available = Math.max(8, width - 6);
    for (const [imgIdx, img] of images.entries()) {
      const decoded = decodePNG(Buffer.from(img.base64, 'base64'));
      if (decoded === null) {
        out.push(c.dim(`  [图片无法渲染：${img.mediaType}]`));
        continue;
      }
      const { cols, rows } = thumbnailCells(decoded.width, decoded.height, images.length, available);
      const imgLines = new ImageBlock(decoded, cols, rows).render(cols).map((l) => `  ${l}`);
      // 序列行是 ImageBlock 产物的首行（位置无关布局：序列在前、空占位在后）
      seqRows.push({ row: out.length, imgIdx, rows: imgLines.length });
      out.push(...imgLines);
    }
    return { lines: out, seqRows };
  }

  private renderUser(it: Extract<DisplayItem, { kind: 'user' }>, width: number): string[] {
    // 压缩保真原话（user_verbatim）：降权显示——去掉整行黄底、改 dim 灰色、加「原话」标记前缀。
    // 为何必须区分：压缩过的长会话 resume 后，保真原话与真人输入在此一视同仁都高亮成黄泡，
    // 结果是「满屏用户消息」掩盖模型输出（2026-08-18 实测会话 122e9c：14 条原话堆顶部）。
    // 真人输入仍是高亮黄底，两相对比才分得出「这是你刚说的」还是「那是早先保留下来的」。
    const bodyLines = wrap(it.text, width - 2);
    const bg = c.userBg;
    if (it.turnNum !== undefined) {
      // 带轮次编号的 prompt 可点击：OSC 8 超链接包裹正文，点击后跳转到该轮输入框
      const url = `step://turn/${it.turnNum}`;
      const linked = bodyLines.map((l) => {
        const plain = bg(c.userText(l));
        return hyperlink(plain, url);
      });
      // 在首行前注入 OSC 133 A 语义标记，供 pi-tui scrollToPrompt（Ctrl+Shift+↑/↓）定位。
      // 必须在 indent/hanging 前缀之前，使标记处于行首（scrollContentLines 正则 ^ 锚定位置 0）。
      const prependMarker = (lines: string[]): string[] => {
        if (lines.length > 0) lines[0] = PROMPT_MARKER + lines[0]!;
        return lines;
      };
      if (it.verbatim === true) {
        return prependMarker([...hanging(linked, c.dim('┊ 原话 '), 2), '']);
      }
      return prependMarker([...indent(linked, bg(c.user('│ '))), '']);
    }
    // 无轮次编号（开源模型/旧快照不可点）
    if (it.verbatim === true) {
      const body = bodyLines.map((l) => c.dim(l));
      return [...hanging(body, c.dim('┊ 原话 '), 2), ''];
    }
    const body = bodyLines.map((l) => bg(c.userText(l)));
    return [...indent(body, bg(c.user('│ '))), ''];
  }

  private renderItem(width: number): string[] {
    const it = this.item;
    switch (it.kind) {
      case 'welcome':
        return renderWelcome(it.data, width);
      case 'user': {
        const body = this.renderUser(it, width);
        const images = this.renderInlineImages(it.images ?? [], width);
        // 图片区域登记：sixel 序列行的本地行号存字段，Transcript 汇总成文档行区域表
        // （预览浮层的点击命中用）。注意偏移——seqRows 是相对图片产物的行号，
        // 拼进块产物时前面还有正文 body 行，必须加上 body.length。
        this.lastImageRows = images.seqRows.map((s) => ({ ...s, row: body.length + s.row }));
        return [...body, ...images.lines];
      }
      case 'assistant': {
        // 前缀灰色 ●，第一行带前缀，续行对齐
        // 走增量路径：流式输出时每帧只重算尾部未闭合 token，已闭合前缀复用缓存行。
        // 全量路径实测 O(total)/帧，200 行代码块流式时单帧 45ms，见 renderMarkdownStreaming 注释。
        const md = this.renderMarkdownStreaming(it.text, width - 2, false);
        return [...hanging(md, c.dim('● '), 2), ''];
      }
      case 'thinking': {
        // thinking 只走灰色（dimAll），左侧不带装饰符——与黄色状态栏已足以标识
        // 同样走增量路径：thinking 也是流式追加的正文。
        const rendered = dimAll(this.renderMarkdownStreaming(it.text, width - 2, true));
        if (rendered.length <= THINKING_FOLD_LINES) return [...hanging(rendered, '  ', 2), ''];
        const head = rendered.slice(0, THINKING_FOLD_LINES);
        const folded = c.dim(`  … 还有 ${rendered.length - THINKING_FOLD_LINES} 行（Ctrl+O 查看）`);
        return [...hanging(head, '  ', 2), folded, ''];
      }
      case 'note':
        return [...hanging(wrap(c.note(it.text), width - 2), c.note('· '), 2), ''];
      case 'error':
        return [...hanging(wrap(c.error(it.text), width - 2), c.error('✗ '), 2), ''];
      case 'tool': {
        // read_media 等工具回传的图片挂在结果体之后：与 user 贴图同一套缩略图 + 区域
        // 登记（点击进预览）。tool 的 renderTool 有多个 early return，图片在外层拼
        // 才能覆盖所有分支。
        const body = this.renderTool(it, width);
        const images = this.renderInlineImages(it.images ?? [], width);
        this.lastImageRows = images.seqRows.map((s) => ({ ...s, row: body.length + s.row }));
        return [...body, ...images.lines];
      }
      case 'goalPanel':
        return [...wrap(`goal: ${it.data.objective}`, width - 2).map((l) => c.accent(l)), ''];
      case 'foldSummary':
        // 逐回合折叠的摘要占位：一行 dim，告知更早的块已被折成摘要释放内存。
        // 正文/user/assistant 不折叠（用户最常回看），只有 tool/thinking 等旧块进摘要。
        return [...hanging(wrap(c.dim(`↳ 折叠了 ${it.count} 个旧块（更早的轮次，仍在历史中）`), width - 2), c.dim('· '), 2), ''];
      case 'monitor': {
        // Monitor 监听区块：折叠时显示最后一批摘要 + 批次计数，展开时显示全部批次。
        const total = it.batches.length;
        const last = it.batches[total - 1] ?? '';
        const lastLines = last.split('\n').filter((l) => l !== '');
        const summary = lastLines.length > 0 ? lastLines[lastLines.length - 1]! : '';
        const head = c.dim(
          it.collapsed
            ? `◈ monitor ${it.taskId}（${total} 批）${summary ? `：${summary}` : ''}（Ctrl+O 展开）`
            : `◈ monitor ${it.taskId}（${total} 批，已展开）`,
        );
        if (it.collapsed) {
          return [...hanging(wrap(head, width - 2), c.dim('· '), 2), ''];
        }
        // 展开：显示全部批次，每批之间空行分隔
        const allText = it.batches.join('\n\n');
        const body = wrap(allText, width - 4).map((l) => c.dim(l));
        return [...hanging([head, ...body], c.dim('· '), 2), ''];
      }
      case 'cron':
        // cron prompt 可能很长（几百字符），必须先 wrap 再逐行着色。
        // 原来直接 `c.accent(prompt)` 整段当一行返回，992 字符 > 67 列终端宽度
        // → pi-tui doRender 断言崩溃（2026-08-17 第二次宽度溢出）。
        // 先 wrap 再 map(c.accent)：每个换行后的子行独立着色，不丢失颜色。
        return [...wrap(`cron: ${it.data.prompt ?? ''}`, width - 2).map((l) => c.accent(l)), ''];
      default:
        return [];
    }
  }

  private renderTool(it: Extract<DisplayItem, { kind: 'tool' }>, width: number): string[] {
    // 出口钳宽：本函数所有 return 都必须过 clamp。summary/shell/offload 等提前 return 的分支
    // 曾绕过底部统一钳宽——summarizeResult 按固定 80 字符截断，加上 `    ↳ ` 前缀后 84 列，
    // 在 67 列终端直接触发 pi-tui doRender 宽度断言崩溃（2026-08-24 两次：69>67、84>67，
    // 崩溃行均为 shell 结果摘要行）。
    const clamp = (lines: string[]): string[] => lines.map((l) => truncateToWidth(l, width));
    const mark = it.status === 'running' ? c.warn(spinnerFrame()) : it.status === 'ok' ? c.ok('✓') : c.error('✗');
    const elapsed =
      it.status === 'running' && it.startedAt !== undefined
        ? c.dim(t('toolCall.elapsed', { s: Math.max(0, Math.round((Date.now() - it.startedAt) / 1000)) }))
        : '';
    // 前台任务运行中才提示可转后台。Ctrl+B 转全部前台任务（bash / spawn_agent / dynamic_workflow），
    // 故提示统一落在卡片上。key 名里的 bash 是历史包袱，文案通用，保留不改以免 i18n 分叉。
    const bgHint = it.status === 'running' && CTRL_B_TOOLS.has(it.name) ? c.dim(t('toolCall.bashBackgroundHint')) : '';
    const subagent =
      it.subagentType !== undefined || it.description !== undefined
        ? c.dim(` ${[it.subagentType, it.description].filter((x) => x !== undefined).join(' · ')}`)
        : '';
    const head = `${mark} ${c.toolName(it.name)}${toolArgText(it)}${subagent}${elapsed}${bgHint}`;
    const out = visibleWidth(head) > width ? wrap(head, width) : [head];

    // dynamic_workflow 阶段：运行中逐个列出（● 当前 / ✓ 已完成），终态坍缩成一行计数
    const wf = it.dynamicWorkflow;
    if (wf !== undefined && wf.phases.length > 0) {
      if (it.status === 'running') {
        for (const ph of wf.phases) {
          const m = ph.status === 'running' ? c.warn('●') : c.ok('✓');
          // 阶段标题可能很长（模型自取），窄终端下超宽会触发 doRender 崩溃，故 wrap + 截断。
          out.push(...indent(wrap(c.dim(`${m} ${ph.title}`), width - 4), '    '));
        }
      } else {
        out.push(c.dim(`    ↳ ${wf.phases.length} 个阶段`));
      }
    }

    // 并行折叠：同时运行中的 spawn_agent 达到阈值时，本卡片只出一行摘要。
    // 信息没有丢——头部有总数，Ctrl+O 全屏查看器走 renderExpanded 仍是完整形态（含子工具列表）。
    // 只折运行中的：终态卡片本来就只有 3 行（子工具已折叠成计数），再折省不了多少，
    // 反而让用户回看时看不到哪个子 agent 用了哪些工具。
    if (it.name === 'spawn_agent' && it.status === 'running' && (it.subagentParallel ?? 0) >= SUBAGENT_FOLD_THRESHOLD) {
      const label = [it.subagentType, it.description].filter((x) => x !== undefined).join(' · ');
      const cur = it.subagentToolEvents?.filter((e) => e.status === 'running').at(-1);
      const one = [label, subagentStats(it), cur !== undefined ? `${cur.name}` : ''].filter((x) => x !== '').join(' · ');
      return clamp([`${mark} ${c.toolName(it.name)}${one !== '' ? c.dim(` ${one}`) : ''}`]);
    }

    // 子 agent 进度：统计段 + 嵌套工具事件（运行中显示最近 3 条，完成后折叠计数），直接挂在卡片上
    const stats = subagentStats(it);
    if (stats !== '') out.push(...indent(wrap(c.dim(stats), width - 4), '    '));
    const sub = it.subagentToolEvents;
    if (sub !== undefined && sub.length > 0) {
      if (it.status === 'running') {
        for (const ev of sub.slice(-3)) {
          const m = ev.status === 'running' ? spinnerFrame() : ev.status === 'ok' ? '✓' : '✗';
          out.push(c.dim(`    ${m} ${ev.name}`));
        }
      } else {
        out.push(c.dim(`    ↳ ${sub.length} 个子工具调用`));
      }
    }

    if (it.result !== undefined && it.result !== '' || it.resultFile !== undefined) {
      // 结果已 offload 到文件：不再有 result 字段，只显示文件路径
      if (it.resultFile !== undefined && it.result === undefined) {
        const fname = basename(it.resultFile);
        out.push(c.dim(`    ↳ 输出已保存至 ${linkPath(fname, it.resultFile)}（Ctrl+O 查看）`));
        out.push('');
        return clamp(out);
      }
      // 超大结果提前 offload（仅在 result 字段存在时检查）
      if (it.result !== undefined && it.result.length > MAX_INLINE_CHARS) {
        const cached = offloadLargeResult(it.name, it.result);
        if (cached !== undefined) {
          const fname = basename(cached);
          out.push(c.dim(`    ↳ 输出 ${formatBytes(it.result.length)} → ${linkPath(fname, cached)}（Ctrl+O 查看）`));
          out.push('');
          return clamp(out);
        }
      }

      const resultText = it.result ?? '';
      if (resultText === '') { out.push(''); return clamp(out); }

      // Pre-truncation: for huge outputs, only process enough chars for visible preview lines.
      // Without this, split('\n') on a 64MB output allocates millions of entries → OOM crash.
      // Bound processing to preview lines × width × 4 to avoid OOM on split('\n').
      const maxProcessChars = Math.max(ERROR_PREVIEW_LINES, DIFF_MAX_LINES, RESULT_PREVIEW_LINES) * Math.max(width - 4, 10) * 4;
      const isProcessTruncated = resultText.length > maxProcessChars;
      const processText = isProcessTruncated ? resultText.slice(0, maxProcessChars) : resultText;
      // Approximate total lines for hint messages: estimate from byte length / avg line length.
      const resultTotalLines = isProcessTruncated
        ? Math.max(1, Math.floor(resultText.length / 20))
        : resultText.split('\n').length;

      const renderer = getToolRenderer(it.name);
      const lines = processText.split('\n');

      // 错误优先于展示模式：shell/summary 平时藏正文，但失败时用户必须看到报错本体
      // （bash 失败只剩一行统计曾把错误输出整个吞掉，M1 起的测试钉住错误预览行为）。
      if (it.status === 'error') {
        for (const l of lines.slice(0, ERROR_PREVIEW_LINES)) {
          out.push(...indent(wrap(c.error(linkifyAbsolutePaths(l)), width - 4), '    '));
        }
        if (resultTotalLines > ERROR_PREVIEW_LINES) {
          out.push(c.dim(`    ↳ 还有 ${resultTotalLines - ERROR_PREVIEW_LINES} 行（Ctrl+O 查看）`));
        }
      } else if (renderer.bodyMode === 'summary') {
        // 摘要型工具：body 为空，只显示统计芯片
        const stats = outputStats(resultText);
        out.push(c.dim(`    ↳ ${stats.lines} 行 / ${formatBytes(stats.chars)}`));
        if (stats.lines > 0) {
          out.push(c.dim(`    ↳ ${summarizeResult(it.name, resultText)}`));
        }
        out.push('');
        return clamp(out);
      } else if (renderer.bodyMode === 'shell') {
        // 命令型工具：显示执行了什么命令 + 输出统计，不展示输出体
        const cmdPreview = summarizeToolInput(it.name, it.input);
        if (cmdPreview !== '') {
          out.push(c.dim(`    $ ${cmdPreview}`));
        }
        const stats = outputStats(resultText);
        out.push(c.dim(`    ↳ ${stats.lines} 行 / ${formatBytes(stats.chars)}`));
        if (stats.lines > 0) {
          out.push(c.dim(`    ↳ ${summarizeResult(it.name, resultText)}`));
        }
        out.push('');
        return clamp(out);
      } else if (looksLikeDiff(lines)) {
        let added = 0, removed = 0;
        for (const l of lines) {
          const row = DIFF_ROW_RE.exec(l);
          if (row !== null) { if (row[2] === '+') added++; else removed++; }
          else if (!/^[+-]\d+ /.test(l)) {
            if (l.startsWith('+') && !l.startsWith('+++')) added++;
            else if (l.startsWith('-') && !l.startsWith('---')) removed++;
          }
        }
        if (added > 0 || removed > 0) {
          out.push(c.dim(`    ↳ ${added > 0 ? c.ok(`+${added} `) : ''}${removed > 0 ? c.error(`-${removed}`) : ''}`));
        }
        for (const l of lines.slice(0, DIFF_MAX_LINES)) {
          out.push(...indent(wrap(colorDiffLine(l), width - 4), '    '));
        }
        if (resultTotalLines > DIFF_MAX_LINES) {
          out.push(c.dim(`    ↳ 还有 ${resultTotalLines - DIFF_MAX_LINES} 行（Ctrl+O 查看）`));
        }
      } else {
        // 截断模式：按 previewLines 展示首部或尾部，其余折叠
        const previewLines = renderer.previewLines ?? RESULT_PREVIEW_LINES;
        const useTail = renderer.tail ?? false;
        if (useTail && resultTotalLines > previewLines) {
          const hidden = resultTotalLines - previewLines;
          out.push(c.dim(`    ↳ …(${hidden} earlier lines)`));
          for (const l of lines.slice(-previewLines)) {
            out.push(...indent(wrap(linkifyAbsolutePaths(l), width - 4), '    '));
          }
        } else {
          for (const l of lines.slice(0, previewLines)) {
            out.push(...indent(wrap(linkifyAbsolutePaths(l), width - 4), '    '));
          }
          if (resultTotalLines > previewLines) {
            const remaining = resultTotalLines - previewLines;
            out.push(c.dim(`    ↳ 还有 ${remaining} 行（Ctrl+O 查看）`));
          }
        }
      }
    }
    out.push('');
    // 全局兜底：任何遗漏的超宽行（长无空格串、未来新增分支）都被钳到 width，
    // 避免触发 pi-tui doRender 的宽度断言崩溃。与 pickers.render 同款防线。
    // 注意提前 return 的分支不经过这里，必须各自走 clamp（见函数开头注释）。
    return clamp(out);
  }
}

/** 工具参数摘要的着色文本（主界面卡片与 Ctrl+O 展开态共用，避免两处漂移）。 */
function toolArgText(it: Extract<DisplayItem, { kind: 'tool' }>): string {
  if (it.forming === true) {
    // 参数流式中：input 还是空对象，从半截 JSON 里抠关键字段做预览（填参数流的等待空窗）。
    const preview = extractArgsPreview(it.partialArgs ?? '');
    return c.dim(preview !== '' ? `  ${preview}…` : '  参数成形中…');
  }
  const arg = summarizeInput(it.input);
  if (arg === '') return '';
  // 两个空格：单空格时 `write_file src/x.ts` 读起来像一个词组，双空格才分得出「工具」与「操作对象」
  // 路径类工具的摘要就是路径：包 file:// 链接，点击交给系统打开（PiChat.handleUrlClick）
  const linked = linkFilePathArg(it.input, arg);
  return it.name === 'skill' ? c.toolArgSkill(`  ${linked}`) : c.toolArg(`  ${linked}`);
}

/**
 * 从半截工具参数 JSON 里抠出第一个已知关键字段做预览。
 * 正则容忍未闭合的字符串（[^"]* 匹配到串尾），半截 JSON 也能抠出值。
 * 字段优先级按「用户最想知道工具要动什么」排：路径/命令/模式/查询词。
 */
export function extractArgsPreview(partialJson: string): string {
  const KEYS = ['file_path', 'path', 'command', 'pattern', 'query', 'url', 'prompt'];
  for (const key of KEYS) {
    const m = new RegExp(`"${key}"\\s*:\\s*"([^"]{0,60})`).exec(partialJson);
    if (m !== null && m[1] !== undefined && m[1] !== '') return `${key}=${m[1]}`;
  }
  return '';
}

/**
 * 查看器用：工具结果全文铺开（不折叠、不截断），diff 保持着色。
 * 头部状态行/子工具列表沿用 renderTool 的口径，这里只重做结果体。
 */
function renderToolExpanded(it: Extract<DisplayItem, { kind: 'tool' }>, width: number): string[] {
  const mark = it.status === 'running' ? c.warn(spinnerFrame()) : it.status === 'ok' ? c.ok('✓') : c.error('✗');
  const subagent =
    it.subagentType !== undefined || it.description !== undefined
      ? c.dim(` ${[it.subagentType, it.description].filter((x) => x !== undefined).join(' · ')}`)
      : '';
  const head = `${mark} ${c.toolName(it.name)}${toolArgText(it)}${subagent}`;
  const out = visibleWidth(head) > width ? wrap(head, width) : [head];

  // 结果在文件里（offload）：从文件读取
  const cachedResult = it.resultFile !== undefined && it.result === undefined
    ? readCachedOutput(it.resultFile)
    : undefined;
  const resultText = cachedResult ?? it.result ?? '';

  if (resultText !== '') {
    // Expanded view: show more but still protect against OOM on massive outputs.
    // 20x the collapsed limit = enough for practical full-output inspection while
    // capping absolute memory (e.g. 3 * 63 * 4 * 20 ≈ 15 KB  for narrow terminal).
    const maxProcessChars = Math.max(ERROR_PREVIEW_LINES, DIFF_MAX_LINES, RESULT_PREVIEW_LINES) * Math.max(width - 4, 10) * 4 * 20;
    const isProcessTruncated = resultText.length > maxProcessChars;
    const processText = isProcessTruncated ? resultText.slice(0, maxProcessChars) : resultText;
    const lines = processText.split('\n');

    if (it.status === 'error') {
      for (const l of lines) out.push(...indent(wrap(c.error(linkifyAbsolutePaths(l)), width - 4), '    '));
    } else if (looksLikeDiff(lines)) {
      for (const l of lines) {
        out.push(...indent(wrap(colorDiffLine(l), width - 4), '    '));
      }
    } else {
      for (const l of lines) out.push(...indent(wrap(linkifyAbsolutePaths(l), width - 4), '    '));
    }
    if (isProcessTruncated) {
      out.push(c.dim(`    ↳ 输出过长，仅展示前 ${lines.length} 行`));
    }
  }
  out.push('');
  return out.map((l) => truncateToWidth(l, width));
}

/**
 * 历史说明：终端图片渲染支持已于 2026-09-22 拆除。
 *
 * pi-tui 的能力检测对 Windows Terminal 恒报 images:null（框架硬编码），内联 kitty
 * 序列在 WT alt-screen 下从未走通，曾按「检测 WT ≥1.22 则强制启用 kitty」打过补丁
 * （ src/tui-pi/imageCaps.ts，已删），实测在 WT 里留下大片空白占位。让框架支持 WT
 * 图片等于重构其图片层，收益不抵代价，故整条渲染链路（kitty 序列发射、图片实例
 * 缓存、能力探测修正）全部移除，只保留文本计数提示（PiChat 侧拼入结果文本）。
 */
