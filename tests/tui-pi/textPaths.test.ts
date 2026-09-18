/**
 * 正文绝对路径建链的专项测试。
 *
 * 重点钉住「不点错」：URL 中间段不扫、围栏代码块内不扫、已有链接内不嵌套、
 * 行号后缀与句尾标点剥掉、无扩展名非目录不建链。建链正确性是次要的
 * （hyperlink 的格式由 pi-tui 保证，fileLink 的测试覆盖 buildFileUrl）。
 */
import { describe, expect, it } from 'vitest';
import { linkifyAbsolutePaths } from '../../src/tui-pi/textPaths.js';

const ESC = String.fromCharCode(27);
const LINK_OPEN = `${ESC}]8;;step-file:`;

/** 文本里是否含 step-file: 链接。 */
function hasLink(s: string): boolean {
  return s.includes(LINK_OPEN);
}

describe('建链命中', () => {
  it('POSIX 绝对路径（带扩展名）建链', () => {
    const out = linkifyAbsolutePaths('已修改 /home/ke/proj/src/a.ts 完成');
    expect(hasLink(out)).toBe(true);
    // 显示文本是被剥干净的路径本身
    expect(out).toContain(`${LINK_OPEN}`);
    expect(out).toContain('完成');
  });

  it('Windows 盘符路径（反斜杠）建链', () => {
    const out = linkifyAbsolutePaths('文件在 C:\\Users\\ke\\notes\\readme.md 里');
    expect(hasLink(out)).toBe(true);
  });

  it('目录（分隔符结尾）建链', () => {
    const out = linkifyAbsolutePaths('看 /home/ke/proj/src/ 目录');
    expect(hasLink(out)).toBe(true);
  });

  it('同一行多个路径各自建链', () => {
    const out = linkifyAbsolutePaths('/a/b.ts 和 /c/d.md');
    expect(out.split(LINK_OPEN).length - 1).toBe(2);
  });
});

describe('保守跳过', () => {
  it('URL 中间段不建链（https://example.com/a/b.js）', () => {
    const out = linkifyAbsolutePaths('见 https://example.com/a/b.js 说明');
    expect(hasLink(out)).toBe(false);
  });

  it('裸词内的路径形状不建链（foo/bar/x.ts）', () => {
    const out = linkifyAbsolutePaths('模块 foo/bar/x.ts 已改名');
    expect(hasLink(out)).toBe(false);
  });

  it('无扩展名且非目录结尾不建链（a/b 词组）', () => {
    const out = linkifyAbsolutePaths('走 and/or/whatever 这条路');
    expect(hasLink(out)).toBe(false);
  });

  it('围栏代码块内不建链', () => {
    const out = linkifyAbsolutePaths('示例：\n```\nimport x from /abs/lib.js\n```\n结束');
    expect(hasLink(out)).toBe(false);
  });

  it('围栏块外正常建链（同一文本）', () => {
    const out = linkifyAbsolutePaths('```\n/abs/in-code.js\n```\n另外 /abs/real.ts 可点');
    expect(out.split(LINK_OPEN).length - 1).toBe(1);
  });

  it('markdown 链接的 URL 位不重复建链（[text](/a/b.ts)）', () => {
    const out = linkifyAbsolutePaths('看 [说明](/a/b.ts) 这里');
    // 无 step-file 链接（md 链接交给 Markdown 解析器，非白名单 URL 会被降级）
    expect(hasLink(out)).toBe(false);
  });

  it('已有 OSC 8 链接内不嵌套（链接文本本身是绝对路径）', () => {
    const existing = `${ESC}]8;;step-file:C%3A%2Fpre.ts${ESC}\\C:\\pre.ts${ESC}]8;;${ESC}\\`;
    const out = linkifyAbsolutePaths(`已链接 ${existing} 结束`);
    // 原有链接保持原样，不出现双层
    expect(out).toBe(`已链接 ${existing} 结束`);
  });

  it('纯文本无斜杠时原样返回（引用相等）', () => {
    const text = '没有路径的一句话';
    expect(linkifyAbsolutePaths(text)).toBe(text);
  });
});

describe('清洗规则', () => {
  it('grep 风格行号后缀剥掉（/a/b.ts:42:match）', () => {
    const out = linkifyAbsolutePaths('/a/b.ts:42:match 这一行');
    expect(hasLink(out)).toBe(true);
    // 链接载荷里不含 :42
    expect(out).toContain('a%2Fb.ts');
    expect(out).not.toContain('%3A42');
  });

  it('句尾标点剥掉（句号/逗号/右括号）', () => {
    const out = linkifyAbsolutePaths('看 /a/b.ts，然后 /c/d.md。');
    expect(hasLink(out)).toBe(true);
    expect(out).not.toContain('b.ts%EF%BC%8C'); // 中文逗号不进链接
    expect(out.endsWith('。')).toBe(true);
  });

  it('URL 载荷对反斜杠与中文做百分号编码（decode 可还原）', () => {
    const out = linkifyAbsolutePaths('C:\\项目\\笔记.md 在这里');
    expect(hasLink(out)).toBe(true);
    // 反斜杠与中文都在链接载荷里被编码
    expect(out).toContain('%5C');
    expect(out).toContain('%E7');
  });
});
