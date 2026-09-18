/**
 * 正文里的绝对路径可点击化：扫出路径形状的文本，包成 step-file: 链接。
 *
 * 只认绝对路径（Windows 盘符 C:\ 或 POSIX 根 /）：相对路径要按会话 cwd 解析，
 * 而本渲染层拿不到 cwd（ItemBlock/Transcript 都不携带），误解析比不可点更糟。
 * 需要相对路径可点时先把 cwd 透传进渲染层，再放宽判定。
 *
 * 保守判定（宁可不点也不点错）：
 * - 末段必须有扩展名（.ts/.md 等）或以分隔符结尾（目录）——避免把普通词组当路径；
 * - 前导字符不能是词字符（防止 URL 中间段 /a/b.js 被扫出来建链）；
 * - 不在已有 OSC 8 链接内（防嵌套）、不在围栏代码块内（示例代码常含不可点的路径）；
 * - 中文标点处切断、句尾标点剥掉、扩展名之后的冒号后缀（grep 风格 :42:match）剥掉
 *   （链接目标是文件，没有行号跳转）。
 *
 * 顺序必须在 softenBreaks 之后调用：软换行可能把 URL 折断在两行，
 * 先合并才能拿到完整的 URL 判定前导字符。
 */
import { hyperlink } from '@earendil-works/pi-tui';
import { buildFileUrl, isSafeLinkPath } from './fileLink.js';

/** 绝对路径起点：Windows 盘符（C:\ 或 C:/）或 POSIX 根 /。 */
const ABS_PATH_RE = /(?:[A-Za-z]:[\\/]|\/)[^\s"'`*?<>|()[\]{}]+/g;
/** 句尾标点（含中文标点）：剥掉后再建链。 */
const TRAILING_JUNK_RE = /[.,;:!?)\]}>'"、，；：！？）】〕》」』]+$/;
/** 扩展名（末段）：.ts/.md 这类，末段必须以它结尾。 */
const EXT_RE = /\.[A-Za-z0-9]{1,6}$/;
/** 中文标点：正文里路径到此终止（路径名含中文标点的概率极低，切断收益大）。 */
const CJK_PUNCT_RE = /[，。、；：！？（）【】《》「」『』]/;
/** 词字符：前导字符命中说明扫描位置在 URL/标识符中间，不是路径起点。 */
const WORDISH_BEFORE_RE = /[A-Za-z0-9._~:/@-]$/;

const OSC8_OPEN = '\x1b]8;;';
const OSC8_CLOSE = '\x1b]8;;\x1b\\';

/** 已有 OSC 8 超链接的区间（开序列起到闭序列止）。 */
function osc8Regions(text: string): Array<[number, number]> {
  const regions: Array<[number, number]> = [];
  let i = 0;
  for (;;) {
    const s = text.indexOf(OSC8_OPEN, i);
    if (s === -1) break;
    const e = text.indexOf(OSC8_CLOSE, s + OSC8_OPEN.length);
    if (e === -1) break;
    regions.push([s, e + OSC8_CLOSE.length]);
    i = e + OSC8_CLOSE.length;
  }
  return regions;
}

/** 围栏代码块区间（``` 或 ~~~ 起止，按行切换）。 */
function fenceRegions(text: string): Array<[number, number]> {
  const regions: Array<[number, number]> = [];
  let offset = 0;
  let start = -1;
  for (const line of text.split('\n')) {
    const t = line.trimStart();
    const isFence = t.startsWith('```') || t.startsWith('~~~');
    if (isFence && start === -1) start = offset;
    else if (isFence && start !== -1) {
      regions.push([start, offset + line.length]);
      start = -1;
    }
    offset += line.length + 1;
  }
  if (start !== -1) regions.push([start, text.length]);
  return regions;
}

function inRegions(pos: number, regions: Array<[number, number]>): boolean {
  return regions.some(([s, e]) => pos >= s && pos < e);
}

/**
 * 清洗扫描到的路径候选：
 * 1. 中文标点处切断（`/a/b.ts，然后` → `/a/b.ts`；中文路径 `C:\项目\x.md` 不含中文标点，不受影响）；
 * 2. 剥句尾标点；
 * 3. 剥扩展名之后的冒号后缀（grep 风格 `/a/b.ts:42:match` → `/a/b.ts`：
 *    贪心回退后 group 1 落在最后一个扩展名结尾处，行号与匹配内容一并丢弃）。
 */
function cleanPathCandidate(token: string): string {
  let path = token;
  const cjkCut = path.search(CJK_PUNCT_RE);
  if (cjkCut > 0) path = path.slice(0, cjkCut);
  path = path.replace(TRAILING_JUNK_RE, '');
  const extCut = path.match(/^(.*\.[A-Za-z0-9]{1,6})(?::[^\s]*)?$/);
  if (extCut !== null && extCut[1] !== undefined && extCut[1] !== '') path = extCut[1];
  return path;
}

/**
 * 把正文里的绝对路径包成 step-file: 链接。无路径或全部命中跳过条件时原样返回
 * （引用相等，调用方可直接判空短路）。
 */
export function linkifyAbsolutePaths(text: string): string {
  if (text === '' || (!text.includes('/') && !text.includes('\\'))) return text;
  const osc = osc8Regions(text);
  const fences = fenceRegions(text);
  let out = '';
  let last = 0;
  let linked = false;
  ABS_PATH_RE.lastIndex = 0;
  for (let m = ABS_PATH_RE.exec(text); m !== null; m = ABS_PATH_RE.exec(text)) {
    const start = m.index;
    if (inRegions(start, osc) || inRegions(start, fences)) continue;
    // 前导词字符：URL 中间段（example.com/a/b.js）、标识符（foo/bar/x.ts 在句中）
    // 都不该从中间切出来建链
    const before = start > 0 ? text[start - 1]! : '';
    if (WORDISH_BEFORE_RE.test(before)) continue;
    // ]( 前导：markdown 链接的 URL 位（[text](/a/b.ts)），交给 md 解析器
    if (start >= 2 && text.slice(start - 2, start) === '](') continue;
    const path = cleanPathCandidate(m[0]);
    if (path === '') continue;
    const isDir = path.endsWith('/') || path.endsWith('\\');
    const stem = isDir ? path.slice(0, -1) : path;
    // 无扩展名且非目录结尾 → 保守不建链（"a/b" 这类词组不点）
    if (!isDir && !EXT_RE.test(stem)) continue;
    if (!isSafeLinkPath(stem)) continue;
    const url = buildFileUrl(stem);
    if (url === undefined) continue;
    out += text.slice(last, start) + hyperlink(path, url);
    last = start + path.length;
    linked = true;
  }
  if (!linked) return text;
  return out + text.slice(last);
}
