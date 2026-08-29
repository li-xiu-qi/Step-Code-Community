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

  it('/handoff <id> 压栈时用 handoffCurrent 作返回点，并激活该子会话', () => {
    const push = body.slice(body.indexOf('// 把当前所在会话压栈'));
    expect(push).toContain('this.handoffStack.push(this.handoffCurrent');
    expect(push).toContain('this.handoffCurrent = id');
    // 激活是「用户后续输入走子 agent」的前提，缺了它就退化成一次性 handoff
    expect(push).toContain('this.activeSubagent = id');
  });

  it('/handoff main 解除激活但不动返回栈', () => {
    const body = runHandoffBody();
    expect(body).toContain("id === 'main'");
    expect(body).toContain('this.activeSubagent = null');
    expect(body).toContain('this.syncSubagentTargetBadge()');
    // main 只管「现在跟谁说话」，栈记录「去过哪」——清激活时不能弹栈
    const mainBranch = body.slice(body.indexOf("id === 'main'"), body.indexOf("id === 'back'"));
    expect(mainBranch).not.toContain('this.handoffStack.pop()');
  });

  it('/handoff back 先解除激活再弹栈', () => {
    const body = runHandoffBody();
    const backBranch = body.slice(body.indexOf("id === 'back'"), body.indexOf("id === ''"));
    expect(backBranch).toContain('this.activeSubagent = null');
    expect(backBranch).toContain('this.handoffStack.pop()');
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
  it('无参 /handoff 开选择器而不是要求用户手抄 id', () => {
    const body = runHandoffBody();
    // 让用户复制 sub-01a7f3 去敲比直接选更麻烦——空参必须给选择器
    expect(body).toContain('this.openHandoffPicker()');
  });

  it('选择器只列待命（standby）会话，一次性跑完即归档的没有续聊价值', () => {
    const src = piChatSrc;
    const picker = src.slice(src.indexOf('private openHandoffPicker'), src.indexOf('private openHandoffPicker') + 1200);
    expect(picker).toContain('m.standby === true');
  });

  it('选择器里 Enter 直接激活，不必再敲一次 /handoff <id>', () => {
    const src = piChatSrc;
    const picker = src.slice(src.indexOf('private openHandoffPicker'), src.indexOf('private openHandoffPicker') + 1800);
    expect(picker).toContain('onHandoff:');
    expect(picker).toContain('this.runHandoff(id)');
  });

  it('handoff 走 runSubagent，不走 browseSubagentSession（不是只读浏览）', () => {
    const body = runHandoffBody();
    expect(body).not.toContain('browseSubagentSession');
    expect(body).toContain('currentRunSubagent');
  });
});
