/**
 * 图片预览浮层：点击转录区里的图片后打开，居中卡片 + 缩放 + 平移。
 *
 * 交互设计（对标实现）：Esc/q 或点击卡片外关闭；0 适配、1/2/4/8 直达缩放档、
 * +/- 升降档；方向键与 hjkl 平移；工具栏按钮可点（鼠标按行列命中）；滚轮上下
 * 平移、拖拽平移。zoom>0 时先裁原图再最近邻放大（见 imageInspection.ts），
 * 每个源像素是实心块，看代码截图时分毫毕现。
 *
 * 与基于布局树的框架（点击处理器挂节点、布局层算命中）不同，本方是 string[] 渲染：
 * 卡片几何由 render 现算并登记（工具栏行号与按钮列区间），handleMouse 按同一函数
 * 的产出做命中，保证「画的」与「点的」永远一致。
 */
import { matchesKey, truncateToWidth, visibleWidth, type Component } from '@earendil-works/pi-tui';
import { ImageBlock, type DecodedImage } from './imageBlock.js';
import {
  clampCenter,
  cropAndScale,
  inspectionRegion,
  previewViewportPx,
  PREVIEW_ZOOM_LEVELS,
  type PreviewZoom,
} from './imageInspection.js';
import { parseSGRMouse } from './mouseEvents.js';
import { c } from './theme.js';

export interface PreviewImageMeta {
  readonly mediaType: string;
  readonly width: number;
  readonly height: number;
  readonly bytes: number;
  readonly name?: string;
}

/** 卡片固定 chrome：上边框 + 下边框 + 工具栏 + 图片上下各一空行。 */
const CARD_CHROME_ROWS = 5;
const CARD_CHROME_COLS = 4;
const MIN_CARD_COLS = 40;
/** 小于这个尺寸终端不弹预览（卡片放不下）：调用方应拦住。 */
export const PREVIEW_MIN_WIDTH = 50;
export const PREVIEW_MIN_HEIGHT = 16;

interface ToolbarButton {
  readonly label: string;
  readonly title: string;
  readonly startCol: number;
  readonly endCol: number;
  readonly run: () => void;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export class ImagePreviewOverlay implements Component {
  private zoom: PreviewZoom = 0;
  private center: { x: number; y: number };
  /** 最近一次 render 的工具栏行号（0-based，含补头空行）；-1 = 未渲染。 */
  private toolbarRow = -1;
  /** 最近一次 render 的工具栏按钮列区间（与画的同一来源）。 */
  private buttons: readonly ToolbarButton[] = [];
  /** 拖拽起点（press 时的行列与中心），drag 序列按位移累计。 */
  private dragFrom: { col: number; row: number; cx: number; cy: number } | null = null;

  private readonly image: DecodedImage;
  private readonly meta: PreviewImageMeta;
  private readonly close: () => void;
  private readonly requestRender: () => void;

  /**
   * Component 接口要求。预览内容是外部图片，没有内部缓存可失效：
   * zoom/center 每帧从状态现算，父容器重新渲染时天然拿到新值。
   */
  invalidate(): void {}

  constructor(opts: {
    image: DecodedImage;
    meta: PreviewImageMeta;
    close: () => void;
    requestRender: () => void;
  }) {
    this.image = opts.image;
    this.meta = opts.meta;
    this.close = opts.close;
    this.requestRender = opts.requestRender;
    this.center = { x: opts.image.width / 2, y: opts.image.height / 2 };
  }

  handleInput(data: string): void {
    const mouse = parseSGRMouse(data);
    if (mouse !== undefined) {
      this.handleMouse(mouse);
      return;
    }
    if (matchesKey(data, 'escape') || data === 'q') {
      this.close();
      return;
    }
    if (data === '0') this.setZoom(0);
    else if (data === '1' || data === '2' || data === '4' || data === '8') this.setZoom(Number(data) as PreviewZoom);
    else if (data === '+' || data === '=') this.setZoom(this.zoom === 0 ? 1 : Math.min(8, this.zoom * 2) as PreviewZoom);
    else if (data === '-' || data === '_') this.setZoom(this.zoom === 0 ? 0 : Math.max(1, this.zoom / 2) as PreviewZoom);
    else if (matchesKey(data, 'left') || data === 'h') this.pan(-1, 0);
    else if (matchesKey(data, 'right') || data === 'l') this.pan(1, 0);
    else if (matchesKey(data, 'up') || data === 'k') this.pan(0, -1);
    else if (matchesKey(data, 'down') || data === 'j') this.pan(0, 1);
    this.requestRender();
  }

  /** 鼠标交互：工具栏点击、滚轮平移、拖拽平移、点卡片外关闭。 */
  handleMouse(ev: ReturnType<typeof parseSGRMouse>): void {
    if (ev === undefined) return;
    if (ev.kind === 'wheel') {
      // 滚轮只平移不缩放：缩放档位是显式操作，滚轮误触改缩放比误触平移更难恢复
      if (ev.button === 4) this.pan(0, -1);
      if (ev.button === 5) this.pan(0, 1);
      this.requestRender();
      return;
    }
    if (ev.kind === 'press') {
      // 工具栏命中：行对得上、列落在按钮区间内
      if (ev.row === this.toolbarRow) {
        const btn = this.buttons.find((b) => ev.col >= b.startCol && ev.col < b.endCol);
        if (btn !== undefined) {
          btn.run();
          this.requestRender();
          return;
        }
      }
      // 拖拽起点记录（图片区内）
      this.dragFrom = { col: ev.col, row: ev.row, cx: this.center.x, cy: this.center.y };
      return;
    }
    if (ev.kind === 'drag' && this.dragFrom !== null && this.zoom > 0) {
      // 位移按「格 → 像素 / zoom」换算：拖动 1 格 = 视口移动 1 格像素
      const viewport = previewViewportPx(1, 1);
      const dx = (ev.col - this.dragFrom.col) * viewport.width / this.zoom;
      const dy = (ev.row - this.dragFrom.row) * viewport.height / this.zoom;
      this.center = clampCenter(this.image, previewViewportPx(this.imageCols, this.imageRows), this.zoom,
        { x: this.dragFrom.cx - dx, y: this.dragFrom.cy - dy });
      this.requestRender();
      return;
    }
    if (ev.kind === 'release') {
      // 单击（press 与 release 同行列同按钮）= 点卡片外关闭
      if (this.dragFrom !== null && this.dragFrom.col === ev.col && this.dragFrom.row === ev.row) {
        if (ev.row !== this.toolbarRow) this.close();
      }
      this.dragFrom = null;
    }
  }

  /** 当前预览区格数（render 与拖拽换算共用，render 后有效）。 */
  private imageCols = 60;
  private imageRows = 20;

  private setZoom(next: PreviewZoom): void {
    if (next === this.zoom) return;
    this.zoom = next;
    if (next === 0) return;
    // zoom 切换后中心钳回新区域（视口变小，旧中心可能越界）
    this.center = clampCenter(this.image, previewViewportPx(this.imageCols, this.imageRows), next, this.center);
  }

  /** 平移一帧（视口的四分之一），zoom=0（适配）时不可平移。 */
  private pan(dx: number, dy: number): void {
    if (this.zoom === 0) return;
    const viewport = previewViewportPx(this.imageCols, this.imageRows);
    this.center = clampCenter(this.image, viewport, this.zoom, {
      x: this.center.x + (dx * viewport.width) / 4,
      y: this.center.y + (dy * viewport.height) / 4,
    });
  }

  /** 图片区格数：zoom=0 按图适配，zoom>0 用卡片内可用格数（裁剪填充）。 */
  private computeImageCells(cardCols: number, cardRows: number, totalRows: number): { cols: number; rows: number } {
    const availCols = Math.max(1, Math.min(cardCols - CARD_CHROME_COLS, totalRows === 0 ? 0 : Number.MAX_SAFE_INTEGER));
    const availRows = Math.max(1, cardRows - CARD_CHROME_ROWS);
    if (this.zoom === 0) {
      // fit：按图宽高比换算（cell 9×18，ratio = h/w * 18/9 = h/(2w)）
      const ratio = Math.max(0.1, Math.min(10, this.image.height / Math.max(1, this.image.width)));
      let cols = availCols;
      let rows = Math.max(1, Math.round(cols / (2 * ratio)));
      if (rows > availRows) {
        rows = availRows;
        cols = Math.max(1, Math.min(availCols, Math.round(2 * rows * ratio)));
      }
      return { cols, rows };
    }
    return { cols: availCols, rows: availRows };
  }

  render(width: number): string[] {
    return this.renderAt(width, PREVIEW_MIN_HEIGHT);
  }

  /** 按给定总行数渲染（overlay 拿到的就是视口行数；测试可直接给行数）。 */
  renderAt(width: number, totalRows: number): string[] {
    const cardCols = Math.max(MIN_CARD_COLS, Math.min(width, Math.max(MIN_CARD_COLS, Math.floor(width * 0.95))));
    const cardRows = Math.max(6, Math.min(totalRows, Math.max(6, Math.floor(totalRows * 0.95))));
    const { cols, rows } = this.computeImageCells(cardCols, cardRows, totalRows);
    this.imageCols = cols;
    this.imageRows = rows;

    // 图片行：zoom=0 整图 fit；zoom>0 裁剪 + 最近邻放大到区满
    const imageLines = this.zoom === 0
      ? new ImageBlock(this.image, cols).render(cols)
      : new ImageBlock(
          cropAndScale(this.image, inspectionRegion(this.image, previewViewportPx(cols, rows), this.zoom, this.center), cols * 9, rows * 18),
          cols,
        ).render(cols);

    const title = `${this.meta.mediaType.replace(/^image\//u, '').toUpperCase()} · ${this.meta.width}×${this.meta.height} · ${formatBytes(this.meta.bytes)}${this.zoom === 0 ? '' : ` · ${this.zoom * 100}%`}${this.meta.name !== undefined && this.meta.name !== '' ? ` · ${this.meta.name}` : ''}`;
    const topBorder = borderTitleRow(title, cardCols);
    const toolbar = this.buildToolbar(cardCols);

    // 组装卡片行
    const card: string[] = [topBorder, ''];
    for (const l of imageLines) card.push(this.frameImageLine(l, cardCols));
    card.push('');
    card.push(toolbar.text);
    card.push('╰' + '─'.repeat(Math.max(0, cardCols - 2)) + '╯');
    // 工具栏在卡片内的行号（卡片从 topPad 开始）
    const toolbarRowInCard = 2 + imageLines.length + 1;

    const topPad = Math.max(0, Math.floor((totalRows - card.length) / 2));
    const leftPad = Math.max(0, Math.floor((width - cardCols) / 2));
    const pad = ' '.repeat(leftPad);
    const out: string[] = [];
    for (let i = 0; i < topPad; i++) out.push('');
    for (const line of card) out.push(pad + line);
    while (out.length < totalRows) out.push('');
    this.toolbarRow = topPad + toolbarRowInCard;
    this.buttons = toolbar.buttons.map((b) => ({ ...b, startCol: b.startCol + leftPad, endCol: b.endCol + leftPad }));
    return out;
  }

  /** 图片行进卡片边框：序列行不可截断（截了 WT 画黑块），按原宽放。 */
  private frameImageLine(line: string, cardCols: number): string {
    const w = visibleWidth(line);
    if (w + CARD_CHROME_COLS <= cardCols) return `│ ${line} │`;
    // 超宽（不可能：图片区格数按卡片算的）——兜底截断防宽度守卫
    return `│ ${truncateToWidth(line, cardCols - CARD_CHROME_COLS)} │`;
  }

  /** 工具栏：画的与点的同一份数据。 */
  private buildToolbar(cardCols: number): { text: string; buttons: ToolbarButton[] } {
    const mk = (label: string, title: string, run: () => void) => ({ label, title, run });
    const defs = [
      mk('适配', '整图放入预览区', () => this.setZoom(0)),
      mk('100%', '原始像素 1:1', () => this.setZoom(1)),
      mk('+', '放大', () => this.setZoom(this.zoom === 0 ? 1 : Math.min(8, this.zoom * 2) as PreviewZoom)),
      mk('-', '缩小', () => this.setZoom(this.zoom === 0 ? 0 : Math.max(1, this.zoom / 2) as PreviewZoom)),
      mk('←', '左移', () => this.pan(-1, 0)),
      mk('↑', '上移', () => this.pan(0, -1)),
      mk('↓', '下移', () => this.pan(0, 1)),
      mk('→', '右移', () => this.pan(1, 0)),
      mk('Esc', '关闭预览', () => this.close()),
    ];
    const buttons: ToolbarButton[] = [];
    let col = 0;
    let text = '';
    for (const d of defs) {
      const cell = `[${d.label}]`;
      buttons.push({ ...d, startCol: col, endCol: col + cell.length });
      const active = d.label === '100%' ? this.zoom === 1 : d.label === '适配' ? this.zoom === 0 : false;
      text += active ? c.bold(cell) : cell;
      col += cell.length;
    }
    // 居中
    const pad = Math.max(0, Math.floor((cardCols - CARD_CHROME_COLS - col) / 2));
    const shifted = buttons.map((b) => ({ ...b, startCol: b.startCol + pad + 2, endCol: b.endCol + pad + 2 }));
    return { text: `│ ${' '.repeat(pad)}${text}${' '.repeat(Math.max(0, cardCols - CARD_CHROME_COLS - pad - col))} │`, buttons: shifted };
  }
}

/** `╭─── title ───╮`，标题已由调用方备好。 */
function borderTitleRow(title: string, cardCols: number): string {
  if (cardCols < 2) return cardCols === 1 ? '╭' : '';
  const inner = Math.max(0, cardCols - 2);
  const text = truncateToWidth(title, Math.max(0, inner - 4));
  const labelled = text === '' ? '' : ` ${text} `;
  const fill = Math.max(0, inner - visibleWidth(labelled));
  const left = Math.floor(fill / 2);
  return `╭${'─'.repeat(left)}${labelled}${'─'.repeat(fill - left)}╮`;
}

export { PREVIEW_ZOOM_LEVELS };
