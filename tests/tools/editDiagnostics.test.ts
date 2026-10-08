import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { executeTool } from '../../src/tools/index.js';

/**
 * edit_file 匹配失败的诊断质量。
 *
 * 背景：老报错只有一句「未找到 old_string」或「出现 N 次，不唯一」，模型拿不到任何
 * 位置信息，只能盲目重试（反复 read + 反复 edit 烧轮次）。现在要求报错能指路：
 * 不唯一必须给行号，未找到要给「为什么没找到、可能在哪一行」。
 */

let dir: string;
let ctx: { cwd: string };

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'stepcode-editdiag-'));
  ctx = { cwd: dir };
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('edit_file 匹配失败诊断', () => {
  it('不唯一时报错带全部候选行号', async () => {
    writeFileSync(join(dir, 'dup.txt'), 'head\n  const x = 1;\nmid\n  const x = 1;\ntail\n');
    const r = await executeTool(
      'edit_file',
      { path: 'dup.txt', old_string: '  const x = 1;', new_string: '  const x = 2;' },
      ctx,
    );
    expect(r.isError).toBe(true);
    expect(r.content).toContain('出现 2 次');
    // 两处分别在第 2、4 行
    expect(r.content).toContain('2、4');
  });

  it('多处不唯一超出展示上限时附总数', async () => {
    const many = Array.from({ length: 9 }, () => 'same line').join('\n');
    writeFileSync(join(dir, 'many.txt'), many);
    const r = await executeTool(
      'edit_file',
      { path: 'many.txt', old_string: 'same line', new_string: 'changed' },
      ctx,
    );
    expect(r.isError).toBe(true);
    expect(r.content).toContain('出现 9 次');
    expect(r.content).toContain('等 9 处');
  });

  it('未找到时区分空白不一致并给出真实行号', async () => {
    // 文件用两个空格缩进，old_string 用四个 → 归一化空白后才能命中
    writeFileSync(join(dir, 'ws.txt'), 'a\n  x = 1\nb\n');
    const r = await executeTool(
      'edit_file',
      { path: 'ws.txt', old_string: '    x = 1', new_string: '    x = 2' },
      ctx,
    );
    expect(r.isError).toBe(true);
    expect(r.content).toContain('空白');
    expect(r.content).toContain('2'); // 真实命中行
  });

  it('未找到时首行能定位则报首行行号与漂移原因', async () => {
    writeFileSync(join(dir, 'drift.txt'), 'l1\nl2\nfoo bar baz\nqux\nl5\n');
    // 首行对得上，后续行文件里没有
    const r = await executeTool(
      'edit_file',
      { path: 'drift.txt', old_string: 'foo bar baz\nMISSING', new_string: 'z' },
      ctx,
    );
    expect(r.isError).toBe(true);
    expect(r.content).toContain('首行');
    expect(r.content).toContain('3');
    expect(r.content).toContain('不一致');
  });

  it('完全找不到时只给文件规模并要求重读', async () => {
    writeFileSync(join(dir, 'none.txt'), 'l1\nl2\nl3\nl4\nl5\n');
    const r = await executeTool(
      'edit_file',
      { path: 'none.txt', old_string: '完全不相关的一段文字', new_string: 'z' },
      ctx,
    );
    expect(r.isError).toBe(true);
    // 末尾换行让 split 多出一段空串，故 5 行文件报 6
    expect(r.content).toContain('6 行');
    expect(r.content).toContain('read_file');
  });

  it('批量 edits 的行号基于前一条编辑后的文本', async () => {
    // 先插入一行把 dup 顶到第 4 行，第二条编辑的 old_string 出现在第 2 与第 4 行
    writeFileSync(join(dir, 'seq.txt'), 'dup\ntail\n');
    const r = await executeTool(
      'edit_file',
      {
        path: 'seq.txt',
        edits: [
          { old_string: 'tail', new_string: 'dup\ntail' },
          { old_string: 'dup', new_string: 'DUP' },
        ],
      },
      ctx,
    );
    expect(r.isError).toBe(true);
    expect(r.content).toContain('edits[1]');
    // 插入后文本为 dup / dup / tail，dup 在第 1 和第 2 行
    expect(r.content).toContain('1、2');
  });

  it('replace_all=true 时不报不唯一，正常改写全部', async () => {
    writeFileSync(join(dir, 'all.txt'), 'x\nx\nx\n');
    const r = await executeTool(
      'edit_file',
      { path: 'all.txt', old_string: 'x', new_string: 'y', replace_all: true },
      ctx,
    );
    expect(r.isError).toBe(false);
    expect(r.content).toContain('替换 3 处');
  });
});
