import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SessionQueueStore } from '../../src/agent/sessionQueue/store.js';

/**
 * 跨 session 队列的存储层契约。
 *
 * 这批测试为新引入的「消费回执」而写。回执要解决的是：投递方 `session_send` 之后只收到
 * 「已投递」，无法知道对方何时真的读到——跨会话交接常常就断在这里（对方一直不查 inbox）。
 *
 * 回执的最大风险是递归：A 投给 B，B 消费时回执给 A，A 消费回执时若再回执给 B 就无限循环。
 * 故回执消息必须可识别，且消费方 drain 到回执时不再生成回执。
 */
const tmpDirs: string[] = [];
afterEach(() => {
  while (tmpDirs.length > 0) rmSync(tmpDirs.pop()!, { recursive: true, force: true });
});

const mk = (): SessionQueueStore => {
  const dir = mkdtempSync(join(tmpdir(), 'stepcode-squeue-'));
  tmpDirs.push(dir);
  return new SessionQueueStore(dir);
};

describe('SessionQueueStore 基础投递与消费', () => {
  it('投递后目标会话 peek 可见、drain 取走', () => {
    const q = mk();
    q.enqueue('B', 'A', '干活');
    expect(q.peek('B')).toHaveLength(1);
    expect(q.drain('B').map((m) => m.text)).toEqual(['干活']);
    expect(q.peek('B')).toHaveLength(0);
  });

  it('drain 后消息不重复投递（幂等）', () => {
    const q = mk();
    q.enqueue('B', 'A', '一次');
    q.drain('B');
    expect(q.drain('B')).toHaveLength(0);
  });

  it('消息按目标会话隔离', () => {
    const q = mk();
    q.enqueue('B', 'A', '给 B');
    q.enqueue('C', 'A', '给 C');
    expect(q.drain('B').map((m) => m.text)).toEqual(['给 B']);
    expect(q.drain('C').map((m) => m.text)).toEqual(['给 C']);
  });

  it('空队列 drain 返回空数组，不抛错', () => {
    const q = mk();
    expect(q.drain('nobody')).toEqual([]);
  });

  it('已消费消息保留在文件里（审计）', () => {
    const dir = mkdtempSync(join(tmpdir(), 'stepcode-squeue-'));
    tmpDirs.push(dir);
    const q = new SessionQueueStore(dir);
    q.enqueue('B', 'A', '留痕');
    q.drain('B');
    const raw = readFileSync(join(dir, 'B.json'), 'utf8');
    expect(raw).toContain('consumedAt');
    expect(raw).toContain('留痕');
  });
});

describe('SessionQueueStore 消费回执（kind=receipt）', () => {
  it('回执带 kind 标记，与普通消息可区分', () => {
    const q = mk();
    q.enqueue('B', 'A', '对方已读', 'receipt');
    const [m] = q.drain('B');
    expect(m!.kind).toBe('receipt');
  });

  it('普通消息不带 kind（缺省语义，旧数据兼容）', () => {
    const q = mk();
    q.enqueue('B', 'A', '普通指令');
    const [m] = q.drain('B');
    expect(m!.kind).toBeUndefined();
  });

  it('回执与普通消息共存时各自完整取走', () => {
    const q = mk();
    q.enqueue('B', 'A', '指令一');
    q.enqueue('B', 'A', '回执：指令一已读', 'receipt');
    q.enqueue('B', 'A', '指令二');
    const got = q.drain('B');
    expect(got.map((m) => `${m.kind ?? 'message'}:${m.text}`)).toEqual([
      'message:指令一',
      'receipt:回执：指令一已读',
      'message:指令二',
    ]);
  });

  it('回执也走消费标记（不会反复投递）', () => {
    const q = mk();
    q.enqueue('B', 'A', '回执', 'receipt');
    q.drain('B');
    expect(q.drain('B')).toHaveLength(0);
    expect(q.peek('B')).toHaveLength(0);
  });

  it('回执的 from/to 与普通消息同构（投递方据此知道是谁读的）', () => {
    const q = mk();
    q.enqueue('A', 'B', 'B 已读你的消息', 'receipt');
    const [m] = q.peek('A');
    expect(m!.from).toBe('B');
    expect(m!.to).toBe('A');
  });
});
