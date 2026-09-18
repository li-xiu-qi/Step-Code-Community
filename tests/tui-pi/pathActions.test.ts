/**
 * 路径动作的系统交付层测试。只覆盖无副作用的 OSC 52 写入；
 * reveal/open 的 spawn 行为有真实系统副作用（弹窗口），留给手动验证。
 */
import { describe, expect, it } from 'vitest';
import { copyTextToClipboard } from '../../src/tui-pi/pathActions.js';

describe('copyTextToClipboard', () => {
  it('写 OSC 52 序列：ESC ] 52 ; c ; <base64> BEL', () => {
    const writes: string[] = [];
    copyTextToClipboard('C:/proj/src/a.ts', (d) => writes.push(d));
    expect(writes).toHaveLength(1);
    const seq = writes[0]!;
    expect(seq.startsWith('\x1b]52;c;')).toBe(true);
    expect(seq.endsWith('\x07')).toBe(true);
    const b64 = seq.slice('\x1b]52;c;'.length, -1);
    expect(Buffer.from(b64, 'base64').toString('utf-8')).toBe('C:/proj/src/a.ts');
  });

  it('含中文的路径按 UTF-8 编码后再 base64', () => {
    const writes: string[] = [];
    copyTextToClipboard('C:/项目/笔记.md', (d) => writes.push(d));
    const b64 = writes[0]!.slice('\x1b]52;c;'.length, -1);
    expect(Buffer.from(b64, 'base64').toString('utf-8')).toBe('C:/项目/笔记.md');
  });
});
