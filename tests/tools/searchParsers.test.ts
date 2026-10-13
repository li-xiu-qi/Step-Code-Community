/**
 * AnySearch 响应解析测试：钉住 data.results / 顶层 results 两种包装与失败归类。
 * （bing/duckduckgo 的 HTML 解析器随抓取类提供商一并移除，2026-10-13。）
 */
import { describe, expect, it } from 'vitest';
import { anysearchProvider } from '../../src/tools/search/providers/anysearch.js';

describe('anysearchProvider', () => {
  it('data.results 包装解析', async () => {
    const payload = { data: { results: [{ title: '甲', url: 'https://a.com', snippet: '摘', content: '正文', date: '2026-01-01' }] } };
    const original = globalThis.fetch;
    globalThis.fetch = (async () => ({ ok: true, status: 200, json: async () => payload }) as Response) as typeof fetch;
    try {
      const hits = await anysearchProvider.search({ query: 'q', n: 5, key: 'k' });
      expect(hits).toHaveLength(1);
      expect(hits[0]).toMatchObject({ title: '甲', url: 'https://a.com', snippet: '摘', content: '正文', time: '2026-01-01' });
    } finally {
      globalThis.fetch = original;
    }
  });

  it('顶层 results 包装兜底', async () => {
    const payload = { results: [{ title: '乙', url: 'https://b.com', content: '正文乙' }] };
    const original = globalThis.fetch;
    globalThis.fetch = (async () => ({ ok: true, status: 200, json: async () => payload }) as Response) as typeof fetch;
    try {
      const hits = await anysearchProvider.search({ query: 'q', n: 5, key: 'k' });
      expect(hits).toHaveLength(1);
      expect(hits[0]!.title).toBe('乙');
    } finally {
      globalThis.fetch = original;
    }
  });

  it('429 归类为 quota（驱动长冷却）', async () => {
    const original = globalThis.fetch;
    globalThis.fetch = (async () => ({ ok: false, status: 429 }) as Response) as typeof fetch;
    try {
      await expect(anysearchProvider.search({ query: 'q', n: 5, key: 'k' })).rejects.toMatchObject({ kind: 'quota' });
    } finally {
      globalThis.fetch = original;
    }
  });
});
