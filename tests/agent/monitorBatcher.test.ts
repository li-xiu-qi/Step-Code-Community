/**
 * 行缓冲器测试。
 *
 * 这四个常数改动需要有理由——
 * 它们解决的是具体问题（内存膨胀 / 逐行推送烧 token / 超长行打爆上下文），
 * 不是可以随手调的参数。
 */
import { describe, expect, it } from 'vitest';
import {
  MONITOR_BATCH_CAP,
  MONITOR_FLUSH_MS,
  MONITOR_LINE_CAP,
  createMonitorBatcher,
} from '../../src/agent/background/monitorBatcher.js';

describe('行缓冲器：行切分', () => {
  it('半行留在缓冲里，不产生事件', () => {
    const b = createMonitorBatcher();
    expect(b.push('没有换行的半')).toBe(false);
    expect(b.flush()).toBeNull();
  });

  it('凑齐换行才成行，且 trim 掉首尾空白', () => {
    const b = createMonitorBatcher();
    expect(b.push('  hello  \n')).toBe(true);
    expect(b.flush()).toBe('hello');
  });

  it('分块到达的数据能正确拼回一行', () => {
    const b = createMonitorBatcher();
    b.push('ERROR db: ');
    b.push('connection refused\n');
    expect(b.flush()).toBe('ERROR db: connection refused');
  });

  it('空行被丢弃，不产生空事件', () => {
    const b = createMonitorBatcher();
    b.push('\n\n   \nreal\n');
    expect(b.flush()).toBe('real');
  });
});

describe('行缓冲器：200ms 窗口内合并', () => {
  it('同一窗口的多行合并为一条，用换行连接', () => {
    const b = createMonitorBatcher();
    b.push('line1\nline2\nline3\n');
    expect(b.flush()).toBe('line1\nline2\nline3');
  });

  it('flush 后缓冲清空，下次 push 重新起窗口', () => {
    const b = createMonitorBatcher();
    b.push('a\n');
    expect(b.flush()).toBe('a');
    b.push('b\n');
    expect(b.flush()).toBe('b');
  });

  it('常量值有明确推导依据', () => {
    // 四个常数的值由内存/上下文预算推导，改动需要理由
    expect(MONITOR_FLUSH_MS).toBe(200);
    expect(MONITOR_LINE_CAP).toBe(500);
    expect(MONITOR_BATCH_CAP).toBe(3000);
  });
});

describe('行缓冲器：双层截断', () => {
  it('超长单行截断到 500 字符并标注', () => {
    const b = createMonitorBatcher();
    b.push(`${'x'.repeat(800)}\n`);
    const out = b.flush()!;
    expect(out.length).toBe(500 + '...(truncated)'.length);
    expect(out.endsWith('...(truncated)')).toBe(true);
  });

  it('整批超 3000 字符也截断', () => {
    const b = createMonitorBatcher();
    // 10 行 × 400 字符 = 4000，超整批上限
    for (let i = 0; i < 10; i++) b.push(`${'y'.repeat(400)}\n`);
    const out = b.flush()!;
    // 截断标记只在整批末尾加一次，不是每行都加
    expect(out.length).toBe(3000 + '...(truncated)'.length);
    expect(out.endsWith('...(truncated)')).toBe(true);
    expect(out.split('...(truncated)').length - 1).toBe(1);
  });

  it('不超限的内容原样保留，不加截断标记', () => {
    const b = createMonitorBatcher();
    b.push('short line\n');
    expect(b.flush()).toBe('short line');
  });
});

describe('行缓冲器：强制 flush', () => {
  it('force 把残余半行凑成最后一条（进程退出前）', () => {
    const b = createMonitorBatcher();
    b.push('完整行\n残余半行');
    expect(b.flush()).toBe('完整行');
    expect(b.flush(true)).toBe('残余半行');
  });

  it('force 但无残余时返回 null，不发空事件', () => {
    const b = createMonitorBatcher();
    b.push('done\n');
    b.flush();
    expect(b.flush(true)).toBeNull();
  });

  it('1MB 缓冲上限：只保留尾部，不无限增长', () => {
    const b = createMonitorBatcher();
    // 灌 2MB 无换行数据，应被截到 1MB
    b.push('z'.repeat(2 * 1024 * 1024));
    expect(b.pending()).toBe(0);
    // 加个换行让它成行，行本身仍受 500 字符限制
    b.push('\n');
    expect(b.flush()!.length).toBe(500 + '...(truncated)'.length);
  });
});
