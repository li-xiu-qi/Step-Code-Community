import { describe, expect, it } from 'vitest';
import { whitelistDeny } from '../../src/acp/server.js';

/**
 * 白名单硬门单测：纯函数，不跑真实 agent。覆盖未配置、空数组、名单内外、
 * MCP 工具全名判定四种形态。执行层硬门的存在理由是 executeTool 只校验
 * 「是否已注册」不校验白名单，幻觉调用名单外工具会被放行。
 */
describe('whitelistDeny（ACP 工具白名单硬门）', () => {
  it('未配置时返回 null（不收窄，行为不变）', () => {
    expect(whitelistDeny('bash', undefined)).toBeNull();
  });

  it('空数组视为未配置', () => {
    expect(whitelistDeny('bash', [])).toBeNull();
  });

  it('名单内放行（返回 null 交后续授权流程）', () => {
    expect(whitelistDeny('tool_search', ['tool_search', 'skill'])).toBeNull();
    expect(whitelistDeny('read_file', ['tool_search', 'skill', 'read_file'])).toBeNull();
  });

  it('名单外拒绝且原因含工具名', () => {
    const r = whitelistDeny('write_file', ['tool_search', 'skill']);
    expect(r).not.toBeNull();
    expect(r!.decision).toBe('deny');
    expect(r!.reason).toContain('write_file');
  });

  it('MCP 工具按 mcp__server__tool 全名判定，同前缀不同 server 不误放', () => {
    const list = ['tool_search', 'mcp__hearsight__search'];
    expect(whitelistDeny('mcp__hearsight__search', list)).toBeNull();
    expect(whitelistDeny('mcp__other__search', list)).not.toBeNull();
    expect(whitelistDeny('mcp__hearsight__evil', list)).not.toBeNull();
  });
});
