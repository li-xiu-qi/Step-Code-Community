import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';

/**
 * 子 agent 模板的工具能力查询，供 runTurn 的并行调度做冲突判定。
 *
 * 背景：`spawn_agent` 工具的 access 之前写死为
 *   subagent_type === 'explore' ? {kind:'none'} : {kind:'all'}
 * 导致只有 explore 能并行，reverse-engineer / general 等一律串行，
 * 用户配置的 max_concurrent 完全用不上（accessConflict 里 all 遇 all 必冲突，
 * 第一道闸永远先卡死）。这里改成按模板 tools 声明推断。
 */

/** 会写文件或执行命令的工具。bash 视为写（副作用不可判定，与 access.ts 一致）。 */
const WRITE_TOOLS = new Set(['write_file', 'edit_file', 'bash', 'notebook_edit']);

/**
 * 内置角色的并行能力（与 subagent/registry.ts 的 BUILTIN_AGENTS 对齐）。
 * 这些角色没有 .md 模板，能力由 registry 内置定义决定，不能靠读磁盘推断。
 * 新增内置角色时这里要同步，否则会退化为保守的 all。
 */
const BUILTIN_PARALLEL: Record<string, 'read' | 'all'> = {
  explore: 'read', // 只读工具集
  general: 'all', // 工具全集（除 spawn_agent）
  'claude-code': 'all', // 外部 CLI，副作用不可判定
  codex: 'all',
};

/**
 * 读一个 agent 模板的 frontmatter，返回 tools 数组。
 * 找不到或解析失败返回 undefined（调用方按保守处理）。
 */
function readTemplateTools(cwd: string, agentType: string): string[] | undefined {
  for (const dir of [join(cwd, '.step-code', 'agents'), join(homedir(), '.step-code', 'agents')]) {
    const file = join(dir, `${agentType}.md`);
    try {
      const raw = readFileSync(file, 'utf8');
      const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(raw);
      if (m === null) continue;
      const fm = parseYaml(m[1]) as { tools?: unknown } | null;
      const t = fm?.tools;
      return Array.isArray(t) ? t.map(String) : undefined;
    } catch {
      continue;
    }
  }
  return undefined;
}

/**
 * 查询子 agent 的并行能力。
 * - 'read'：可并行（模板显式声明 tools 且不含写工具）
 * - 'all'：必须串行（未声明 tools，或声明了写工具）
 *
 * 未声明 tools 的模板（如内置 general）按 all 保守处理——它默认拥有全部工具。
 */
export function subagentParallelKind(cwd: string, agentType: string): 'read' | 'all' {
  // 内置角色优先：registry 定义的能力，不靠磁盘模板推断
  const builtin = BUILTIN_PARALLEL[agentType];
  if (builtin !== undefined) return builtin;
  const tools = readTemplateTools(cwd, agentType);
  if (tools === undefined) return 'all';
  if (tools.some((t) => WRITE_TOOLS.has(t))) return 'all';
  return 'read';
}
