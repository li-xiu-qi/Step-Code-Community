/**
 * markdownPrep.softenBreaks：段落软换行合并（对齐 Ink 版 softenBreaks 语义）。
 * 钉住：CJK 直接、拉丁补空格、词内标点保护 URL、结构行不合并。
 */
import { describe, expect, it } from 'vitest';
import { markdownTransform, softenBreaks, stripUnsafeLinks } from '../../src/chat/markdownPrep.js';

describe('softenBreaks 软换行合并', () => {
  it('CJK 相邻直接接，不加空格', () => {
    expect(softenBreaks('这是第一行\n接着第二行')).toBe('这是第一行接着第二行');
  });

  it('拉丁两侧补一个空格', () => {
    expect(softenBreaks('hello world\nnext line')).toBe('hello world next line');
  });

  it('一侧 CJK 一侧拉丁也直接接', () => {
    expect(softenBreaks('中文\nenglish')).toBe('中文english');
    expect(softenBreaks('english\n中文')).toBe('english中文');
  });

  it('词内标点 + 小写/数字续接直接接（URL/路径不断行）', () => {
    expect(softenBreaks('见 https://example.com/\ndocs 说明')).toBe('见 https://example.com/docs 说明');
    expect(softenBreaks('src/tui-\npi 目录')).toBe('src/tui-pi 目录');
  });

  it('空行是段落边界，不跨段合并', () => {
    expect(softenBreaks('第一段\n\n第二段')).toBe('第一段\n\n第二段');
  });

  it('结构行不参与合并：标题/列表/表格/引用/分割线', () => {
    expect(softenBreaks('# 标题\n正文')).toBe('# 标题\n正文');
    expect(softenBreaks('正文\n- 列表项')).toBe('正文\n- 列表项');
    expect(softenBreaks('| a | b |\n| c | d |')).toBe('| a | b |\n| c | d |');
    expect(softenBreaks('> 引用\n第二行')).toBe('> 引用\n第二行');
    expect(softenBreaks('上文\n---\n下文')).toBe('上文\n---\n下文');
    expect(softenBreaks('1. 第一\n2. 第二')).toBe('1. 第一\n2. 第二');
  });

  it('围栏代码块内一个字都不动', () => {
    const src = '```ts\nconst a =\n1;\nconst b = 2;\n```\n段落一\n段落二';
    expect(softenBreaks(src)).toBe('```ts\nconst a =\n1;\nconst b = 2;\n```\n段落一段落二');
  });

  it('列表项内的续行不合并进列表项（保守方向）', () => {
    expect(softenBreaks('- 第一项\n- 第二项')).toBe('- 第一项\n- 第二项');
  });

  it('连续多行段落逐行合并成一行', () => {
    expect(softenBreaks('甲\n乙\n丙')).toBe('甲乙丙');
  });
});

/**
 * stripUnsafeLinks：markdown 链接的 scheme 白名单。
 * 钉住：白名单内原样、白名单外降级为纯文本、降级后不留裸 URL、不吞内容。
 */
describe('stripUnsafeLinks 链接 scheme 白名单', () => {
  it('白名单内的链接原样保留', () => {
    const cases = [
      '[官网](https://example.com)',
      '[内网](http://intranet.local/x)',
      '[文件](file:///C:/a/b.ts)',
      '[路径](step-file:src%2Fmain.ts)',
      '[跳转](step://turn/3)',
    ];
    for (const c of cases) expect(stripUnsafeLinks(c)).toBe(c);
  });

  it('scheme 大小写不敏感（HTTPS 也放行）', () => {
    expect(stripUnsafeLinks('[x](HTTPS://EXAMPLE.COM)')).toBe('[x](HTTPS://EXAMPLE.COM)');
  });

  it('白名单外的 scheme 降级为纯文本', () => {
    // prompt injection 的典型载荷：借终端 handler 触发系统行为
    expect(stripUnsafeLinks('[点我](ssh://evil.example.com)')).toBe('点我');
    expect(stripUnsafeLinks('[点我](vnc://evil.example.com)')).toBe('点我');
    expect(stripUnsafeLinks('[点我](javascript:alert(1))')).toBe('点我');
    expect(stripUnsafeLinks('[点我](file:relative/path)')).toBe('点我');
    // 前缀伪装：以 https 开头但不是 http(s) scheme 的不能被放过
    expect(stripUnsafeLinks('[x](httpsx://a.com)')).toBe('x');
  });

  it('降级后不留链接语法，也不留裸 URL 诱导手工复制', () => {
    const out = stripUnsafeLinks('说明 [查看](ssh://evil) 结束');
    expect(out).toBe('说明 查看 结束');
    expect(out).not.toContain('](');
    expect(out).not.toContain('ssh:');
  });

  it('显示文本为空时原样保留，不吞内容', () => {
    expect(stripUnsafeLinks('[](ssh://evil)')).toBe('[](ssh://evil)');
  });

  it('带 title 的链接也参与判定', () => {
    expect(stripUnsafeLinks('[x](https://a.com "标题")')).toBe('[x](https://a.com "标题")');
    expect(stripUnsafeLinks('[x](ssh://a.com "标题")')).toBe('x');
  });

  it('一次处理多个链接，各自判定互不影响', () => {
    const src = '[好](https://ok.com) 与 [坏](ssh://bad.com) 与 [内](step://turn/1)';
    expect(stripUnsafeLinks(src)).toBe('[好](https://ok.com) 与 坏 与 [内](step://turn/1)');
  });

  it('方括号加圆括号但非链接语法的形态不动', () => {
    expect(stripUnsafeLinks('见 [注] (说明)')).toBe('见 [注] (说明)');
  });
});

/**
 * markdownTransform：过滤必须接在 softenBreaks 之后。
 * 钉住顺序依赖：URL 被软换行折断时，先合并才能看到完整 scheme。
 */
describe('markdownTransform 的过滤接入顺序', () => {
  it('被软换行折断的 URL 也能正确拦截', () => {
    const out = markdownTransform('看这\n[点我](ssh://evil.example.com)');
    expect(out).not.toContain('](');
    expect(out).toContain('点我');
  });

  it('白名单链接在合并换行后仍保留', () => {
    expect(markdownTransform('看这\n[官网](https://example.com)')).toContain('[官网](https://example.com)');
  });
});
