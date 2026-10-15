import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  checkForUpdate,
  compareReleaseVersions,
  fetchLatestRelease,
  isSeaInstallation,
  normalizeReleaseVersion,
  readSuppressedVersion,
  resolvePlatformAssetName,
  resolveStepExecutablePath,
  runUpdateCommand,
  writeSuppressedVersion,
  UPDATE_STATE_FILE,
} from '../src/update.js';

/** 构造一个 GitHub releases/latest 的假响应。 */
function fakeLatestRelease(tag: string, assets: { name: string; url: string }[]): Response {
  return new Response(
    JSON.stringify({
      tag_name: tag,
      assets: assets.map((a) => ({ name: a.name, browser_download_url: a.url })),
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
}

describe('normalizeReleaseVersion', () => {
  it('剥 v 前缀与标签前缀，返回规范 vX.Y.Z', () => {
    expect(normalizeReleaseVersion('v0.1.5')).toBe('v0.1.5');
    expect(normalizeReleaseVersion('0.1.5')).toBe('v0.1.5');
    expect(normalizeReleaseVersion('refs/tags/v0.1.5')).toBe('v0.1.5');
    expect(normalizeReleaseVersion('  v0.1.5  ')).toBe('v0.1.5');
  });
  it('非法版本返回 null', () => {
    expect(normalizeReleaseVersion('v0.1')).toBeNull();
    expect(normalizeReleaseVersion('latest')).toBeNull();
    expect(normalizeReleaseVersion('')).toBeNull();
  });
});

describe('compareReleaseVersions', () => {
  it('逐数字段比较', () => {
    expect(compareReleaseVersions('v0.1.5', 'v0.1.5')).toBe(0);
    expect(compareReleaseVersions('v0.1.6', 'v0.1.5')).toBe(1);
    expect(compareReleaseVersions('v0.1.5', 'v0.1.6')).toBe(-1);
    expect(compareReleaseVersions('v0.10.0', 'v0.9.9')).toBe(1);
    expect(compareReleaseVersions('v1.0.0', 'v0.99.99')).toBe(1);
  });
});

describe('resolvePlatformAssetName', () => {
  it('三平台资产名固定', () => {
    expect(resolvePlatformAssetName('win32', 'x64')).toBe('step-code-win32-x64.exe');
    expect(resolvePlatformAssetName('darwin', 'arm64')).toBe('step-code-darwin-arm64');
    expect(resolvePlatformAssetName('linux', 'x64')).toBe('step-code-linux-x64');
  });
  it('不支持的平台返回 undefined', () => {
    expect(resolvePlatformAssetName('win32', 'arm64')).toBeUndefined();
    expect(resolvePlatformAssetName('freebsd', 'x64')).toBeUndefined();
  });
});

describe('isSeaInstallation / resolveStepExecutablePath', () => {
  it('step.exe 与 step 判定为 SEA', () => {
    expect(isSeaInstallation('C:/tools/step.exe')).toBe(true);
    expect(isSeaInstallation('/usr/local/bin/step')).toBe(true);
  });
  it('node / npm 形态不是 SEA', () => {
    expect(isSeaInstallation('C:/Program Files/nodejs/node.exe')).toBe(false);
    expect(isSeaInstallation('/usr/bin/node')).toBe(false);
  });
  it('当前测试进程（node）解析不到 SEA 可执行路径', () => {
    expect(resolveStepExecutablePath({})).toBeUndefined();
  });
  it('STEPCODE_BINARY_PATH 覆盖生效', () => {
    expect(resolveStepExecutablePath({ STEPCODE_BINARY_PATH: 'C:/tools/step.exe' })).toBe('C:\\tools\\step.exe');
  });
});

describe('update state 文件', () => {
  it('写入后读回，清空后删除文件', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'step-update-state-'));
    try {
      const statePath = join(dir, UPDATE_STATE_FILE);
      await writeSuppressedVersion(dir, 'v0.1.6');
      expect(await readSuppressedVersion(dir)).toBe('v0.1.6');
      // 文件确实落盘了
      const raw = JSON.parse(await readFile(statePath, 'utf8')) as { suppressedVersion: string };
      expect(raw.suppressedVersion).toBe('v0.1.6');
      await writeSuppressedVersion(dir, null);
      expect(await readSuppressedVersion(dir)).toBeUndefined();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
  it('损坏/缺失的 state 文件读回 undefined', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'step-update-state-'));
    try {
      await writeFile(join(dir, UPDATE_STATE_FILE), 'not-json', 'utf8');
      expect(await readSuppressedVersion(dir)).toBeUndefined();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('fetchLatestRelease', () => {
  it('解析 tag 与本平台资产（win32-x64 视角）', async () => {
    const fetchImpl = (async (): Promise<Response> =>
      fakeLatestRelease('v0.1.6', [
        { name: 'step-code-win32-x64.exe', url: 'https://example.com/step-code-win32-x64.exe' },
        { name: 'step-code-win32-x64.exe.sha256', url: 'https://example.com/step-code-win32-x64.exe.sha256' },
        { name: 'step-code-darwin-arm64', url: 'https://example.com/step-code-darwin-arm64' },
      ])) as typeof fetch;
    const release = await fetchLatestRelease({ fetchImpl });
    expect(release).not.toBeNull();
    expect(release!.version).toBe('v0.1.6');
    if (process.platform === 'win32' && process.arch === 'x64') {
      expect(release!.binary?.name).toBe('step-code-win32-x64.exe');
      expect(release!.checksum?.name).toBe('step-code-win32-x64.exe.sha256');
    }
  });
  it('网络失败返回 null（fail-open）', async () => {
    const fetchImpl = (async (): Promise<Response> => {
      throw new Error('network down');
    }) as typeof fetch;
    expect(await fetchLatestRelease({ fetchImpl })).toBeNull();
  });
  it('非 200 返回 null', async () => {
    const fetchImpl = (async (): Promise<Response> => new Response('rate limited', { status: 403 })) as typeof fetch;
    expect(await fetchLatestRelease({ fetchImpl })).toBeNull();
  });
});

describe('checkForUpdate', () => {
  const exePath = process.platform === 'win32' ? 'C:/tools/step.exe' : '/usr/local/bin/step';

  it('SEA 形态且无新版 → up-to-date', async () => {
    const fetchImpl = (async (): Promise<Response> =>
      fakeLatestRelease('v0.0.1', [
        { name: 'step-code-win32-x64.exe', url: 'x' },
        { name: 'step-code-win32-x64.exe.sha256', url: 'y' },
      ])) as typeof fetch;
    const res = await checkForUpdate({ executablePath: exePath, fetchImpl });
    expect(res.status).toBe('up-to-date');
  });

  it('SEA 形态且远端更新 → available', async () => {
    const fetchImpl = (async (): Promise<Response> =>
      fakeLatestRelease('v9.9.9', [
        { name: 'step-code-win32-x64.exe', url: 'x' },
        { name: 'step-code-win32-x64.exe.sha256', url: 'y' },
      ])) as typeof fetch;
    const res = await checkForUpdate({ executablePath: exePath, fetchImpl });
    expect(res.status).toBe('available');
    expect(res.latestVersion).toBe('v9.9.9');
  });

  it('源码形态 → source-install（不联网）', async () => {
    const res = await checkForUpdate({});
    expect(res.status).toBe('source-install');
  });

  it('禁用环境变量 → disabled', async () => {
    const fetchImpl = (async (): Promise<Response> =>
      fakeLatestRelease('v9.9.9', [])) as typeof fetch;
    const res = await checkForUpdate({
      executablePath: exePath,
      fetchImpl,
      env: { STEPCODE_DISABLE_UPDATE_CHECK: '1' },
    });
    expect(res.status).toBe('disabled');
  });

  it('force 绕过禁用环境变量', async () => {
    const fetchImpl = (async (): Promise<Response> =>
      fakeLatestRelease('v9.9.9', [])) as typeof fetch;
    const res = await checkForUpdate({
      executablePath: exePath,
      fetchImpl,
      env: { STEPCODE_DISABLE_UPDATE_CHECK: '1' },
      force: true,
    });
    expect(res.status).toBe('available');
  });
});

describe('runUpdateCommand（不触网的安全分支）', () => {
  it('源码形态直接提示，exit 2 语义', async () => {
    const res = await runUpdateCommand({});
    expect(res.status).toBe('source-install');
  });

  it('禁用环境变量 → disabled', async () => {
    const exePath = process.platform === 'win32' ? 'C:/tools/step.exe' : '/usr/local/bin/step';
    const res = await runUpdateCommand({ executablePath: exePath, env: { STEPCODE_DISABLE_UPDATE_CHECK: '1' } });
    expect(res.status).toBe('disabled');
  });

  it('远端无更新 → up-to-date', async () => {
    const exePath = process.platform === 'win32' ? 'C:/tools/step.exe' : '/usr/local/bin/step';
    const fetchImpl = (async (): Promise<Response> =>
      fakeLatestRelease('v0.0.1', [])) as typeof fetch;
    const res = await runUpdateCommand({ executablePath: exePath, fetchImpl });
    expect(res.status).toBe('up-to-date');
  });
});
