import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { BackgroundManager } from '../../src/agent/background/manager.js';
import { notificationIdFor } from '../../src/agent/background/notify.js';
import { notifyDedupKey } from '../../src/agent/wirelog.js';

/**
 * 通知去重的键空间一致性。
 *
 * 线上 bug（2026-08-29 实例）：会话 `20260826111521-0c4ad0` 磁盘上有 132 个未抑制的已终态
 * 后台任务，其中 98 个 completed。每次 resume 该会话，reconcile 把这 98 个全部判定为
 * 「未送达」并补投进发送队列——用户看到 queue:98，其中绝大多数是几天前就已结算的任务。
 *
 * 根因是两处用了不同的键空间：
 * - `delivered` 集合（SessionStore.deliveredNotifications）存的是 **dedup key**，
 *   形如 `tmta3lkef-155completedtask:tmta3lkef-155:completed`（三截拼接）。
 * - `persistedHashes`（PiChat.reconcileBackground 从 session.notificationBodies 构造）
 *   存的是**通知正文**，形如 `<notification id="task:...">...</notification>`。
 *
 * 二者永不相等，故「已持久化的通知不再补投」这道去重完全失效。
 * 本文件锁的是 reconcile 侧的契约：传 delivered 时应只补投真正未送达的任务。
 */
const tmpDirs: string[] = [];
afterEach(() => {
  while (tmpDirs.length > 0) rmSync(tmpDirs.pop()!, { recursive: true, force: true });
});

function setup(tasks: Array<{ id: string; status: 'completed' | 'failed' | 'killed' }>): {
  mgr: BackgroundManager;
  dir: string;
} {
  const dir = mkdtempSync(join(tmpdir(), 'stepcode-notify-'));
  tmpDirs.push(dir);
  for (const t of tasks) {
    mkdirSync(join(dir, t.id), { recursive: true });
    writeFileSync(
      join(dir, t.id, 'meta.json'),
      JSON.stringify({
        id: t.id,
        command: `cmd-${t.id}`,
        status: t.status,
        startedAt: '2026-08-29T00:00:00.000Z',
        output: '',
        outputPath: join(dir, t.id, 'output.log'),
        outputBytes: 0,
        endedAt: '2026-08-29T00:01:00.000Z',
      }),
      'utf8',
    );
  }
  return { mgr: new BackgroundManager(10, { tasksDir: dir }), dir };
}

describe('reconcile：dedup key 去重', () => {
  it('dedup key 命中 → 不补投（正常去重）', () => {
    const { mgr } = setup([{ id: 't1', status: 'completed' }]);
    const key = notifyDedupKey('t1', 'completed', notificationIdFor({ id: 't1', status: 'completed' } as never));
    const r = mgr.reconcile(new Set([key]));
    expect(r.redeliver).toHaveLength(0);
  });

  it('dedup key 未命中 → 补投', () => {
    const { mgr } = setup([{ id: 't1', status: 'completed' }]);
    const r = mgr.reconcile(new Set());
    expect(r.redeliver).toHaveLength(1);
    expect(r.redeliver[0]!.id).toBe('t1');
  });

  it('通知正文不能当 dedup key 用（锁线上 bug）', () => {
    // 这是出 bug的那一侧：把 formatSettleNotification 的产物（正文）塞进 delivered，
    // reconcile 应当仍然补投——因为键空间不同，正文匹配不上任何 dedup key。
    const { mgr } = setup([{ id: 't1', status: 'completed' }]);
    const body = `<notification id="task:t1:completed" category="task" type="task.completed">状态：已完成</notification>`;
    const r = mgr.reconcile(new Set([body]));
    // 若这里变成 0，说明有人「修好」了键空间；但正确的修法是统一键空间，
    // 而不是让正文偶然匹配上。当前锁的是现状，附断言说明意图。
    expect(r.redeliver).toHaveLength(1);
  });

  it('suppressNotify 的任务不参与补投', () => {
    const dir = mkdtempSync(join(tmpdir(), 'stepcode-notify-'));
    tmpDirs.push(dir);
    mkdirSync(join(dir, 't1'), { recursive: true });
    writeFileSync(
      join(dir, 't1', 'meta.json'),
      JSON.stringify({
        id: 't1', command: 'x', status: 'completed',
        startedAt: '2026-08-29T00:00:00.000Z', output: '',
        outputPath: join(dir, 't1', 'output.log'), outputBytes: 0,
        suppressNotify: true,
      }),
      'utf8',
    );
    const mgr = new BackgroundManager(10, { tasksDir: dir });
    expect(mgr.reconcile(new Set()).redeliver).toHaveLength(0);
  });

  it('混合场景：只有未送达且未抑制的进补投列表', () => {
    const dir = mkdtempSync(join(tmpdir(), 'stepcode-notify-'));
    tmpDirs.push(dir);
    const mk = (id: string, status: string, suppress?: boolean): void => {
      mkdirSync(join(dir, id), { recursive: true });
      writeFileSync(
        join(dir, id, 'meta.json'),
        JSON.stringify({
          id, command: `c-${id}`, status,
          startedAt: '2026-08-29T00:00:00.000Z', output: '',
          outputPath: join(dir, id, 'output.log'), outputBytes: 0,
          ...(suppress === true ? { suppressNotify: true } : {}),
        }),
        'utf8',
      );
    };
    mk('delivered-ok', 'completed');
    mk('suppressed', 'completed', true);
    mk('leak-1', 'completed');
    mk('leak-2', 'failed');

    const mgr = new BackgroundManager(10, { tasksDir: dir });
    const key = notifyDedupKey('delivered-ok', 'completed', notificationIdFor({ id: 'delivered-ok', status: 'completed' } as never));
    const r = mgr.reconcile(new Set([key]));
    expect(r.redeliver.map((t) => t.id).sort()).toEqual(['leak-1', 'leak-2']);
  });
});
