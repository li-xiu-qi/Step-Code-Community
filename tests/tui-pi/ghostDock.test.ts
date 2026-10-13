/**
 * 底部 dock 区域幽灵行回归测试：真实 ActivityLine + 真实 ChromePanels + 变高编辑器。
 *
 * 与 ghostFrame.test.ts 的区别：那里用固定行数的假组件，dock 高度变化形状单一；
 * 这里 activity 行数在 0/1/2/4 间跳（thinking 预览 1-3 行）、队列 0→3 条、
 * 编辑器 3→5 行（多行输入/footer 行出现消失），并叠加矮终端超高 dock 的裁剪形态，
 * 贴近真机报告的「底部区域残留幽灵行」现场。
 *
 * 结论记录（2026-10-13 取证）：这些形态下帧模型与迷你终端模拟屏逐帧一致，
 * 差分渲染路径（布局 → 全屏重算 → 逐行 diff / SU-SD 快路径）在 dock 抖动下无脱节。
 * 真机幽灵行的残留源是帧模型之外的物理层（ConPTY 丢字节、终端吞序列、帧外直写），
 * 修复面在 consoleGuard（92dd073）与周期/回合边界全量自愈，本测试钉住「模型侧无罪」
 * 这一前提，防止将来有人往组件/渲染层误加规避代码。
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  Container,
  ScrollView,
  TuiAltScreen,
  VStack,
  visibleWidth,
  type Component,
  type Terminal,
} from '@earendil-works/pi-tui';
import { ActivityLine } from '../../src/tui-pi/StatusLine.js';
import { ChromePanels } from '../../src/tui-pi/ChromePanels.js';

// ---------- 迷你终端模拟器（与 ghostFrame.test.ts 同款） ----------
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
    if (privateMode) return;
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
      case 'G': this.c = Math.min(Math.max((nums[0] ?? 1) - 1, 0), this.cols - 1); return;
      case 'J': if ((nums[0] ?? 0) === 2) this.grid = Array.from({ length: this.rows }, () => Array<string>(this.cols).fill('')); return;
      case 'K': if ((nums[0] ?? 0) === 2 || params === '') this.grid[this.r]!.fill(''); return;
      case 'r': {
        this.marginTop = Math.max((nums[0] ?? 1) - 1, 0);
        this.marginBottom = Math.min((nums[1] ?? this.rows) - 1, this.rows - 1);
        return;
      }
      case 'S': {
        const n = nums[0] || 1;
        for (let k = 0; k < n; k++) {
          this.grid.splice(this.marginTop, 1);
          this.grid.splice(this.marginBottom, 0, Array<string>(this.cols).fill(''));
        }
        return;
      }
      case 'T': {
        const n = nums[0] || 1;
        for (let k = 0; k < n; k++) {
          this.grid.splice(this.marginBottom + 1, 0, Array<string>(this.cols).fill(''));
          this.grid.splice(this.marginTop, 1);
          this.grid.length = this.rows;
        }
        return;
      }
      default: return;
    }
  }

  lines(): string[] {
    return this.grid.map((row) => row.join('').replace(/\s+$/u, ''));
  }
}

class FakeTerminal implements Terminal {
  columns = 100;
  rows = 30;
  constructor(rows = 30, columns = 100) {
    this.rows = rows;
    this.columns = columns;
  }
  readonly writes: string[] = [];
  kittyProtocolActive = false;
  start(): void {}
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
  drain(): string { const s = this.writes.join(''); this.writes.length = 0; return s; }
}

const ANSI_RE = /\x1b\[[0-9;?]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[()][0-9A-Z]|\x1b[@-Z\\-]/g;
function strip(s: string): string {
  return s.replace(ANSI_RE, '').replace(/\s+$/u, '');
}

function linesComp(get: () => string[]): Component {
  return { render: () => get(), invalidate: () => {} } as unknown as Component;
}

interface ScenarioState {
  transcript: string[];
  frame: number;
  editorLines: number; // 编辑器内容行数（多行输入 + footer）
}

/** 用真实组件跑场景：script 每帧改状态，逐帧 doRender 校验一致。 */
function runRealScenario(frames: number, script: (s: ScenarioState, act: ActivityLine, chrome: ChromePanels, sv: ScrollView) => void, termRows = 30) {
  const term = new FakeTerminal(termRows);
  const logDir = mkdtempSync(join(tmpdir(), 'ghostdock-'));
  const tui = new TuiAltScreen(term, false, logDir);
  tui.beforeTerminalStart();

  const s: ScenarioState = { transcript: [], frame: 0, editorLines: 3 };
  for (let i = 0; i < 45; i++) s.transcript.push(`转录行 ${i}：正文内容 CJK 混排 abc ${i}`);

  const activity = new ActivityLine();
  const chrome = new ChromePanels();
  const inputSlot = new Container();
  const editor = linesComp(() => {
    const out = [`╭${'─'.repeat(40)}╮`];
    for (let i = 0; i < s.editorLines - 2; i++) out.push(`│ 内容行 ${i + 1}${' '.repeat(30)}│`);
    out.push(`╰${'─'.repeat(40)}╯`);
    return out;
  });
  inputSlot.addChild(editor);
  const status = linesComp(() => [`yolo  Model  busy  queue:${chrome ? '' : ''}`]);

  const transcriptComp = linesComp(() => s.transcript.slice());
  const sv = new ScrollView(transcriptComp, { follow: 'end', primary: true, overscroll: 'chain', scrollbar: 'auto' });
  tui.setLayoutRoot(new VStack([
    { component: sv, basis: 0, grow: 1, shrink: 1 },
    { component: activity, shrink: 1, minSize: 0 },
    { component: chrome, shrink: 1, minSize: 0 },
    { component: inputSlot, shrink: 1, minSize: 3 },
    { component: status, shrink: 1, minSize: 1 },
  ]));

  const vt = new VtScreen(term.rows, term.columns);
  const anyTui = tui as unknown as { doRender: () => void; previousScreen: string[] };

  const divergences: string[] = [];
  let suCount = 0;
  let sdCount = 0;
  for (s.frame = 0; s.frame < frames; s.frame++) {
    script(s, activity, chrome, sv);
    anyTui.doRender();
    const out = term.drain();
    suCount += (out.match(/\x1b\[\d+S/g) ?? []).length;
    sdCount += (out.match(/\x1b\[\d+T/g) ?? []).length;
    vt.feed(out);
    const expected = anyTui.previousScreen.map(strip);
    const actual = vt.lines();
    for (let r = 0; r < expected.length; r++) {
      if (expected[r] !== actual[r]) {
        divergences.push(`帧 ${s.frame} 行 ${r}:\n  模型: ${JSON.stringify(expected[r])}\n  屏幕: ${JSON.stringify(actual[r])}`);
        break;
      }
    }
    if (divergences.length >= 5) break;
  }
  return { divergences, suCount, sdCount };
}

describe('真实组件 dock 抖动：模拟屏与帧模型一致', () => {
  it('thinking 预览 0/1/2/4 行抖动 + 队列增删 + 编辑器变高', () => {
    const r = runRealScenario(300, (s, act, chrome, sv) => {
      // 每帧流式追加：SU 快路径高频命中
      s.transcript.push(`流式新行 ${s.frame}：token ${'y'.repeat(s.frame % 30)}`);
      if (s.frame === 10) act.setBusy(true);
      if (s.frame === 30) act.setThinking(true, '第一段思考：正在分析问题，先列出候选方案……');
      if (s.frame === 60) act.setThinking(true, '第一段思考：正在分析问题，先列出候选方案……\n第二段思考：方案 A 与方案 B 对比，B 更稳妥……\n第三段思考：决定采用 B，开始实现……\n第四段：补充更多细节让预览占满三行……');
      if (s.frame === 90) chrome.setQueue(['队列第一条：另外你需要注意下 brief 里的思路', '队列第二条']);
      if (s.frame === 120) act.setThinking(false, '');
      if (s.frame === 150) chrome.setQueue([]);
      if (s.frame === 180) s.editorLines = 5;
      if (s.frame === 210) s.editorLines = 3;
      if (s.frame === 230) sv.scrollBy(-5);
      if (s.frame === 240) sv.scrollBy(5);
      if (s.frame === 260) { act.setBusy(false); chrome.setQueue(['收尾前再排一条']); }
      if (s.frame === 280) chrome.setQueue([]);
    });
    expect(r.suCount + r.sdCount).toBeGreaterThan(0);
    expect(r.divergences).toEqual([]);
  });

  it('矮终端超高 dock：子组件被布局裁剪（超行丢弃）期间模型与屏幕仍一致', () => {
    // 终端只有 14 行：activity 4 + queue 面板 5 + editor 3 + status 1 = 13 行 dock，
    // 转录区被压到 1 行；activity/chrome 超行被 lineOffset 裁剪。裁剪边界抖动
    // （预览行数变、队列增删、编辑器变高）是最容易残留幽灵行的形态。
    const r = runRealScenario(200, (s, act, chrome) => {
      s.transcript.push(`流式新行 ${s.frame}`);
      if (s.frame === 10) act.setBusy(true);
      if (s.frame === 30) act.setThinking(true, '甲：第一段思考内容，分析当前局面的关键点……\n乙：第二段思考，方案对比与取舍……\n丙：第三段，决定与实施步骤……\n丁：第四段，补充细节占满预览行……');
      if (s.frame === 70) chrome.setQueue(['队列第一条内容比较长会占一行', '第二条', '第三条']);
      if (s.frame === 100) act.setThinking(true, '只剩一段短思考。');
      if (s.frame === 120) chrome.setQueue([]);
      if (s.frame === 140) s.editorLines = 5;
      if (s.frame === 160) { act.setBusy(false); s.editorLines = 3; }
      if (s.frame === 180) chrome.setQueue(['收尾再排一条']);
    }, 14);
    expect(r.divergences).toEqual([]);
  });
});
