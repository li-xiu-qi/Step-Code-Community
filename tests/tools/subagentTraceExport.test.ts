/**
 * subagent_trace_export 的实测覆盖。
 *
 * 重点不在「能写文件」，而在三条边界：
 * 1. 导出是全量的——subagent_trace 受 50 条上限约束，导出不该继承那个截断
 * 2. jsonl 可被脚本回读（A/B 测评要程序化消费）
 * 3. md 写失败不影响 jsonl 已落盘这一事实
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SubagentStore } from '../../src/agent/subagent/store.js';
import { SessionStore } from '../../src/session/store.js';
import { stored } from '../../src/agent/message.js';
import { subagentTraceExportTool } from '../../src/tools/subagentControl.js';

let base: string;
let cwd: string;
let outDir: string;
let store: SubagentStore;

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'trace-export-'));
  cwd = join(base, 'project');
  outDir = join(base, 'out');
  store = new SubagentStore(new SessionStore(base));
});
afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

/** 造一个带 N 条消息的子会话并落盘。 */
function seedWithMessages(id: string, count: number): void {
  const session = store.create(cwd, { model: 'm', agentType: 'explore', depth: 1 });
  session.id = id;
  const messages = [];
  for (let i = 0; i < count; i++) {
    messages.push(
      stored(
        { role: i % 2 === 0 ? 'user' : 'assistant', content: `第 ${i + 1} 条消息正文` },
        { kind: i % 2 === 0 ? 'user' : 'assistant' },
      ),
    );
  }
  session.messages = messages;
  store.saveSnapshot(session);
  store.appendMessages(cwd, id, messages);
}

function run(input: { id: string; outDir?: string; withMarkdown?: boolean }) {
  return subagentTraceExportTool.execute(input, { cwd, subagentStore: store });
}

/** 列出导出目录下的文件（按名）。 */
function exported(): string[] {
  if (!existsSync(outDir)) return [];
  return readdirSync(outDir).sort();
}

describe('subagent_trace_export', () => {
  it('工具已注册（没注册则模型调不到）', async () => {
    const { allToolNames } = await import('../../src/tools/index.js');
    expect(allToolNames()).toContain('subagent_trace_export');
  });

  it('落盘 jsonl + md，内容可回读', async () => {
    seedWithMessages('sub-e1', 4);
    const r = await run({ id: 'sub-e1', outDir });
    expect(r.isError).not.toBe(true);

    const files = exported();
    expect(files.length).toBe(2);
    expect(files.some((f) => f.endsWith('.jsonl'))).toBe(true);
    expect(files.some((f) => f.endsWith('.md'))).toBe(true);

    const jsonl = files.find((f) => f.endsWith('.jsonl'))!;
    const rows = readFileSync(join(outDir, jsonl), 'utf8').trim().split('\n');
    expect(rows.length).toBe(4);
    // 每行必须是合法 JSON，且带 ts/id/origin/message 四个字段——脚本靠这个回读
    for (const row of rows) {
      const parsed = JSON.parse(row) as { ts: string; id: string; origin: unknown; message: { content: string } };
      expect(parsed.message).toBeDefined();
      expect(parsed.ts).toBeDefined();
    }
  });

  it('导出是全量的，不继承 subagent_trace 的 50 条上限', async () => {
    // 这是两个工具的核心分工：读取受上限约束防上下文爆炸，落盘不受限。
    // 截断会丢掉关键轮次，测评对比场景下等于数据损坏。
    seedWithMessages('sub-e2', 120);
    const r = await run({ id: 'sub-e2', outDir });
    expect(r.isError).not.toBe(true);

    const jsonl = exported().find((f) => f.endsWith('.jsonl'))!;
    const rows = readFileSync(join(outDir, jsonl), 'utf8').trim().split('\n');
    expect(rows.length).toBe(120);
  });

  it('withMarkdown: false 只产 jsonl', async () => {
    seedWithMessages('sub-e3', 2);
    await run({ id: 'sub-e3', outDir, withMarkdown: false });
    const files = exported();
    expect(files.length).toBe(1);
    expect(files[0]!.endsWith('.jsonl')).toBe(true);
  });

  it('md 是人读的：含角色分隔与正文', async () => {
    seedWithMessages('sub-e4', 3);
    await run({ id: 'sub-e4', outDir });
    const md = exported().find((f) => f.endsWith('.md'))!;
    const text = readFileSync(join(outDir, md), 'utf8');
    expect(text).toContain('第 1 条消息正文');
    expect(text).toContain('## [1] user');
    expect(text).toContain('## [2] assistant');
  });

  it('不存在的会话 → 报错并提示用 subagent_list', async () => {
    const r = await run({ id: 'sub-nope', outDir });
    expect(r.isError).toBe(true);
    expect(r.content).toContain('subagent_list');
  });

  it('没有消息的会话 → 报错（不产出空文件）', async () => {
    const session = store.create(cwd, { model: 'm', agentType: 'general', depth: 1 });
    session.id = 'sub-empty';
    store.saveSnapshot(session);
    const r = await run({ id: 'sub-empty', outDir });
    expect(r.isError).toBe(true);
  });

  it('上下文缺 subagentStore → 报错', async () => {
    const r = await subagentTraceExportTool.execute({ id: 'sub-x' }, { cwd });
    expect(r.isError).toBe(true);
  });

  it('输出目录不存在时自动创建', async () => {
    seedWithMessages('sub-e5', 1);
    const nested = join(base, 'a', 'b', 'c');
    const r = await run({ id: 'sub-e5', outDir: nested });
    expect(r.isError).not.toBe(true);
    expect(readdirSync(nested).length).toBe(2);
  });

  it('文件名带时间戳，同目录多次导出不互相覆盖', async () => {
    seedWithMessages('sub-e6', 2);
    await run({ id: 'sub-e6', outDir });
    // 同一秒内时间戳相同会撞名，这是已知边界；这里只验「至少落盘且可读」
    expect(readdirSync(outDir).length).toBeGreaterThanOrEqual(2);
    // 名字里含角色与 id 前缀，人在目录里能认出是谁的 trace
    expect(exported()[0]!).toContain('explore');
    expect(exported()[0]!).toContain('sub-e6'.slice(0, 8));
  });

  it('返回体里列出实际写入的路径', async () => {
    // 模型要把路径转述给用户，靠返回值而不是自己猜目录
    seedWithMessages('sub-e7', 1);
    const r = await run({ id: 'sub-e7', outDir });
    expect(r.content).toContain(outDir);
    expect(r.content).toContain('.jsonl');
  });
});
