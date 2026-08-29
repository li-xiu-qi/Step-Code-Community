/**
 * /handoff 命令与返回栈的接线断言。
 *
 * PiChat 不可实例化（构造依赖 TUI/Provider），这里锁源码里的关键接线点，
 * 与 subagentBrowse.test.ts 同风格。测的是「接线是否存在且语义正确」，
 * 不是端到端跑一次 handoff（那需要真 provider，属集成测试范畴）。
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join as pathJoin } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = pathJoin(dirname(fileURLToPath(import.meta.url)), '..', '..');
const piChatSrc = readFileSync(pathJoin(repoRoot, 'src', 'tui-pi', 'PiChat.ts'), 'utf8');

/** 截取 runHandoff 方法体（从声明到下一个同级方法声明）。 */
function runHandoffBody(): string {
  const start = piChatSrc.indexOf('private async runHandoff(args: string)');
  expect(start).toBeGreaterThan(-1);
  const next = piChatSrc.indexOf('\n  /**', start + 10);
  return piChatSrc.slice(start, next > start ? next : start + 4000);
}

describe('/handoff 接线', () => {
  it('命令路由存在', () => {
    const route = piChatSrc.slice(piChatSrc.indexOf("case 'handoff'"), piChatSrc.indexOf("case 'handoff'") + 120);
    expect(route).toContain('runHandoff');
  });

  it('busy 时可即时执行（INSTANT_WHEN_BUSY 含 handoff）', () => {
    const cmds = readFileSync(pathJoin(repoRoot, 'src', 'chat', 'commands.ts'), 'utf8');
    const instant = cmds.slice(cmds.indexOf('INSTANT_WHEN_BUSY'), cmds.indexOf('INSTANT_WHEN_BUSY') + 400);
    expect(instant).toContain('handoff');
  });

  it('命令已注册进 SLASH_COMMANDS', () => {
    const cmds = readFileSync(pathJoin(repoRoot, 'src', 'chat', 'commands.ts'), 'utf8');
    expect(cmds).toContain("{ name: 'handoff', describe: 'cmd.handoff' }");
  });

  it('返回栈字段存在', () => {
    expect(piChatSrc).toContain('private readonly handoffStack: string[]');
    expect(piChatSrc).toContain('private handoffCurrent: string | null');
  });
});

describe('/handoff back 返回栈语义', () => {
  const body = runHandoffBody();

  it('back 分支弹栈', () => {
    const back = body.slice(body.indexOf("id === 'back'"), body.indexOf("id === 'back'") + 600);
    expect(back).toContain('this.handoffStack.pop()');
  });

  it('栈空时提示而不是崩溃', () => {
    const back = body.slice(body.indexOf("id === 'back'"), body.indexOf("id === 'back'") + 600);
    expect(back).toContain('prev === undefined');
  });

  it('栈底空串 = 主会话标记，不调 resume', () => {
    const back = body.slice(body.indexOf("id === 'back'"), body.indexOf("id === 'back'") + 900);
    expect(back).toContain("prev === ''");
    expect(back).toContain('this.handoffCurrent = null');
  });

  it('/handoff <id> 压栈时用 handoffCurrent 作返回点', () => {
    const push = body.slice(body.indexOf('// 把当前所在会话压栈'));
    expect(push).toContain('this.handoffStack.push(this.handoffCurrent') ;
    expect(push).toContain('this.handoffCurrent = id');
  });

  it('handoff 到子会话用 resume 而非新建', () => {
    expect(body).toContain('resume: id');
    expect(body).not.toContain('fork:');
  });

  it('subagentType 传 general 占位（resume 路径用 snap.agentType）', () => {
    expect(body).toContain("subagentType: 'general'");
  });

  it('busy 时拒绝（currentRunSubagent 为 undefined）', () => {
    expect(body).toContain('t(\'cmd.handoff.busy\')');
  });
});

describe('/handoff 与 /agents 的边界', () => {
  it('handoff 走 runSubagent，不走 browseSubagentSession（不是只读浏览）', () => {
    const body = runHandoffBody();
    expect(body).not.toContain('browseSubagentSession');
    expect(body).toContain('currentRunSubagent');
  });
});
