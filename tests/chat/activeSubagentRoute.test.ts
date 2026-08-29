import { describe, expect, it } from 'vitest';
import { routesToActiveSubagent } from '../../src/tui-pi/PiChat.js';

describe('routesToActiveSubagent', () => {
  it('未激活子 agent 时，所有输入都归主会话', () => {
    expect(routesToActiveSubagent(null, '随便说点什么')).toBe(false);
    expect(routesToActiveSubagent(null, '! ls -la')).toBe(false);
  });

  it('激活子 agent 后，普通输入路由到该子 agent', () => {
    expect(routesToActiveSubagent('sub-01', '继续写第三部分')).toBe(true);
    // 多行、含特殊字符都不影响路由
    expect(routesToActiveSubagent('sub-01', '第一行\n第二行（带括号）')).toBe(true);
  });

  it('`!` bash 始终本地执行，不转给子 agent', () => {
    // 亲手敲下的命令本身就是授权，转交会改变语义
    expect(routesToActiveSubagent('sub-01', '! ls -la')).toBe(false);
  });

  it('单独的 `!` 不当作 bash 命令（与 dispatchText 的既有判定一致）', () => {
    expect(routesToActiveSubagent('sub-01', '!')).toBe(true);
  });

  it('空输入在激活态下仍走子 agent（由调用方决定是否拦空）', () => {
    expect(routesToActiveSubagent('sub-01', '')).toBe(true);
  });
});
