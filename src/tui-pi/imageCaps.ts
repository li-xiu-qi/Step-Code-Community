/**
 * 终端图片能力探测修正。
 *
 * pi-tui 0.84.1 的 detectCapabilities 对 Windows Terminal 一律返回 images:null
 * （terminal-image.js 的 WT_SESSION 分支），但 WT 自 1.22（2025-08）起支持
 * kitty graphics 协议。用户在 WT 里跑 step-code 是主力场景，不做修正则图片
 * 永远走文本降级。
 *
 * 策略：检测到 WT_SESSION 时查 wt 版本，>= 1.22 则用 setCapabilities 覆盖为
 * kitty。版本拿不到时保守不动（保持 null）——降级是安全默认，误启用反而会在
 * 老 WT 上把 kitty 转义序列当垃圾字符显示。
 *
 * 版本来源：`wt.exe --version` 打印 "Windows Terminal 1.22.x"（app execution
 * alias，WT 会话内 PATH 可达）。拿不到（非 WT 启动的 wt 不存在、输出格式变）
 * 一律视为未知，不覆盖。
 */
import { getCapabilities, setCapabilities } from '@earendil-works/pi-tui';
import { spawnSync } from 'node:child_process';

/** WT 支持 kitty graphics 的最低版本（1.22，2025-08 发布）。 */
const MIN_KITTY_WT_MAJOR = 1;
const MIN_KITTY_WT_MINOR = 22;

/**
 * 查询 wt 版本号。返回 [major, minor] 或 undefined。
 * spawnSync 失败（wt 不在 PATH）、超时、输出不匹配都归为 undefined。
 *
 * 注意：undefined 不代表「不是 WT」或「太老」，只代表「问不出来」。调用方
 * （applyWtKittyOverride）据此按够新处理。
 */
function detectWtVersion(): [number, number] | undefined {
  let r: ReturnType<typeof spawnSync>;
  try {
    r = spawnSync('wt.exe', ['--version'], { encoding: 'utf8', timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'] });
  } catch {
    return undefined;
  }
  if (r.error !== undefined || r.status !== 0) return undefined;
  const out = r.stdout;
  const m = /(\d+)\.(\d+)(?:\.(\d+))?/.exec(typeof out === 'string' ? out : out?.toString('utf8') ?? '');
  if (m === null) return undefined;
  const major = Number.parseInt(m[1]!, 10);
  const minor = Number.parseInt(m[2]!, 10);
  if (Number.isNaN(major) || Number.isNaN(minor)) return undefined;
  return [major, minor];
}

/** 版本是否 >= [1, 22]。 */
function wtSupportsKitty(v: [number, number]): boolean {
  if (v[0] !== MIN_KITTY_WT_MAJOR) return v[0] > MIN_KITTY_WT_MAJOR;
  return v[1] >= MIN_KITTY_WT_MINOR;
}

/**
 * 启动时调用一次（在任何 Image 渲染前，因为 getCapabilities 有缓存）。
 * 仅在 Windows Terminal 内时把 images 覆盖为 kitty。
 *
 * 为什么必须覆盖：pi-tui 的 `detectCapabilities` 对 `WT_SESSION` 是硬编码返回
 * `images: null`（见其 terminal-image.js 的 WT 分支），且它的名单里根本没有
 * Windows Terminal——只列了 kitty/ghostty/wezterm/warp/iterm2。WT 自 1.22
 * （2025-08）起支持 kitty graphics，但那份名单没跟着更新。
 *
 * 判据为什么不再以版本号为必要条件：`wt.exe` 不在 PATH 是常态（用 WT 完全不需要
 * 把它加进 PATH，2026-09-15 本机实测 `which wt.exe` 为 not found），旧实现因此
 * 直接 return，覆盖从未生效，图片一律落到 pi-tui 的 fallback 占位文本。
 * WT 自 1.22 起支持且会自动更新，拿不到版本时假定够新比假定太旧更合理。
 * 只有拿到版本且明确低于门槛时才保守不动。
 *
 * 代价：极老的 WT（< 1.22）会把 kitty 转义序列显示成垃圾字符。
 */
export function applyWtKittyOverride(): void {
  if (process.env.WT_SESSION === undefined) return;
  const caps = getCapabilities();
  // 已有图片能力（未来 pi-tui 自己认了 WT，或用户强制）则不动
  if (caps.images !== null) return;
  const v = detectWtVersion();
  if (v !== undefined && !wtSupportsKitty(v)) return;
  setCapabilities({ ...caps, images: 'kitty' });
}
