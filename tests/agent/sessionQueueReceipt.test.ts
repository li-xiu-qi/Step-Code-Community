import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { sendReadReceipts, type QueueMessageLike, type ReceiptSink } from '../../src/agent/sessionQueue/receipt.js';
import { SessionQueueStore } from '../../src/agent/sessionQueue/store.js';

const A = "session-aaaa-1111";
const B = "session-bbbb-2222";

const msg = (over: Partial<QueueMessageLike> & { id: string }): QueueMessageLike => ({
  from: A,
  text: "去调研剪贴板产品",
  ...over,
});

function fakeSink(): ReceiptSink & { calls: Array<{ to: string; from: string; text: string; kind: string }> } {
  const calls: Array<{ to: string; from: string; text: string; kind: string }> = [];
  return {
    calls,
    enqueue(to, from, text, kind) {
      calls.push({ to, from, text, kind });
      return 'receipt-' + calls.length;
    },
  };
}

describe('sendReadReceipts', () => {
  it("普通消息生成回执，带原文摘要", () => {
    const sink = fakeSink();
    const out = sendReadReceipts(B, [msg({ id: "m1", text: "调研剪贴板产品并给结论" })], sink);
    expect(out).toHaveLength(1);
    expect(out[0]!.to).toBe(A);
    expect(sink.calls[0]!.kind).toBe('receipt');
    expect(sink.calls[0]!.from).toBe(B);
    expect(sink.calls[0]!.text).toContain("已收到");
    expect(sink.calls[0]!.text).toContain("调研剪贴板产品");
  });

  it("回执不再产生回执", () => {
    const sink = fakeSink();
    const out = sendReadReceipts(A, [msg({ id: 'r1', kind: 'receipt', from: B })], sink);
    expect(out).toEqual([]);
    expect(sink.calls).toHaveLength(0);
  });

  it("混合批次只给普通消息回执", () => {
    const sink = fakeSink();
    const out = sendReadReceipts(B, [
      msg({ id: 'm1', text: '任务一' }),
      msg({ id: 'r1', kind: 'receipt', from: A, text: '[已收到] 任务一' }),
      msg({ id: 'm2', text: '任务二' }),
    ], sink);
    expect(out.map((r) => r.messageId)).toEqual(['m1', 'm2']);
    expect(sink.calls).toHaveLength(2);
  });

  it("空批次不产生回执", () => {
    const sink = fakeSink();
    expect(sendReadReceipts(B, [], sink)).toEqual([]);
    expect(sink.calls).toHaveLength(0);
  });

  it("超长正文截断", () => {
    const sink = fakeSink();
    sendReadReceipts(B, [msg({ id: 'm1', text: 'x'.repeat(500) })], sink);
    expect(sink.calls[0]!.text.length).toBeLessThan(200);
    expect(sink.calls[0]!.text).toContain("…");
  });

  it("批量各得一张回执且 id 不重复", () => {
    const sink = fakeSink();
    const out = sendReadReceipts(B, [
      msg({ id: 'm1', text: '1' }),
      msg({ id: 'm2', text: '2' }),
      msg({ id: 'm3', text: '3' }),
    ], sink);
    expect(out.map((r) => r.messageId)).toEqual(['m1', 'm2', 'm3']);
    expect(new Set(out.map((r) => r.receiptId)).size).toBe(3);
  });

  it("不修改入参数组", () => {
    const sink = fakeSink();
    const input = [msg({ id: "m1" })];
    sendReadReceipts(B, input, sink);
    expect(input).toHaveLength(1);
    expect(input[0]!.kind).toBeUndefined();
  });
});

describe('回执链路端到端', () => {
  const tmpDirs: string[] = [];
  afterEach(() => { while (tmpDirs.length > 0) rmSync(tmpDirs.pop()!, { recursive: true, force: true }); });
  const mkq = (): SessionQueueStore => {
    const dir = mkdtempSync(join(tmpdir(), 'stepcode-receipt-'));
    tmpDirs.push(dir);
    return new SessionQueueStore(dir);
  };

  it("A 投给 B，B 消费后 A 收到回执；A 消费回执时不再产生回执", () => {
    const q = mkq();
    q.enqueue(B, A, "去调研剪贴板产品");
    const byB = q.drain(B);
    expect(sendReadReceipts(B, byB, q)).toHaveLength(1);
    expect(q.peek(A)).toHaveLength(1);
    expect(q.peek(A)[0]!.kind).toBe('receipt');
    const byA = q.drain(A);
    expect(sendReadReceipts(A, byA, q)).toEqual([]);
    expect(q.peek(B)).toHaveLength(0);
  });

  it("四轮往返后全库无剩余", () => {
    const q = mkq();
    q.enqueue(B, A, "第一轮");
    for (const self of [B, A, B, A]) {
      const got = q.drain(self);
      sendReadReceipts(self, got, q);
    }
    expect(q.drain(A)).toHaveLength(0);
    expect(q.drain(B)).toHaveLength(0);
    expect(q.peek(A)).toHaveLength(0);
    expect(q.peek(B)).toHaveLength(0);
  });
});

