import { BitmapBuilder, PixelMode } from "text-shaper";
import { libassGaussianBlur } from "../libass_blur";
import { SUBPIXEL_SCALE, toFixed26_6, fromFixed26_6 } from "../math/fixed";

export function beBlurPre(
  buf: Uint8Array,
  stride: number,
  width: number,
  height: number,
): void {
  for (let y = 0; y < height; y++) {
    const row = y * stride;
    for (let x = 0; x < width; x++) {
      const v = buf[row + x] ?? 0;
      buf[row + x] = ((v >> 1) + 1) >> 1;
    }
  }
}

export function beBlurPost(
  buf: Uint8Array,
  stride: number,
  width: number,
  height: number,
): void {
  for (let y = 0; y < height; y++) {
    const row = y * stride;
    for (let x = 0; x < width; x++) {
      const v = buf[row + x] ?? 0;
      buf[row + x] = (v << 2) - (v > 32 ? 1 : 0);
    }
  }
}

export function beBlurOnce(
  buf: Uint8Array,
  stride: number,
  width: number,
  height: number,
  tmp: Uint16Array,
): void {
  const colPix = tmp.subarray(0, stride);
  const colSum = tmp.subarray(stride);

  let x = 1;
  let sum = buf[0] ?? 0;
  for (; x < width; x++) {
    const next = (buf[x - 1] ?? 0) + (buf[x] ?? 0);
    const colPixVal = sum + next;
    sum = next;
    colPix[x - 1] = colPixVal;
    colSum[x - 1] = colPixVal;
  }
  let colPixVal = sum + (buf[x - 1] ?? 0);
  colPix[x - 1] = colPixVal;
  colSum[x - 1] = colPixVal;

  for (let y = 1; y < height; y++) {
    const dstRow = (y - 1) * stride;
    const srcRow = y * stride;
    x = 1;
    sum = buf[srcRow] ?? 0;
    for (; x < width; x++) {
      const next = (buf[srcRow + x - 1] ?? 0) + (buf[srcRow + x] ?? 0);
      colPixVal = sum + next;
      sum = next;
      const colSumVal = colPix[x - 1] + colPixVal;
      colPix[x - 1] = colPixVal;
      const out = colSum[x - 1] + colSumVal;
      colSum[x - 1] = colSumVal;
      buf[dstRow + x - 1] = out >> 4;
    }
    colPixVal = sum + (buf[srcRow + x - 1] ?? 0);
    const colSumVal = colPix[x - 1] + colPixVal;
    colPix[x - 1] = colPixVal;
    const out = colSum[x - 1] + colSumVal;
    colSum[x - 1] = colSumVal;
    buf[dstRow + x - 1] = out >> 4;
  }

  const lastRow = (height - 1) * stride;
  for (x = 0; x < width; x++) {
    buf[lastRow + x] = (colSum[x] + colPix[x]) >> 4;
  }
}

export function applyBeBlur(
  bitmap: { buffer: Uint8Array; width: number; rows: number; pitch: number },
  passes: number,
): void {
  const be = Math.max(0, Math.round(passes));
  if (be <= 0) return;
  const width = bitmap.width;
  const height = bitmap.rows;
  if (width <= 1 || height <= 1) return;
  const stride = bitmap.pitch;
  const tmp = new Uint16Array(stride * 2);
  let remaining = be;
  if (--remaining > 0) {
    beBlurPre(bitmap.buffer, stride, width, height);
    do {
      beBlurOnce(bitmap.buffer, stride, width, height, tmp);
    } while (--remaining > 0);
    beBlurPost(bitmap.buffer, stride, width, height);
  }
  beBlurOnce(bitmap.buffer, stride, width, height, tmp);
}

export function bePadding(passes: number): number {
  const be = Math.max(0, Math.round(passes));
  if (be <= 3) return be;
  if (be <= 7) return 4;
  return 5;
}

const BLUR_PRECISION = 1 / 256;
const POSITION_PRECISION = 8;
const BLUR_RADIUS_SCALE = 2 / Math.sqrt(Math.log(256));
const BLUR_SCALE = (64 * BLUR_PRECISION) / POSITION_PRECISION;
const TRANSFORM_SUBPIXEL_ORDER = 3;
const TRANSFORM_SUBPIXEL_STEP = SUBPIXEL_SCALE >> TRANSFORM_SUBPIXEL_ORDER;

export function quantizeBlur(
  blur: number,
  blurScale: number,
): { sigma: number; mask: number } {
  const base = Number.isFinite(blur) && blur > 0 ? blur : 0;
  const scale = Number.isFinite(blurScale) && blurScale > 0 ? blurScale : 1;
  let radius = base * scale * BLUR_RADIUS_SCALE;
  radius *= BLUR_SCALE;
  const q = Math.round(Math.log1p(radius) / BLUR_PRECISION);
  const sigma = Math.expm1(BLUR_PRECISION * q) / BLUR_SCALE;
  const val = (1 + radius) * (POSITION_PRECISION / 2);
  const ord = val > 0 ? Math.floor(Math.log2(val)) + 1 : 0;
  const mask = ord > 0 ? (1 << ord) - 1 : 0;
  return { sigma, mask };
}

export function quantizeShadowOffset(offsetPx: number, mask: number): number {
  const fixed = toFixed26_6(offsetPx);
  if (mask <= 0) return fromFixed26_6(fixed);
  const rounded = (fixed + (mask >> 1)) & ~mask;
  return fromFixed26_6(rounded);
}

export function quantizeTransformPos(value: number): number {
  const fixed = toFixed26_6(value);
  const step = TRANSFORM_SUBPIXEL_STEP;
  const rounded = (fixed + (step >> 1)) & ~(step - 1);
  return fromFixed26_6(rounded);
}

export function applyTextShaperGaussianBlur(
  glyph: {
    bitmap: {
      buffer: Uint8Array;
      width: number;
      rows: number;
      pitch: number;
      pixelMode: PixelMode;
      numGrays?: number;
    };
    bearingX: number;
    bearingY: number;
  },
  sigmaX: number,
  sigmaY: number,
): {
  bitmap: {
    buffer: Uint8Array;
    width: number;
    rows: number;
    pitch: number;
    pixelMode: PixelMode;
    numGrays?: number;
  };
  bearingX: number;
  bearingY: number;
} {
  if (!(sigmaX > 0 || sigmaY > 0)) return glyph;
  let builder = BitmapBuilder.fromRasterizedGlyph(glyph);
  const blurred = builder.adaptiveBlur(sigmaX, sigmaY).toRasterizedGlyph();
  return blurred;
}

export function applyLibassGaussianBlur(
  glyph: {
    bitmap: {
      buffer: Uint8Array;
      width: number;
      rows: number;
      pitch: number;
      pixelMode: PixelMode;
      numGrays?: number;
    };
    bearingX: number;
    bearingY: number;
  },
  sigmaX: number,
  sigmaY: number,
): {
  bitmap: {
    buffer: Uint8Array;
    width: number;
    rows: number;
    pitch: number;
    pixelMode: PixelMode;
    numGrays?: number;
  };
  bearingX: number;
  bearingY: number;
} {
  if (!(sigmaX > 0 || sigmaY > 0)) return glyph;
  if (glyph.bitmap.pixelMode !== PixelMode.Gray) return glyph;
  const r2x = sigmaX * sigmaX;
  const r2y = sigmaY * sigmaY;
  const blurred = libassGaussianBlur(
    {
      buffer: glyph.bitmap.buffer,
      width: glyph.bitmap.width,
      rows: glyph.bitmap.rows,
      pitch: glyph.bitmap.pitch,
      pixelMode: glyph.bitmap.pixelMode,
      numGrays: glyph.bitmap.numGrays,
    },
    r2x,
    r2y,
  );
  return {
    bitmap: blurred.bitmap,
    bearingX: glyph.bearingX - blurred.shiftX,
    bearingY: glyph.bearingY + blurred.shiftY,
  };
}
