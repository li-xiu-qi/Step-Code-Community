/**
 * sixel 缩略图渲染链路的进程内测试（真 PiChat + 真 TuiAltScreen 写路径）。
 *
 * 2026-09-29 修的两个缺陷，都有真机截图与进程内实测支撑：
 *
 * 缺陷一（图被擦成一条）：缩略图早期是「首行放整图序列 + 后面 N-1 行空占位」。库层
 * doRender 的 imagesNeedRedraw 分支会在图片行的屏幕行号位移时，把**所有行**重写一遍
 * （含占位行），每行都以 `\x1b[2K` 开头。WT 的 sixel 像素附着在字符格上，EL 会连格内
 * 像素一起销毁（WT PR #18855）。于是先画出的整图被随后写入的占位行逐行擦掉，只剩第一行。
 * 修法：每行一条只画自己那 18px 的序列，行间无共享像素。
 *
 * 缺陷二（序列被截断）：库层 extractAnsiCode 只认 CSI/OSC/APC，**不认 DCS**。于是
 * visibleWidth 把 sixel 载荷当成可见字符，一条 1794 字节的缩略图序列算出约 1500 列宽；
 * Transcript.render 对尾块做的 safeTail 一截，1794 字节变 113 字节，序列缺 ST 结尾。
 * 图片块刚从 read_media 落盘时正是尾块，所以新图必残。修法：截断前先过
 * isImageSequenceLine。
 *
 * 两个缺陷互相触发：图在尾块时被截残，新块到来后图挪进前缀、行内容变化点亮
 * imagesNeedRedraw，旧占位设计下就被擦成一条。这就是「时而正常时而塌成一条」的来源。
 *
 * 探针验证（dev-verification 第 1 节）：把 renderSixel 改回「首行整图 + 空占位」，
 * 或把 Transcript.render 的 safeTail 去掉 isImageSequenceLine 判定，本文件断言必须报红。
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deflateSync } from 'node:zlib';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Terminal } from '@earendil-works/pi-tui';
import { PiChat } from '../../src/tui-pi/PiChat.js';
import { SessionStore } from '../../src/session/store.js';
import type { DisplayItem } from '../../src/chat/types.js';

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf: Buffer): number {
  let c = -1;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff]! ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

/**
 * 现场生成一张 width×height 的 8bit RGB PNG。测试图要 multi-row：8x6 那种小图
 * scale=1、pxH=6，只占一行，没有第二行可验。400x300 缩到 22 格后 pxH=150，占 9 行。
 */
function makePng(width: number, height: number): string {
  const raw = Buffer.alloc(height * (width * 3 + 1));
  let p = 0;
  for (let y = 0; y < height; y++) {
    raw[p++] = 0; // filter: none
    for (let x = 0; x < width; x++) {
      raw[p++] = (x * 255) / Math.max(1, width - 1);
      raw[p++] = (y * 255) / Math.max(1, height - 1);
      raw[p++] = (x + y) % 16 === 0 ? 255 : 40;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // color type: truecolor
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]).toString('base64');
}

const BIG_PNG_B64 = makePng(400, 300);

/** sixel DCS 引导段（与库层 isImageLine 用的是同一个前缀）。 */
const SIXEL_PREFIX = '\x1bP';
/** sixel ST 结束符：序列完整与否的判据。 */
const ST = '\x1b\\';

class FakeTerminal implements Terminal {
  columns = 100;
  rows = 40;
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
  send(data: string): void { this.onInput?.(data); }
  allOutput(): string { return this.writes.join(''); }
}

/**
 * 把一帧的写入拆成「屏幕行号 -> 该行写出的内容」。
 * 库层每行写 `\x1b[<row>;1H\x1b[2K<内容>`，连续行用 `\r\n` 跟进（升序书写）。
 */
function frameRows(frame: string): Map<number, string> {
  const out = new Map<number, string>();
  let cursor = -1;
  const marks: { at: number; len: number; abs?: number }[] = [];
  const re = /\x1b\[(\d+);1H|\r\n/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(frame)) !== null) {
    marks.push({ at: m.index, len: m[0].length, abs: m[1] !== undefined ? Number(m[1]) - 1 : undefined });
  }
  for (let i = 0; i < marks.length; i++) {
    const mark = marks[i]!;
    cursor = mark.abs ?? cursor + 1;
    const end = i + 1 < marks.length ? marks[i + 1]!.at : frame.length;
    out.set(cursor, frame.slice(mark.at + mark.len, end));
  }
  return out;
}

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

async function makeChat(): Promise<{ chat: PiChat; term: FakeTerminal; cleanup: () => Promise<void> }> {
  const dir = mkdtempSync(join(tmpdir(), 'sixelrow-'));
  const store = new SessionStore(dir);
  const term = new FakeTerminal();
  const chat = new PiChat({
    provider: {} as never,
    systemPrefix: '',
    agentsMd: '',
    skillsRef: { current: [] as never },
    subagentRegistry: new Map(),
    reloadSkills: () => {},
    ctx: { cwd: dir, capabilities: ['image_in'] } as never,
    model: 'test-model',
    config: { provider: 'test', tui: {}, compaction: {} } as never,
    initialMode: 'manual',
    store,
    session: {
      id: 'sixel-row',
      cwd: dir,
      messages: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    } as never,
    goalStore: undefined,
    maxContextSize: 100_000,
    hookEngineRef: { current: undefined },
    subagentStore: undefined as never,
  });
  void chat.start();
  await new Promise<void>((r) => setTimeout(r, 50));
  const tuiAny = chat as unknown as { tui: { terminal: Terminal; handleTerminalInput: (d: string) => void } };
  tuiAny.tui.terminal = term;
  term.start((data) => tuiAny.tui.handleTerminalInput(data));
  return { chat, term, cleanup: async () => { rmSync(dir, { recursive: true, force: true }); } };
}

function render(chat: PiChat, force: boolean): void {
  const tui = chat as unknown as { tui: { requestRender: () => void; renderNow: (f: boolean) => void } };
  tui.tui.requestRender();
  tui.tui.renderNow(force);
}

interface ChatInternals {
  transcript: { push: (i: DisplayItem) => void; imageRegions: () => { startRow: number; spanRows: number }[] };
  transcriptScrollView?: { scrollTop: number };
}

const TOOL_WITH_IMAGE: DisplayItem = {
  kind: 'tool',
  id: 't1',
  name: 'read_media',
  status: 'ok',
  result: '（图）',
  images: [{ mediaType: 'image/png', base64: BIG_PNG_B64 }],
} as DisplayItem;

describe('sixel 缩略图渲染链路', () => {
  let h: Awaited<ReturnType<typeof makeChat>> | undefined;
  const prevProtocol = process.env.STEP_CODE_IMAGE_PROTOCOL;

  beforeEach(async () => {
    process.env.STEP_CODE_IMAGE_PROTOCOL = 'sixel';
    h = await makeChat();
  });
  afterEach(async () => {
    await h?.cleanup();
    h = undefined;
    if (prevProtocol === undefined) delete process.env.STEP_CODE_IMAGE_PROTOCOL;
    else process.env.STEP_CODE_IMAGE_PROTOCOL = prevProtocol;
  });

  it('尾块里的图片行不被宽度截断，每行都是完整序列（有 ST 结尾）', async () => {
    const { chat, term } = h!;
    const t = chat as unknown as ChatInternals;

    t.transcript.push({ kind: 'note', text: 'above' } as DisplayItem);
    t.transcript.push(TOOL_WITH_IMAGE); // 图片块此刻就是尾块
    render(chat, true);
    await tick();

    const regions = t.transcript.imageRegions();
    expect(regions.length).toBe(1);
    const spanRows = regions[0]!.spanRows;
    const scrollTop = t.transcriptScrollView?.scrollTop ?? 0;
    const imgScreenRow = regions[0]!.startRow - scrollTop;
    expect(spanRows).toBeGreaterThan(1); // 多行图才验得住

    const rows = frameRows(term.allOutput());
    const bad: number[] = [];
    for (let r = imgScreenRow; r < imgScreenRow + spanRows; r++) {
      const content = rows.get(r);
      if (content === undefined || !content.includes(SIXEL_PREFIX) || !content.includes(ST)) bad.push(r);
    }
    expect(
      bad,
      `这些图片行被 safeTail 截断了（屏幕行 ${imgScreenRow}..${imgScreenRow + spanRows - 1}），` +
        '序列缺 ST 结尾，WT 解析不出完整图',
    ).toEqual([]);
  }, 20000);

  it('滚动触发 imagesNeedRedraw 全屏重写时，图片跨的每一行都自带序列', async () => {
    const { chat, term } = h!;
    // 小视口 + 足够多的内容，才滚得动；滚动是真实会话里最高频的触发器
    term.rows = 24;
    const t = chat as unknown as ChatInternals & {
      transcriptScrollView?: { scrollBy: (n: number) => number; scrollTop: number; viewportHeight: number };
    };
    for (let i = 0; i < 30; i++) {
      t.transcript.push({ kind: 'note', text: `pad-${i}` } as DisplayItem);
    }
    t.transcript.push(TOOL_WITH_IMAGE);
    render(chat, true);
    await tick();

    const region = t.transcript.imageRegions()[0]!;
    const startRow = region.startRow;
    const spanRows = region.spanRows;
    const scrollTop0 = t.transcriptScrollView?.scrollTop ?? 0;
    expect(startRow - scrollTop0).toBeGreaterThanOrEqual(0); // 图在视口内

    // 往上滚一行：图片行的屏幕行号位移，点亮库层 imagesNeedRedraw（非 fullRedraw），
    // 屏幕所有行被重写一遍。这一帧正是旧实现把图擦成一条的场合。
    term.writes.length = 0;
    t.transcriptScrollView?.scrollBy(-1);
    render(chat, false);
    await tick();

    const scrollTop1 = t.transcriptScrollView?.scrollTop ?? 0;
    expect(scrollTop1).toBeLessThan(scrollTop0); // 确实滚动了
    const row1 = Math.max(0, startRow - scrollTop1);
    // 只验视口内的行：图片底部可能伸进 dock 区，那些行本来就不该被写
    const vh = t.transcriptScrollView?.viewportHeight ?? term.rows;
    const rowEnd = Math.min(row1 + spanRows, vh);
    const rows = frameRows(term.allOutput());
    const missing: number[] = [];
    for (let r = row1; r < rowEnd; r++) {
      const content = rows.get(r);
      if (content === undefined || !content.includes(SIXEL_PREFIX)) missing.push(r);
    }
    expect(
      missing,
      `滚动后这些图片行被重写但不含序列（屏幕行 ${row1}..${rowEnd - 1}，视口 ${vh} 行）。` +
        '空占位行被 [2K 重写时，WT 上就把图擦到只剩第一行',
    ).toEqual([]);
  }, 20000);

  it('对照组：内容不变时不重画序列（不会每帧吐 N 条序列）', async () => {
    const { chat, term } = h!;
    const t = chat as unknown as ChatInternals;
    t.transcript.push({ kind: 'note', text: 'above' } as DisplayItem);
    t.transcript.push(TOOL_WITH_IMAGE);
    render(chat, true);
    await tick();

    term.writes.length = 0;
    render(chat, false);
    await tick();
    // 无变化帧：上一帧内容逐行相同，库层跳过未变行，不该出现任何序列
    expect(term.allOutput()).not.toContain(SIXEL_PREFIX);
  }, 20000);
});
