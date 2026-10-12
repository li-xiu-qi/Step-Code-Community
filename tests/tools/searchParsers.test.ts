/**
 * Bing / DuckDuckGo HTML 解析器测试：钉住卡片结构与实体解码，改版即红。
 */
import { describe, expect, it } from 'vitest';
import { parseBingHtml } from '../../src/tools/search/providers/bing.js';
import { parseDdgHtml } from '../../src/tools/search/providers/duckduckgo.js';

describe('parseBingHtml', () => {
  it('提取标题/链接/摘要，去标签与实体解码', () => {
    const html = `
      <li class="b_algo"><h2><a href="https://a.com/x">标题 &amp; 甲</a></h2>
        <div class="b_caption"><p>摘要 <strong>加粗</strong> 内容</p></div></li>
      <li class="b_algo"><h2><a href="https://b.com/y">标题乙</a></h2></li>`;
    const hits = parseBingHtml(html, 10);
    expect(hits).toHaveLength(2);
    expect(hits[0]).toMatchObject({ title: '标题 & 甲', url: 'https://a.com/x' });
    expect(hits[0]!.snippet).toContain('加粗');
    expect(hits[1]!.snippet).toBeUndefined();
  });

  it('非 http 链接跳过、max 生效', () => {
    const html = `
      <li class="b_algo"><h2><a href="javascript:void(0)">坏</a></h2></li>
      <li class="b_algo"><h2><a href="https://a.com">一</a></h2></li>
      <li class="b_algo"><h2><a href="https://b.com">二</a></h2></li>`;
    const hits = parseBingHtml(html, 1);
    expect(hits).toHaveLength(1);
    expect(hits[0]!.url).toBe('https://a.com');
  });
});

describe('parseDdgHtml', () => {
  it('uddg 跳转链接解码', () => {
    const html = `
      <a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Freal.com%2Fpage&amp;rut=abc">真实标题</a>
      <a class="result__snippet" href="#">真实摘要 &lt;em&gt;</a>`;
    const hits = parseDdgHtml(html, 10);
    expect(hits).toHaveLength(1);
    expect(hits[0]!.url).toBe('https://real.com/page');
    expect(hits[0]!.title).toBe('真实标题');
    expect(hits[0]!.snippet).toContain('真实摘要');
  });

  it('直链与跳转链混合', () => {
    const html = `
      <a class="result__a" href="https://direct.com/">直连</a>
      <a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fvia.com%2F">跳转</a>`;
    const hits = parseDdgHtml(html, 10);
    expect(hits.map((h) => h.url)).toEqual(['https://direct.com/', 'https://via.com/']);
  });
});
