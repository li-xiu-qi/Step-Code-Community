/**
 * 幽灵帧复现测试：alt-screen 全帧 diff 的「帧模型 vs 物理屏」一致性。
 *
 * 背景：真机截图显示 busy 期间 ActivityLine 的历史帧（不同时间戳的 spinner 行）
 * 被固化在转录区，且常驻不消。TuiAltScreen 的 diff 是逐行比较 previousScreen，
 * 理论上一致；能让物理屏与模型脱节的只剩两条路——帧外直写终端（由 consoleGuard
 * 堵住）、原生滚动快路径 (SU/SD) 误判。本测试用真实 TuiAltScreen + 真实
 * VStack/ScrollView 布局 + 迷你终端模拟器，逐帧断言「模拟屏 == previousScreen」。
 *
 * 场景 A：dock 每帧都变（spinner 逐帧 tick），diff 路径为主。
 * 场景 B：转录每帧流式追加、dock 少变，强制走 SU/SD 原生滚动快路径，并叠加
 *         队列增删（dock 高度变 → 滚动条 thumb 移动）与滚轮上下滚动。断言里
 *         同时核对 SU/SD 确实触发过，防止「快路径根本没跑到」的假绿。
 *
 * 模拟器只实现渲染器实际会发的序列子集（定位/清行/SU/SD/DECSTBM/换行），
 * 文本按可见宽度写格子，比较前两侧都去 ANSI、去尾空格。
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ScrollView, TuiAltScreen, VStack, visibleWidth, type Component, type Terminal } from '@earendil-works/pi-tui';

// ---------- 迷你终端模拟器 ----------

const CSI_RE = /^\x1b\[([0-9;?]*)([@-~])/;
const OSC_BEL_RE = /^\x1b\][^\x07]*\x07/;
const OSC_ST_RE = /^\x1b\][^\x1b]*\x1b\\/;
const CHARSET_RE = /^\x1b[()][0-9A-Z]/;
const TWO_CHAR_ESC_RE = /^\x1b[@-Z\\-]/;

class VtScreen {
  readonly rows: number;
  readonly cols: number;
  private grid: string[][];
  private r = 0;
  private c = 0;
  private marginTop = 0;
  private marginBottom: number;

  constructor(rows: number, cols: number) {
    this.rows = rows;
    this.cols = cols;
    this.marginBottom = rows - 1;
    this.grid = Array.from({ length: rows }, () => Array<string>(cols).fill(''));
  }

  /** 喂一段渲染器输出。 */
  feed(data: string): void {
    let i = 0;
    while (i < data.length) {
      const rest = data.slice(i);
      if (rest[0] === '\x1b') {
        const osc = OSC_BEL_RE.exec(rest) ?? OSC_ST_RE.exec(rest);
        if (osc) { i += osc[0].length; continue; }
        const cs = CHARSET_RE.exec(rest);
        if (cs) { i += cs[0].length; continue; }
        const csi = CSI_RE.exec(rest);
        if (csi) { i += csi[0].length; this.execCsi(csi[1]!, csi[2]!); continue; }
        const two = TWO_CHAR_ESC_RE.exec(rest);
        if (two) { i += two[0].length; continue; }
        i += 1;
        continue;
      }
      const ch = rest[0]!;
      if (ch === '\r') { this.c = 0; i += 1; continue; }
      if (ch === '\n') { this.r = Math.min(this.r + 1, this.rows - 1); i += 1; continue; }
      if (ch === '\x07') { i += 1; continue; }
      // 可打印字符：按码点取，宽字符占两格
      const cp = rest.codePointAt(0)!;
      const g = String.fromCodePoint(cp);
      const w = Math.max(1, visibleWidth(g));
      if (this.c < this.cols) {
        this.grid[this.r]![this.c] = g;
        if (w === 2 && this.c + 1 < this.cols) this.grid[this.r]![this.c + 1] = '';
      }
      this.c = Math.min(this.c + w, this.cols - 1);
      i += g.length;
    }
  }

  private execCsi(params: string, final: string): void {
    const nums = params.replace('?', '').split(';').map((s) => (s === '' ? 0 : Number.parseInt(s, 10)));
    const privateMode = params.startsWith('?');
    if (privateMode) return; // ?2026h/l ?25h/l ?7l ?1049h/l 等模式位忽略
    switch (final) {
      case 'H': case 'f': {
        this.r = Math.min(Math.max((nums[0] ?? 1) - 1, 0), this.rows - 1);
        this.c = Math.min(Math.max((nums[1] ?? 1) - 1, 0), this.cols - 1);
        return;
      }
      case 'A': this.r = Math.max(this.r - (nums[0] || 1), 0); return;
      case 'B': this.r = Math.min(this.r + (nums[0] || 1), this.rows - 1); return;
      case 'C': this.c = Math.min(this.c + (nums[0] || 1), this.cols - 1); return;
      case 'D': this.c = Math.max(this.c - (nums[0] || 1), 0); return;
      case 'G': this.c = Math.min(Math.max((nums[0] || 1) - 1, 0), this.cols - 1); return;
      case 'J': if ((nums[0] ?? 0) === 2) this.grid = Array.from({ length: this.rows }, () => Array<string>(this.cols).fill('')); return;
      case 'K': if ((nums[0] ?? 0) === 2 || params === '') this.grid[this.r]!.fill(''); return;
      case 'r': {
        this.marginTop = Math.max((nums[0] ?? 1) - 1, 0);
        this.marginBottom = Math.min((nums[1] ?? this.rows) - 1, this.rows - 1);
        return;
      }
      case 'S': { // SU：滚动区上移 n 行
        const n = nums[0] || 1;
        for (let k = 0; k < n; k++) {
          this.grid.splice(this.marginTop, 1);
          this.grid.splice(this.marginBottom, 0, Array<string>(this.cols).fill(''));
        }
        return;
      }
      case 'T': { // SD：滚动区下移 n 行
        const n = nums[0] || 1;
        for (let k = 0; k < n; k++) {
          this.grid.splice(this.marginBottom + 1, 0, Array<string>(this.cols).fill(''));
          this.grid.splice(this.marginTop, 1);
          this.grid.length = this.rows;
        }
        return;
      }
      default: return; // m 等忽略
    }
  }

  /** 去尾空格的纯文本行。 */
  lines(): string[] {
    return this.grid.map((row) => row.join('').replace(/\s+$/u, ''));
  }
}

// ---------- FakeTerminal（沿用 render.test.ts 形态） ----------

class FakeTerminal implements Terminal {
  columns = 100;
  rows = 30;
  readonly writes: string[] = [];
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
  clearFromCursor(): void {}
  clearScreen(): void {}
  setTitle(): void {}
  setProgress(): void {}
  /** 取走自上次以来的新输出。 */
  drain(): string { const s = this.writes.join(''); this.writes.length = 0; return s; }
}

// ---------- 场景驱动 ----------

function linesComp(get: () => string[]): Component {
  return { render: () => get(), invalidate: () => {} } as unknown as Component;
}

const ANSI_RE = /\x1b\[[0-9;?]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[()][0-9A-Z]|\x1b[@-Z\\-]/g;
function strip(s: string): string {
  return s.replace(ANSI_RE, '').replace(/\s+$/u, '');
}

const SPINNER = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

interface ScenarioState {
  transcript: string[];
  frame: number;
  busy: boolean;
  queued: number;
  editorText: string;
  statusBusy: string;
}

interface RunResult {
  divergences: string[];
  suCount: number;
  sdCount: number;
}

/** 跑一个场景：script 每帧改状态，逐帧 doRender 并校验模拟屏与帧模型一致。 */
function runScenario(frames: number, script: (s: ScenarioState, sv: ScrollView) => void): RunResult {
  const term = new FakeTerminal();
  const logDir = mkdtempSync(join(tmpdir(), 'ghost-'));
  const tui = new TuiAltScreen(term, false, logDir);
  tui.beforeTerminalStart();

  const s: ScenarioState = {
    transcript: [],
    frame: 0,
    busy: true,
    queued: 0,
    editorText: '',
    statusBusy: 'busy',
  };
  for (let i = 0; i < 45; i++) s.transcript.push(`转录行 ${i}：一些正文内容，含 CJK 混排 abc ${i}`);

  const activity = linesComp(() => {
    if (!s.busy) return [];
    // 文本 4 帧一变（对齐真实 200ms tick 内多个 16ms 渲染帧共用同一份 activity 文本
    // 的形态）：不变帧里 dock 与上一帧逐字节相同，SU 快路径才有机会被验证通过。
    const tick = Math.floor(s.frame / 4);
    const spin = SPINNER[tick % SPINNER.length];
    return [
      `${spin} 鼓捣中（${Math.floor(tick / 10)}s 无新输出） ${tick * 8}s · ↓ ${tick * 4} tok Esc 中断`,
      `  · 提示： ↑/↓ 回溯输入历史`,
    ];
  });
  const chrome = linesComp(() => {
    if (s.queued === 0) return [];
    return [
      `发送队列（${s.queued} 条，回合结束后按序发送）`,
      `  └ 另外你需要注意下brief里面提到的一些写作的思路比如2. 带上TRAE…`,
      `  ↑ 取回一条 · Esc 中断`,
    ];
  });
  const editor = linesComp(() => [
    `╭────────────────────────────────────────╮`,
    s.editorText === '' ? `│ 思考中…输入将加入发送队列              │` : `│ ${s.editorText}`,
    `╰────────────────────────────────────────╯`,
  ]);
  const status = linesComp(() => [`yolo  Doubao Seed Evolving (300K)  ${s.statusBusy}  queue:${s.queued}`]);

  const transcriptComp = linesComp(() => s.transcript.slice());
  const sv = new ScrollView(transcriptComp, { follow: 'end', primary: true, overscroll: 'chain', scrollbar: 'auto' });
  const root = new VStack([
    { component: sv, basis: 0, grow: 1, shrink: 1 },
    { component: activity, shrink: 1, minSize: 0 },
    { component: chrome, shrink: 1, minSize: 0 },
    { component: editor, shrink: 1, minSize: 3 },
    { component: status, shrink: 1, minSize: 1 },
  ]);
  tui.setLayoutRoot(root);

  const vt = new VtScreen(term.rows, term.columns);
  const anyTui = tui as unknown as { doRender: () => void; previousScreen: string[] };

  const divergences: string[] = [];
  let suCount = 0;
  let sdCount = 0;
  for (s.frame = 0; s.frame < frames; s.frame++) {
    script(s, sv);
    anyTui.doRender();
    const out = term.drain();
    suCount += (out.match(/\x1b\[\d+S/g) ?? []).length;
    sdCount += (out.match(/\x1b\[\d+T/g) ?? []).length;
    vt.feed(out);

    const expected = anyTui.previousScreen.map(strip);
    const actual = vt.lines();
    for (let r = 0; r < expected.length; r++) {
      if (expected[r] !== actual[r]) {
        divergences.push(
          `帧 ${s.frame} 行 ${r}:\n  模型: ${JSON.stringify(expected[r])}\n  屏幕: ${JSON.stringify(actual[r])}`,
        );
        break; // 每帧只记第一处
      }
    }
    if (divergences.length >= 5) break;
  }
  return { divergences, suCount, sdCount };
}

describe('alt-screen 幽灵帧：模拟屏与帧模型逐帧一致', () => {
  it('场景 A：busy 流式 + 队列增删 + busy 切换的 240 帧无脱节', () => {
    const r = runScenario(240, (s) => {
      if (s.frame % 3 === 0) s.transcript.push(`流式新行 ${s.frame}：模型输出 token 流 ${'x'.repeat(s.frame % 40)}`);
      if (s.frame === 60) s.queued = 1;
      if (s.frame === 90) s.queued = 0;
      if (s.frame === 120) { s.busy = false; s.statusBusy = 'ready'; }
      if (s.frame === 150) { s.busy = true; s.statusBusy = 'busy'; }
      if (s.frame === 180) s.editorText = '罢了，调整。';
      if (s.frame === 200) s.queued = 2;
    });
    expect(r.divergences).toEqual([]);
  });

  it('场景 B：逐帧流式（SU 快路径）+ 队列抖动 thumb + 滚轮滚动仍无脱节', () => {
    const r = runScenario(300, (s, sv) => {
      // 每帧追加：转录区每帧都在滚，最大化 SU 快路径命中
      s.transcript.push(`流式新行 ${s.frame}：token ${'y'.repeat(s.frame % 30)}`);
      // 队列与转录滚动同帧增删：dock 高度变 → thumb 移动与内容平移同帧发生
      if (s.frame === 80) s.queued = 1;
      if (s.frame === 120) s.queued = 0;
      if (s.frame === 160) s.queued = 3;
      if (s.frame === 200) s.queued = 0;
      // 滚轮：上翻 5 行看历史，再下翻回跟随位
      if (s.frame === 230) sv.scrollBy(-5);
      if (s.frame === 240) sv.scrollBy(-3);
      if (s.frame === 250) sv.scrollBy(8);
      if (s.frame === 270) s.editorText = '用户输入了一行字';
    });
    // 快路径必须真的触发过，否则「无脱节」是没跑到的假绿
    expect(r.suCount + r.sdCount).toBeGreaterThan(0);
    expect(r.divergences).toEqual([]);
  });
});
