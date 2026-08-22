/**
 * Command 定义 — 从 .md 文件加载，用户可自定义。
 *
 * 三种命令类型：
 * - prompt:   纯 prompt 注入（plan, review）
 * - pipeline: 有固定执行流程，prompt 可定制（reflect）
 * - action:   硬编码系统操作（/model, /yolo 等，不在此系统内）
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, basename } from 'node:path';
import { homedir } from 'node:os';

const COMMANDS_DIR = '.step-code/commands';
const FRONTMATTER_RE = /^---\s*\n([\s\S]*?)\n---\s*\n([\s\S]*)$/;
const KEY_RE = /^(\w+):\s*(.*)$/;

// ─── 类型 ───────────────────────────────────────────────────────────────────

/** 命令类型。 */
export type CommandType = 'prompt' | 'pipeline' | 'skill';

export interface CommandDefinition {
  name: string;
  /** 命令类型：prompt = 纯注入；pipeline = 有代码流程。 */
  type: CommandType;
  description: string;
  triggers: string[];
  /** pipeline 类型：代码中的处理器函数名。 */
  handler?: string;
  allowedTools?: string[];
  model?: string;
  skills?: string[];
  output: 'inline' | 'file';
  outputPath?: string;
  /** 排序权重（越高越先匹配）。内置 100，用户 50。 */
  priority?: number;
  /** 命令正文（Markdown body），注入上下文或作为自定义 prompt。 */
  body: string;
  /** 透传给 pipeline handler 的额外参数。 */
  params?: Record<string, string | number | boolean>;
}

// ─── Frontmatter 解析 ──────────────────────────────────────────────────────

function parseFrontmatter(raw: string): { meta: Record<string, string | string[]>; body: string } | null {
  const match = FRONTMATTER_RE.exec(raw);
  if (!match) return null;

  const meta: Record<string, string | string[]> = {};
  const lines = match[1].split('\n');
  let currentKey: string | null = null;
  let currentList: string[] | null = null;

  for (const line of lines) {
    const trimmed = line.trim();
    // YAML list item: `- value` or `- "value"`
    if (currentKey && trimmed.startsWith('- ')) {
      if (currentList === null) currentList = [];
      currentList.push(trimmed.slice(2).replace(/^["']|["']$/g, ''));
      continue;
    }
    // Flush any pending list
    if (currentKey && currentList) {
      meta[currentKey] = currentList;
      currentKey = null;
      currentList = null;
    }
    // Key-value pair
    const km = KEY_RE.exec(trimmed);
    if (km) {
      currentKey = km[1];
      let value: string | string[] = km[2].trim();
      if (value.startsWith('[') && value.endsWith(']')) {
        value = value.slice(1, -1).split(',').map((s) => s.trim().replace(/^["']|["']$/g, ''));
        meta[currentKey] = value;
        currentKey = null; // inline array, no list follows
      } else if (value === '') {
        // Value is on following lines (YAML list)
        currentList = null; // will be set when first `- item` arrives
      } else {
        meta[currentKey] = value;
        currentKey = null;
      }
    }
  }
  // Flush trailing list
  if (currentKey && currentList) {
    meta[currentKey] = currentList;
  }

  return { meta, body: match[2].trim() };
}

function toString(v: string | string[] | undefined, fallback = ''): string {
  if (v === undefined) return fallback;
  return Array.isArray(v) ? v[0] ?? fallback : v;
}

function toStringArray(v: string | string[] | undefined): string[] {
  if (v === undefined) return [];
  return Array.isArray(v) ? v : [v].filter(Boolean);
}

function toNumber(v: string | string[] | undefined, fallback?: number): number | undefined {
  const s = toString(v);
  if (s === '') return fallback;
  const n = Number(s);
  return Number.isNaN(n) ? fallback : n;
}

// ─── 公共 API ──────────────────────────────────────────────────────────────

/**
 * 从 .md 文件加载单个命令定义。
 */
export function loadCommandFile(filepath: string, priority: number): CommandDefinition | null {
  try {
    const raw = readFileSync(filepath, 'utf-8');
    const parsed = parseFrontmatter(raw);
    if (!parsed) return null;

    const { meta, body } = parsed;
    const type = (toString(meta.type, 'prompt') as CommandType);

    // 从 frontmatter 收集透传参数（非标准字段全部进 params）
    const KNOWN_KEYS = new Set(['name', 'type', 'description', 'triggers', 'handler', 'allowedTools', 'model', 'skills', 'output', 'outputPath', 'priority']);
    const params: Record<string, string | number | boolean> = {};
    for (const [k, v] of Object.entries(meta)) {
      if (KNOWN_KEYS.has(k)) continue;
      if (typeof v === 'string') {
        const n = Number(v);
        params[k] = v === 'true' ? true : v === 'false' ? false : (!Number.isNaN(n) && v.trim() !== '' ? n : v);
      }
    }

    return {
      name: toString(meta.name, basename(filepath, '.md')),
      type,
      description: toString(meta.description),
      triggers: toStringArray(meta.triggers).length > 0 ? toStringArray(meta.triggers) : [toString(meta.name, basename(filepath, '.md'))],
      handler: toString(meta.handler) || undefined,
      allowedTools: toStringArray(meta.allowedTools).length > 0 ? toStringArray(meta.allowedTools) : undefined,
      model: toString(meta.model) || undefined,
      skills: toStringArray(meta.skills).length > 0 ? toStringArray(meta.skills) : undefined,
      output: (toString(meta.output, 'inline') as 'inline' | 'file'),
      outputPath: toString(meta.outputPath) || undefined,
      priority: toNumber(meta.priority, priority),
      body,
      params: Object.keys(params).length > 0 ? params : undefined,
    };
  } catch {
    return null;
  }
}

/**
 * 加载命令：用户级 ~/.step-code/commands/ + 项目级 .step-code/commands/ + builtin。
 * 优先级：builtin(100) > user(75) > project(50)。同名项目级覆盖用户级。
 */
export function loadCommands(): CommandDefinition[] {
  const commands: CommandDefinition[] = [];

  // builtin（优先级 100）
  const builtinDir = join(COMMANDS_DIR, 'builtin');
  const builtinFiles = new Set(
    existsSync(builtinDir) ? readdirSync(builtinDir).filter((f) => f.endsWith('.md')) : [],
  );
  for (const f of builtinFiles) {
    const cmd = loadCommandFile(join(builtinDir, f), 100);
    if (cmd) commands.push(cmd);
  }

  // 用户级（优先级 75）
  const userDir = join(homedir(), '.step-code', 'commands');
  if (existsSync(userDir)) {
    try {
      const userFiles = new Set(
        readdirSync(userDir).filter((f) => f.endsWith('.md')),
      );
      for (const f of userFiles) {
        if (builtinFiles.has(f)) continue; // builtin 同名覆盖用户级
        const cmd = loadCommandFile(join(userDir, f), 75);
        if (cmd) commands.push(cmd);
      }
    } catch { /* */ }
  }

  // 项目级（优先级 50），覆盖用户级同名
  try {
    const projectNames = new Set<string>();
    for (const f of readdirSync(COMMANDS_DIR).filter((f) => f.endsWith('.md'))) {
      if (builtinFiles.has(f)) continue;
      projectNames.add(f);
      const cmd = loadCommandFile(join(COMMANDS_DIR, f), 50);
      if (cmd) commands.push(cmd);
    }
    // 移除被项目级覆盖的用户级同名命令
    const filtered = commands.filter((c) => {
      if ((c.priority ?? 0) !== 75) return true;
      return !projectNames.has(c.name + '.md');
    });
    return filtered.sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0));
  } catch { /* */ }

  commands.sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0));
  return commands;
}

/**
 * 根据用户输入匹配最佳命令。
 */
export function matchCommand(input: string, commands: CommandDefinition[]): CommandDefinition | null {
  const normalized = input.toLowerCase().trim();
  let best: CommandDefinition | null = null;
  let bestPriority = -1;

  for (const cmd of commands) {
    for (const trigger of cmd.triggers) {
      if (normalized.includes(trigger.toLowerCase())) {
        if ((cmd.priority ?? 0) > bestPriority) {
          best = cmd;
          bestPriority = cmd.priority ?? 0;
        }
        break;
      }
    }
  }

  return best;
}
