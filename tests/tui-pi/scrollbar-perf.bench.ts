/**
 * 滚动条与滚动帧成本基准，结构对齐生产布局（PiChat.ts:793-801）：
 * VStack 根 -> [ScrollView(transcript, basis 0/grow 1/shrink 1), 其余 dock 项]。
 *
 * 背景：用户反馈加滚动条后交互卡顿。此基准在同一结构上分别量 idle / hover /
 * 滚动 / 滚动+hover 四种帧，用于定位开销在不在滚动条路径。
 *
 * 注意：早期版本用 ScrollView 直接当 layoutRoot 且给 Text 传了选项对象，
 * 触发布局层 NaN 宽度，导致 Text 内部缓存永不命中、每帧全量重 wrap，
 * 量出来的 30ms 基线是病态值。现在按生产结构重建。
 *
 * 只测 render 帧成本，不起真实终端。.bench.ts 后缀，vitest 不会当测试跑。
 */
import { TuiAltScreen, ScrollView, VStack, Box, Text } from '@earendil-works/pi-tui';
import type { Terminal } from '@earendil-works/pi-tui';

class FakeTerminal {
  columns = 200;
  rows = 50;
  writes: string[] = [];
  kittyProtocolActive = false;
  private onInput: ((data: string) => void) | undefined;
  start(onInput: (data: string) => void): void { this.onInput = onInput; }
  stop(): void {}
  async drainInput(): Promise<void> {}
  write(data: string): void { this.writes.push(data); }
  moveBy(): void {}
  hideCursor(): void {}
  showCursor(): void {}
  clearLine(): void {}
  clearScreen(): void {}
  setTitle(): void {}
  setProgress(): void {}
  send(data: string): void { this.onInput?.(data); }
  allOutput(): string { return this.writes.join(''); }
  reset(): void { this.writes.length = 0; }
}

const WIDTH = 200;
const HEIGHT = 50;
const CONTENT_LINES = 400;

/** 生产结构：VStack 根，ScrollView 占满剩余高度。 */
function buildScreen(): { term: FakeTerminal; tui: TuiAltScreen; scroll: ScrollView } {
  const term = new FakeTerminal();
  const tui = new TuiAltScreen(term as unknown as Terminal);
  tui.start();
  const inner = new Box(0, 0);
  for (let i = 0; i < CONTENT_LINES; i++) {
    inner.addChild(new Text(`line ${i} ${'x'.repeat(120)} tail`, 0, 0));
  }
  const scroll = new ScrollView(inner, {
    follow: 'end',
    primary: true,
    overscroll: 'chain',
    scrollbar: 'auto',
  });
  tui.setLayoutRoot(
    new VStack([
      { component: scroll, basis: 0, grow: 1, shrink: 1 },
    ]),
  );
  tui.renderNow();
  return { term, tui, scroll };
}

function bench(label: string, fn: () => void, frames = 200): void {
  for (let i = 0; i < 20; i++) fn();
  const t0 = process.hrtime.bigint();
  for (let i = 0; i < frames; i++) fn();
  const t1 = process.hrtime.bigint();
  const perFrameMs = Number(t1 - t0) / 1e6 / frames;
  console.log(`${label}: ${perFrameMs.toFixed(3)} ms/frame (${frames} frames)`);
}

const { tui, scroll } = buildScreen();
console.log(`content=${CONTENT_LINES} viewport=${HEIGHT} width=${WIDTH}`);
console.log(`scrollbar visible=${scroll.isScrollbarVisible}`);

bench('idle  (thumbWidth=1)', () => tui.renderNow());

scroll.setScrollbarActive(true);
bench('hover (thumbWidth=2)', () => tui.renderNow());
scroll.setScrollbarActive(false);

let top = 0;
bench('scroll frame', () => {
  top = (top + 1) % 300;
  scroll.scrollTo(top);
  tui.renderNow();
});

scroll.setScrollbarActive(true);
bench('scroll + hover', () => {
  top = (top + 1) % 300;
  scroll.scrollTo(top);
  tui.renderNow();
});
scroll.setScrollbarActive(false);
