import { mkdirSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { backupBeforeWrite } from './checkpoint.js';
import { maybeAutoCommit } from './autoCommit.js';
import { z } from 'zod';
import { resolvePath } from './fsutil.js';
import { fail, ok, type ToolDef } from './types.js';
import { renderDiffClustered } from '../chat/diffView.js';

/** edit 结果预览的 diff 主体最大行数（折叠上限，超出附「N more changes hidden」）。 */
const EDIT_DIFF_MAX_LINES = 40;

/** 完整 diff 落盘目录下最多保留的文件数（与 bash 超大输出落盘同口径）。 */
const MAX_DIFF_FILES = 20;

/**
 * 计算 needle 在 haystack 中的全部起始下标（不重叠）。
 *
 * 用于匹配失败的行号诊断：模型拿到的报错要能直接指到文件里的行，而不是一句
 * 「未找到」让人盲目重试。
 */
function allIndexOf(haystack: string, needle: string): number[] {
  const at: number[] = [];
  let from = 0;
  for (;;) {
    const i = haystack.indexOf(needle, from);
    if (i === -1) break;
    at.push(i);
    from = i + needle.length;
  }
  return at;
}

/** 字符下标转行号（1 起）。 */
function lineAt(text: string, index: number): number {
  let line = 1;
  const end = Math.min(index, text.length);
  for (let i = 0; i < end; i++) {
    if (text[i] === '\n') line++;
  }
  return line;
}

/** 行号列表压成人类可读串：最多展示 limit 个，超出附总数。 */
function formatLineList(lines: number[], limit = 6): string {
  const head = lines.slice(0, limit).join('、');
  return lines.length > limit ? `${head} 等 ${lines.length} 处` : head;
}

/**
 * 匹配失败诊断：为什么 old_string 没找到，以及它可能在哪。
 *
 * 三级排查，逐级给出可执行信息：
 * 1. 空白归一化后能否命中（缩进/tab/CRLF 不一致是最常见原因）→ 报真实行号；
 * 2. 首行能否定位（说明锚点对上了，是后续内容漂移）→ 报首行行号；
 * 3. 都不行 → 只给文件行数，让模型重新 read_file。
 *
 * 只读 text，不改动它；返回给人看的提示行（不含前缀，调用方拼 label）。
 */
function diagnoseMiss(text: string, oldStr: string): string {
  // 1. 空白归一化：把每行的行尾空白与连续空格/tab 折叠后比较
  const normLine = (s: string): string => s.replace(/[ \t]+/g, ' ').replace(/\s+$/, '');
  const normText = text.split('\n').map(normLine).join('\n');
  const normOld = oldStr.split('\n').map(normLine).join('\n');
  const normAt = allIndexOf(normText, normOld);
  if (normAt.length > 0) {
    // normLine 只删行尾空白、折叠空格，不增删换行，故同一下标仍在同一行
    const lines = normAt.map((i) => lineAt(text, i));
    return `原文的空白（缩进/tab/行尾空格）与文件不一致，忽略空白后命中的行：${formatLineList(lines)}。请按 read_file 返回的原文字符复刻。`;
  }
  // 2. 首行定位：至少告诉模型它锚在第一行没错，往后错了
  const firstLine = oldStr.split('\n')[0] ?? '';
  if (firstLine.trim() !== '') {
    const at = allIndexOf(text, firstLine);
    if (at.length > 0) {
      const lines = at.map((i) => lineAt(text, i));
      return `old_string 首行在文件中位于 ${formatLineList(lines)}，但其后内容与文件不一致（可能已被其它编辑改过，或漏抄了中间行）。`;
    }
  }
  // 3. 兜底：给文件规模，暗示可能读的不是当前版本
  const totalLines = text.split('\n').length;
  return `文件当前 ${totalLines} 行，未找到任何相近片段。请重新 read_file 读取当前内容后再试。`;
}

/**
 * 完整 diff 落盘到 `.step-code/tool-output/edit-diff-*.log`，返回相对 cwd 的路径。
 * 磁盘不可写等失败返回 null（调用方退回原提示文案）。超出保留数按 mtime 删最旧。
 */
function saveFullDiff(cwd: string, content: string): string | null {
  try {
    const dir = join(cwd, '.step-code', 'tool-output');
    mkdirSync(dir, { recursive: true });
    const now = new Date();
    const p = (n: number, w = 2): string => String(n).padStart(w, '0');
    const stamp =
      `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}` +
      `-${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}`;
    const name = `edit-diff-${stamp}-${process.pid}.log`;
    writeFileSync(join(dir, name), content, 'utf8');
    // 保留最近 MAX_DIFF_FILES 个，删最旧；清理失败静默（非关键路径）
    const logs = readdirSync(dir)
      .filter((n) => n.startsWith('edit-diff-') && n.endsWith('.log'))
      .map((n) => ({ n, t: statSync(join(dir, n)).mtimeMs }))
      .sort((a, b) => a.t - b.t);
    for (const f of logs.slice(0, Math.max(0, logs.length - MAX_DIFF_FILES))) {
      try {
        unlinkSync(join(dir, f.n));
      } catch {
        // 被占用或已删：跳过
      }
    }
    return `.step-code/tool-output/${name}`;
  } catch {
    return null;
  }
}

const singleEditSchema = z.object({
  old_string: z.string().describe('要被替换的原文，必须与文件中的内容逐字符匹配。'),
  new_string: z.string().describe('替换后的新内容。'),
  replace_all: z
    .boolean()
    .optional()
    .describe('是否替换全部匹配。默认 false，此时 old_string 必须唯一。'),
});

const schema = z
  .object({
    path: z.string().describe('要编辑的文件路径。'),
    /** 单条编辑（与 edits 二选一）。 */
    old_string: z.string().optional().describe('要被替换的原文，必须与文件中的内容逐字符匹配。'),
    /** 单条编辑（与 edits 二选一）。 */
    new_string: z.string().optional().describe('替换后的新内容。'),
    replace_all: z
      .boolean()
      .optional()
      .describe('是否替换全部匹配。默认 false，此时 old_string 必须唯一。'),
    /** 批量编辑（与 old_string/new_string 二选一）。一次调用应用多处修改，减少调用轮次。 */
    edits: z.array(singleEditSchema).optional().describe(
      '批量编辑列表。与 old_string/new_string 二选一。每个元素包含 old_string/new_string/replace_all。',
    ),
  })
  .refine(
    (d) => (d.old_string !== undefined) !== (d.edits !== undefined),
    '必须提供 old_string/new_string 或 edits 其中之一，不可同时提供。',
  );

export const editFileTool: ToolDef<z.infer<typeof schema>> = {
  name: 'edit_file',
  description:
    '对已有文件做精确字符串替换。支持单条编辑或批量编辑。' +
    '用场景：局部修改代码、更新配置值、替换函数实现。' +
    '不用场景：整文件重写——用 write_file；追加内容——用 bash 的 echo >>；大规模结构性改动——重新写整个文件效率更高。',
  schema,
  access: (input, ctx) => ({ kind: 'write', path: resolvePath(ctx.cwd, input.path) }),
  async execute(input, ctx) {
    const abs = resolvePath(ctx.cwd, input.path);

    // Stale Guard：检查文件是否被读过、是否在上次读取后被修改
    const guard = ctx.fileGuard;
    if (guard) {
      const verdict = guard.check(abs);
      if (verdict.kind === 'not-read' || verdict.kind === 'stale' || verdict.kind === 'protected') {
        return fail(verdict.message);
      }
    }

    let text: string;
    try {
      text = readFileSync(abs, 'utf8');
    } catch {
      return fail(`文件不存在或无法读取：${input.path}`);
    }

    // 归一化入参：统一成 edits 数组处理
    type EditEntry = { old_string: string; new_string: string; replace_all?: boolean };
    const entries: EditEntry[] = input.edits
      ? input.edits
      : [{ old_string: input.old_string!, new_string: input.new_string!, replace_all: input.replace_all }];

    // 单条编辑时做同值检查
    if (!input.edits && input.old_string === input.new_string) {
      return fail('old_string 与 new_string 相同，无需编辑。');
    }

    // 换行符处理工具
    const toLF = (s: string): string => s.replace(/\r\n/g, '\n');
    const isCRLF = /\r\n/.test(text);

    // 顺序应用所有 edits
    let searchText = text;
    let normalized = false;
    let totalReplacements = 0;

    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i]!;
      let oldStr = entry.old_string;
      let newStr = entry.new_string;

      let occurrences = searchText.split(oldStr).length - 1;
      if (occurrences === 0 && !normalized) {
        // fallback：归一化换行符后重试匹配
        const normText = toLF(searchText);
        const normOld = toLF(oldStr);
        const normCount = normText.split(normOld).length - 1;
        if (normCount > 0) {
          searchText = normText;
          oldStr = normOld;
          newStr = toLF(newStr);
          occurrences = normCount;
          normalized = true;
        }
      }

      const label = entries.length > 1 ? ` edits[${i}]` : '';
      if (occurrences === 0) {
        return fail(
          `未找到 old_string${label}。\n${diagnoseMiss(searchText, oldStr)}`,
        );
      }
      if (occurrences > 1 && entry.replace_all !== true) {
        // 报错必须能指路：把每处位置的行号列出来，模型才知道该补哪段上下文、
        // 或者确实该用 replace_all。行号基于当前 searchText（前面的 edits 可能已改动过它）。
        const at = allIndexOf(searchText, oldStr);
        const lines = at.map((idx) => lineAt(searchText, idx));
        const shown = formatLineList(lines);
        return fail(
          `old_string${label} 在文件中出现 ${occurrences} 次，不唯一（第 ${shown} 行）。\n` +
            `请补充上下文使其唯一，或设 replace_all=true 全部替换。`,
        );
      }

      const next =
        entry.replace_all === true
          ? searchText.split(oldStr).join(newStr)
          : searchText.replace(oldStr, newStr);
      totalReplacements += entry.replace_all === true ? occurrences : 1;
      searchText = next;
    }

    // 若走了归一化路径，按文件原有 CRLF 风格写回
    let finalText = searchText;
    if (normalized && isCRLF) {
      finalText = finalText.replace(/\r\n/g, '\n').replace(/\n/g, '\r\n');
    }

    try {
      // 文件级 checkpoint：写入前备份原始内容（CRLF 原样、未经归一化），供 /restore 回滚
      backupBeforeWrite(ctx.cwd, abs, 'edit_file');
      writeFileSync(abs, finalText, 'utf8');
      // 写入后刷新快照，避免后续编辑命中自己造成的 stale
      if (guard) guard.track(abs);
      // git 自动提交（config [git] auto_commit = true 时生效）
      maybeAutoCommit(ctx.gitConfig, abs, ctx.cwd);
    } catch (e) {
      return fail(`写入失败：${(e as Error).message}`);
    }

    // 生成改动预览：用归一化 LF 文本算 diff（避免 CRLF 的 \r 干扰行分割）。
    const diffMeta = { truncated: false, hidden: 0 };
    const diffBody = renderDiffClustered(toLF(text), toLF(finalText), input.path, {
      maxLines: EDIT_DIFF_MAX_LINES,
      result: diffMeta,
    });
    if (diffMeta.truncated && diffMeta.hidden > 0) {
      // 截断提示原本让按 Ctrl+O 展开，但被截内容从未进 content，是假承诺。
      // 改为把完整 diff 落盘（不占上下文），提示行换成真实可用的路径。
      const fullDiff = renderDiffClustered(toLF(text), toLF(finalText), input.path, {});
      const saved = saveFullDiff(ctx.cwd, fullDiff.join('\n'));
      if (saved) {
        diffBody[diffBody.length - 1] =
          `     … ${diffMeta.hidden} more change${diffMeta.hidden > 1 ? 's' : ''} hidden · 完整 diff 已存 ${saved}`;
      }
    }
    const editCount = entries.length;
    const summary = editCount > 1
      ? `已编辑 ${input.path}（${editCount} 处编辑，共替换 ${totalReplacements} 处）。`
      : `已编辑 ${input.path}（替换 ${totalReplacements} 处）。`;
    return ok(diffBody.length > 1 ? `${summary}\n${diffBody.join('\n')}` : summary);
  },
};
