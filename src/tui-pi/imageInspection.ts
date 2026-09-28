/**
 * 图片预览的取景与缩放逻辑（对标设计：先裁剪原图、再最近邻放大）。
 *
 * 为什么先 crop 再放大：放大倍率下如果先缩整图再裁，插值核会让每个源像素糊成
 * 多个渐变像素，「逐像素块」的锐利感没了（看代码截图时尤其明显）。最近邻 +
 * 先裁保证 zoom=N 时每个源像素恰好是 N×N 的实心块。
 *
 * 视口按字符格折算像素：sixel 渲染按每格 9×18px 计（与 imageBlock.renderSixel
 * 同一组常量），crop 尺寸 = 视口像素 / zoom，与预览区的格数换算自洽。
 */
import type { DecodedImage } from './imageBlock.js';

/**
 * 按宽高比适配格数（预览浮层 fit 档用）：不超过 maxCols/maxRows，保持格宽高比
 * 与像素宽高比一致（cell 9×18，系数 2）。
 */
export function fitImageCells(
  imgWidth: number,
  imgHeight: number,
  maxCols: number,
  maxRows: number,
): { cols: number; rows: number } {
  const ratio = Math.max(0.1, Math.min(10, imgHeight / Math.max(1, imgWidth)));
  let cols = Math.max(1, maxCols);
  let rows = Math.max(1, Math.round(cols / (2 * ratio)));
  if (rows > maxRows) {
    rows = Math.max(1, maxRows);
    cols = Math.max(1, Math.min(maxCols, Math.round(2 * rows * ratio)));
  }
  return { cols, rows };
}

/** sixel 渲染的字符格像素尺寸（与 imageBlock.renderSixel 同一组常量）。 */
export const PREVIEW_CELL_W = 9;
export const PREVIEW_CELL_H = 18;

/** 预览缩放档位：0 = 适配（整图放进预览区），1/2/4/8 = 原始像素的 1:1/2:1/4:1/8:1。 */
export const PREVIEW_ZOOM_LEVELS = [1, 2, 4, 8] as const;
export type PreviewZoom = 0 | (typeof PREVIEW_ZOOM_LEVELS)[number];

export interface ImageRegion {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}

/** 只用宽高的图/视口描述（DecodedImage 与 ImageRegion 都兼容）。 */
export interface ImageDimensions {
  readonly width: number;
  readonly height: number;
}

/**
 * 计算 zoom 档位下可见的原图区域（以 center 为中心，钳在图内）。
 * zoom=1 时区域即视口大小（1:1 像素）；zoom=N 时区域为视口的 1/N（放大 N 倍）。
 */
export function inspectionRegion(
  image: ImageDimensions,
  viewport: ImageDimensions,
  zoom: number,
  center: { x: number; y: number },
): ImageRegion {
  const width = Math.max(1, Math.min(image.width, Math.ceil(viewport.width / zoom)));
  const height = Math.max(1, Math.min(image.height, Math.ceil(viewport.height / zoom)));
  const left = Math.max(0, Math.min(image.width - width, Math.round(center.x - width / 2)));
  const top = Math.max(0, Math.min(image.height - height, Math.round(center.y - height / 2)));
  return { left, top, width, height };
}

/** 把 center 钳到区域中心可达的范围（pan 后中心不能把视口推出图外）。 */
export function clampCenter(
  image: ImageDimensions,
  viewport: ImageDimensions,
  zoom: number,
  center: { x: number; y: number },
): { x: number; y: number } {
  const region = inspectionRegion(image, viewport, zoom, center);
  return { x: region.left + region.width / 2, y: region.top + region.height / 2 };
}

/**
 * 裁剪 + 最近邻放大到目标像素尺寸。
 * 超出原图的区域填黑（对齐终端未绘制区域的观感）。
 */
export function cropAndScale(
  img: DecodedImage,
  region: ImageRegion,
  outWidth: number,
  outHeight: number,
): DecodedImage {
  const out = new Uint8Array(outWidth * outHeight * 3);
  for (let y = 0; y < outHeight; y++) {
    // 输出行 y 对应源行：region.top + floor(y / 垂直放大比)
    const sy = region.top + Math.floor((y * region.height) / outHeight);
    for (let x = 0; x < outWidth; x++) {
      const sx = region.left + Math.floor((x * region.width) / outWidth);
      const di = (y * outWidth + x) * 3;
      if (sx < 0 || sy < 0 || sx >= img.width || sy >= img.height) continue; // 出界留黑
      const si = (sy * img.width + sx) * 3;
      out[di] = img.rgb[si]!;
      out[di + 1] = img.rgb[si + 1]!;
      out[di + 2] = img.rgb[si + 2]!;
    }
  }
  return { width: outWidth, height: outHeight, rgb: out };
}

/** 预览区像素视口：字符格数 × 每格像素。 */
export function previewViewportPx(cellColumns: number, cellRows: number): ImageRegion {
  return { left: 0, top: 0, width: cellColumns * PREVIEW_CELL_W, height: cellRows * PREVIEW_CELL_H };
}