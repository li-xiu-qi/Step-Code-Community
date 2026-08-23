import { execSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { basename, dirname } from 'node:path';

/**
 * 文件编辑后自动 git 提交：每次 edit_file / write_file 成功后，
 * 若目标文件在 git 仓库内且当前不在 worktree 隔离环境，则自动
 * git add + commit（commit message 从 diff 的统计信息生成）。
 *
 * 设计取舍：
 * - 默认关闭，需 config [git] auto_commit = true 才启用
 * - 不生成 AI commit message（避免额外交互延迟），用 diff 统计信息代替
 * - 只在非 team worktree 环境生效（team 环境由 team 流程管理提交）
 * - 失败静默（不影响主流程）
 */

/** 检测给定路径是否在 git 仓库内。 */
export function isInsideGitRepo(cwd: string): boolean {
  try {
    execSync('git rev-parse --is-inside-work-tree', {
      cwd,
      encoding: 'utf8',
      stdio: 'pipe',
      timeout: 3000,
    });
    return true;
  } catch {
    return false;
  }
}

/** 检测当前是否在 team worktree 环境（.teams/ 目录存在）。 */
function isTeamWorktree(cwd: string): boolean {
  try {
    const root = execSync('git rev-parse --show-toplevel', {
      cwd,
      encoding: 'utf8',
      stdio: 'pipe',
      timeout: 3000,
    }).trim();
    return root.includes('.teams') || root.includes('.worktrees');
  } catch {
    return false;
  }
}

/** 从 diff 统计生成简短 commit message。 */
function generateCommitMessage(absPath: string, cwd: string): string {
  try {
    const diff = execSync(`git diff --cached --numstat -- "${absPath}"`, {
      cwd,
      encoding: 'utf8',
      stdio: 'pipe',
      timeout: 3000,
    }).trim();

    if (diff) {
      const parts = diff.split(/\s+/);
      const added = parts[0] === '-' ? 'binary' : `+${parts[0]}`;
      const removed = parts[1] === '-' ? 'binary' : `-${parts[1]}`;
      const file = basename(absPath);
      return `chore(${file}): auto-commit ${added} ${removed}`;
    }
  } catch {
    // 统计失败时回退到简单 message
  }

  const file = basename(absPath);
  return `chore(${file}): update`;
}

/**
 * 自动 git add + commit 指定文件。
 * 失败静默（不影响主流程）。
 * 返回是否成功提交。
 */
export function autoCommitFile(absPath: string, cwd: string): boolean {
  try {
    if (!isInsideGitRepo(cwd)) return false;
    if (isTeamWorktree(cwd)) return false;

    const gitDir = dirname(absPath);
    execSync(`git add -- "${absPath}"`, {
      cwd: gitDir,
      encoding: 'utf8',
      stdio: 'pipe',
      timeout: 5000,
    });

    const message = generateCommitMessage(absPath, cwd);
    execSync(`git commit -m "${message}" --no-verify`, {
      cwd: gitDir,
      encoding: 'utf8',
      stdio: 'pipe',
      timeout: 5000,
    });

    return true;
  } catch {
    // 静默失败：可能是 git 未配置、空提交、merge 冲突等
    return false;
  }
}

/**
 * 在工具执行后调用：若 auto-commit 启用，则自动提交改动的文件。
 * @param config  git 配置 { auto_commit: boolean }
 * @param absPath  改动的文件绝对路径
 * @param cwd      当前工作目录
 */
export function maybeAutoCommit(
  config: { autoCommit?: boolean } | undefined,
  absPath: string,
  cwd: string,
): void {
  if (!config?.autoCommit) return;
  if (!existsSync(absPath)) return;

  autoCommitFile(absPath, cwd);
}
