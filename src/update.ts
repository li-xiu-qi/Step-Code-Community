/**
 * 自更新模块：SEA 单文件形态 + 源码/link 形态双支持。
 *
 * 分发源：GitHub Releases（li-xiu-qi/Step-Code-Community）。
 * .github/workflows/release.yml 打 tag 时上传三平台 SEA 可执行文件 + 同名 .sha256，
 * 资产名固定：step-code-win32-x64.exe / step-code-darwin-arm64 / step-code-linux-x64。
 * 另有 step-code.tgz（npm 固定名 tarball）与 step-code-community-<ver>.tgz，本模块不消费。
 *
 * 设计取舍（自更新机制按社区版自身情况做减法）：
 * - 上游自更新走自有静态 bucket（latest.json + manifest.json + install 脚本）；社区版无此基础设施，
 *   直接用 GitHub Releases API（/releases/latest → tag_name + assets）。免认证限额 60 次/小时，
 *   对低频检查（默认一天一次级别）足够；env 可显式禁用/强制。
 * - 上游用 proper-lockfile 做安装锁；这里不引入依赖，靠「下载到 .new + 校验通过才替换」幂等。
 *   两个并发 update 会互相覆盖 .new，但校验/smoke/替换各自原子，最坏结果是一次失败的替换提示。
 * - 上游有 windows-self-update quarantine（原生 addon 换版本时被 exe 锁）；社区版纯 JS/wasm，
 *   无原生依赖，替换只需换单个 exe。
 * - 双形态判定：process.execPath 的 basename 是 step/step.exe → SEA 单文件；否则（node 跑
 *   dist/main.js，pnpm link / npm 全局 / 源码直跑）→ 源码形态，自更新提示 git pull + build，
 *   不做二进制替换。
 *
 * Windows 替换的「不杀自己」方案：SEA 形态下进程自己就是 exe，运行中无法改名。解法是 spawn
 * 一个 detach 的 PowerShell 辅助进程（不锁 exe），旧进程正常退出后由它执行
 * Move-Item 替换 + Start-Process 重启。旧进程在目录外面当协调者，不碰自己。
 */
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { VERSION } from './version.js';

export const DEFAULT_UPDATE_REPO = 'li-xiu-qi/Step-Code-Community';
/** 沿用既有 state 文件名约定，与生态内其他 CLI 的更新记忆文件可互认。 */
export const UPDATE_STATE_FILE = 'tui-update-state.json';

const DISABLE_UPDATE_ENV_NAMES = ['STEPCODE_DISABLE_UPDATE_CHECK', 'STEPCODE_DISABLE_TUI_UPDATE_CHECK'] as const;
const FORCE_UPDATE_ENV_NAMES = ['STEPCODE_ENABLE_UPDATE_CHECK', 'STEPCODE_ENABLE_TUI_UPDATE_CHECK'] as const;

const UPDATE_CHECK_TIMEOUT_MS = 1_500;
const UPDATE_INSTALL_TIMEOUT_MS = 120_000;
const SMOKE_TIMEOUT_MS = 15_000;

const SEA_BIN_NAMES = ['step', 'step.exe'] as const;

interface ReleaseAsset {
  name: string;
  browserDownloadUrl: string;
}

interface LatestRelease {
  /** 规范化后的版本，如 'v0.1.6' */
  version: string;
  /** 本平台 SEA 可执行文件资产；平台不支持时为 undefined */
  binary?: ReleaseAsset;
  /** 与 binary 同名的 .sha256 资产 */
  checksum?: ReleaseAsset;
  assets: ReleaseAsset[];
}

export interface UpdateCheckInput {
  repo?: string;
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
  executablePath?: string;
  /** 强制检查：绕过环境变量禁用与启动频率节流 */
  force?: boolean;
  /** state 文件根目录（默认 ~/.step-code） */
  storageRootDir?: string;
}

export type UpdateCheckStatus = 'disabled' | 'up-to-date' | 'available' | 'source-install' | 'error';

export interface UpdateCheckResult {
  status: UpdateCheckStatus;
  currentVersion: string;
  latestVersion?: string;
  message?: string;
}

export interface UpdateCommandInput extends UpdateCheckInput {
  argv?: readonly string[];
}

export type UpdateCommandStatus = 'up-to-date' | 'installed' | 'source-install' | 'disabled' | 'error';

export interface UpdateCommandResult {
  status: UpdateCommandStatus;
  message: string;
}

// ---------------------------------------------------------------------------
// 版本号工具
// ---------------------------------------------------------------------------

/** 规范化版本串：剥 refs/tags/、v 前缀、step- 前缀 → 'v0.1.5'；无法识别返回 null。 */
export function normalizeReleaseVersion(value: string): string | null {
  let normalized = value.trim().replace(/^refs\/tags\//u, '');
  normalized = normalized.replace(/^(?:step(?:-harness)?|pi|community)-v/iu, '');
  normalized = normalized.replace(/^v(?=\d)/iu, '');
  if (!/^\d+\.\d+\.\d+$/u.test(normalized)) return null;
  return `v${normalized}`;
}

/**
 * 比较两个版本串（v0.1.5 与 v0.1.6）。数字段逐位比较，位数不足补 0。
 * 只认 MAJOR.MINOR.PATCH；带预发布后缀的版本按数字段比较后回退 localeCompare。
 */
export function compareReleaseVersions(left: string, right: string): number {
  const parse = (value: string): { numbers: number[]; suffix: string } | null => {
    const normalized = normalizeReleaseVersion(value);
    if (normalized === null) return null;
    const match = /^v(\d+(?:\.\d+)*)(.*)$/u.exec(normalized);
    if (match === null) return null;
    return {
      numbers: match[1].split('.').map((part) => Number.parseInt(part, 10)),
      suffix: match[2] ?? '',
    };
  };
  const parsedLeft = parse(left);
  const parsedRight = parse(right);
  if (parsedLeft === null || parsedRight === null) return left.localeCompare(right);
  const length = Math.max(parsedLeft.numbers.length, parsedRight.numbers.length);
  for (let index = 0; index < length; index += 1) {
    const leftValue = parsedLeft.numbers[index] ?? 0;
    const rightValue = parsedRight.numbers[index] ?? 0;
    if (leftValue !== rightValue) return leftValue > rightValue ? 1 : -1;
  }
  if (parsedLeft.suffix === parsedRight.suffix) return 0;
  if (parsedLeft.suffix === '') return 1;
  if (parsedRight.suffix === '') return -1;
  return parsedLeft.suffix.localeCompare(parsedRight.suffix);
}

// ---------------------------------------------------------------------------
// 形态判定与路径
// ---------------------------------------------------------------------------

/** 当前进程是否 SEA 单文件形态（execPath 本身是 step/step.exe）。 */
export function isSeaInstallation(execPath: string = process.execPath): boolean {
  const name = basename(execPath).toLowerCase();
  return (SEA_BIN_NAMES as readonly string[]).includes(name);
}

/** SEA 形态下返回可执行文件绝对路径；源码/link 形态返回 undefined。 */
export function resolveStepExecutablePath(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const override = env.STEPCODE_BINARY_PATH?.trim();
  if (override) return resolve(override);
  if (isSeaInstallation(process.execPath)) return resolve(process.execPath);
  return undefined;
}

/** state 文件路径：~/.step-code/tui-update-state.json（可注入 storageRootDir 供测试）。 */
export function resolveUpdateStatePath(storageRootDir: string): string {
  return join(storageRootDir, UPDATE_STATE_FILE);
}

export function defaultStorageRootDir(): string {
  return join(homedir(), '.step-code');
}

/** 读取已压制（提示过/跳过）的版本；文件缺失或损坏返回 undefined。 */
export async function readSuppressedVersion(storageRootDir: string): Promise<string | undefined> {
  try {
    const raw = JSON.parse(await readFile(resolveUpdateStatePath(storageRootDir), 'utf8')) as {
      suppressedVersion?: unknown;
    };
    return typeof raw.suppressedVersion === 'string' && raw.suppressedVersion.trim() !== ''
      ? raw.suppressedVersion.trim()
      : undefined;
  } catch {
    return undefined;
  }
}

/** 写入压制版本；传 null 清空（删除 state 文件）。 */
export async function writeSuppressedVersion(storageRootDir: string, version: string | null): Promise<void> {
  const statePath = resolveUpdateStatePath(storageRootDir);
  if (version === null || version.trim() === '') {
    await rm(statePath, { force: true });
    return;
  }
  await mkdir(dirname(statePath), { recursive: true });
  await writeFile(statePath, `${JSON.stringify({ suppressedVersion: version.trim() }, null, 2)}\n`, 'utf8');
}

/** 本平台 SEA 资产名。平台不在支持列表（如 win32-arm64）返回 undefined。 */
export function resolvePlatformAssetName(platform: NodeJS.Platform = process.platform, arch = process.arch): string | undefined {
  const target =
    platform === 'win32' && arch === 'x64'
      ? 'win32-x64'
      : platform === 'darwin' && arch === 'arm64'
        ? 'darwin-arm64'
        : platform === 'linux' && arch === 'x64'
          ? 'linux-x64'
          : undefined;
  if (target === undefined) return undefined;
  return `step-code-${target}${platform === 'win32' ? '.exe' : ''}`;
}

// ---------------------------------------------------------------------------
// 网络与 Release 解析（fetch 可注入，供测试）
// ---------------------------------------------------------------------------

async function fetchWithTimeout(url: string, fetchImpl: typeof fetch, timeoutMs: number): Promise<Response> {
  try {
    return await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs) });
  } catch (error) {
    // 重试一次瞬时网络错误（首跳 DNS/TLS 偶发）
    return fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs) });
  }
}

function parseLatestRelease(payload: unknown): LatestRelease | null {
  const body = payload as { tag_name?: unknown; assets?: unknown } | null;
  if (body === null || typeof body !== 'object') return null;
  const tag = typeof body.tag_name === 'string' ? normalizeReleaseVersion(body.tag_name) : null;
  if (tag === null) return null;
  const assets: ReleaseAsset[] = [];
  if (Array.isArray(body.assets)) {
    for (const item of body.assets) {
      const asset = item as { name?: unknown; browser_download_url?: unknown } | null;
      if (
        asset !== null &&
        typeof asset === 'object' &&
        typeof asset.name === 'string' &&
        typeof asset.browser_download_url === 'string'
      ) {
        assets.push({ name: asset.name, browserDownloadUrl: asset.browser_download_url });
      }
    }
  }
  const assetName = resolvePlatformAssetName();
  const binary = assetName !== undefined ? assets.find((a) => a.name === assetName) : undefined;
  const checksum =
    binary !== undefined ? assets.find((a) => a.name === `${binary.name}.sha256`) : undefined;
  return { version: tag, binary, checksum, assets };
}

/** 拉取 GitHub 最新 release；网络失败返回 null（调用方 fail-open）。 */
export async function fetchLatestRelease(input: UpdateCheckInput = {}): Promise<LatestRelease | null> {
  const fetchImpl = input.fetchImpl ?? fetch;
  const repo = input.repo?.trim() || DEFAULT_UPDATE_REPO;
  const url = `https://api.github.com/repos/${repo}/releases/latest`;
  try {
    const response = await fetchWithTimeout(url, fetchImpl, UPDATE_CHECK_TIMEOUT_MS);
    if (!response.ok) return null;
    return parseLatestRelease(await response.json());
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// 检查（启动低频 / step update --check 共用）
// ---------------------------------------------------------------------------

function isUpdateCheckEnabled(env: NodeJS.ProcessEnv, force: boolean): boolean {
  if (force) return true;
  if (DISABLE_UPDATE_ENV_NAMES.some((name) => readBooleanEnv(env[name]))) return false;
  if (FORCE_UPDATE_ENV_NAMES.some((name) => readBooleanEnv(env[name]))) return true;
  return true;
}

/**
 * 检查是否有新版本。不安装、不弹交互。
 * 启动路径用：发现新版本 → 调用方提示「运行 step update 升级」，并把该版本写入
 * suppressedVersion（同一版本只提示一次）。
 */
export async function checkForUpdate(input: UpdateCheckInput = {}): Promise<UpdateCheckResult> {
  const env = input.env ?? process.env;
  const current = normalizeReleaseVersion(VERSION);
  if (current === null) return { status: 'error', currentVersion: '', message: '无法解析当前版本号' };

  const executablePath = input.executablePath ?? resolveStepExecutablePath(env);
  if (executablePath === undefined) {
    return {
      status: 'source-install',
      currentVersion: VERSION,
      message: '当前为源码/npm 形态安装，不执行二进制自更新（升级走 git pull + npm run build）',
    };
  }

  if (!isUpdateCheckEnabled(env, input.force ?? false)) {
    return { status: 'disabled', currentVersion: VERSION };
  }

  const latest = await fetchLatestRelease(input);
  if (latest === null) {
    return { status: 'error', currentVersion: VERSION, message: '无法获取最新版本（网络或限流）' };
  }
  if (compareReleaseVersions(latest.version, current) <= 0) {
    return { status: 'up-to-date', currentVersion: VERSION, latestVersion: latest.version };
  }
  return { status: 'available', currentVersion: VERSION, latestVersion: latest.version };
}

// ---------------------------------------------------------------------------
// 安装（step update）
// ---------------------------------------------------------------------------

/** 当前版本号字符串（不做规范化），与 version.ts 的 VERSION 同一来源。 */

/**
 * 执行完整更新：下载 .new → sha256 校验 → smoke test → 替换 → 重启。
 * 退出码：0 成功/无需更新；1 失败；2 源码形态/不支持平台。
 */
export async function runUpdateCommand(input: UpdateCommandInput = {}): Promise<UpdateCommandResult> {
  const env = input.env ?? process.env;
  const currentVersion = VERSION;
  const current = normalizeReleaseVersion(currentVersion);
  if (current === null) {
    return { status: 'error', message: `无法解析当前版本号 ${currentVersion}` };
  }

  const executablePath = input.executablePath ?? resolveStepExecutablePath(env);
  if (executablePath === undefined) {
    return {
      status: 'source-install',
      message:
        '当前是源码/npm 形态安装，不执行二进制自更新。\n' +
        '升级方式：在安装目录执行 git pull，然后 npm run build（或 pnpm install && pnpm run build）。',
    };
  }

  if (!isUpdateCheckEnabled(env, input.force ?? false)) {
    return { status: 'disabled', message: '更新检查已被环境变量禁用' };
  }

  const latest = await fetchLatestRelease(input);
  if (latest === null) {
    return { status: 'error', message: '无法获取最新版本（网络或限流），请稍后重试' };
  }
  if (compareReleaseVersions(latest.version, current) <= 0) {
    return { status: 'up-to-date', message: `已是最新版本 ${currentVersion}` };
  }
  if (latest.binary === undefined || latest.checksum === undefined) {
    return { status: 'error', message: `最新版本 ${latest.version} 没有本平台（${process.platform}-${process.arch}）的 SEA 产物` };
  }

  // 下载 + 校验 + smoke，全过才动安装目录
  const newPath = `${executablePath}.new`;
  try {
    await stageAndVerify({
      binaryUrl: latest.binary.browserDownloadUrl,
      checksumUrl: latest.checksum.browserDownloadUrl,
      destPath: newPath,
      expectedVersion: latest.version,
      fetchImpl: input.fetchImpl ?? fetch,
    });
  } catch (error) {
    await rm(newPath, { force: true }).catch(() => {});
    return { status: 'error', message: `下载或校验失败：${error instanceof Error ? error.message : String(error)}` };
  }

  // 替换 + 重启（按平台分策略，见模块头注释）
  let relaunchMode: 'relaunched' | 'deferred';
  try {
    relaunchMode = await replaceAndRelaunch(executablePath, input.argv ?? []);
  } catch (error) {
    return { status: 'error', message: `替换失败：${error instanceof Error ? error.message : String(error)}` };
  }
  if (relaunchMode === 'deferred') {
    return {
      status: 'installed',
      message: `新版 ${latest.version} 已就绪（下载与校验通过）。本进程退出后将自动替换并重启，请稍候片刻。`,
    };
  }
  return { status: 'installed', message: `已更新到 ${latest.version}` };
}

async function stageAndVerify(input: {
  binaryUrl: string;
  checksumUrl: string;
  destPath: string;
  expectedVersion: string;
  fetchImpl: typeof fetch;
}): Promise<void> {
  const { binaryUrl, checksumUrl, destPath, expectedVersion, fetchImpl } = input;
  // 下载 exe
  const binaryResponse = await fetchWithTimeout(binaryUrl, fetchImpl, UPDATE_INSTALL_TIMEOUT_MS);
  if (!binaryResponse.ok) throw new Error(`下载失败 HTTP ${binaryResponse.status}`);
  const binaryBuffer = Buffer.from(await binaryResponse.arrayBuffer());
  await mkdir(dirname(destPath), { recursive: true });
  await writeFile(destPath, binaryBuffer);

  // 下载 sha256 并比对
  const checksumResponse = await fetchWithTimeout(checksumUrl, fetchImpl, UPDATE_INSTALL_TIMEOUT_MS);
  if (!checksumResponse.ok) throw new Error(`下载校验文件失败 HTTP ${checksumResponse.status}`);
  const checksumText = (await checksumResponse.text()).trim();
  const expectedChecksum = checksumText.split(/\s+/u)[0]?.toLowerCase();
  if (expectedChecksum === undefined || !/^[a-f0-9]{64}$/u.test(expectedChecksum)) {
    throw new Error(`校验文件格式异常：${checksumText.slice(0, 120)}`);
  }
  const actualChecksum = createHash('sha256').update(binaryBuffer).digest('hex');
  if (actualChecksum !== expectedChecksum) {
    throw new Error(`sha256 不匹配（期望 ${expectedChecksum}，实际 ${actualChecksum}）`);
  }

  // smoke test：新版必须能启动且版本号正确
  const smoke = await smokeTest(destPath, expectedVersion);
  if (!smoke.ok) throw new Error(smoke.message);
}

/** 执行新二进制 --version 并核对版本。社区版 versionLine 输出可能带构建后缀（commit+time），取行首主版本。 */
export async function smokeTest(
  binaryPath: string,
  expectedVersion: string,
): Promise<{ ok: boolean; message: string }> {
  const result = await new Promise<{ code: number | null; stdout: string; stderr: string }>((resolvePromise) => {
    const child = spawn(binaryPath, ['--version'], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill();
    }, SMOKE_TIMEOUT_MS);
    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += String(chunk);
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += String(chunk);
    });
    child.once('error', (error) => {
      clearTimeout(timer);
      resolvePromise({ code: null, stdout, stderr: String(error) });
    });
    child.once('exit', (code) => {
      clearTimeout(timer);
      resolvePromise({ code, stdout, stderr });
    });
  });
  if (result.code !== 0) {
    return { ok: false, message: `新版冒烟测试失败（exit ${result.code ?? 'spawn error'}）：${result.stderr.trim() || result.stdout.trim() || '无输出'}` };
  }
  const firstLine = result.stdout.trim().split('\n')[0] ?? '';
  const reported = normalizeReleaseVersion(firstLine);
  const expected = normalizeReleaseVersion(expectedVersion);
  if (reported === null || expected === null || reported !== expected) {
    return { ok: false, message: `新版版本号不符（输出 ${firstLine.slice(0, 80) || '(空)'}，期望 ${expectedVersion}）` };
  }
  return { ok: true, message: 'ok' };
}

/** 替换旧 exe 并重启。POSIX rename 运行中文件安全（立即生效）；Windows 交给 detached 辅助进程（旧进程退出后生效）。返回 'relaunched'（已直接重启）或 'deferred'（退出后生效）。 */
async function replaceAndRelaunch(
  executablePath: string,
  argv: readonly string[],
): Promise<'relaunched' | 'deferred'> {
  if (process.platform === 'win32') {
    spawnWindowsRelocator(executablePath, argv);
    return 'deferred';
  }
  // POSIX：rename 运行中的可执行文件不失败（inode 引用），直接换名后拉起新版。
  const oldPath = `${executablePath}.old`;
  const newPath = `${executablePath}.new`;
  await rename(executablePath, oldPath).catch(() => {
    // .old 残留（上次失败）时 rename 失败；unlink 后重试
    return rm(oldPath, { force: true }).then(() => rename(executablePath, oldPath));
  });
  await rename(newPath, executablePath);
  await relaunchAsChild(executablePath, argv);
  return 'relaunched';
}

/**
 * Windows 替换：spawn 一个 detach 的 PowerShell 辅助进程（不加载也不锁 step.exe），
 * 旧进程正常退出后由它执行 Move-Item 替换 + Start-Process 重启。
 * 旧进程在目录外面当协调者，不需要杀自己——SEA 自更新的核心优势。
 */
function spawnWindowsRelocator(executablePath: string, argv: readonly string[]): void {
  const scriptPath = join(tmpdir(), `step-update-${process.pid}-${randomUUID()}.ps1`);
  const exe = executablePath.replaceAll("'", "''");
  // 重启参数：透传原 argv（不含 update 本身，避免重启后重入 update 命令）
  const json = JSON.stringify([...argv]);
  const script = [
    '$ErrorActionPreference = "Stop"',
    `$exe = '${exe}'`,
    `$new = "$exe.new"`,
    `$old = "$exe.old"`,
    `$log = "$exe.update.log"`,
    'try {',
    `  $self = Get-Process -Id ${process.pid} -ErrorAction SilentlyContinue`,
    '  if ($self) { $self.WaitForExit() }',
    '  Start-Sleep -Milliseconds 200',
    '  Move-Item -Force $exe $old',
    '  Move-Item -Force $new $exe',
    `  $args = '${json}' | ConvertFrom-Json`,
    '  Start-Process -FilePath $exe -ArgumentList $args',
    '  "OK $exe" | Out-File -FilePath $log -Encoding utf8',
    '} catch {',
    '  "FAIL: $_" | Out-File -FilePath $log -Encoding utf8',
    '}',
  ].join('\n');
  writeFileSync(scriptPath, script, 'utf8');
  const child = spawn(
    'powershell',
    ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', scriptPath],
    { detached: true, stdio: 'ignore' },
  );
  child.unref();
}

/** POSIX：spawn 新版继承 stdio，本进程作为父进程等它结束，透传退出码。 */
async function relaunchAsChild(binaryPath: string, argv: readonly string[]): Promise<void> {
  await new Promise<void>((resolvePromise, rejectPromise) => {
    const child = spawn(binaryPath, [...argv], { stdio: 'inherit', env: process.env });
    child.once('error', rejectPromise);
    child.once('exit', (code) => {
      if (code === 0) {
        resolvePromise();
      } else {
        rejectPromise(new Error(`新版退出码 ${code ?? 1}`));
      }
    });
  });
}

// ---------------------------------------------------------------------------
// 启动低频检查（cli-app 交互模式调用；fail-open，绝不影响启动）
// ---------------------------------------------------------------------------

/**
 * 交互模式启动前的快速检查：发现新版本 → stderr 打一行提示（供用户跑 step update），
 * 并把该版本写进 suppressedVersion（同一版本只提示一次）。
 * 所有异常/超时路径静默返回，启动不被更新检查拖累。
 */
export async function maybeNotifyUpdateOnStart(input: UpdateCheckInput = {}): Promise<void> {
  const env = input.env ?? process.env;
  // 非 SEA 形态（源码/link）或明确禁用 → 不检查
  if (resolveStepExecutablePath(env) === undefined) return;
  if (!isUpdateCheckEnabled(env, false)) return;
  try {
    const result = await checkForUpdate({ ...input, force: false });
    if (result.status !== 'available' || result.latestVersion === undefined) return;
    const storageRoot = input.storageRootDir ?? defaultStorageRootDir();
    const suppressed = await readSuppressedVersion(storageRoot);
    if (suppressed === result.latestVersion) return;
    await writeSuppressedVersion(storageRoot, result.latestVersion);
    process.stderr.write(
      `\n[step] 发现新版本 ${result.latestVersion}（当前 ${result.currentVersion}）。运行 step update 升级。\n`,
    );
  } catch {
    // fail-open：任何异常都不影响启动
  }
}

function readBooleanEnv(value: string | undefined): boolean {
  return value !== undefined && ['1', 'true', 'yes', 'on'].includes(value.trim().toLowerCase());
}
