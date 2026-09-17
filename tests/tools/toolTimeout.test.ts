import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { executeTool, registerDynamicTool, clearDynamicTools } from '../../src/tools/index.js';
import type { ToolContext, ToolResult } from '../../src/tools/types.js';

const ctx: ToolContext = { cwd: process.cwd() };

afterEach(() => {
  clearDynamicTools();
  vi.useRealTimers();
});

/** 注册一个带可控行为的测试工具。run 签名与 ToolDef.execute 一致。 */
function reg(name: string, opts: { timeoutMs?: number; run: (input: unknown, ctx: ToolContext) => Promise<ToolResult> | ToolResult }): void {
  registerDynamicTool({
    name,
    description: 'test tool',
    schema: z.object({}),
    timeoutMs: opts.timeoutMs,
    async execute(input, ctx) {
      return opts.run(input, ctx);
    },
  });
}

const hang = () => new Promise<ToolResult>(() => {});

describe('per-tool 超时', () => {
  it('不声明 timeoutMs 的工具不设时限：挂起的工具不会被超时杀掉', async () => {
    reg('slow_tool', { run: hang });
    // 用一个必然 reject 的竞速判据：30ms 后看它有没有出结果。
    // 直接 await 会挂死测试，所以用 Promise.race 断言「无结果」。
    const raced = Promise.race([
      executeTool('slow_tool', {}, ctx).then(() => 'done'),
      new Promise((r) => setTimeout(() => r('still-running'), 30)),
    ]);
    expect(await raced).toBe('still-running');
  });

  it('声明 timeoutMs 的工具到点返回 TOOL_TIMEOUT 而非挂死', async () => {
    reg('slow_tool', { timeoutMs: 20, run: hang });
    const r = await executeTool('slow_tool', {}, ctx);
    expect(r.isError).toBe(true);
    expect(r.errorCode).toBe('TOOL_TIMEOUT');
    expect(r.content).toContain('超时');
    expect(r.content).toContain('20ms');
  });

  it('超时前正常完成的工具不受影响', async () => {
    reg('fast_tool', { timeoutMs: 5000, run: async () => ({ content: 'ok', isError: false }) });
    const r = await executeTool('fast_tool', {}, ctx);
    expect(r.isError).toBe(false);
    expect(r.content).toBe('ok');
    expect(r.errorCode).toBeUndefined();
  });

  it('超时向工具传入的 signal 发起 abort：工具可借 signal 收尾', async () => {
    let sawAbort = false;
    reg('signal_tool', {
      timeoutMs: 20,
      run: (_input, c) =>
        new Promise<ToolResult>((resolve) => {
          c.signal?.addEventListener('abort', () => {
            sawAbort = true;
            resolve({ content: 'aborted-by-signal', isError: true });
          });
        }),
    });
    const r = await executeTool('signal_tool', {}, ctx);
    // 工具响应了 signal 并自行返回：race 先拿到的是工具的结果，
    // 但超时已触发，结果仍被替换为 TOOL_TIMEOUT（对齐 DSH：谁触发谁定性）
    expect(sawAbort).toBe(true);
    expect(r.errorCode).toBe('TOOL_TIMEOUT');
  });

  it('工具忽略 signal 时超时仍能收回合：race 兜底，无 unhandled rejection', async () => {
    // 超时后迟到的 reject：若无人接会打炸 vitest 进程，这里显式验证不炸
    reg('stubborn_tool', {
      timeoutMs: 20,
      run: () => new Promise<ToolResult>((_, reject) => setTimeout(() => reject(new Error('late reject')), 100)),
    });
    const r = await executeTool('stubborn_tool', {}, ctx);
    expect(r.errorCode).toBe('TOOL_TIMEOUT');
    await new Promise((res) => setTimeout(res, 150));
    // 到点没有 unhandled rejection 即通过（vitest 会把 unhandled rejection 判为失败）
  });

  it('用户中断（外部 signal 先 abort）不标成超时：工具自报的中断结果透传', async () => {
    const ctrl = new AbortController();
    reg('cancel_tool', {
      timeoutMs: 1000,
      run: (_input, c) =>
        new Promise<ToolResult>((resolve) => {
          c.signal?.addEventListener('abort', () => {
            resolve({ content: '用户中断，操作已取消。', isError: true });
          });
        }),
    });
    const p = executeTool('cancel_tool', {}, { ...ctx, signal: ctrl.signal });
    ctrl.abort();
    const r = await p;
    expect(r.content).toContain('用户中断');
    expect(r.errorCode).toBeUndefined();
  });

  it('进入时外部 signal 已 abort：工具直接看到 aborted', async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    let sawAborted = false;
    reg('pre_aborted_tool', {
      timeoutMs: 1000,
      run: (_input, c) => {
        sawAborted = c.signal?.aborted === true;
        return { content: 'seen', isError: false };
      },
    });
    await executeTool('pre_aborted_tool', {}, { ...ctx, signal: ctrl.signal });
    expect(sawAborted).toBe(true);
  });

  it('timeoutMs 非正数按不设超时处理：不误杀声明失误的工具', async () => {
    reg('zero_tool', { timeoutMs: 0, run: async () => ({ content: 'ok', isError: false }) });
    const r = await executeTool('zero_tool', {}, ctx);
    expect(r.content).toBe('ok');
    expect(r.errorCode).toBeUndefined();
  });

  it('工具抛异常且超时未触发：按普通执行异常回灌，不带 errorCode', async () => {
    reg('throw_tool', {
      timeoutMs: 1000,
      run: () => {
        throw new Error('boom');
      },
    });
    const r = await executeTool('throw_tool', {}, ctx);
    expect(r.isError).toBe(true);
    expect(r.content).toContain('执行异常');
    expect(r.errorCode).toBeUndefined();
  });
});
