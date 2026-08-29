import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { subagentParallelKind } from '../../src/tools/subagentAccess.js';

let cwd: string;

beforeEach(() => {
  cwd = join(tmpdir(), `sa-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(join(cwd, '.step-code', 'agents'), { recursive: true });
});
afterEach(() => rmSync(cwd, { recursive: true, force: true }));

function writeTemplate(name: string, tools: string[] | null): void {
  const fm = tools === null ? 'description: x' : `description: x\ntools: [${tools.map((t) => `'${t}'`).join(', ')}]`;
  writeFileSync(join(cwd, '.step-code', 'agents', `${name}.md`), `---\n${fm}\n---\nbody`, 'utf8');
}

describe('subagentParallelKind', () => {
  it('无写工具的模板 → read（可并行）', () => {
    writeTemplate('ro', ['read_file', 'grep', 'glob', 'web_search']);
    expect(subagentParallelKind(cwd, 'ro')).toBe('read');
  });

  it('含 write_file → all（串行）', () => {
    writeTemplate('w', ['read_file', 'write_file']);
    expect(subagentParallelKind(cwd, 'w')).toBe('all');
  });

  it('含 edit_file → all', () => {
    writeTemplate('e', ['read_file', 'edit_file']);
    expect(subagentParallelKind(cwd, 'e')).toBe('all');
  });

  it('含 bash → all（副作用不可判定）', () => {
    writeTemplate('b', ['read_file', 'bash']);
    expect(subagentParallelKind(cwd, 'b')).toBe('all');
  });

  it('未声明 tools（默认拥有全部工具）→ all', () => {
    writeTemplate('noft', null);
    expect(subagentParallelKind(cwd, 'noft')).toBe('all');
  });

  it('模板不存在 → all（保守串行）', () => {
    expect(subagentParallelKind(cwd, 'ghost')).toBe('all');
  });

  it('内置 explore 保持只读并行（registry 定义，不靠磁盘模板）', () => {
    expect(subagentParallelKind(cwd, 'explore')).toBe('read');
  });

  it('内置 general 串行（工具全集）', () => {
    expect(subagentParallelKind(cwd, 'general')).toBe('all');
  });

  it('内置 claude-code / codex 串行（外部 CLI 副作用不可判定）', () => {
    expect(subagentParallelKind(cwd, 'claude-code')).toBe('all');
    expect(subagentParallelKind(cwd, 'codex')).toBe('all');
  });
});
