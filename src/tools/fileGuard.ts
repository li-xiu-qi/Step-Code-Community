import { statSync } from 'node:fs';

/**
 * 文件读守护（Stale Guard）
 *
 * 防止模型幻觉式编辑：
 *   1. edit_file / write_file 前，检查文件是否被读过；
 *   2. 如果读过，检查文件是否在上次读取后被修改（mtime/size 变化）。
 *
 * 设计：
 *   - read_file 成功读取时，调用 {@link FileGuard.track} 记录 mtime + size
 *   - edit_file / write_file 执行前，调用 {@link FileGuard.check} 验证
 *   - 检查结果为软提示（warn）或硬阻止（block），由工具决定
 */

export interface FileSnapshot {
  /** 最后读取时的 mtime（毫秒）。 */
  mtimeMs: number;
  /** 最后读取时的文件大小（字节）。 */
  size: number;
}

export type GuardVerdict =
  | { kind: 'ok' }
  | { kind: 'not-read'; message: string }
  | { kind: 'stale'; message: string }
  | { kind: 'new-file' };

export class FileGuard {
  private snapshots = new Map<string, FileSnapshot>();

  /** 记录文件被成功读取时的快照。 */
  track(absPath: string): void {
    try {
      const st = statSync(absPath);
      this.snapshots.set(absPath, { mtimeMs: st.mtimeMs, size: st.size });
    } catch {
      // stat 失败（文件刚被删）→ 删除快照，后续写入时按 new-file 处理
      this.snapshots.delete(absPath);
    }
  }

  /** 清除某文件的快照（如文件被删除后）。 */
  untrack(absPath: string): void {
    this.snapshots.delete(absPath);
  }

  /**
   * 检查文件是否可安全写入。
   * @param absPath 文件绝对路径
   * @param opts.requireRead 是否要求必须先读过（默认 true）
   */
  check(absPath: string, opts?: { requireRead?: boolean }): GuardVerdict {
    const requireRead = opts?.requireRead ?? true;
    const snap = this.snapshots.get(absPath);

    // 从未读过
    if (!snap) {
      if (!requireRead) return { kind: 'ok' };
      return {
        kind: 'not-read',
        message:
          `文件未被读取过，无法确认其内容。请先使用 read_file 读取此文件，` +
          `然后再进行编辑。如果你确定要创建新文件，请使用 write_file 并提供完整内容。`,
      };
    }

    // 检查文件是否在上次读取后被修改
    try {
      const st = statSync(absPath);
      if (st.mtimeMs !== snap.mtimeMs || st.size !== snap.size) {
        return {
          kind: 'stale',
          message:
            `文件自上次读取后已被修改（外部变更，可能是用户编辑器或其他进程）。` +
            `请重新使用 read_file 读取最新内容，然后再进行编辑。`,
        };
      }
    } catch {
      // 文件在上次读取后被删除
      return {
        kind: 'stale',
        message: `文件自上次读取后已被删除。请确认文件状态后重试。`,
      };
    }

    return { kind: 'ok' };
  }

  /** 获取当前快照数量（测试用）。 */
  get size(): number {
    return this.snapshots.size;
  }

  /** 清空所有快照（新会话时调用）。 */
  clear(): void {
    this.snapshots.clear();
  }
}
