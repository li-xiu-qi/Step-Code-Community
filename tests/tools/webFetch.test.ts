import { afterEach, describe, expect, it, vi } from 'vitest';
import * as undici from 'undici';
import { webFetchTool } from '../../src/tools/webFetch.js';
import { webResultCache } from '../../src/tools/webCache.js';
import type { ToolContext } from '../../src/tools/types.js';

vi.mock('node:dns/promises', async () => {
  // 保留真实实现：不干预 DNS 的用例（原有内容提取测试）继续走真实解析。
  // SSRF 用例里用 spyOn 覆盖 lookup，只改返回值不改结构。
  const actual = await vi.importActual<typeof import('node:dns/promises')>('node:dns/promises');
  return { ...actual, default: actual };
});

import * as dnsPromises from 'node:dns/promises';
const mockedLookup = vi.spyOn(dnsPromises, 'lookup');

vi.mock('undici', async () => {
  const actual = await vi.importActual<typeof undici>('undici');
  return {
    ...actual,
    fetch: vi.fn(),
  };
});

const mockedFetch = vi.mocked(undici.fetch);

const ctx: ToolContext = { cwd: process.cwd() };

afterEach(() => {
  vi.clearAllMocks();
  // spyOn 建立的 mock 实现会被 clearAllMocks 一并清掉，这里恢复默认实现
  mockedLookup.mockRestore();
  webResultCache.clear();
});

function makeResponse(opts: {
  status?: number;
  headers?: Record<string, string>;
  body?: string;
}): Response {
  const { status = 200, headers = {}, body = '' } = opts;
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: {
      get: (name: string) => headers[name.toLowerCase()] ?? null,
    },
    text: async () => body,
    body: null,
  } as unknown as Response;
}

describe('web_fetch 工具', () => {
  it('text/plain 原样透传', async () => {
    mockedFetch.mockResolvedValueOnce(
      makeResponse({
        headers: { 'content-type': 'text/plain; charset=utf-8' },
        body: 'plain text content',
      }) as unknown as Awaited<ReturnType<typeof undici.fetch>>,
    );
    const r = await webFetchTool.execute({ url: 'https://example.com/a.txt' }, ctx);
    expect(r.isError).toBe(false);
    expect(r.content).toContain('plain text content');
    expect(r.content).toContain('full response body');
  });

  it('application/x-sh 作为文本透传，不走 HTML 提取', async () => {
    const script = '#!/bin/sh\necho hello';
    mockedFetch.mockResolvedValueOnce(
      makeResponse({
        headers: { 'content-type': 'application/x-sh' },
        body: script,
      }) as unknown as Awaited<ReturnType<typeof undici.fetch>>,
    );
    const r = await webFetchTool.execute({ url: 'https://cdn.kimi.com/webbridge/install.sh' }, ctx);
    expect(r.isError).toBe(false);
    expect(r.content).toContain('#!/bin/sh');
    expect(r.content).toContain('echo hello');
  });

  it('application/json 作为文本透传', async () => {
    mockedFetch.mockResolvedValueOnce(
      makeResponse({
        headers: { 'content-type': 'application/json' },
        body: '{"ok":true}',
      }) as unknown as Awaited<ReturnType<typeof undici.fetch>>,
    );
    const r = await webFetchTool.execute({ url: 'https://example.com/api' }, ctx);
    expect(r.isError).toBe(false);
    expect(r.content).toContain('{"ok":true}');
  });

  it('text/html 走 Readability 提取', async () => {
    mockedFetch.mockResolvedValueOnce(
      makeResponse({
        headers: { 'content-type': 'text/html' },
        body: '<html><head><title>T</title></head><body><article><p>paragraph</p></article></body></html>',
      }) as unknown as Awaited<ReturnType<typeof undici.fetch>>,
    );
    const r = await webFetchTool.execute({ url: 'https://example.com/article' }, ctx);
    expect(r.isError).toBe(false);
    expect(r.content).toContain('paragraph');
  });

  it('HTTP 错误返回错误结果', async () => {
    mockedFetch.mockResolvedValueOnce(
      makeResponse({ status: 404, body: 'not found' }) as unknown as Awaited<ReturnType<typeof undici.fetch>>,
    );
    const r = await webFetchTool.execute({ url: 'https://example.com/missing' }, ctx);
    expect(r.isError).toBe(true);
    expect(r.content).toContain('404');
  });

  // --- 提取后正文的返回上限（OOM 修复：MAX_BYTES 只拦响应体，不拦提取后正文）---

  it('正文超过 inline 上限时截断并附恢复提示，且不写入缓存', async () => {
    webResultCache.clear();
    const url = 'https://example.com/huge.txt';
    const body = 'H'.repeat(250_000); // > MAX_INLINE_CHARS (200k)
    mockedFetch.mockResolvedValueOnce(
      makeResponse({
        headers: { 'content-type': 'text/plain; charset=utf-8' },
        body,
      }) as unknown as Awaited<ReturnType<typeof undici.fetch>>,
    );
    const r = await webFetchTool.execute({ url }, ctx);
    expect(r.isError).toBe(false);
    expect(r.content).toContain('[content truncated: showing first 200000 of 250000 characters');
    // 返回体不含全文（截断后长度远小于原文 + 提示）
    expect(r.content.length).toBeLessThan(body.length);
    // 关键：截断内容不入缓存——半截正文一旦命中会被当成完整结果
    expect(webResultCache.get(url)).toBeUndefined();
    expect(webResultCache.size).toBe(0);
  });

  it('正文未超上限时正常写入缓存', async () => {
    webResultCache.clear();
    const url = 'https://example.com/small.txt';
    mockedFetch.mockResolvedValueOnce(
      makeResponse({
        headers: { 'content-type': 'text/plain; charset=utf-8' },
        body: 'small body',
      }) as unknown as Awaited<ReturnType<typeof undici.fetch>>,
    );
    await webFetchTool.execute({ url }, ctx);
    expect(webResultCache.get(url)?.content).toBe('small body');
    webResultCache.clear();
  });

  // --- 站点适配：微信公众号 #js_content 隐藏容器 ---
  // 公众号正文容器首屏带 style="visibility:hidden;opacity:0"，Readability 判不可见
  // 只返回标题作者（2026-08-04 实测 272 字 vs 正文 6632 字）。适配仅对
  // mp.weixin.qq.com 主机、仅对 #js_content 生效，不得泄漏成全局行为。

  function makeWeChatHtml(paragraphs: string[]): string {
    const body = paragraphs.map((p) => `<p>${p}</p>`).join('');
    return (
      '<html><head><title>文章标题</title></head><body>' +
      '<div class="rich_media"><h1>文章标题</h1><div id="js_name">某公众号</div>' +
      `<div class="rich_media_content" id="js_content" style="visibility: hidden; opacity: 0;">${body}</div>` +
      '</div></body></html>'
    );
  }

  it('微信公众号：#js_content 隐藏 style 被剥离后返回正文而非只有标题作者', async () => {
    webResultCache.clear();
    const paragraphs = Array.from({ length: 30 }, (_, i) => `正文段落第 ${String(i)} 段，公众号正文内容。`);
    mockedFetch.mockResolvedValueOnce(
      makeResponse({
        headers: { 'content-type': 'text/html' },
        body: makeWeChatHtml(paragraphs),
      }) as unknown as Awaited<ReturnType<typeof undici.fetch>>,
    );
    const r = await webFetchTool.execute({ url: 'https://mp.weixin.qq.com/s/abc123' }, ctx);
    expect(r.isError).toBe(false);
    expect(r.content).toContain('正文段落第 29 段');
    expect(r.content.length).toBeGreaterThan(paragraphs.join('').length / 2);
    webResultCache.clear();
  });

  it('非微信 URL 不触发特判：隐藏容器仍按原逻辑处理', async () => {
    webResultCache.clear();
    // 同一 fixture 放在非微信域名下，隐藏内容不应被强行提取；
    // Readability/fallback 原逻辑返回什么就是什么，关键是返回值不含「正文字段」直取痕迹
    const paragraphs = Array.from({ length: 30 }, (_, i) => `正文字段第 ${String(i)} 段内容。`);
    mockedFetch.mockResolvedValueOnce(
      makeResponse({
        headers: { 'content-type': 'text/html' },
        body:
          '<html><head><title>T</title></head><body><article><p>可见正文</p></article>' +
          `<div id="js_content" style="visibility:hidden;opacity:0;">${paragraphs
            .map((p) => `<p>${p}</p>`)
            .join('')}</div></body></html>`,
      }) as unknown as Awaited<ReturnType<typeof undici.fetch>>,
    );
    const r = await webFetchTool.execute({ url: 'https://example.com/article' }, ctx);
    expect(r.isError).toBe(false);
    expect(r.content).toContain('可见正文');
    expect(r.content).not.toContain('正文字段第 29 段');
    webResultCache.clear();
  });

  it('微信页 Readability 结果异常短时回退到 #js_content 文本', async () => {
    webResultCache.clear();
    // 无 h1/标题线索、正文容器结构极扁平时，Readability 可能只返回页头碎片；
    // 只要结果远短于 #js_content 自身文本（阈值 1/3），必须回退直取
    const paragraphs = Array.from({ length: 40 }, (_, i) => `回退路径正文第 ${String(i)} 段，内容内容内容。`);
    mockedFetch.mockResolvedValueOnce(
      makeResponse({
        headers: { 'content-type': 'text/html' },
        body: makeWeChatHtml(paragraphs),
      }) as unknown as Awaited<ReturnType<typeof undici.fetch>>,
    );
    const r = await webFetchTool.execute({ url: 'https://mp.weixin.qq.com/s/def456' }, ctx);
    expect(r.isError).toBe(false);
    // 不管走的是 Readability 主路径还是 #js_content 回退，完整正文都必须在
    expect(r.content).toContain('回退路径正文第 0 段');
    expect(r.content).toContain('回退路径正文第 39 段');
    webResultCache.clear();
  });

  describe('SSRF 防护：私有地址阻断', () => {
    // resolveSafeFetchTarget 只在域名解析后才知道目标 IP，这里用 mock DNS
    // 控制解析结果，才能测到「域名解析到私网地址」这条真实路径
    function resolveTo(address: string): void {
      mockedLookup.mockResolvedValueOnce([
        { address, family: address.includes(':') ? 6 : 4 },
      ] as unknown as Awaited<ReturnType<typeof dnsPromises.lookup>>);
    }

    async function expectRefused(url: string): Promise<void> {
      const r = await webFetchTool.execute({ url }, ctx);
      expect(r.isError).toBe(true);
    }

    it('拒绝字面量私有 IPv4 地址', async () => {
      for (const url of [
        'http://127.0.0.1/x',
        'http://10.0.0.1/x',
        'http://192.168.1.1/x',
        'http://172.16.0.1/x',
        'http://169.254.169.254/latest/meta-data/',
        'http://0.0.0.0/x',
      ]) {
        await expectRefused(url);
      }
      expect(mockedFetch).not.toHaveBeenCalled();
    });

    it('拒绝 IPv4-mapped IPv6 形式的私有地址（Node BlockList 内建解嵌）', async () => {
      for (const url of [
        'http://[::ffff:127.0.0.1]/x',
        'http://[::ffff:10.0.0.1]/x',
        'http://[::ffff:169.254.169.254]/x',
        'http://[::ffff:192.168.1.1]/x',
      ]) {
        await expectRefused(url);
      }
      expect(mockedFetch).not.toHaveBeenCalled();
    });

    it('拒绝 NAT64/DNS64 前缀下内嵌私有 IPv4 的地址', async () => {
      // RFC 6052 well-known 前缀 64:ff9b::/96，后 32 位是内嵌 IPv4。
      // 这类地址 isIP() 返回 6，阻断表的 IPv6 条目覆盖不到内嵌部分，
      // 必须解嵌后按 IPv4 再判（2026-09-11 实测曾漏放）。
      for (const url of [
        'http://[64:ff9b::a00:1]/x', // 10.0.0.1
        'http://[64:ff9b::7f00:1]/x', // 127.0.0.1
        'http://[64:ff9b::a9fe:a9fe]/x', // 169.254.169.254 云元数据
        'http://[64:ff9b::c0a8:101]/x', // 192.168.1.1
        'http://[64:ff9b::6440:1]/x', // 100.64.0.1，落在 100.64.0.0/10
        'http://[64:ff9b::1]/x', // 0.0.0.1，压缩写法
        'http://[64:FF9B::A00:1]/x', // 大写形式
      ]) {
        await expectRefused(url);
      }
      expect(mockedFetch).not.toHaveBeenCalled();
    });

    it('NAT64 前缀下内嵌公网 IPv4 的地址放行（解嵌逻辑不得误判）', async () => {
      resolveTo('2606:2800:220:1:248:1893:25c8:1946');
      mockedFetch.mockResolvedValueOnce(
        makeResponse({
          headers: { 'content-type': 'text/plain' },
          body: 'hello',
        }) as unknown as Awaited<ReturnType<typeof undici.fetch>>,
      );
      const r = await webFetchTool.execute({ url: 'http://[64:ff9b::0808:808]/x' }, ctx);
      expect(r.isError).toBe(false);
    });

    it('拒绝纯 IPv6 回环与链路本地地址', async () => {
      for (const url of [
        'http://[::1]/x',
        'http://[fe80::1]/x',
        'http://[fc00::1]/x',
      ]) {
        await expectRefused(url);
      }
      expect(mockedFetch).not.toHaveBeenCalled();
    });

    it('拒绝域名解析到私有地址', async () => {
      resolveTo('127.0.0.1');
      await expectRefused('http://evil.test/x');
      resolveTo('169.254.169.254');
      await expectRefused('http://metadata.test/x');
      resolveTo('10.1.2.3');
      await expectRefused('http://internal.test/x');
      expect(mockedFetch).not.toHaveBeenCalled();
    });

    it('localhost 主机名直接拒绝', async () => {
      await expectRefused('http://localhost:3000/x');
      await expectRefused('http://app.localhost/x');
      expect(mockedLookup).not.toHaveBeenCalled();
    });

    it('拒绝非 http(s) 协议', async () => {
      await expectRefused('file:///etc/passwd');
      await expectRefused('ftp://example.com/x');
      expect(mockedFetch).not.toHaveBeenCalled();
    });

    it('域名解析到公网地址时放行（阻断逻辑不得误伤正常站点）', async () => {
      resolveTo('93.184.216.34');
      mockedFetch.mockResolvedValueOnce(
        makeResponse({
          headers: { 'content-type': 'text/plain' },
          body: 'public page',
        }) as unknown as Awaited<ReturnType<typeof undici.fetch>>,
      );
      const r = await webFetchTool.execute({ url: 'https://example.com/page' }, ctx);
      expect(r.isError).toBe(false);
      expect(r.content).toContain('public page');
    });

    it('重定向到私有地址时再次校验（逐跳钉扎）', async () => {
      // 第一跳公网放行，第二跳跳回私网必须拦下
      resolveTo('93.184.216.34');
      mockedFetch.mockResolvedValueOnce(
        makeResponse({
          status: 302,
          headers: { location: 'http://169.254.169.254/latest/meta-data/' },
          body: '',
        }) as unknown as Awaited<ReturnType<typeof undici.fetch>>,
      );
      await expectRefused('https://example.com/redirect');
    });
  });

});
