import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { GoalState } from './mode.js';

/** Goal 持久化：一个 goal 一条记录,JSON 格式。 */
export interface GoalRecord extends GoalState {
  /** 唯一标识。 */
  id: string;
  /** 最近操作该 goal 的 session id（非所属,一个 goal 可被多个 session 操作）。 */
  lastSessionId?: string;
  /** 已完成标记（completed goal 的 status 仍为原状态，用此字段区分，避免改 GoalState 类型）。 */
  completed?: boolean;
}

/**
 * Goal 持久化存储。
 *
 * 落盘到 `<dir>/<goalId>.json`，每个 goal 一份完整 JSON。
 * 目录由调用方传入（通常来自 SessionStore.goalsDir()），全局、不按 workdir 分桶——
 * goal 天然跨 session 流转，与 SessionQueueStore 同属跨 session 基础设施。
 */
export class GoalStore {
  constructor(private readonly dir: string) {}

  private dirFor(): string {
    return this.dir;
  }

  private fileFor(id: string): string {
    return `${this.dirFor()}/${id}.json`;
  }

  private ensureDir(): void {
    if (!existsSync(this.dirFor())) mkdirSync(this.dirFor(), { recursive: true });
  }

  /**
   * 写入一条 goal 记录（覆盖已有）。
   *
   * @param expectedUpdatedAt 乐观锁：若提供且与磁盘上现有记录的 updatedAt 不一致，拒绝写入并返回 false。
   *   防止跨 session 并发写时旧快照覆盖新快照。首次写入（无现有记录）时跳过检查。
   * @returns 是否写入成功（false = 乐观锁冲突，调用方应重新加载后重试）。
   */
  save(record: GoalRecord, expectedUpdatedAt?: number): boolean {
    this.ensureDir();
    if (expectedUpdatedAt !== undefined) {
      const existing = this.load(record.id);
      if (existing !== null && existing.updatedAt !== expectedUpdatedAt) {
        return false; // 乐观锁冲突：磁盘上的版本比调用方看到的更新
      }
    }
    const toWrite = { ...record, updatedAt: Date.now() };
    writeFileSync(this.fileFor(record.id), JSON.stringify(toWrite, null, 2), 'utf8');
    return true;
  }

  /** 按 id 读取。 */
  load(id: string): GoalRecord | null {
    const file = this.fileFor(id);
    if (!existsSync(file)) return null;
    try {
      return JSON.parse(readFileSync(file, 'utf8')) as GoalRecord;
    } catch {
      return null;
    }
  }

  /** 列出某个 session 最近操作过的所有 goal。 */
  listBySession(sessionId: string): GoalRecord[] {
    const dir = this.dirFor();
    if (!existsSync(dir)) return [];
    const matched: GoalRecord[] = [];
    for (const file of readdirSync(dir).filter((f) => f.endsWith('.json'))) {
      try {
        const record = JSON.parse(readFileSync(join(dir, file), 'utf8')) as GoalRecord;
        if (record.lastSessionId === sessionId) matched.push(record);
      } catch {
        // 损坏文件跳过
      }
    }
    return matched;
  }

  /** 列出所有尚未完成的 goal（active/paused/blocked 且非 completed 标记）。 */
  listActive(): GoalRecord[] {
    const dir = this.dirFor();
    if (!existsSync(dir)) return [];
    const active: GoalRecord[] = [];
    for (const file of readdirSync(dir).filter((f) => f.endsWith('.json'))) {
      try {
        const record = JSON.parse(readFileSync(join(dir, file), 'utf8')) as GoalRecord;
        if (record.completed === true) continue;
        if (record.status === 'active' || record.status === 'paused' || record.status === 'blocked') active.push(record);
      } catch {
        // 损坏文件跳过
      }
    }
    return active;
  }

  /** 删除一条 goal 记录。 */
  delete(id: string): void {
    const file = this.fileFor(id);
    if (existsSync(file)) rmSync(file);
  }
}
