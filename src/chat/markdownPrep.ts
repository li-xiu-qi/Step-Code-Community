/**
 * Markdown 源文本预处理：合并段落内的软换行。
 *
 * pi-tui 的 Markdown 把段落内单个换行渲染成硬换行，中文「一句一行」会被拆成短行。
 * 这里按行合并连续的非结构行（围栏代码块、表格、列表、标题、引用、分割线不动）；
 * 词内标点（`.-/_:@`）+ 小写/数字续接直接接，保护 URL/路径/标识符不断行。
 */

/** CJK 与全角区间。 */
const CJK_RE = /[⺀-鿿豈-﫿＀-￯　-〿]/u;
/** 词内连接标点：后接小写/数字时换行直接删除（URL、路径、标识符不断行）。 */
const WORD_PUNCT_RE = /[.\-/_:@]/;
const LOWER_NUM_RE = /[a-z0-9]/;

/**
 * 结构行判定：这些行不参与合并（自身是 Markdown 结构，或合并会破坏语义）。
 * 空行返回 true——它本身就是段落边界，由它天然截断连续段。
 */
function isStructural(line: string): boolean {
  const t = line.trimStart();
  if (t === '') return true;
  if (t.startsWith('#')) return true; // ATX 标题
  if (t.startsWith('|')) return true; // 表格行
  if (t.startsWith('>')) return true; // 引用
  if (t.startsWith('- ') || t.startsWith('* ') || t.startsWith('+ ')) return true; // 无序列表
  if (/^\d+[.)]\s/.test(t)) return true; // 有序列表
  if (t.startsWith('```') || t.startsWith('~~~')) return true; // 围栏（主循环另做状态跟踪，这里兜底）
  if (/^(---+|\*\*\*+|___+)$/.test(t)) return true; // 分割线 / setext 二级标题线
  if (/^ {4}\S/.test(line)) return true; // 缩进代码块
  return false;
}

/**
 * 合并段落内的软换行。规则：
 * - 任一侧 CJK → 直接接（中文不加空格）
 * - 前行尾是词内标点且后行首是小写/数字 → 直接接（保护 URL/路径）
 * - 其余 → 补一个空格（拉丁词间）
 */
export function softenBreaks(source: string): string {
  const lines = source.split('\n');
  const out: string[] = [];
  let inFence = false;
  for (const line of lines) {
    const t = line.trimStart();
    if (t.startsWith('```') || t.startsWith('~~~')) inFence = !inFence;
    const prev = out.length > 0 ? out[out.length - 1]! : undefined;
    if (inFence || prev === undefined || isStructural(line) || isStructural(prev)) {
      out.push(line);
      continue;
    }
    const a = prev.trimEnd().slice(-1);
    const b = t.slice(0, 1);
    if (CJK_RE.test(a) || CJK_RE.test(b) || (WORD_PUNCT_RE.test(a) && LOWER_NUM_RE.test(b))) {
      out[out.length - 1] = prev.trimEnd() + t;
    } else {
      out[out.length - 1] = `${prev.trimEnd()} ${t}`;
    }
  }
  return out.join('\n');
}

/** pi-tui Markdown 的 transform 入口签名适配（忽略可用宽度参数，合并不依赖宽度）。 */
export function markdownTransform(markdown: string): string {
  return stripUnsafeLinks(softenBreaks(markdown));
}

/**
 * 可安全渲染成 OSC 8 超链接的 URL scheme 白名单。
 *
 * 终端在点击超链接时按 scheme 派发 handler，所以渲染成链接等于把「点击即执行」
 * 的权限交给 URL 的提供方。模型输出、工具结果、以及任何进入正文的外部文本都
 * 可能携带链接，其中 prompt injection 的典型手法就是塞一个 `ssh:` 或 `vnc:` 之类的
 * 目标。白名单之外的 scheme 一律降级为纯文本。
 *
 * 放行 `step-file:` 与 `step://` 是本项目内部 scheme（`fileLink.ts` 的路径链接与
 * 轮次跳转），`file://` 与 `https?://` 是用户预期内的两类。
 *
 * 白名单只放自家 scheme 与用户预期内的两类协议（file 与 http(s)），
 * 其余一律不建链。
 */
const RENDERABLE_URL_RE = /^(?:step-file:|step:\/\/|file:\/\/|https?:\/\/)/i;

/**
 * Markdown 行内链接：`[text](url)` 或 `[text](url "title")`。
 *
 * URL 主体允许一层嵌套圆括号（`(?:[^()\s]|\([^()\s]*\))+`），否则
 * `javascript:alert(1)` 这类载荷会在第一个右括号处截断，替换后残留一个孤立的
 * `)`，既没拦住链接又破坏了正文。title 段可选且必须双引号包裹。
 */
const MD_LINK_RE = /\[([^\]\n]*)\]\(\s*((?:[^()\s]|\([^()\s]*\))+)(?:\s+"[^"]*")?\s*\)/g;

/**
 * 把 scheme 不在白名单的 markdown 链接降级为纯文本。
 *
 * 顺序必须在 softenBreaks 之后：软换行可能把一个 URL 折断在两行，先合并才能
 * 拿到完整的 URL 判定 scheme。
 *
 * 显示文本为空时原样保留，避免正则误伤把内容整段吃掉。
 */
export function stripUnsafeLinks(markdown: string): string {
  return markdown.replace(MD_LINK_RE, (whole: string, text: string, url: string) => {
    if (RENDERABLE_URL_RE.test(url)) return whole;
    if (text.trim() === '') return whole;
    return text;
  });
}
