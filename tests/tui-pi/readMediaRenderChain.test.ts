/**
 * read_media 工具图 → 转录区渲染链路自测（2026-09-28 真机「[图片无法渲染]」的回归网）。
 *
 * 链路与断点：readMedia 交付的图在 offloadMedia 里被换成 stepref:<hash> 附件仓指针
 * （内存只持指针是附件仓的设计），事件流把指针透传到 tool_end；UI 层若不还原，
 * decodePNG 拿「stepref:...」这串文本去解 PNG 必然失败，转录区显示降级行、预览
 * 点不开。本文件在进程内闭合这条链：read_media 真实执行 → offload 成指针 →
 * rehydrateToolImages 还原 → decodePNG → ItemBlock 出 sixel 序列行 → 区域表命中。
 * 不经过真终端，钉住的是应用侧行为（WT 的终解释仍属真机项）。
 */
import { randomFillSync } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Jimp } from 'jimp';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { executeTool } from '../../src/tools/index.js';
import { AttachmentStore } from '../../src/session/attachments.js';
import { decodePNG, rehydrateToolImages } from '../../src/tui-pi/imageBlock.js';
import { ItemBlock } from '../../src/tui-pi/blocks.js';
import { Transcript } from '../../src/tui-pi/Transcript.js';
import type { DisplayItem } from '../../src/chat/types.js';
import type { ToolContext } from '../../src/tools/types.js';

let dir: string;
let sessionsDir: string;
let ctx: ToolContext;

async function noisePng(width: number, height: number, name: string): Promise<string> {
  const img = new Jimp({ width, height, color: 0x000000ff });
  randomFillSync(img.bitmap.data as Buffer);
  writeFileSync(join(dir, name), await img.getBuffer('image/png'));
  return name;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'stepcode-chain-'));
  sessionsDir = mkdtempSync(join(tmpdir(), 'stepcode-chain-sessions-'));
  ctx = { cwd: dir, capabilities: ['image_in'] };
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  rmSync(sessionsDir, { recursive: true, force: true });
});

describe('read_media → UI 渲染链路', () => {
  it('降采样交付图经 offload→rehydrate 后 UI 可解码（stepref 指针还原）', async () => {
    // 600×400 噪声图必超 256KB 预算 → 走 jimp 重编码降采样路径（真机那张的同一条）
    const name = await noisePng(600, 400, 'big.png');
    const result = await executeTool('read_media', { path: name }, ctx);
    expect(result.isError).toBe(false);
    const delivered = result.images![0]!;

    // 模拟 offloadMedia：附件仓把 base64 换成指针（大图必走这条）
    const store = new AttachmentStore(sessionsDir);
    const stepref = store.offload(dir, delivered.base64, delivered.mediaType);
    expect(stepref.startsWith('stepref:')).toBe(true);
    // 没还原前 UI 解不动（这就是 bug 形态，顺带钉住）
    expect(decodePNG(Buffer.from(stepref, 'base64'))).toBeNull();

    // UI 层还原（本轮修复入口）
    const restored = rehydrateToolImages([{ ...delivered, base64: stepref }], store, dir);
    expect(restored![0]!.base64).not.toBe(stepref);
    expect(decodePNG(Buffer.from(restored![0]!.base64, 'base64'))).not.toBeNull();
  });

  it('小图直通（未 offload）不经过还原也能解码', async () => {
    const small = new Jimp({ width: 60, height: 40, color: 0x228844ff });
    writeFileSync(join(dir, 'small.png'), await small.getBuffer('image/png'));
    const result = await executeTool('read_media', { path: 'small.png' }, ctx);
    const delivered = result.images![0]!;
    const restored = rehydrateToolImages([delivered], undefined, dir);
    expect(decodePNG(Buffer.from(restored![0]!.base64, 'base64'))).not.toBeNull();
  });

  it('还原后的图进 tool 块渲染的是 sixel 缩略图而非降级行，且命中区域可取回', async () => {
    const name = await noisePng(300, 150, 'mid.png');
    const result = await executeTool('read_media', { path: name }, ctx);
    const delivered = result.images![0]!;
    const store = new AttachmentStore(sessionsDir);
    const stepref = store.offload(dir, delivered.base64, delivered.mediaType);
    const images = rehydrateToolImages([{ ...delivered, base64: stepref }], store, dir)!;

    const t = new Transcript();
    t.push({
      kind: 'tool',
      id: 't1',
      name: 'read_media',
      status: 'ok',
      result: 'ok',
      images,
    } as unknown as DisplayItem);
    const lines = t.render(80);
    const regions = t.imageRegions();
    expect(regions).toHaveLength(1);
    // 序列行是真 sixel（DCS 引导段），不是降级文本
    expect(lines[regions[0]!.startRow]).toContain('\x1bP0;1;q');
    // 整个产物里没有降级行
    expect(lines.some((l) => l.includes('[图片无法渲染'))).toBe(false);
    // 命中后能定位到该 tool 块的图
    const hit = t.imageRegionAt(regions[0]!.startRow)!;
    expect(hit.blockIdx).toBe(0);
    expect(hit.imgIdx).toBe(0);
  });

  it('offload 后附件被删：渲染层降级而不是把指针画成图', async () => {
    const name = await noisePng(200, 120, 'gone.png');
    const result = await executeTool('read_media', { path: name }, ctx);
    const delivered = result.images![0]!;
    const store = new AttachmentStore(sessionsDir);
    const stepref = store.offload(dir, delivered.base64, delivered.mediaType);
    // 删掉整个会话根模拟「附件文件被移走」（附件在 <sessionsDir>/<workdirKey>/attachments 下）
    rmSync(sessionsDir, { recursive: true, force: true });
    // rehydrate 找不到 → 置空串。渲染层对空串走降级行。
    const images = rehydrateToolImages([{ ...delivered, base64: stepref }], store, dir)!;
    expect(images[0]!.base64).toBe('');
    const block = new ItemBlock({
      kind: 'tool', id: 't2', name: 'read_media', status: 'ok', result: 'ok', images,
    } as unknown as DisplayItem);
    const lines = block.render(80);
    expect(lines.some((l) => l.includes('[图片无法渲染'))).toBe(true);
  });
});
