/**
 * 大输出文件缓存 — 超过阈值的结果写入磁盘文件，渲染时只展示文件路径。
 *
 * offload 避免大结果长期驻留进程堆，配合 ExpandOverlay 按需读取。
 */

import { existsSync, mkdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const CACHE_DIR = join(homedir(), '.step-code', 'output-cache');
const MAX_CACHE_AGE_MS = 30 * 60 * 1000; // 30 分钟
const MAX_CACHE_BYTES = 200 * 1024 * 1024; // 200 MB 总上限
const MAX_INLINE_CHARS = 4096; // 超过此阈值 offload
const MAX_SINGLE_FILE = 10 * 1024 * 1024; // 单文件 10 MB 上限
const FILENAME_PREFIX = 'tool-out-';
const CONTENT_HASH_LEN = 16;

let _initialized = false;

function ensureDir(): void {
  if (!_initialized) {
    mkdirSync(CACHE_DIR, { recursive: true });
    _initialized = true;
  }
}

/**
 * 用内容的 SHA-256 前 16 字符做文件名的一部分，避免重复写入相同内容。
 * 追加 tool name + 时间戳做唯一键。
 */
function makeFilename(toolName: string, result: string): string {
  // 简易 hash：用字符串长度 + 前/后字符做指纹
  const fingerprint =
    result.length.toString(16) +
    result.slice(0, 32).replace(/[^a-zA-Z0-9]/g, '').toLowerCase() +
    result.slice(-32).replace(/[^a-zA-Z0-9]/g, '').toLowerCase();
  const hash = fingerprint.slice(0, CONTENT_HASH_LEN);
  const ts = Date.now().toString(36);
  return `${FILENAME_PREFIX}${toolName}-${hash}-${ts}.txt`;
}

/**
 * 如果 result 超过阈值则写文件，返回可被 DisplayItem 引用的路径。
 * 否则返回 undefined（不需要 offload）。
 */
export function offloadIfNeeded(toolName: string, result: string): string | undefined {
  // 小结果不需要 offload（摘要型工具除外）
  if (result.length <= MAX_INLINE_CHARS && !requiresOffload(toolName, result)) {
    return undefined;
  }

  // 超大结果直接截断，不写文件（避免磁盘 DoS）
  if (result.length > MAX_SINGLE_FILE) {
    return undefined;
  }

  ensureDir();
  const filename = makeFilename(toolName, result);
  const filepath = join(CACHE_DIR, filename);

  try {
    writeFileSync(filepath, result, 'utf-8');
    scheduleCleanup();
    return filepath;
  } catch {
    return undefined;
  }
}

/** 检查是否需要 offload（即使结果在 MAX_INLINE_CHARS 以内）。 */
function requiresOffload(toolName: string, result: string): boolean {
  // 某些工具始终 offload
  const alwaysOffload = new Set(['web_extract']);
  if (alwaysOffload.has(toolName)) return result.length > 0;
  return false;
}

/** 从缓存文件读取内容（用于 ExpandOverlay）。 */
export function readCachedOutput(filepath: string): string | null {
  try {
    if (!existsSync(filepath)) return null;
    return readFileSync(filepath, 'utf-8');
  } catch {
    return null;
  }
}

/** 删除指定的缓存文件。 */
export function removeCachedOutput(filepath: string): void {
  try {
    unlinkSync(filepath);
  } catch {
    // 忽略
  }
}

/** 清理过期的缓存文件（异步，不阻塞主线程）。 */
function scheduleCleanup(): void {
  // 用 setImmediate 让清理在下一个事件循环迭代执行
  // 不阻塞当前的事件处理
  setImmediate(() => {
    try {
      cleanup();
    } catch {
      // 清理失败不阻塞
    }
  });
}

function cleanup(): void {
  if (!existsSync(CACHE_DIR)) return;

  let totalSize = 0;
  const entries: { path: string; mtime: number; size: number }[] = [];

  try {
    const files = require('node:fs').readdirSync(CACHE_DIR);
    const now = Date.now();
    for (const file of files) {
      if (!file.startsWith(FILENAME_PREFIX)) continue;
      const fp = join(CACHE_DIR, file);
      try {
        const st = statSync(fp);
        const age = now - st.mtimeMs;
        const size = st.size;
        totalSize += size;
        entries.push({ path: fp, mtime: st.mtimeMs, size });
        // 删除过期文件
        if (age > MAX_CACHE_AGE_MS) {
          unlinkSync(fp);
          totalSize -= size;
        }
      } catch {
        // 跳过去掉的文件
      }
    }
    // 总大小超限时 LRU 淘汰
    if (totalSize > MAX_CACHE_BYTES) {
      entries.sort((a, b) => a.mtime - b.mtime); // 最老的先删
      for (const entry of entries) {
        if (totalSize <= MAX_CACHE_BYTES * 0.7) break;
        try {
          unlinkSync(entry.path);
          totalSize -= entry.size;
        } catch {
          // 跳过
        }
      }
    }
  } catch {
    // 无法读取目录，略过
  }
}
