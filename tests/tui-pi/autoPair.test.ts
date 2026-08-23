import { describe, expect, it } from 'vitest';
import { AUTO_PAIRS, CLOSE_CHARS, decodePrintable, planAutoPair, shouldPair } from '../../src/tui-pi/autoPair.js';

describe('autoPair 纯逻辑', () => {
  describe('AUTO_PAIRS / CLOSE_CHARS', () => {
    it('覆盖三类括号与三类引号', () => {
      expect(AUTO_PAIRS).toEqual({ '(': ')', '[': ']', '{': '}', '"': '"', "'": "'", '`': '`' });
      expect(CLOSE_CHARS).toEqual(new Set([')', ']', '}', '"', "'", '`']));
    });
  });

  describe('decodePrintable', () => {
    it('裸字符原样返回', () => {
      expect(decodePrintable('(')).toBe('(');
      expect(decodePrintable('a')).toBe('a');
      expect(decodePrintable(' ')).toBe(' ');
    });
    it('kitty CSI-u 序列还原成字符', () => {
      // '(' 的码点是 40；kitty 编码为 ESC [ 40 u
      expect(decodePrintable('\x1b[40u')).toBe('(');
      expect(decodePrintable('\x1b[97u')).toBe('a');
    });
    it('控制键 / 箭头 / 粘贴返回 undefined', () => {
      expect(decodePrintable('\x1b[D')).toBeUndefined(); // 左箭头
      expect(decodePrintable('\r')).toBeUndefined(); // 回车（<32）
      expect(decodePrintable('\x1b')).toBeUndefined(); // 单独 ESC
      expect(decodePrintable('\x1b[200~')).toBeUndefined(); // 粘贴开始
    });
  });

  describe('开符配对', () => {
    it('括号恒配对，光标在行尾', () => {
      expect(planAutoPair('(', '')).toEqual({ kind: 'insert-pair', text: '()' });
      expect(planAutoPair('[', '')).toEqual({ kind: 'insert-pair', text: '[]' });
      expect(planAutoPair('{', '')).toEqual({ kind: 'insert-pair', text: '{}' });
    });
    it('括号跟在字母后仍配对（foo( → foo(|)）', () => {
      expect(planAutoPair('(', 'x')).toEqual({ kind: 'insert-pair', text: '()' });
    });
    it('引号在行尾配对', () => {
      expect(planAutoPair('"', '')).toEqual({ kind: 'insert-pair', text: '""' });
      expect(planAutoPair("'", '')).toEqual({ kind: 'insert-pair', text: "''" });
      expect(planAutoPair('`', '')).toEqual({ kind: 'insert-pair', text: '``' });
    });
    it('引号后接字母数字不配对（避开 don’t 撇号）', () => {
      expect(planAutoPair("'", 't')).toEqual({ kind: 'none' });
      expect(planAutoPair('"', 'h')).toEqual({ kind: 'none' });
    });
  });

  describe('闭符 type-over', () => {
    it('光标处已是该闭符 → 右移越过，不重复插入', () => {
      expect(planAutoPair(')', ')')).toEqual({ kind: 'skip-close' });
      expect(planAutoPair('"', '"')).toEqual({ kind: 'skip-close' });
    });
    it('光标处不是该闭符 → 普通插入（走 none，交回编辑器）', () => {
      expect(planAutoPair(')', 'x')).toEqual({ kind: 'none' });
      expect(planAutoPair(')', '')).toEqual({ kind: 'none' });
    });
  });

  describe('不干预的输入', () => {
    it('普通字母数字返回 none', () => {
      expect(planAutoPair('a', '')).toEqual({ kind: 'none' });
      expect(planAutoPair('1', '')).toEqual({ kind: 'none' });
    });
    it('右括号但不是 type-over（光标处为空）返回 none', () => {
      expect(planAutoPair(']', '')).toEqual({ kind: 'none' });
    });
  });

  describe('shouldPair 启发式', () => {
    it('括号恒 true', () => {
      expect(shouldPair('(', 'a')).toBe(true);
      expect(shouldPair('[', '5')).toBe(true);
    });
    it('引号仅下一字符非字母数字', () => {
      expect(shouldPair('"', '')).toBe(true);
      expect(shouldPair('"', ' ')).toBe(true);
      expect(shouldPair('"', '.')).toBe(true);
      expect(shouldPair('"', 'a')).toBe(false);
      expect(shouldPair("'", '9')).toBe(false);
    });
  });
});
