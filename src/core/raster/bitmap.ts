import { SUBPIXEL_SCALE, toFixed26_6 } from "../math/fixed";

export function splitSubpixel(value: number): { i: number; s: number } {
  const f = toFixed26_6(value);
  let i = Math.floor(f / SUBPIXEL_SCALE);
  let s = f - i * SUBPIXEL_SCALE;
  if (s < 0) {
    s += SUBPIXEL_SCALE;
    i -= 1;
  }
  return { i, s };
}

export function shiftBitmapSubpixel(
  buf: Uint8Array,
  width: number,
  height: number,
  stride: number,
  shiftX: number,
  shiftY: number,
): void {
  const sx = shiftX & 63;
  const sy = shiftY & 63;
  if (sx) {
    for (let y = 0; y < height; y++) {
      const row = y * stride;
      for (let x = width - 1; x > 0; x--) {
        const idx = row + x;
        const prevIdx = idx - 1;
        const b = (buf[prevIdx] * sx) >> 6;
        buf[prevIdx] -= b;
        buf[idx] += b;
      }
    }
  }
  if (sy) {
    for (let x = 0; x < width; x++) {
      for (let y = height - 1; y > 0; y--) {
        const idx = y * stride + x;
        const prevIdx = idx - stride;
        const b = (buf[prevIdx] * sy) >> 6;
        buf[prevIdx] -= b;
        buf[idx] += b;
      }
    }
  }
}

export function addBitmapClamped(
  dst: Uint8Array,
  dstWidth: number,
  dstHeight: number,
  dstStride: number,
  src: Uint8Array,
  srcWidth: number,
  srcHeight: number,
  srcStride: number,
  offsetX: number,
  offsetY: number,
): void {
  const startX = Math.max(0, offsetX);
  const startY = Math.max(0, offsetY);
  const endX = Math.min(dstWidth, offsetX + srcWidth);
  const endY = Math.min(dstHeight, offsetY + srcHeight);
  if (startX >= endX || startY >= endY) return;
  const srcStartX = startX - offsetX;
  const srcStartY = startY - offsetY;
  const span = endX - startX;
  for (let y = 0; y < endY - startY; y++) {
    const dstRow = (startY + y) * dstStride + startX;
    const srcRow = (srcStartY + y) * srcStride + srcStartX;
    for (let x = 0; x < span; x++) {
      const s = src[srcRow + x]!;
      if (!s) continue;
      const idx = dstRow + x;
      const v = dst[idx]! + s;
      dst[idx] = v > 255 ? 255 : v;
    }
  }
}

export function maxBitmapClamped(
  dst: Uint8Array,
  dstWidth: number,
  dstHeight: number,
  dstStride: number,
  src: Uint8Array,
  srcWidth: number,
  srcHeight: number,
  srcStride: number,
  offsetX: number,
  offsetY: number,
): void {
  const startX = Math.max(0, offsetX);
  const startY = Math.max(0, offsetY);
  const endX = Math.min(dstWidth, offsetX + srcWidth);
  const endY = Math.min(dstHeight, offsetY + srcHeight);
  if (startX >= endX || startY >= endY) return;
  const srcStartX = startX - offsetX;
  const srcStartY = startY - offsetY;
  const span = endX - startX;
  for (let y = 0; y < endY - startY; y++) {
    const dstRow = (startY + y) * dstStride + startX;
    const srcRow = (srcStartY + y) * srcStride + srcStartX;
    for (let x = 0; x < span; x++) {
      const s = src[srcRow + x]!;
      if (!s) continue;
      const idx = dstRow + x;
      const v = dst[idx]!;
      dst[idx] = s > v ? s : v;
    }
  }
}

export function subBitmapClamped(
  dst: Uint8Array,
  dstWidth: number,
  dstHeight: number,
  dstStride: number,
  src: Uint8Array,
  srcWidth: number,
  srcHeight: number,
  srcStride: number,
  offsetX: number,
  offsetY: number,
): void {
  const startX = Math.max(0, offsetX);
  const startY = Math.max(0, offsetY);
  const endX = Math.min(dstWidth, offsetX + srcWidth);
  const endY = Math.min(dstHeight, offsetY + srcHeight);
  if (startX >= endX || startY >= endY) return;
  const srcStartX = startX - offsetX;
  const srcStartY = startY - offsetY;
  const span = endX - startX;
  for (let y = 0; y < endY - startY; y++) {
    const dstRow = (startY + y) * dstStride + startX;
    const srcRow = (srcStartY + y) * srcStride + srcStartX;
    for (let x = 0; x < span; x++) {
      const s = src[srcRow + x]!;
      if (!s) continue;
      const idx = dstRow + x;
      const v = dst[idx]! - s;
      dst[idx] = v > 0 ? v : 0;
    }
  }
}

export function normalizeLayerOrigin(layer: {
  bitmap: Uint8Array;
  width: number;
  height: number;
  stride: number;
  originX: number;
  originY: number;
}): void {
  const fx = toFixed26_6(layer.originX);
  const fy = toFixed26_6(layer.originY);
  let ix = Math.floor(fx / SUBPIXEL_SCALE);
  let iy = Math.floor(fy / SUBPIXEL_SCALE);
  let sx = fx - ix * SUBPIXEL_SCALE;
  let sy = fy - iy * SUBPIXEL_SCALE;
  if (sx < 0) {
    sx += SUBPIXEL_SCALE;
    ix -= 1;
  }
  if (sy < 0) {
    sy += SUBPIXEL_SCALE;
    iy -= 1;
  }
  if (sx !== 0 || sy !== 0) {
    shiftBitmapSubpixel(
      layer.bitmap,
      layer.width,
      layer.height,
      layer.stride,
      sx,
      sy,
    );
  }
  layer.originX = ix;
  layer.originY = iy;
}

export function fixOutlineBitmap(
  outline: {
    bitmap: { buffer: Uint8Array; width: number; rows: number; pitch: number };
  },
  outlineX: number,
  outlineY: number,
  fill: {
    bitmap: { buffer: Uint8Array; width: number; rows: number; pitch: number };
  },
  fillX: number,
  fillY: number,
): void {
  const oPos = splitSubpixel(outlineX);
  const fPos = splitSubpixel(fillX);
  const oPosY = splitSubpixel(outlineY);
  const fPosY = splitSubpixel(fillY);
  const oX = oPos.i;
  const oY = oPosY.i;
  const fX = fPos.i;
  const fY = fPosY.i;

  const oW = outline.bitmap.width;
  const oH = outline.bitmap.rows;
  const fW = fill.bitmap.width;
  const fH = fill.bitmap.rows;

  const l = Math.max(oX, fX);
  const t = Math.max(oY, fY);
  const r = Math.min(oX + oW, fX + fW);
  const b = Math.min(oY + oH, fY + fH);
  if (r <= l || b <= t) return;

  const oBuf = outline.bitmap.buffer;
  const fBuf = fill.bitmap.buffer;
  const oStride = outline.bitmap.pitch;
  const fStride = fill.bitmap.pitch;

  for (let y = t; y < b; y++) {
    const oy = y - oY;
    const fy = y - fY;
    const oRow = oy * oStride;
    const fRow = fy * fStride;
    for (let x = l; x < r; x++) {
      const ox = x - oX;
      const fx = x - fX;
      const g = fBuf[fRow + fx] ?? 0;
      const o = oBuf[oRow + ox] ?? 0;
      oBuf[oRow + ox] = o > g ? o - (g >> 1) : 0;
    }
  }
}
