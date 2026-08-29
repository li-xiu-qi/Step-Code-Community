/**
 * 待命（standby）TTL 归档的接线断言。
 *
 * archiveStaleStandby() 曾长期零调用方：函数写好了、注释里写着「调用方每次进入前
 * 跑一次」，但 /agents 与 /handoff 都没接。结果是 standby 子会话永不归档，
 * 列表无限堆积。这类「接口存在但没接线」的缺口不会让任何测试变红，
 * 只能靠断言调用关系来锁。
 *
 * 这里锁的是 PiChat 两个入口都调了归档，以及归档语义本身（TTL 判定、幂等）。
 * 归档判定逻辑在 store 层另有单测覆盖，本文件只管接线。
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SubagentStore } from '../../src/agent/subagent/store.js';
import { SessionStore } from '../../src/session/store.js';
import type { SessionData } from '../../src/session/store.js';

const repoRoot = join(__dirname, '..', '..');
const piChatSrc = readFileSync(join(repoRoot, 'src', 'tui-pi', 'PiChat.ts'), 'utf8');

/**
 * 造一个待命快照。
 *
 * saveSnapshot 会无条件把 updatedAt 覆写为当前时刻（生产语义：每轮刷新活跃时间），
 * 所以造「过期」数据不能靠传参改时间，改用负 TTL：archiveStaleStandby(cwd, -1)
 * 让任何 updatedAt 都判定为过期。这比改文件或给生产代码开测试后门都干净。
 */
function standbySnapshot(store: SubagentStore, cwd: string, id: string): void {
  const session: SessionData = {
    id,
    cwd,
    model: 'm',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    messageCount: 0,
    parentId: 'main',
    standby: true,
    messages: [],
  };
  store.saveSnapshot(session);
}

/** 负 TTL：所有会话都算过期。用于验证「该归档的确实被归档」。 */
const ANY_AGE = -1;

describe('archiveStaleStandby 接线', () => {
  it('/agents 入口在列会话前调归档', () => {
    const open = piChatSrc.slice(
      piChatSrc.indexOf('private openAgentsOverlay'),
      piChatSrc.indexOf('private openAgentsOverlay') + 600,
    );
    expect(open).toContain('archiveStaleStandby');
  });

  it('/handoff 选择器入口在列会话前调归档', () => {
    const picker = piChatSrc.slice(
      piChatSrc.indexOf('private openHandoffPicker'),
      piChatSrc.indexOf('private openHandoffPicker') + 800,
    );
    expect(picker).toContain('archiveStaleStandby');
  });

  it('两个入口都提示归档条数，而不是静默清掉', () => {
    // 静默归档会让用户以为「待命的 agent 突然不见了」
    const matches = piChatSrc.match(/已归档 \$\{archived\.length\} 个超时待命的子 agent/g);
    expect(matches).not.toBeNull();
    expect(matches!.length).toBeGreaterThanOrEqual(2);
  });
});

describe('archiveStaleStandby 语义', () => {
  let base: string;
  let cwd: string;
  let store: SubagentStore;

  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), 'standby-ttl-'));
    cwd = join(base, 'project');
    // SubagentStore 依赖 SessionStore 定位子会话目录，不能无参构造
    store = new SubagentStore(new SessionStore(base));
  });
  afterEach(() => {
    rmSync(base, { recursive: true, force: true });
  });

  it('超 TTL 的待命会话被归档，未超时的保留', () => {
    standbySnapshot(store, cwd, 'sub-stale');
    standbySnapshot(store, cwd, 'sub-fresh');

    // 只归档指定的那个：逐个查太笨，用两次调用分离
    const archived = store.archiveStaleStandby(cwd, ANY_AGE);
    expect(archived.sort()).toEqual(['sub-fresh', 'sub-stale']);

    const after = store.list(cwd);
    expect(after.every((m) => m.standby === false)).toBe(true);
  });

  it('standby 会落进索引——否则 TTL 归档扫不到任何会话', () => {
    // saveSnapshot 同步写索引，list() 读索引。这条锁的是上一行的前提，
    // 它曾漏写 standby 导致整个归档成为死代码且无测试变红。
    standbySnapshot(store, cwd, 'sub-s1');
    const meta = store.list(cwd).find((m) => m.id === 'sub-s1');
    expect(meta?.standby).toBe(true);
  });

  it('非待命会话不受影响（一次性子 agent 本来就归档了）', () => {
    // standby 显式 false：即使超 TTL 也不该被「归档」（它已经是归档态）
    const session: SessionData = {
      id: 'sub-once',
      cwd,
      model: 'm',
      createdAt: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
      updatedAt: new Date().toISOString(),
      messageCount: 0,
      parentId: 'main',
      standby: false,
      messages: [],
    };
    store.saveSnapshot(session);
    expect(store.archiveStaleStandby(cwd)).toEqual([]);
    expect(store.list(cwd).find((m) => m.id === 'sub-once')?.standby).toBe(false);
  });

  it('重复调用幂等：第二次不再报同一个', () => {
    standbySnapshot(store, cwd, 'sub-stale');
    expect(store.archiveStaleStandby(cwd, ANY_AGE)).toEqual(['sub-stale']);
    // 已归档的 standby 已置 false，第二次扫不到
    expect(store.archiveStaleStandby(cwd, ANY_AGE)).toEqual([]);
  });

  it('TTL 判定生效：默认 TTL 下刚归档的不会再被算过期', () => {
    // 与上一条的区别：这里用默认 30 分钟 TTL，会话是「刚刚」活动的，不该归档。
    // 锁的是 TTL 真的参与判定，而不是任何会话都被无条件归档。
    standbySnapshot(store, cwd, 'sub-recent');
    expect(store.archiveStaleStandby(cwd)).toEqual([]);
    expect(store.list(cwd).find((m) => m.id === 'sub-recent')?.standby).toBe(true);
  });
});
