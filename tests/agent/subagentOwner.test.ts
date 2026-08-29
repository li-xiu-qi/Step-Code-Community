/**
 * 子会话归属（owner）拦截：主 agent 编排产物只读，用户自己 fork 出来的才能接管。
 *
 * 为什么值得锁：主 agent 用 spawn_agent 拉起的子会话是它工作流的中间产物。
 * 用户闯进去改方向，主 agent 后续读它历史时看到的就不是它自己安排的那段工作，
 * 而这种偏差不会让任何东西报错，事后极难察觉。
 *
 * 竞品参照：Codex 的 parent_owned_threads 就是这套机制，主 agent spawn 的子线程
 * UI 上只能看，只有 /side 显式开的 fork 能直连输入。
 *
 * 这里锁四层：create() 默认值、spawn/fork 分支的标记、索引落盘、handoff 拦截。
 * 索引那层是重点——上一轮 standby 就是漏写索引导致整条链路失效且无测试变红。
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SubagentStore } from '../../src/agent/subagent/store.js';
import { SessionStore } from '../../src/session/store.js';
import type { SessionData } from '../../src/session/store.js';

const repoRoot = join(__dirname, '..', '..');
const piChatSrc = readFileSync(join(repoRoot, 'src', 'tui-pi', 'PiChat.ts'), 'utf8');
const runnerSrc = readFileSync(join(repoRoot, 'src', 'agent', 'subagent', 'runner.ts'), 'utf8');

/** 造一个子会话快照并落盘。 */
function seed(store: SubagentStore, cwd: string, id: string, owner: 'agent' | 'user'): void {
  const session: SessionData = {
    id,
    cwd,
    model: 'm',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    messageCount: 0,
    parentId: 'main',
    owner,
    standby: true,
    messages: [],
  };
  store.saveSnapshot(session);
}

describe('owner 落库', () => {
  let base: string;
  let cwd: string;
  let store: SubagentStore;

  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), 'owner-lock-'));
    cwd = join(base, 'project');
    store = new SubagentStore(new SessionStore(base));
  });
  afterEach(() => {
    rmSync(base, { recursive: true, force: true });
  });

  it('create() 默认 agent（旧调用方不传也不放开）', () => {
    const s = store.create(cwd, { model: 'm', agentType: 'general', depth: 1 });
    expect(s.owner).toBe('agent');
  });

  it('create() 可显式指定 user', () => {
    const s = store.create(cwd, { model: 'm', agentType: 'general', depth: 1, owner: 'user' });
    expect(s.owner).toBe('user');
  });

  it('owner 进索引——否则 handoff 判定读不到（与 standby 同款陷阱）', () => {
    // saveSnapshot 同步写索引，list() 读索引。漏写会让 isUserOwned 恒 false，
    // 所有子会话都被锁死且无测试变红。
    seed(store, cwd, 'sub-u', 'user');
    seed(store, cwd, 'sub-a', 'agent');
    const list = store.list(cwd);
    expect(list.find((m) => m.id === 'sub-u')?.owner).toBe('user');
    expect(list.find((m) => m.id === 'sub-a')?.owner).toBe('agent');
  });
});

describe('isUserOwned 判定', () => {
  let base: string;
  let cwd: string;
  let store: SubagentStore;

  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), 'standby-owner-'));
    cwd = join(base, 'project');
    store = new SubagentStore(new SessionStore(base));
  });
  afterEach(() => {
    rmSync(base, { recursive: true, force: true });
  });

  it('user 归属可直连', () => {
    seed(store, cwd, 'sub-u', 'user');
    expect(store.isUserOwned(cwd, 'sub-u')).toBe(true);
  });

  it('agent 归属不可直连', () => {
    seed(store, cwd, 'sub-a', 'agent');
    expect(store.isUserOwned(cwd, 'sub-a')).toBe(false);
  });

  it('不存在的会话按不可直连处理（不报错，交由上层给提示）', () => {
    expect(store.isUserOwned(cwd, 'sub-nope')).toBe(false);
  });

  it('旧快照无 owner 字段 → 按 agent 处理（默认锁死）', () => {
    // 直接写一个不带 owner 的快照，模拟升级前的历史数据
    const legacy: SessionData = {
      id: 'sub-legacy',
      cwd,
      model: 'm',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      messageCount: 0,
      parentId: 'main',
      messages: [],
    };
    store.saveSnapshot(legacy);
    // 缺省锁死比缺省放开安全：放开会让用户无意间改写主 agent 正在依赖的中间产物
    expect(store.isUserOwned(cwd, 'sub-legacy')).toBe(false);
  });

  it('索引重建后 owner 不丢（rebuildIndex 同款陷阱）', () => {
    // 上一轮 standby 就是漏在 rebuildIndex 里。list() 命中有效索引时走缓存，
    // 索引过期才重建——所以这里显式删掉索引文件，强制走重建路径。
    //（新建 store 实例不够：上个实例刚写的索引 rebuiltAt 是新的，仍判未过期。）
    seed(store, cwd, 'sub-rebuild', 'user');
    expect(store.isUserOwned(cwd, 'sub-rebuild')).toBe(true);

    const indexPath = join(base, 'project', 'subagents', 'index.json');
    rmSync(indexPath, { force: true });
    expect(store.isUserOwned(cwd, 'sub-rebuild')).toBe(true);
  });
});

describe('runner 标记', () => {
  it('spawn 分支标 agent（主 agent 编排产物）', () => {
    const spawn = runnerSrc.slice(runnerSrc.indexOf('parentId: req.parentSessionId ?? deps.parentSessionId'));
    expect(spawn.slice(0, 400)).toContain("owner: 'agent'");
  });

  it('fork 分支标 user（用户显式另起一条线）', () => {
    const fork = runnerSrc.slice(runnerSrc.indexOf('parentId: forkId'));
    expect(fork.slice(0, 400)).toContain("owner: 'user'");
  });
});

describe('/handoff 归属拦截', () => {
  it('命令里查 isUserOwned 才放行', () => {
    const body = piChatSrc.slice(
      piChatSrc.indexOf('private async runHandoff'),
      piChatSrc.indexOf('private syncSubagentTargetBadge'),
    );
    expect(body).toContain('isUserOwned');
    // 拒了要给出路：fork 一条属于自己的，而不是只说「不行」
    expect(body).toContain('/fork');
  });

  it('无参选择器只列 user 归属的（列出来选了又被拒是误导）', () => {
    // 截到方法结束（下一个 private 声明）而不是靠注释锚点，注释文案会漂
    const start = piChatSrc.indexOf('private openHandoffPicker');
    const end = piChatSrc.indexOf('private ', start + 10);
    const picker = piChatSrc.slice(start, end > start ? end : start + 3000);
    expect(picker).toContain("m.owner === 'user'");
  });

  it('/agents 详情栏标注归属，让用户知道哪些不能接管', () => {
    const overlay = readFileSync(join(repoRoot, 'src', 'tui-pi', 'AgentsOverlay.ts'), 'utf8');
    expect(overlay).toContain("agent.owner === 'user'");
    expect(overlay).toContain('只读');
  });
});
