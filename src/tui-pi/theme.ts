/**
 * pi-tui 前端的主题层：把 chalk 着色函数装配成 pi-tui 各组件要求的 theme 形状。
 * 集中装配，颜色口径才有单一事实源；各 block 直接引用这里的语义色。
 */
import chalk from 'chalk';
import { highlight, supportsLanguage } from 'cli-highlight';
import type { EditorTheme, MarkdownTheme, SelectListTheme } from '@earendil-works/pi-tui';

/** 语义色。 */
export const c = {
  // 用户消息：前缀蓝色加粗 + 正文黄色 + 整行深灰背景（SGR 48;5;236），背景覆盖整行
  user: (s: string) => chalk.blue.bold(s),
  userText: chalk.yellow,
  userBg: chalk.bgAnsi256(236),
  // 滚动条拇指：前景色细线，不是背景色块。库里 styleScrollbarCell 会把空白格换成
  // 左四分之一块字符（U+258E），用前景色上色就得到一条约 2px 的竖线；若用背景色则是
  // 涂满整个字符格的 8-9px 色块，比终端原生滚动条粗得多，这是「进度条丑」的根因。
  // hover 或按下时库里把 thumb 扩到 2 列：第一列画右半块（U+2590）、第二列画左半块
  // （U+258C），两格拼成一条连续的约 8px 竖条。此前用 3 列全块（U+2588），渲染出来是
  // 24px 的实心墙，比终端原生粗三倍，观感就是「突然变粗一大块很丑」。
  // 曾在此加过一条 hover 才显示的淡轨道，实测帧耗时从 32ms 涨到 98ms，已回滚：
  // styleScrollbarTrackCell 每格要 5 次 sliceWithWidth 全行遍历，100 格就是 500 次，
  // 而 sliceWithWidth 是逐字符 extractAnsiCode + grapheme 分段的原语。相比之下 hover
  // 加宽本身只多 1.7ms，值得留；轨道不值 65ms，不留。测量见
  // tests/tui-pi/scrollbar-perf.bench.ts。
  // Windows Terminal 主屏模式下那条是终端用 Direct2D 画的约 2px 半透明亮灰细线，hover 时
  // 终端自行加宽；alt-screen 下终端滚动条被隐藏只能自己画，这里用字符近似同一观感。#a0a0a0 比上一版 #8b8b8b 亮一档，更接近用户看到的「很细的白色竖线」，
  // 又不至于像纯白那样刺眼。半透明本身在字符格子里无法模拟，只能靠亮度近似「淡」的观感。
  scrollbarThumb: chalk.hex('#a0a0a0'),
  assistant: (s: string) => s,
  thinking: chalk.dim,
  toolName: chalk.cyan,
  // 工具参数用 gray（SGR 90）而非 dim（SGR 2）：dim 的降亮由终端决定，不少配色下暗到读不出
  toolArg: chalk.gray,
  // skill 工具参数用黄色：技能激活会改变后续行为，比读写路径更需要一眼认出激活了哪个
  toolArgSkill: chalk.yellow,
  ok: chalk.green,
  error: chalk.red,
  warn: chalk.yellow,
  note: chalk.gray,
  dim: chalk.gray,
  heading: chalk.bold,
  accent: chalk.magenta,
  bold: chalk.bold,
  logo: chalk.blue,
  // tab 条选中态：反色加粗
  tabActive: (s: string) => chalk.inverse.bold(s),
  /** 权限模式徽章色。 */
  mode: (mode: string) => (mode === 'yolo' ? chalk.red : mode === 'auto' ? chalk.yellow : chalk.green),
};

/**
 * markdown 主题。代码块高亮沿用 cli-highlight，语言不支持时原样返回。
 */
export const markdownTheme: MarkdownTheme = {
  heading: (s) => chalk.bold.cyan(s),
  link: (s) => chalk.cyan.underline(s),
  linkUrl: (s) => chalk.dim(s),
  code: (s) => chalk.yellow(s),
  codeBlock: (s) => s,
  codeBlockBorder: (s) => chalk.gray(s),
  quote: (s) => chalk.dim(s),
  quoteBorder: (s) => chalk.gray(s),
  hr: (s) => chalk.gray(s),
  listBullet: (s) => chalk.cyan(s),
  bold: (s) => chalk.bold(s),
  italic: (s) => chalk.italic(s),
  strikethrough: (s) => chalk.strikethrough(s),
  underline: (s) => chalk.underline(s),
  highlightCode: (code, lang) => {
    if (lang === undefined || lang === '' || !supportsLanguage(lang)) return code.split('\n');
    try {
      return highlight(code, { language: lang, ignoreIllegals: true }).split('\n');
    } catch {
      return code.split('\n');
    }
  },
};

/**
 * 思考块的 markdown 主题。保证全灰的是 dimAll（普通段落不经 theme 函数），
 * 这里只让 highlightCode 直接返回纯文本，省掉「上色再被剥掉」的白做功。
 */
export const thinkingMarkdownTheme: MarkdownTheme = {
  ...markdownTheme,
  heading: (s) => chalk.dim(s),
  code: (s) => chalk.dim(s),
  bold: (s) => chalk.dim(s),
  italic: (s) => chalk.dim(s),
  /** 列表 bullet 去掉：thinking 只留纯灰色文字，不需要装饰符号 */
  listBullet: () => '',
  highlightCode: (code) => code.split('\n').map((l) => chalk.dim(l)),
};

/**
 * 把渲染好的行统一压灰：先剥掉全部 SGR，再整行套 dim。
 * 普通段落不经 theme 函数、Markdown 原样输出为默认白，逐项配主题治不了，只能整行剥色再压灰。
 * 只剥 SGR（\x1b[...m），不动 OSC 8 超链接序列。
 */
export function dimAll(lines: readonly string[]): string[] {
  return lines.map((l) => {
    const stripped = l.replace(/\x1b\[[0-9;]*m/g, '');
    return stripped === '' ? '' : chalk.dim(stripped);
  });
}

export const selectListTheme: SelectListTheme = {
  selectedPrefix: (s) => chalk.cyan(s),
  selectedText: (s) => chalk.cyan.bold(s),
  description: (s) => chalk.gray(s),
  scrollInfo: (s) => chalk.gray(s),
  noMatch: (s) => chalk.gray(s),
};

export const editorTheme: EditorTheme = {
  borderColor: (s) => chalk.gray(s),
  selectList: selectListTheme,
};
