/**
 * 工具结果渲染策略注册表 — 按工具名匹配渲染策略。
 *
 * 在内容进入渲染管线前做分类处理：大体积结果提前降级为摘要或 offload，
 * 减少 doRender 的同步工作量。
 */

// ─── 常量 ───────────────────────────────────────────────────────────────────

/** 工具结果预览默认行数（折叠状态下展示的最大行数）。 */
export const RESULT_PREVIEW_LINES = 3;

/** 错误结果预览行数（比普通多 1 行以便看清错误栈首行）。 */
export const ERROR_PREVIEW_LINES = 4;

/** diff 预览行数。200 行触发 OOM 风险，降到 40。 */
export const DIFF_MAX_LINES = 40;

/** 超过此字符数的结果写文件 offload（4KB）。 */
export const MAX_INLINE_CHARS = 4096;

/** 超过此字符数的结果强制 offload（64KB），即使渲染器类型是 full。 */
export const MAX_RESULT_CHARS = 65536;

// ─── 终端控制序列净化 ────────────────────────────────────────────────────────

/**
 * 4 层正则清理 shell 输出中的终端控制序列，返回纯文本。
 *
 * 四层正则清理顺序（OSC → CSI → C0 → 回车残影）：
 * - Layer 1: OSC（超链接、标题）\x1b]...\x07 / \x1b]...\x1b\\
 * - Layer 2: CSI（颜色、光标、擦除）\x1b[...[A-Za-z]
 * - Layer 3: C0 控制字符（bell/backspace 等）\x00-\x1f 中除 \n\t 的部分
 * - Layer 4: 回车残影 \r（单独出现或跟 \n 的 \r\n 已由 split 处理）
 */
export function stripTerminalControls(text: string): string {
  // Layer 1: OSC sequences (OSC 8 hyperlinks, OSC 0/2 window titles)
  let cleaned = text.replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '');
  // Layer 2: CSI sequences (SGR colors, cursor movement, erase, etc.)
  cleaned = cleaned.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '');
  // Layer 3: C0 control chars (except \n=0x0a, \t=0x09)
  cleaned = cleaned.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, '');
  // Layer 4: stray \r (standalone carriage returns not covered by \r\n)
  cleaned = cleaned.replace(/\r/g, '\n');
  return cleaned;
}

// ─── 渲染策略类型 ────────────────────────────────────────────────────────

/** 渲染策略：body 渲染方式。 */
export type BodyMode =
  | 'summary'     // body 为空，芯片只显示统计信息（grep/glob/read 等）
  | 'shell'       // 命令类工具：显示命令摘要 + 输出统计，不展示输出体
  | 'truncated'   // 裁剪到 N 行，超出部分折叠提示（默认）
  | 'full';       // 完整展示（diff）

export interface ToolRenderer {
  /** 折叠状态下的 body 渲染模式。 */
  bodyMode: BodyMode;
  /** 摘要文本。summary/shell 模式用；truncated/full 模式下也可附加一行摘要。 */
  summary?: string;
  /** 预览行数（默认 RESULT_PREVIEW_LINES）。shell 模式忽略此值。 */
  previewLines?: number;
  /** 尾部模式（而非头部）。保留最新 N 行而非最前 N 行，适合长运行命令的实时输出。 */
  tail?: boolean;
  /** 是否总是 offload（无视内容大小，适合元数据类工具）。 */
  forceOffload?: boolean;
}

// ─── 工具分类 ─────────────────────────────────────────────────────────────

/** 摘要型工具：body 完全隐藏，只显示统计/采样。 */
const SUMMARY_TOOLS = new Set<string>([
  'grep', 'glob', 'web_search', 'read_file', 'read', 'ls', 'find',
]);

/** 命令型工具：显示执行的命令 + 输出统计，不展示输出体。 */
const SHELL_TOOLS = new Set<string>([
  'bash', 'run_shell', 'shell', 'exec',
]);

/** 总是 offload 的工具（输出体积不可控）。 */
const ALWAYS_OFFLOAD = new Set<string>([
  'web_extract', // 提取到的网页正文可能非常大
]);

// ─── 注册表 ─────────────────────────────────────────────────────────────────

export function getToolRenderer(toolName: string): ToolRenderer {
  if (SUMMARY_TOOLS.has(toolName)) {
    return { bodyMode: 'summary', summary: '' };
  }
  if (SHELL_TOOLS.has(toolName)) {
    return { bodyMode: 'shell' };
  }
  if (ALWAYS_OFFLOAD.has(toolName)) {
    return { bodyMode: 'truncated', forceOffload: true };
  }
  return { bodyMode: 'truncated' };
}

/** 是否为摘要型工具（渲染 body 为空，只显示统计）。 */
export function isSummaryTool(toolName: string): boolean {
  return SUMMARY_TOOLS.has(toolName);
}

/** 是否为命令型工具（body 显示命令摘要 + 输出统计）。 */
export function isShellTool(toolName: string): boolean {
  return SHELL_TOOLS.has(toolName);
}

/** 工具结果是否需要强制 offload 到文件。 */
export function shouldForceOffload(toolName: string): boolean {
  return ALWAYS_OFFLOAD.has(toolName);
}

// ─── 摘要计算 ────────────────────────────────────────────────────────────

/**
 * 从工具结果中提取摘要行。
 * grep/glob：提取前 N 个命中路径
 * shell：提取首行（通常是命令输出首行）
 * 其他：取首行超长截断
 */
export function summarizeResult(toolName: string, result: string): string {
  if (result.length === 0) return '（空结果）';
  // 先去掉终端控制序列，再按纯文本做摘要分析
  const clean = stripTerminalControls(result);
  const firstLine = clean.split('\n').find((l) => l.trim().length > 0);
  if (!firstLine) return '（空结果）';

  // grep / glob：提取前 N 行作为路径/文本采样
  if (SUMMARY_TOOLS.has(toolName)) {
    const lines = clean.split('\n').filter((l) => l.trim().length > 0);
    const samples = lines.slice(0, 3);
    if (lines.length > 3) {
      return `${samples.join(', ')}, +${lines.length - 3} more`;
    }
    return samples.join(', ');
  }

  // shell 类：取首行作为输出摘要
  if (SHELL_TOOLS.has(toolName)) {
    const trimmed = firstLine.trim();
    if (trimmed.length > 80) return trimmed.slice(0, 77) + '…';
    return trimmed;
  }

  // 其他工具：取首行，超长截断
  const trimmed = firstLine.trim();
  if (trimmed.length > 80) return trimmed.slice(0, 77) + '…';
  return trimmed;
}

/**
 * 从完整输出中萃取行数 + 字符数摘要。
 * 供折叠 hint 行使用：`↳ N 行 / M 字符（Ctrl+O 查看）`
 */
export function outputStats(result: string): { lines: number; chars: number } {
  // 用纯文本做统计，避免 ANSI 控制序列膨胀字符数
  const clean = stripTerminalControls(result);
  const lines = clean.split('\n');
  return { lines: lines.length, chars: clean.length };
}

// ─── 命令参数摘要 ────────────────────────────────────────────────────────

/**
 * 从工具输入的参数中提取可读摘要。
 * bash 提取 command 字段；read_file 提取 path 字段。
 */
export function summarizeToolInput(toolName: string, input: unknown): string {
  if (input === null || input === undefined) return '';
  if (typeof input !== 'object') return String(input);

  const obj = input as Record<string, unknown>;

  if (SHELL_TOOLS.has(toolName) && typeof obj.command === 'string') {
    const cmd = obj.command.trim();
    if (cmd.length > 60) return cmd.slice(0, 57) + '…';
    return cmd;
  }

  if (typeof obj.path === 'string') {
    const p = obj.path.trim();
    if (p.length > 60) return p.slice(0, 57) + '…';
    return p;
  }
  if (typeof obj.file_path === 'string') {
    const p = obj.file_path.trim();
    if (p.length > 60) return p.slice(0, 57) + '…';
    return p;
  }

  // 通用：拼出前两个非空值
  const parts = Object.values(obj)
    .filter((v) => v !== null && v !== undefined && v !== '')
    .slice(0, 2)
    .map((v) => String(v).trim().slice(0, 30));
  if (parts.length === 0) return '';
  return parts.join(' ');
}
