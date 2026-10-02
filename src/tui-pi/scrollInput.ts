import { sliceByColumn, visibleWidth } from '@earendil-works/pi-tui';

/**
 * 单行输入的可视区渲染：长文本横向滚动，光标始终留在可视区内，
 * 避免被 truncateToWidth 从末尾截断成省略号（ask_user 的 Other 输入与审批反馈附言同病灶）。
 *
 * 光标用反显（reverse video）叠在当前字符上，与 pi-tui 的 Input 组件风格一致。
 * 占位符由调用方处理——空文本时传空串即可，调用方自行拼反显光标 + 暗色占位符。
 *
 * 光标按 code-unit 定位，与 QuestionPrompt / ChoiceBlock 现有编辑逻辑一致（均用字符串 slice）。
 *
 * @param value    完整文本
 * @param cursor   光标在 value 中的 code-unit 位置
 * @param maxWidth 可用宽度（列数）
 * @returns 带反显光标的可见文本，宽度不超过 maxWidth
 */
export function renderScrolledInput(value: string, cursor: number, maxWidth: number): string {
  const width = Math.max(1, Math.floor(maxWidth));
  const cur = Math.max(0, Math.min(cursor, value.length));
  const totalWidth = visibleWidth(value);
  const rev = (ch: string): string => `\x1b[7m${ch || ' '}\x1b[27m`;

  let visibleText: string;
  let cursorDisplay: number;
  if (totalWidth < width) {
    // 全部放得下
    visibleText = value;
    cursorDisplay = cur;
  } else {
    // 横向滚动：按光标列算可见窗口，把光标保持在可视区（与 pi-tui Input.render 同算法）
    const cursorCol = visibleWidth(value.slice(0, cur));
    const scrollWidth = Math.max(1, width - 1); // 留 1 列给光标（末尾光标占 1 列）
    const halfWidth = Math.floor(scrollWidth / 2);
    let startCol = 0;
    if (cursorCol > halfWidth) {
      startCol =
        cursorCol > totalWidth - halfWidth
          ? Math.max(0, totalWidth - scrollWidth)
          : Math.max(0, cursorCol - halfWidth);
    }
    visibleText = sliceByColumn(value, startCol, scrollWidth, true);
    const beforeCursor = sliceByColumn(value, startCol, Math.max(0, cursorCol - startCol), true);
    cursorDisplay = beforeCursor.length;
  }

  // 在光标处插入反显字符（code-unit 对齐，与编辑逻辑一致）
  const atCursor = cursorDisplay < visibleText.length ? visibleText.slice(cursorDisplay, cursorDisplay + 1) : ' ';
  return visibleText.slice(0, cursorDisplay) + rev(atCursor) + visibleText.slice(cursorDisplay + 1);
}

/** 光标（code-unit 下标）所在的逻辑行号与行内列。 */
export function lineColFromIndex(text: string, index: number): { line: number; col: number } {
  const idx = Math.max(0, Math.min(index, text.length));
  let line = 0;
  let lineStart = 0;
  for (let i = 0; i < idx; i++) {
    if (text[i] === '\n') {
      line++;
      lineStart = i + 1;
    }
  }
  return { line, col: idx - lineStart };
}

/** 逻辑行号 + 行内列换算回 code-unit 下标（列超行尾则钳到行尾）。 */
export function indexFromLineCol(text: string, line: number, col: number): number {
  const lines = text.split('\n');
  const ln = Math.max(0, Math.min(line, lines.length - 1));
  let idx = 0;
  for (let i = 0; i < ln; i++) idx += lines[i]!.length + 1;
  return idx + Math.max(0, Math.min(col, lines[ln]!.length));
}

/**
 * 多行输入的可视区渲染：逻辑行逐行画出，光标行走 renderScrolledInput 横向滚动，
 * 其余行从头显示（超宽截尾）。行数超 maxLines 时纵向开窗、光标行保持可见，
 * 被遮住的行用暗色省略行指示数量。
 *
 * @param value    完整文本（可含 \n）
 * @param cursor   光标在 value 中的 code-unit 位置
 * @param maxWidth 每行可用宽度（列数）
 * @param maxLines 最多显示的逻辑行数
 */
export function renderMultilineInput(value: string, cursor: number, maxWidth: number, maxLines: number): string[] {
  const width = Math.max(1, Math.floor(maxWidth));
  const cap = Math.max(1, Math.floor(maxLines));
  const lines = value.split('\n');
  const { line: cursorLine, col: cursorCol } = lineColFromIndex(value, cursor);

  // 纵向开窗：光标行优先，向上挤不下再向下借
  let start = Math.max(0, Math.min(cursorLine - Math.floor(cap / 2), lines.length - cap));
  const end = Math.min(lines.length, start + cap);
  start = Math.max(0, end - cap);

  const out: string[] = [];
  // 省略指示用紧凑形态（…↑N / …↓N）：弹层边框宽度按最长行算，长文案会被边框截断
  if (start > 0) out.push(`\x1b[2m…↑${start}\x1b[22m`);
  for (let i = start; i < end; i++) {
    if (i === cursorLine) {
      out.push(renderScrolledInput(lines[i]!, cursorCol, width));
    } else {
      const l = lines[i]!;
      out.push(visibleWidth(l) > width ? `${sliceByColumn(l, 0, width - 1, true)}…` : l);
    }
  }
  const hiddenBelow = lines.length - end;
  if (hiddenBelow > 0) out.push(`\x1b[2m…↓${hiddenBelow}\x1b[22m`);
  return out;
}
