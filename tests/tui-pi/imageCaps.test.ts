/**
 * imageCaps.applyWtKittyOverride：WT 的 kitty 覆盖。
 *
 * 钉住的关键行为是「版本问不出来时仍然启用」。wt.exe 不在 PATH 是常态
 * （用 WT 不需要它），旧实现在这一支直接 return，导致覆盖从未生效、图片
 * 一律落到 pi-tui 的 fallback 占位文本。2026-09-15 本机实测复现并修复。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const spawnSyncMock = vi.hoisted(() => vi.fn());
vi.mock('node:child_process', () => ({ spawnSync: spawnSyncMock }));

const { getCapabilities, resetCapabilitiesCache, setCapabilities } = await import(
  '@earendil-works/pi-tui/dist/terminal-image.js'
);
const { applyWtKittyOverride } = await import('../../src/tui-pi/imageCaps.js');

/** spawnSync 返回成功结果并带上版本输出。 */
function wtVersion(major: number, minor: number): void {
  spawnSyncMock.mockReturnValue({ status: 0, stdout: `Windows Terminal ${major}.${minor}.1234.0\n` });
}

/** spawnSync 失败（wt.exe 不在 PATH、超时、输出不匹配都归这一类）。 */
function wtUnknown(): void {
  spawnSyncMock.mockReturnValue({ error: new Error('spawnSync wt.exe ENOENT'), status: null, stdout: '' });
}

let savedWtSession: string | undefined;

beforeEach(() => {
  resetCapabilitiesCache();
  spawnSyncMock.mockReset();
  savedWtSession = process.env.WT_SESSION;
  process.env.WT_SESSION = 'test-session-id';
});

afterEach(() => {
  resetCapabilitiesCache();
  if (savedWtSession === undefined) delete process.env.WT_SESSION;
  else process.env.WT_SESSION = savedWtSession;
});

describe('applyWtKittyOverride 版本判据', () => {
  it('版本问不出来时仍然启用 kitty（本次修复的核心）', () => {
    wtUnknown();
    expect(getCapabilities().images).toBeNull();
    applyWtKittyOverride();
    expect(getCapabilities().images).toBe('kitty');
  });

  it('版本 >= 1.22 时启用', () => {
    wtVersion(1, 22);
    applyWtKittyOverride();
    expect(getCapabilities().images).toBe('kitty');
  });

  it('版本明显高于门槛时启用（1.x 以上大版本）', () => {
    wtVersion(2, 0);
    applyWtKittyOverride();
    expect(getCapabilities().images).toBe('kitty');
  });

  it('版本明确低于门槛时不启用（保守，避免老 WT 显示垃圾字符）', () => {
    wtVersion(1, 21);
    applyWtKittyOverride();
    expect(getCapabilities().images).toBeNull();
  });

  it('大版本低于门槛时不启用', () => {
    wtVersion(0, 99);
    applyWtKittyOverride();
    expect(getCapabilities().images).toBeNull();
  });

  it('非 WT 会话完全不调用 wt.exe，也不改动能力', () => {
    delete process.env.WT_SESSION;
    applyWtKittyOverride();
    expect(spawnSyncMock).not.toHaveBeenCalled();
    expect(getCapabilities().images).toBeNull();
  });

  it('pi-tui 已给出图片能力时不覆盖（尊重上游或用户强制）', () => {
    setCapabilities({ images: 'iterm2', trueColor: true, hyperlinks: true });
    wtUnknown();
    applyWtKittyOverride();
    expect(getCapabilities().images).toBe('iterm2');
    expect(spawnSyncMock).not.toHaveBeenCalled();
  });

  it('幂等：第二次调用不重复 spawn', () => {
    wtUnknown();
    applyWtKittyOverride();
    applyWtKittyOverride();
    expect(spawnSyncMock).toHaveBeenCalledTimes(1);
    expect(getCapabilities().images).toBe('kitty');
  });
});

describe('Image 渲染的真实行为', () => {
  it('未覆盖时产 fallback 占位文本，覆盖后产 kitty APC 序列', async () => {
    const { Image } = await import('@earendil-works/pi-tui/dist/components/image.js');
    // 1x1 透明 PNG
    const b64 =
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
    const theme = { fallbackColor: (s: string) => s };

    const before = new Image(b64, 'image/png', theme, { maxWidthCells: 20 }).render(40);
    // 复现用户截图里的形态：占位文本，不含任何转义序列
    expect(before).toHaveLength(1);
    expect(before[0]).toContain('[Image:');
    expect(before[0]).not.toContain('\x1b');

    // 版本问不出来（wt.exe 不在 PATH 的常态）也要启用，否则覆盖不生效
    wtUnknown();
    applyWtKittyOverride();
    const after = new Image(b64, 'image/png', theme, { maxWidthCells: 20 }).render(40);
    expect(after.length).toBeGreaterThan(1);
    expect(after[0]).toContain('\x1b_G');
    expect(after[0]).toContain('a=T');
  });
});
