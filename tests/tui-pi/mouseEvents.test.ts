/**
 * SGR 鼠标序列解析测试。
 *
 * 覆盖协议的各分支（按下/释放/拖动/滚轮/修饰键）、坐标 1-based 转 0-based、
 * 非鼠标序列与旧式 X10 的拒绝。纯函数测试，不依赖终端环境。
 */
import { describe, expect, it } from 'vitest';
import { parseSGRMouse } from '../../src/tui-pi/mouseEvents.js';

describe('parseSGRMouse', () => {
  it('左键按下/释放：button 0，坐标转 0-based', () => {
    expect(parseSGRMouse('\x1b[<0;10;5M')).toEqual({ kind: 'press', button: 0, col: 9, row: 4 });
    expect(parseSGRMouse('\x1b[<0;10;5m')).toEqual({ kind: 'release', button: 0, col: 9, row: 4 });
  });

  it('中键/右键按下', () => {
    expect(parseSGRMouse('\x1b[<1;3;3M')).toEqual({ kind: 'press', button: 1, col: 2, row: 2 });
    expect(parseSGRMouse('\x1b[<2;3;3M')).toEqual({ kind: 'press', button: 2, col: 2, row: 2 });
  });

  it('拖动：motion 位（32）判为 drag，按钮号取低两位', () => {
    expect(parseSGRMouse('\x1b[<32;10;5M')).toEqual({ kind: 'drag', button: 0, col: 9, row: 4 });
    expect(parseSGRMouse('\x1b[<34;10;5M')).toEqual({ kind: 'drag', button: 2, col: 9, row: 4 });
  });

  it('滚轮：wheel 位（64）判为 wheel，button 4 上 / 5 下', () => {
    expect(parseSGRMouse('\x1b[<64;10;5M')).toEqual({ kind: 'wheel', button: 4, col: 9, row: 4 });
    expect(parseSGRMouse('\x1b[<65;10;5M')).toEqual({ kind: 'wheel', button: 5, col: 9, row: 4 });
  });

  it('修饰键位不改变按钮识别（shift 4 / alt 8 / ctrl 16）', () => {
    expect(parseSGRMouse('\x1b[<4;10;5M')?.kind).toBe('press');
    expect(parseSGRMouse('\x1b[<8;10;5M')?.button).toBe(0);
    expect(parseSGRMouse('\x1b[<16;10;5M')?.button).toBe(0);
  });

  it('坐标为 0 或损坏时钳到 0，不产出负下标', () => {
    expect(parseSGRMouse('\x1b[<0;0;0M')).toEqual({ kind: 'press', button: 0, col: 0, row: 0 });
  });

  it('非鼠标序列一律拒绝', () => {
    expect(parseSGRMouse('a')).toBeUndefined();
    expect(parseSGRMouse('\x1b[A')).toBeUndefined();
    expect(parseSGRMouse('\x1b[<0;10;5')).toBeUndefined(); // 不完整
    expect(parseSGRMouse('\x1b[<0;10;5X')).toBeUndefined(); // 错误终结符
    expect(parseSGRMouse('\x1b[M abc')).toBeUndefined(); // 旧式 X10，不支持
    expect(parseSGRMouse('\x1b[<a;b;cM')).toBeUndefined(); // 非数字
  });

  it('多位数坐标（大终端 100+ 列）', () => {
    expect(parseSGRMouse('\x1b[<0;120;45M')).toEqual({ kind: 'press', button: 0, col: 119, row: 44 });
  });
});
