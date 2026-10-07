/**
 * npm 从 git 源安装时的构建钩子（`npm i -g github:<owner>/<repo>#<branch>`）。
 *
 * 为什么必须是 prepare：`dist/` 不入库，而 `bin.step` 指向 `dist/main.js`。npm 处理 git
 * 依赖的顺序是 clone → 安装 devDependencies → 运行 prepare → 按 `files` 打包 → 安装，
 * 只有 prepare 落在「装完 devDependencies、还没打包」这个窗口里。prepack 与
 * prepublishOnly 在这条路径上都不执行——实测只声明 prepack 时，装出来的包里只剩
 * package.json，bin 指向的文件根本不存在。
 *
 * 同一个钩子在本地 `pnpm install` 之后也会触发，所以 dist/main.js 已存在时直接跳过，
 * 免得每次装依赖都全量编译一次。需要强制跳过时设 STEP_CODE_SKIP_PREPARE=1。
 *
 * 直接调用 typescript 自带的 tsc.js 而不是 `npm run build`：这个脚本会在 npm 与 pnpm
 * 两种环境下被调用，绕开包管理器差异最省事。
 *
 * 构建前先应用 pnpm-workspace.yaml 里声明的 patches/：pnpm 安装时会自动打这些补丁，
 * npm（git 源安装）不认识这份配置，不补的话 tsc 会对着未打补丁的依赖类型报错
 * （实测：pi-tui 未打补丁时报 scrollbarTrackStyle 不存在，2026-10-07）。应用走
 * `git apply`——npm 从 git 源安装的前提就是机器上有 git。已打过的补丁会跳过，
 * 所以在 pnpm 环境下重复执行本脚本也安全。
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const entry = join(root, 'dist/main.js');
const tsc = join(root, 'node_modules/typescript/lib/tsc.js');

if (process.env.STEP_CODE_SKIP_PREPARE === '1') {
  console.log('[prepare] STEP_CODE_SKIP_PREPARE=1，跳过构建');
  process.exit(0);
}

if (existsSync(entry)) {
  console.log('[prepare] dist/main.js 已存在，跳过构建');
  process.exit(0);
}

if (!existsSync(tsc)) {
  console.error(
    '[prepare] 找不到 node_modules/typescript/lib/tsc.js，无法构建 dist/。\n' +
      '  从 git 源安装时 npm 应当先装好 devDependencies；若是手工执行本脚本，先跑一次依赖安装。\n' +
      '  只想跳过构建（例如仅取源码阅读）时设 STEP_CODE_SKIP_PREPARE=1。',
  );
  process.exit(1);
}

/**
 * 应用 pnpm-workspace.yaml 的 patchedDependencies。解析用窄正则而不是引入 yaml 依赖：
 * 本脚本要在 devDependencies 尚未装全的窗口也能跑，不假设任何第三方包可用。
 * 返回实际打上的补丁数；已应用或声明缺失都不算错误（pnpm 环境下补丁早已就位）。
 */
function applyPnpmPatches() {
  const wsPath = join(root, 'pnpm-workspace.yaml');
  if (!existsSync(wsPath)) return;
  const ws = readFileSync(wsPath, 'utf8');
  const block = ws.match(/^patchedDependencies:\n((?:[ \t]+.+\n?)+)/m);
  if (!block) return;
  const entries = [...block[1].matchAll(/^\s+['"]?(@?[^'":]+?)@([^'":]+)['"]?:\s*(\S+\.patch)\s*$/gm)];
  for (const [, name, version, patchRel] of entries) {
    const pkgDir = join(root, 'node_modules', name);
    const patchPath = join(root, patchRel);
    if (!existsSync(pkgDir) || !existsSync(patchPath)) continue;
    // 必须在仓根执行并 --directory 前置包路径：在包目录内跑 git apply 时，git 会把
    // 补丁路径按仓根相对解释，cwd 子目录外的路径被静默忽略、退出码仍是 0
    // （实测：补丁根本没打上却报成功，2026-10-07）。仓根相对路径在「是 git 仓」
    // 与「不是 git 仓」两种环境下解析一致，npm git 源安装的临时 clone 两种都可能。
    // 包路径还要先 realpath：pnpm 下 node_modules/<pkg> 是指向 .pnpm 存储的符号链接，
    // git apply 拒绝写「beyond a symbolic link」的文件（CI 实测报错），而 pnpm 自己
    // 打好的补丁就在存储真实路径上，反向检测也只有对真实路径才看得准。
    const pkgRel = relative(root, realpathSync(pkgDir)).split(sep).join('/');
    const args = (extra) => ['apply', '--directory', pkgRel, ...extra, patchRel];
    const applied = spawnSync('git', args(['--reverse', '--check']), { cwd: root });
    if (applied.status === 0) {
      console.log(`[prepare] 补丁已应用，跳过: ${name}@${version}`);
      continue;
    }
    const res = spawnSync('git', args([]), { cwd: root });
    if (res.status !== 0) {
      console.error(`[prepare] 补丁应用失败: ${name}@${version}（${patchRel}）\n${res.stderr?.toString() ?? ''}`);
      process.exit(res.status ?? 1);
    }
    console.log(`[prepare] 补丁已应用: ${name}@${version}`);
  }
}

applyPnpmPatches();

console.log('[prepare] 构建 dist/ ...');
const res = spawnSync(process.execPath, [tsc, '-p', join(root, 'tsconfig.json')], {
  cwd: root,
  stdio: 'inherit',
});
if (res.status !== 0) {
  console.error('[prepare] 构建失败，dist/ 未生成，`step` 命令不可用');
  process.exit(res.status ?? 1);
}

// 构建标识：让装出来的这份产物能自证是哪次构建（从 git 源安装时通常拿不到 commit，会记为 unknown）
const info = spawnSync(process.execPath, [join(root, 'scripts/gen-build-info.mjs')], {
  cwd: root,
  stdio: 'inherit',
});
if (info.status !== 0) console.error('[prepare] 构建标识写入失败，不影响运行，版本号将只报 version');

console.log('[prepare] 构建完成: dist/main.js');
