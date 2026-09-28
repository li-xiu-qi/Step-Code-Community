/**
 * SGR 鼠标序列解析（终端鼠标上报的唯一样式，1006 模式）。
 *
 * 为什么需要自己解析：pi-tui 的 StdinBuffer 只负责把完整序列透传上来
 * （emit('data', sequence)），parseKey 对鼠标序列返回 undefined，TUI 的
 * handleInput 链也不产出结构化鼠标事件。社区版要支持「点图片打开预览」
 * （缩略图点击 + 预览浮层），只能在组件层自己解析。
 *
 * 协议：`ESC [ < B ; X ; Y M`（按下/滚动/拖动开始）或 `... m`（释放）。
 * B 的位编码：低两位按钮号（0 左 / 1 中 / 2 右），bit2(4) shift，
 * bit3(8) alt，bit4(16) ctrl，bit5(32) motion（拖动），bit6(64) wheel
 * （wheel 时低两位表方向：0 上 / 1 下 / 2 左 / 3 右）。X / Y 为 1-based
 * 列 / 行，这里统一转成 0-based。
 *
 * 不识别旧式 X10 鼠标（`ESC [ M` + 3 字节）：它坐标上限 223 且字节可能被
 * 当文本回显，现代终端（WT 默认 1006）都用 SGR，明确不支持比猜着解析好。
 */

export interface MouseEvent {
  readonly kind: 'press' | 'release' | 'drag' | 'wheel';
  /** 0 左 / 1 中 / 2 右；wheel 时 4 上 / 5 下 / 6 左 / 7 右。 */
  readonly button: number;
  /** 0-based 列。 */
  readonly col: number;
  /** 0-based 行。 */
  readonly row: number;
}

/** SGR 鼠标序列：整串匹配，不接受前后缀（调用方拿到的就是完整序列）。 */
const SGR_MOUSE_RE = /^\x1b\[<(\d+);(\d+);(\d+)([Mm])$/;

export function parseSGRMouse(data: string): MouseEvent | undefined {
  const m = SGR_MOUSE_RE.exec(data);
  if (m === null) return undefined;
  const code = Number(m[1]);
  const isWheel = (code & 64) !== 0;
  const isMotion = (code & 32) !== 0;
  const button = code & 3;
  // 坐标钳到 0：终端偶尔在窗口边缘报 0（或序列损坏），负下标会静默丢失点击。
  const col = Math.max(0, Number(m[2]) - 1);
  const row = Math.max(0, Number(m[3]) - 1);
  if (isWheel) return { kind: 'wheel', button: 4 + button, col, row };
  if (isMotion) return { kind: 'drag', button, col, row };
  return { kind: m[4] === 'M' ? 'press' : 'release', button, col, row };
}
