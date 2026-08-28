/**
 * 输入框自动配对（括号 / 引号）：键入开符即插入「开+闭」并把光标放到中间；
 * 光标处已是该闭符时右移越过（type-over），不重复插入。
 *
 * 放在独立模块而非塞进 ChatEditor：配对规则（哪些字符配对、何时不配对）是纯逻辑，
 * 与编辑器实例解耦后才能单测，ChatEditor 只负责把它接到输入流上。
 *
 * 设计参照主流终端编辑器的一致行为（不是对标某具体实现）：
 * - 括号（() [] {}）恒配对，即便跟在字母后（`foo(` → `foo(|)` 是标准预期）。
 * - 引号（" ' `）仅当光标下一字符非字母数字时才配对，避开 `don't` 一类撇号被劈成 `don''t`。
 * - 闭符 type-over：`(|)` 再按 `)` 应右移越过而非再插一个。
 * - 中文括号 / 引号一并纳入，行为与对应英文符一致（）
 *   （中文开闭符是不同的码点，解码逐字符放行，配对逻辑无需区分全角 / 半角）。
 */

/**
 * 可配对的开符 → 闭符。
 * 括号类键入即配对、光标放中间；引号类按 shouldPair 判定（光标下非字母数字才配对）。
 * 中文括号 / 引号一并纳入，行为与对应英文符一致。
 */
export const AUTO_PAIRS: Record<string, string> = {
  // 括号类（恒配对）
  '(': ')',
  '[': ']',
  '{': '}',
  '（': '）',
  '【': '】',
  '《': '》',
  '〈': '〉',
  '〔': '〕',
  '〖': '〗',
  // 引号类（按 shouldPair 的字母数字规则判定）
  '"': '"',
  "'": "'",
  '`': '`',
  '“': '”',
  '‘': '’',
  '「': '」',
  '『': '』',
};

/** 闭符集合（type-over 判定用）。 */
export const CLOSE_CHARS = new Set(Object.values(AUTO_PAIRS));

/** 是否应在当前上下文对开符配对。括号恒配对；引号仅当光标下一字符非字母数字。 */
export function shouldPair(open: string, charAtCursor: string): boolean {
  const isQuote = open === '"' || open === "'" || open === '`' ||
    open === '“' || open === '‘' || open === '「' || open === '『';
  if (isQuote)
    return charAtCursor === '' || !/[A-Za-z0-9]/.test(charAtCursor);
  return true;
}

/**
 * 光标是否夹在配对中间：前一字符是开符、光标处是其闭符。
 * 退格命中此形态时应整对删除（`(|)` 按退格 → 空），否则中间那步「只剩一半括号」卡住。
 */
export function isPairSurrounding(charBefore: string, charAtCursor: string): boolean {
  return charBefore !== '' && AUTO_PAIRS[charBefore] === charAtCursor && charAtCursor !== '';
}

/**
 * 解码可打印字符：kitty CSI-u 序列与裸字符都能还原成单个字符。
 * 非可打印（控制键、箭头、粘贴等）返回 undefined，调用方据此放行给编辑器默认处理。
 */
export function decodePrintable(data: string): string | undefined {
  if (data.length === 1 && data.charCodeAt(0) >= 32)
    return data;
  return undefined;
}

/**
 * 给定键入的原始输入与光标处字符，计算自动配对动作。
 * 纯函数：不碰编辑器，输入输出全可断言，单测直接覆盖各分支。
 *
 * @param data 原始按键数据
 * @param charAtCursor 光标当前所在字符（空串表示行尾）
 */
export function planAutoPair(data: string, charAtCursor: string): { kind: 'none' } | { kind: 'skip-close' } | { kind: 'insert-pair'; text: string } {
  const printable = decodePrintable(data);
  if (printable === undefined)
    return { kind: 'none' };
  // type-over：光标处已是该闭符，右移越过而非重复插入
  if (CLOSE_CHARS.has(printable) && charAtCursor === printable)
    return { kind: 'skip-close' };
  const close = AUTO_PAIRS[printable];
  if (close === undefined)
    return { kind: 'none' };
  if (!shouldPair(printable, charAtCursor))
    return { kind: 'none' };
  return { kind: 'insert-pair', text: printable + close };
}
