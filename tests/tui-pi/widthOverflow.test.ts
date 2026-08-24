/**
 * 宽度溢出回归测试：所有 block 类型的 render 输出不得超过终端宽度。
 *
 * 2026-08-17 第二次崩溃：cron prompt 992 字符作为单行输出，终端只有 67 列。
 * pi-tui 的 doRender 有断言：Rendered line exceeds terminal width → 进程崩溃。
 * 之前已修过 thinking 预览的 spinner 前缀超宽，这次是 cron block 同类型问题。
 */
import { describe, expect, it } from 'vitest';
import { visibleWidth } from '@earendil-works/pi-tui';
import { ItemBlock } from '../../src/tui-pi/blocks.js';
import { ActivityLine } from '../../src/tui-pi/StatusLine.js';
import type { DisplayItem } from '../../src/chat/types.js';

function checkNoOverflow(label: string, item: DisplayItem, widths: number[]): void {
  const block = new ItemBlock(item);
  for (const w of widths) {
    const lines = block.render(w);
    for (let i = 0; i < lines.length; i++) {
      // 去掉 ANSI 后测可见宽度
      const vis = lines[i].replace(/\x1b\[[0-9;]*m/g, '').replace(/\]8;;[^\x07]*\x07/g, '').length;
      expect(vis, `${label} width=${w} line ${i} 可见宽度 ${vis} > ${w}`).toBeLessThanOrEqual(w);
    }
  }
}

describe('block 渲染不得超宽', () => {
  const widths = [40, 60, 80];

  it('cron：长 prompt 不超宽', () => {
    const longPrompt = 'cron: 定时检查 AIASys 两条上游 PR 的 CI 状态。'.repeat(20);
    checkNoOverflow('cron', { kind: 'cron', data: { id: '1', cron: '* * * * *', prompt: longPrompt, recurring: true, coalesced: 0 } }, widths);
  });

  it('goalPanel：长 objective 不超宽', () => {
    const longObj = '在 step-code-pi 实验仓完成 Ink → pi-tui 的 TUI 层迁移。'.repeat(10);
    checkNoOverflow('goalPanel', { kind: 'goalPanel', data: { id: '1', objective: longObj } }, widths);
  });

  it('note：长文本不超宽', () => {
    const longText = '这是一段很长的提示文本。'.repeat(20);
    checkNoOverflow('note', { kind: 'note', text: longText }, widths);
  });

  it('assistant：长文本不超宽', () => {
    const longText = '这是一段很长的回复内容。'.repeat(20);
    checkNoOverflow('assistant', { kind: 'assistant', text: longText }, widths);
  });
});

describe('ActivityLine 思考预览不得超宽', () => {
  const widths = [40, 60, 80];

  function checkActivity(label: string, preview: string, w: number): void {
    const a = new ActivityLine();
    a.setBusy(true);
    a.setThinking(true, preview);
    const lines = a.render(w);
    for (let i = 0; i < lines.length; i++) {
      const vis = visibleWidth(lines[i]!);
      expect(vis, `${label} width=${w} line ${i} 可见宽度 ${vis} > ${w}`).toBeLessThanOrEqual(w);
    }
  }

  it('长无空格 token（URL/base64）被钳到宽度内', () => {
    // wrapTextWithAnsi 只按空格折行，无空格长串不会断开；truncateToWidth 是最后的安全阀。
    // 这正是 2026-08-17 两次崩溃的形态（line 19 w=89>87、line 399 w=992>67）。
    const longToken = 'a'.repeat(500);
    for (const w of widths) checkActivity('longToken', longToken, w);
  });

  it('多行 thinking 预览尾部行不超宽', () => {
    const preview = Array.from({ length: 10 }, (_, i) => `思考片段 ${i} ` + 'x'.repeat(100)).join('\n');
    for (const w of widths) checkActivity('multiLine', preview, w);
  });

  it('thinking 为空时不渲染预览块（只留 head，不超宽）', () => {
    // preview 为空时 render 走 else-if 提示分支或仅 head，没有带全长 token 的预览行。
    const a = new ActivityLine();
    a.setBusy(true);
    a.setThinking(true, '');
    for (const w of widths) {
      const lines = a.render(w);
      expect(lines.length).toBeGreaterThanOrEqual(1);
      for (const l of lines) expect(visibleWidth(l), `width=${w}`).toBeLessThanOrEqual(w);
    }
  });
});

describe('tool 结果摘要分支不得超宽（2026-08-24 崩溃回归）', () => {
  // 崩溃现场：summary/shell/offload 分支提前 return，绕过 renderTool 底部的统一钳宽。
  // summarizeResult 按固定 80 字符截断，加上 `    ↳ ` 前缀后可见宽度 84，
  // 在 67 列终端触发 pi-tui doRender 宽度断言（两次崩溃：69>67、84>67）。
  const widths = [40, 67, 80];

  const tool = (over: Partial<Extract<DisplayItem, { kind: 'tool' }>>): DisplayItem => ({
    kind: 'tool',
    id: 't1',
    name: 'bash',
    input: { command: 'ls' },
    status: 'ok',
    ...over,
  });

  it('shell：长无空格首行摘要不超宽', () => {
    // 即 pi-crash.log 的 [92] 行：`ls -la` 输出的长文件名行
    const longLine = '-rw-r--r-- 1 ke 197121 4628591 Aug 24 15:33 ' + 'debug-20260821021949-777892-'.repeat(4) + 'zip';
    checkNoOverflow('tool.shell', tool({ name: 'bash', result: `${longLine}\nsecond` }), widths);
  });

  it('summary：长命中行摘要不超宽', () => {
    const longHit = 'src/' + 'very-long-path-segment/'.repeat(8) + 'file.ts';
    checkNoOverflow('tool.summary', tool({ name: 'grep', result: `${longHit}\n${longHit}` }), widths);
  });

  it('offload：长文件名路径行不超宽', () => {
    checkNoOverflow('tool.resultFile', tool({ result: undefined, resultFile: '/tmp/' + 'x'.repeat(120) + '.log' }), widths);
  });
});
