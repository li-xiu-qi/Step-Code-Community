/**
 * [search] 多提供商配置段解析测试（providers / disabled_providers / [search.<name>]）。
 */
import { describe, expect, it } from 'vitest';
import { resolveSearchConfig } from '../../src/config/config.js';

describe('resolveSearchConfig 多提供商段', () => {
  it('providers 与 disabled_providers 字符串数组解析', () => {
    expect(
      resolveSearchConfig({
        providers: ['stepfun', 'bocha', 'bing'],
        disabled_providers: ['duckduckgo'],
      }),
    ).toEqual({
      providers: ['stepfun', 'bocha', 'bing'],
      disabledProviders: ['duckduckgo'],
    });
  });

  it('非数组/空数组/含非字符串 → 不进结果对象', () => {
    expect(resolveSearchConfig({ providers: 'bing' })).toEqual({});
    expect(resolveSearchConfig({ providers: [] })).toEqual({});
    expect(resolveSearchConfig({ providers: ['bing', 1, null] })).toEqual({ providers: ['bing'] });
  });

  it('提供商子段 key/url/enabled 解析，空子段不进结果', () => {
    expect(
      resolveSearchConfig({
        tavily: { key: 'tvly-x', url: 'https://t.example' },
        duckduckgo: { enabled: false },
        bing: {},
      }),
    ).toEqual({
      tavily: { key: 'tvly-x', url: 'https://t.example' },
      duckduckgo: { enabled: false },
    });
  });

  it('enabled 非布尔不进结果', () => {
    expect(resolveSearchConfig({ bing: { enabled: 'yes' } })).toEqual({});
  });

  it('与既有 url/key/web/image 段共存', () => {
    expect(
      resolveSearchConfig({
        url: 'https://s.com/v1',
        key: 'K',
        providers: ['stepfun'],
        bocha: { key: 'B' },
      }),
    ).toEqual({
      url: 'https://s.com/v1',
      key: 'K',
      providers: ['stepfun'],
      bocha: { key: 'B' },
    });
  });
});
