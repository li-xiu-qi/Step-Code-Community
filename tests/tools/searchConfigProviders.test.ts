/**
 * [search] 多提供商配置段解析测试（providers / disabled_providers / [search.<name>]）。
 */
import { describe, expect, it } from 'vitest';
import { resolveSearchConfig } from '../../src/config/config.js';

describe('resolveSearchConfig 多提供商段', () => {
  it('providers 与 disabled_providers 字符串数组解析', () => {
    expect(
      resolveSearchConfig({
        providers: ['stepfun', 'tavily', 'anysearch'],
        disabled_providers: ['tavily'],
        image_providers: ['doubao', 'stepfun'],
        image_disabled_providers: ['stepfun'],
      }),
    ).toEqual({
      providers: ['stepfun', 'tavily', 'anysearch'],
      disabledProviders: ['tavily'],
      imageProviders: ['doubao', 'stepfun'],
      imageDisabledProviders: ['stepfun'],
    });
  });

  it('非数组/空数组/含非字符串 → 不进结果对象', () => {
    expect(resolveSearchConfig({ providers: 'tavily' })).toEqual({});
    expect(resolveSearchConfig({ providers: [] })).toEqual({});
    expect(resolveSearchConfig({ providers: ['anysearch', 1, null] })).toEqual({ providers: ['anysearch'] });
  });

  it('提供商子段 key/url/enabled 解析，空子段不进结果', () => {
    expect(
      resolveSearchConfig({
        tavily: { key: 'tvly-x', url: 'https://t.example' },
        anysearch: { enabled: false },
        doubao: { key: 'db-x' },
        stepfun: {},
      }),
    ).toEqual({
      tavily: { key: 'tvly-x', url: 'https://t.example' },
      anysearch: { enabled: false },
      doubao: { key: 'db-x' },
    });
  });

  it('enabled 非布尔不进结果', () => {
    expect(resolveSearchConfig({ anysearch: { enabled: 'yes' } })).toEqual({});
  });

  it('与既有 url/key/web/image 段共存', () => {
    expect(
      resolveSearchConfig({
        url: 'https://s.com/v1',
        key: 'K',
        providers: ['stepfun'],
        anysearch: { key: 'A' },
      }),
    ).toEqual({
      url: 'https://s.com/v1',
      key: 'K',
      providers: ['stepfun'],
      anysearch: { key: 'A' },
    });
  });
});
