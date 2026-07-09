import { PixelMode } from "text-shaper";
import { ensureBlurWasmReady, wasmBlurLevel0 } from "./blur-wasm";
import { recordAllocCensus } from "./raster/bitmap";

type GrayBitmap = {
  buffer: Uint8Array;
  width: number;
  rows: number;
  pitch: number;
  pixelMode: PixelMode;
  numGrays?: number;
};

export type BlurMethod = {
  level: number;
  radius: number;
  coeff: Int16Array;
};

type NonZeroBounds = {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
};

const blurMethodCache = new Map<number, BlurMethod>();
let blurWasmInit = false;
let blurScratchA = new Int16Array(0);
let blurScratchB = new Int16Array(0);
let blurRowScratch = new Int16Array(0);
// Scratch arrays are module-level for normal glyph-sized blur calls, but they
// must not retain a one-off full-frame bitmap high-water forever. Larger needs
// get a local scratch buffer that dies after the call; output pixels are
// unchanged because these arrays are purely intermediate.
const MAX_RETAINED_BLUR_SCRATCH_CELLS = (32 * 1024 * 1024) >> 1;

function growRetainedScratch(cur: Int16Array, need: number): Int16Array {
  if (cur.length >= need) return cur;
  let cap = cur.length > 0 ? cur.length : 1024;
  while (cap < need) cap *= 2;
  return new Int16Array(cap);
}

function acquireBlurScratchA(need: number): Int16Array {
  if (need > MAX_RETAINED_BLUR_SCRATCH_CELLS) return new Int16Array(need);
  blurScratchA = growRetainedScratch(blurScratchA, need);
  return blurScratchA;
}

function acquireBlurScratchB(need: number): Int16Array {
  if (need > MAX_RETAINED_BLUR_SCRATCH_CELLS) return new Int16Array(need);
  blurScratchB = growRetainedScratch(blurScratchB, need);
  return blurScratchB;
}

function acquireBlurScratchPair(need: number): { a: Int16Array; b: Int16Array } {
  if (need > MAX_RETAINED_BLUR_SCRATCH_CELLS) {
    return { a: new Int16Array(need), b: new Int16Array(need) };
  }
  blurScratchA = growRetainedScratch(blurScratchA, need);
  blurScratchB = growRetainedScratch(blurScratchB, need);
  return { a: blurScratchA, b: blurScratchB };
}

const DITHER_LINE = new Int16Array([
  8, 40, 8, 40, 8, 40, 8, 40, 8, 40, 8, 40, 8, 40, 8, 40,
  56, 24, 56, 24, 56, 24, 56, 24, 56, 24, 56, 24, 56, 24, 56, 24,
]);

function calcGauss(res: Float64Array, n: number, r2: number): void {
  const alpha = 0.5 / r2;
  let mul = Math.exp(-alpha);
  const mul2 = mul * mul;
  let cur = Math.sqrt(alpha / Math.PI);

  res[0] = cur;
  cur *= mul;
  res[1] = cur;
  for (let i = 2; i < n; i++) {
    mul *= mul2;
    cur *= mul;
    res[i] = cur;
  }
}

function coeffFilter(coeff: Float64Array, n: number, kernel: number[]): void {
  let prev1 = coeff[1] ?? 0;
  let prev2 = coeff[2] ?? 0;
  let prev3 = coeff[3] ?? 0;
  for (let i = 0; i < n; i++) {
    const res =
      (coeff[i] ?? 0) * kernel[0] +
      (prev1 + (coeff[i + 1] ?? 0)) * kernel[1] +
      (prev2 + (coeff[i + 2] ?? 0)) * kernel[2] +
      (prev3 + (coeff[i + 3] ?? 0)) * kernel[3];
    prev3 = prev2;
    prev2 = prev1;
    prev1 = coeff[i] ?? 0;
    coeff[i] = res;
  }
}

function calcMatrix(mat: Array<Float64Array>, matFreq: Float64Array, n: number): void {
  for (let i = 0; i < n; i++) {
    mat[i]![i] = (matFreq[2 * i + 2] ?? 0) + 3 * (matFreq[0] ?? 0) - 4 * (matFreq[i + 1] ?? 0);
    for (let j = i + 1; j < n; j++) {
      mat[i]![j] =
        (matFreq[i + j + 2] ?? 0) +
        (matFreq[j - i] ?? 0) +
        2 * ((matFreq[0] ?? 0) - (matFreq[i + 1] ?? 0) - (matFreq[j + 1] ?? 0));
      mat[j]![i] = mat[i]![j];
    }
  }

  for (let k = 0; k < n; k++) {
    const z = 1 / mat[k]![k]!;
    mat[k]![k] = 1;
    for (let i = 0; i < n; i++) {
      if (i === k) continue;
      const mul = mat[i]![k]! * z;
      mat[i]![k] = 0;
      for (let j = 0; j < n; j++) {
        mat[i]![j]! -= mat[k]![j]! * mul;
      }
    }
    for (let j = 0; j < n; j++) {
      mat[k]![j]! *= z;
    }
  }
}

function calcCoeff(mu: Float64Array, n: number, r2: number, mul: number): void {
  const w = 12096;
  const kernel = [
    ((((+3280 / w) * mul + 1092 / w) * mul + 2520 / w) * mul + 5204 / w),
    ((((-2460 / w) * mul - 273 / w) * mul - 210 / w) * mul + 2943 / w),
    ((((+984 / w) * mul - 546 / w) * mul - 924 / w) * mul + 486 / w),
    ((((-164 / w) * mul + 273 / w) * mul - 126 / w) * mul + 17 / w),
  ];

  const matFreq = new Float64Array(17);
  matFreq[0] = kernel[0]!;
  matFreq[1] = kernel[1]!;
  matFreq[2] = kernel[2]!;
  matFreq[3] = kernel[3]!;
  coeffFilter(matFreq, 7, kernel);

  const vecFreq = new Float64Array(12);
  calcGauss(vecFreq, n + 4, r2 * mul);
  coeffFilter(vecFreq, n + 1, kernel);

  const mat = new Array<Float64Array>(8);
  for (let i = 0; i < 8; i++) mat[i] = new Float64Array(8);
  calcMatrix(mat, matFreq, n);

  const vec = new Float64Array(8);
  for (let i = 0; i < n; i++) {
    vec[i] = (matFreq[0] ?? 0) - (matFreq[i + 1] ?? 0) - (vecFreq[0] ?? 0) + (vecFreq[i + 1] ?? 0);
  }

  for (let i = 0; i < n; i++) {
    let res = 0;
    for (let j = 0; j < n; j++) {
      res += mat[i]![j]! * vec[j]!;
    }
    mu[i] = Math.max(0, res);
  }
}

export function findBestMethod(r2: number): BlurMethod {
  const cached = blurMethodCache.get(r2);
  if (cached) return cached;
  const mu = new Float64Array(8);
  let level = 0;
  let radius = 4;

  if (r2 < 0.5) {
    level = 0;
    radius = 4;
    mu[1] = 0.085 * r2 * r2 * r2;
    mu[0] = 0.5 * r2 - 4 * mu[1];
    mu[2] = 0;
    mu[3] = 0;
  } else {
    const sqrtVal = Math.sqrt(0.11569 * r2 + 0.20591047);
    level = Math.floor(Math.log2(sqrtVal)) + 1;
    const frac = sqrtVal / 2 ** (level - 1) - 1;
    const mul = 0.25 ** level;
    radius = 8 - Math.floor((10.1525 + 0.8335 * mul) * (1 - frac));
    if (radius < 4) radius = 4;
    calcCoeff(mu, radius, r2, mul);
  }

  const coeff = new Int16Array(8);
  for (let i = 0; i < radius; i++) {
    coeff[i] = (0x10000 * mu[i]! + 0.5) | 0;
  }

  const method = { level, radius, coeff };
  blurMethodCache.set(r2, method);
  return method;
}

function shrinkFunc(p1p: number, p1n: number, z0p: number, z0n: number, n1p: number, n1n: number): number {
  let r = ((p1p + p1n + n1p + n1n) >> 1) | 0;
  r = ((r + z0p + z0n) >> 1) | 0;
  r = ((r + p1n + n1p) >> 1) | 0;
  return ((r + z0p + z0n + 2) >> 2) | 0;
}

// expandFunc is inlined at its call sites (expandHorz/expandVert): returning
// a tuple allocated an array per output pixel in the hottest loops.

function unpackToInt16(src: Uint8Array, width: number, height: number, stride: number, dst: Int16Array): void {
  let di = 0;
  for (let y = 0; y < height; y++) {
    const row = y * stride;
    for (let x = 0; x < width; x++) {
      const v = src[row + x]!;
      dst[di++] = (((v << 7) | (v >> 1)) + 1) >> 1;
    }
  }
}

function packFromInt16(src: Int16Array, width: number, height: number, dst: Uint8Array): void {
  let si = 0;
  for (let y = 0; y < height; y++) {
    const ditherRow = (y & 1) << 4;
    for (let x = 0; x < width; x++) {
      const dither = DITHER_LINE[ditherRow + (x & 15)] ?? 0;
      const v = src[si++] ?? 0;
      let out = (v - (v >> 8) + dither) >> 6;
      if (out < 0) out = 0;
      else if (out > 255) out = 255;
      dst[y * width + x] = out;
    }
  }
}

function ensureBlurRowScratch(width: number): Int16Array {
  if (blurRowScratch.length < width) {
    let cap = blurRowScratch.length > 0 ? blurRowScratch.length : 256;
    while (cap < width) cap *= 2;
    blurRowScratch = new Int16Array(cap);
  }
  return blurRowScratch;
}

function unpackRowToInt16(src: Uint8Array, srcOff: number, width: number, dst: Int16Array): void {
  let x = 0;
  const w4 = width & ~3;
  for (; x < w4; x += 4) {
    let v = src[srcOff + x]!;
    dst[x] = (((v << 7) | (v >> 1)) + 1) >> 1;
    v = src[srcOff + x + 1]!;
    dst[x + 1] = (((v << 7) | (v >> 1)) + 1) >> 1;
    v = src[srcOff + x + 2]!;
    dst[x + 2] = (((v << 7) | (v >> 1)) + 1) >> 1;
    v = src[srcOff + x + 3]!;
    dst[x + 3] = (((v << 7) | (v >> 1)) + 1) >> 1;
  }
  for (; x < width; x++) {
    const v = src[srcOff + x]!;
    dst[x] = (((v << 7) | (v >> 1)) + 1) >> 1;
  }
}

function blurHorzEdgePxR4Two(src: Int16Array, cx: number, w: number, c0: number, c1: number): number {
  const center = cx >= 0 && cx < w ? src[cx]! : 0;
  const t2 = center + center;
  let acc = 0x8000;
  let li = cx - 1;
  let ri = cx + 1;
  const l1 = li >= 0 && li < w ? src[li]! : 0;
  const r1 = ri >= 0 && ri < w ? src[ri]! : 0;
  acc += (l1 + r1 - t2) * c0;
  li = cx - 2;
  ri = cx + 2;
  const l2 = li >= 0 && li < w ? src[li]! : 0;
  const r2 = ri >= 0 && ri < w ? src[ri]! : 0;
  acc += (l2 + r2 - t2) * c1;
  return (center + (acc >> 16)) | 0;
}

function blurHorzRowR4Two(dst: Int16Array, dstOff: number, src: Int16Array, w: number, c0: number, c1: number): void {
  const outW = w + 8;
  const coreStart = Math.min(8, outW);
  const coreEnd = Math.max(coreStart, Math.min(w, outW));
  let x = 0;
  for (; x < coreStart; x++) dst[dstOff + x] = blurHorzEdgePxR4Two(src, x - 4, w, c0, c1);
  for (; x < coreEnd; x++) {
    const ci = x - 4;
    const center = src[ci]!;
    const t2 = center + center;
    const acc =
      0x8000 +
      (src[ci - 1]! + src[ci + 1]! - t2) * c0 +
      (src[ci - 2]! + src[ci + 2]! - t2) * c1;
    dst[dstOff + x] = (center + (acc >> 16)) | 0;
  }
  for (; x < outW; x++) dst[dstOff + x] = blurHorzEdgePxR4Two(src, x - 4, w, c0, c1);
}

function blurHorzEdgePxR4TwoAt(src: Int16Array, srcOff: number, cx: number, w: number, c0: number, c1: number): number {
  const center = cx >= 0 && cx < w ? src[srcOff + cx]! : 0;
  const t2 = center + center;
  let acc = 0x8000;
  let li = cx - 1;
  let ri = cx + 1;
  const l1 = li >= 0 && li < w ? src[srcOff + li]! : 0;
  const r1 = ri >= 0 && ri < w ? src[srcOff + ri]! : 0;
  acc += (l1 + r1 - t2) * c0;
  li = cx - 2;
  ri = cx + 2;
  const l2 = li >= 0 && li < w ? src[srcOff + li]! : 0;
  const r2 = ri >= 0 && ri < w ? src[srcOff + ri]! : 0;
  acc += (l2 + r2 - t2) * c1;
  return (center + (acc >> 16)) | 0;
}

function blurHorzRowR4TwoAt(
  dst: Int16Array,
  dstOff: number,
  src: Int16Array,
  srcOff: number,
  w: number,
  c0: number,
  c1: number,
): void {
  const outW = w + 8;
  const coreStart = Math.min(8, outW);
  const coreEnd = Math.max(coreStart, Math.min(w, outW));
  let x = 0;
  for (; x < coreStart; x++) dst[dstOff + x] = blurHorzEdgePxR4TwoAt(src, srcOff, x - 4, w, c0, c1);
  for (; x < coreEnd; x++) {
    const ci = srcOff + x - 4;
    const center = src[ci]!;
    const t2 = center + center;
    const acc =
      0x8000 +
      (src[ci - 1]! + src[ci + 1]! - t2) * c0 +
      (src[ci - 2]! + src[ci + 2]! - t2) * c1;
    dst[dstOff + x] = (center + (acc >> 16)) | 0;
  }
  for (; x < outW; x++) dst[dstOff + x] = blurHorzEdgePxR4TwoAt(src, srcOff, x - 4, w, c0, c1);
}

function findNonZeroBounds(bitmap: GrayBitmap): NonZeroBounds | null {
  const { buffer, width: w, rows: h, pitch } = bitmap;
  let minX = w;
  let minY = h;
  let maxX = -1;
  let maxY = -1;

  for (let y = 0; y < h; y++) {
    const row = y * pitch;
    let left = 0;
    while (left < w && buffer[row + left] === 0) left++;
    if (left === w) continue;

    let right = w - 1;
    while (right > left && buffer[row + right] === 0) right--;

    if (left < minX) minX = left;
    if (right > maxX) maxX = right;
    if (y < minY) minY = y;
    maxY = y;
  }

  return maxX >= 0 ? { minX, minY, maxX, maxY } : null;
}

function blurVertPackPaddedR4TwoInto(
  out: Uint8Array,
  dstX: number,
  dstY: number,
  dstStride: number,
  mid: Int16Array,
  outW: number,
  outH: number,
  c0: number,
  c1: number,
): void {
  const totalC = 2 * (c0 + c1);
  for (let y = 0; y < outH; y++) {
    const cbRow = (y + 4) * outW;
    const oRow = (dstY + y) * dstStride + dstX;
    const t1 = cbRow - outW, b1 = cbRow + outW;
    const t2 = cbRow - 2 * outW, b2 = cbRow + 2 * outW;
    const evenDither = ((dstY + y) & 1) === 0 ? 8 : 56;
    const oddDither = ((dstY + y) & 1) === 0 ? 40 : 24;
    const d0 = (dstX & 1) === 0 ? evenDither : oddDither;
    const d1 = (dstX & 1) === 0 ? oddDither : evenDither;
    let x = 0;
    const w2 = outW & ~1;
    for (; x < w2; x += 2) {
      let center = mid[cbRow + x]!;
      let acc = 0x8000 + (mid[t1 + x]! + mid[b1 + x]!) * c0 + (mid[t2 + x]! + mid[b2 + x]!) * c1;
      let v = (center + ((acc - center * totalC) >> 16)) | 0;
      v = (v << 16) >> 16;
      let o = (v - (v >> 8) + d0) >> 6;
      if (o < 0) o = 0;
      else if (o > 255) o = 255;
      out[oRow + x] = o;

      const x1 = x + 1;
      center = mid[cbRow + x1]!;
      acc = 0x8000 + (mid[t1 + x1]! + mid[b1 + x1]!) * c0 + (mid[t2 + x1]! + mid[b2 + x1]!) * c1;
      v = (center + ((acc - center * totalC) >> 16)) | 0;
      v = (v << 16) >> 16;
      o = (v - (v >> 8) + d1) >> 6;
      if (o < 0) o = 0;
      else if (o > 255) o = 255;
      out[oRow + x1] = o;
    }
    if (x < outW) {
      const center = mid[cbRow + x]!;
      const acc = 0x8000 + (mid[t1 + x]! + mid[b1 + x]!) * c0 + (mid[t2 + x]! + mid[b2 + x]!) * c1;
      let v = (center + ((acc - center * totalC) >> 16)) | 0;
      v = (v << 16) >> 16;
      let o = (v - (v >> 8) + d0) >> 6;
      if (o < 0) o = 0;
      else if (o > 255) o = 255;
      out[oRow + x] = o;
    }
  }
}

function blurVertPackPaddedR4Two(
  out: Uint8Array,
  mid: Int16Array,
  outW: number,
  outH: number,
  c0: number,
  c1: number,
): void {
  const totalC = 2 * (c0 + c1);
  for (let y = 0; y < outH; y++) {
    const cbRow = (y + 4) * outW;
    const oRow = y * outW;
    const t1 = cbRow - outW, b1 = cbRow + outW;
    const t2 = cbRow - 2 * outW, b2 = cbRow + 2 * outW;
    const d0 = (y & 1) === 0 ? 8 : 56;
    const d1 = (y & 1) === 0 ? 40 : 24;
    let x = 0;
    const w2 = outW & ~1;
    for (; x < w2; x += 2) {
      let center = mid[cbRow + x]!;
      let acc = 0x8000 + (mid[t1 + x]! + mid[b1 + x]!) * c0 + (mid[t2 + x]! + mid[b2 + x]!) * c1;
      let v = (center + ((acc - center * totalC) >> 16)) | 0;
      v = (v << 16) >> 16;
      let o = (v - (v >> 8) + d0) >> 6;
      if (o < 0) o = 0;
      else if (o > 255) o = 255;
      out[oRow + x] = o;

      const x1 = x + 1;
      center = mid[cbRow + x1]!;
      acc = 0x8000 + (mid[t1 + x1]! + mid[b1 + x1]!) * c0 + (mid[t2 + x1]! + mid[b2 + x1]!) * c1;
      v = (center + ((acc - center * totalC) >> 16)) | 0;
      v = (v << 16) >> 16;
      o = (v - (v >> 8) + d1) >> 6;
      if (o < 0) o = 0;
      else if (o > 255) o = 255;
      out[oRow + x1] = o;
    }
    if (x < outW) {
      const center = mid[cbRow + x]!;
      const acc = 0x8000 + (mid[t1 + x]! + mid[b1 + x]!) * c0 + (mid[t2 + x]! + mid[b2 + x]!) * c1;
      let v = (center + ((acc - center * totalC) >> 16)) | 0;
      v = (v << 16) >> 16;
      let o = (v - (v >> 8) + d0) >> 6;
      if (o < 0) o = 0;
      else if (o > 255) o = 255;
      out[oRow + x] = o;
    }
  }
}


function blurLevel0R4TwoCropped(
  bitmap: GrayBitmap,
  blurX: BlurMethod,
  blurY: BlurMethod,
  bounds: NonZeroBounds,
): { bitmap: GrayBitmap; shiftX: number; shiftY: number } {
  const w = bitmap.width;
  const h = bitmap.rows;
  const outW = w + 8;
  const outH = h + 8;
  const cropW = bounds.maxX - bounds.minX + 1;
  const cropH = bounds.maxY - bounds.minY + 1;
  const localOutW = cropW + 8;
  const localOutH = cropH + 8;
  const midSize = (cropH + 16) * localOutW;

  const row = ensureBlurRowScratch(cropW);
  const mid = acquireBlurScratchA(midSize);
  const padTop = 8 * localOutW;
  mid.fill(0, 0, padTop);
  mid.fill(0, padTop + cropH * localOutW, midSize);

  const src = bitmap.buffer;
  const pitch = bitmap.pitch;
  const c0x = blurX.coeff[0]!, c1x = blurX.coeff[1]!;
  for (let y = 0; y < cropH; y++) {
    unpackRowToInt16(src, (bounds.minY + y) * pitch + bounds.minX, cropW, row);
    blurHorzRowR4Two(mid, padTop + y * localOutW, row, cropW, c0x, c1x);
  }

  const outBuffer = new Uint8Array(outW * outH);
  if ((globalThis as any).__SUBFRAME_ALLOC_CENSUS__)
    recordAllocCensus("blur.output.alloc", outBuffer.length);
  blurVertPackPaddedR4TwoInto(
    outBuffer,
    bounds.minX,
    bounds.minY,
    outW,
    mid,
    localOutW,
    localOutH,
    blurY.coeff[0]!,
    blurY.coeff[1]!,
  );

  const outBitmap = {
    buffer: outBuffer,
    width: outW,
    rows: outH,
    pitch: outW,
    pixelMode: PixelMode.Gray,
    numGrays: 256,
  };
  return { bitmap: outBitmap, shiftX: 4, shiftY: 4 };
}

function blurLevel0R4TwoEmpty(bitmap: GrayBitmap): { bitmap: GrayBitmap; shiftX: number; shiftY: number } {
  const outW = bitmap.width + 8;
  const outH = bitmap.rows + 8;
  const outBuffer = new Uint8Array(outW * outH);
  if ((globalThis as any).__SUBFRAME_ALLOC_CENSUS__)
    recordAllocCensus("blur.output.alloc", outBuffer.length);
  const outBitmap = {
    buffer: outBuffer,
    width: outW,
    rows: outH,
    pitch: outW,
    pixelMode: PixelMode.Gray,
    numGrays: 256,
  };
  return { bitmap: outBitmap, shiftX: 4, shiftY: 4 };
}

function blurLevel0R4TwoUnpack(
  bitmap: GrayBitmap,
  blurX: BlurMethod,
  blurY: BlurMethod,
): { bitmap: GrayBitmap; shiftX: number; shiftY: number } {
  const w = bitmap.width;
  const h = bitmap.rows;
  const outW = w + 8;
  const outH = h + 8;
  const unpackSize = w * h;
  const midSize = (h + 16) * outW;

  const unpacked = acquireBlurScratchB(unpackSize);
  const mid = acquireBlurScratchA(midSize);
  unpackToInt16(bitmap.buffer, w, h, bitmap.pitch, unpacked);

  const padTop = 8 * outW;
  mid.fill(0, 0, padTop);
  mid.fill(0, padTop + h * outW, midSize);

  const c0x = blurX.coeff[0]!, c1x = blurX.coeff[1]!;
  for (let y = 0; y < h; y++) {
    blurHorzRowR4TwoAt(mid, padTop + y * outW, unpacked, y * w, w, c0x, c1x);
  }

  const outBuffer = new Uint8Array(outW * outH);
  if ((globalThis as any).__SUBFRAME_ALLOC_CENSUS__)
    recordAllocCensus("blur.output.alloc", outBuffer.length);
  blurVertPackPaddedR4Two(outBuffer, mid, outW, outH, blurY.coeff[0]!, blurY.coeff[1]!);

  const outBitmap = {
    buffer: outBuffer,
    width: outW,
    rows: outH,
    pitch: outW,
    pixelMode: PixelMode.Gray,
    numGrays: 256,
  };
  return { bitmap: outBitmap, shiftX: 4, shiftY: 4 };
}

// Ultra-hot path for the usual ASS glyph blur case: both axes are level-0,
// radius-4, and the far two taps are mathematically zero. It stays JS-only and
// single-threaded, but removes the full-bitmap unpack pass, works one source row
// at a time for better cache locality, and uses a dedicated vertical+dither pack
// loop with no per-pixel dither table lookup. It is byte-identical to the
// generic level-0 path for this coefficient shape.
function blurLevel0R4Two(
  bitmap: GrayBitmap,
  blurX: BlurMethod,
  blurY: BlurMethod,
): { bitmap: GrayBitmap; shiftX: number; shiftY: number } {
  const w = bitmap.width;
  const h = bitmap.rows;
  const outW = w + 8;
  const outH = h + 8;
  const midSize = (h + 16) * outW;

  const row = ensureBlurRowScratch(w);
  const mid = acquireBlurScratchA(midSize);
  const padTop = 8 * outW;
  mid.fill(0, 0, padTop);
  mid.fill(0, padTop + h * outW, midSize);

  const src = bitmap.buffer;
  const pitch = bitmap.pitch;
  const c0x = blurX.coeff[0]!, c1x = blurX.coeff[1]!;
  for (let y = 0; y < h; y++) {
    unpackRowToInt16(src, y * pitch, w, row);
    blurHorzRowR4Two(mid, padTop + y * outW, row, w, c0x, c1x);
  }

  const outBuffer = new Uint8Array(outW * outH);
  if ((globalThis as any).__SUBFRAME_ALLOC_CENSUS__)
    recordAllocCensus("blur.output.alloc", outBuffer.length);
  blurVertPackPaddedR4Two(outBuffer, mid, outW, outH, blurY.coeff[0]!, blurY.coeff[1]!);

  const outBitmap = {
    buffer: outBuffer,
    width: outW,
    rows: outH,
    pitch: outW,
    pixelMode: PixelMode.Gray,
    numGrays: 256,
  };
  return { bitmap: outBitmap, shiftX: 4, shiftY: 4 };
}

function shrinkHorz(dst: Int16Array, src: Int16Array, w: number, h: number): number {
  const dstW = (w + 5) >> 1;
  // Taps span sx-4 .. sx+1 (sx = 2x); bounds checks only in edge zones.
  const coreStart = Math.min(2, dstW);
  const coreEnd = Math.max(coreStart, Math.min((w - 1) >> 1, dstW));
  for (let y = 0; y < h; y++) {
    const srcRow = y * w;
    const dstRow = y * dstW;
    for (let x = 0; x < coreStart; x++) {
      const sx = x * 2;
      const p1p = sx - 4 >= 0 && sx - 4 < w ? src[srcRow + sx - 4]! : 0;
      const p1n = sx - 3 >= 0 && sx - 3 < w ? src[srcRow + sx - 3]! : 0;
      const z0p = sx - 2 >= 0 && sx - 2 < w ? src[srcRow + sx - 2]! : 0;
      const z0n = sx - 1 >= 0 && sx - 1 < w ? src[srcRow + sx - 1]! : 0;
      const n1p = sx >= 0 && sx < w ? src[srcRow + sx]! : 0;
      const n1n = sx + 1 >= 0 && sx + 1 < w ? src[srcRow + sx + 1]! : 0;
      dst[dstRow + x] = shrinkFunc(p1p, p1n, z0p, z0n, n1p, n1n);
    }
    for (let x = coreStart; x < coreEnd; x++) {
      const si = srcRow + x * 2;
      dst[dstRow + x] = shrinkFunc(
        src[si - 4]!,
        src[si - 3]!,
        src[si - 2]!,
        src[si - 1]!,
        src[si]!,
        src[si + 1]!,
      );
    }
    for (let x = coreEnd; x < dstW; x++) {
      const sx = x * 2;
      const p1p = sx - 4 >= 0 && sx - 4 < w ? src[srcRow + sx - 4]! : 0;
      const p1n = sx - 3 >= 0 && sx - 3 < w ? src[srcRow + sx - 3]! : 0;
      const z0p = sx - 2 >= 0 && sx - 2 < w ? src[srcRow + sx - 2]! : 0;
      const z0n = sx - 1 >= 0 && sx - 1 < w ? src[srcRow + sx - 1]! : 0;
      const n1p = sx >= 0 && sx < w ? src[srcRow + sx]! : 0;
      const n1n = sx + 1 >= 0 && sx + 1 < w ? src[srcRow + sx + 1]! : 0;
      dst[dstRow + x] = shrinkFunc(p1p, p1n, z0p, z0n, n1p, n1n);
    }
  }
  return dstW;
}

function shrinkVert(dst: Int16Array, src: Int16Array, w: number, h: number): number {
  const dstH = (h + 5) >> 1;
  // Row-major iteration (y outer) keeps all six taps on contiguous rows.
  for (let y = 0; y < dstH; y++) {
    const sy = y * 2;
    const r0 = sy - 4 >= 0 && sy - 4 < h ? (sy - 4) * w : -1;
    const r1 = sy - 3 >= 0 && sy - 3 < h ? (sy - 3) * w : -1;
    const r2 = sy - 2 >= 0 && sy - 2 < h ? (sy - 2) * w : -1;
    const r3 = sy - 1 >= 0 && sy - 1 < h ? (sy - 1) * w : -1;
    const r4 = sy < h ? sy * w : -1;
    const r5 = sy + 1 < h ? (sy + 1) * w : -1;
    const dRow = y * w;
    for (let x = 0; x < w; x++) {
      const p1p = r0 >= 0 ? src[r0 + x]! : 0;
      const p1n = r1 >= 0 ? src[r1 + x]! : 0;
      const z0p = r2 >= 0 ? src[r2 + x]! : 0;
      const z0n = r3 >= 0 ? src[r3 + x]! : 0;
      const n1p = r4 >= 0 ? src[r4 + x]! : 0;
      const n1n = r5 >= 0 ? src[r5 + x]! : 0;
      dst[dRow + x] = shrinkFunc(p1p, p1n, z0p, z0n, n1p, n1n);
    }
  }
  return dstH;
}

function expandHorz(dst: Int16Array, src: Int16Array, w: number, h: number): number {
  const dstW = w * 2 + 4;
  const kMax = (dstW - 1) >> 1;
  for (let y = 0; y < h; y++) {
    const srcRow = y * w;
    const dstRow = y * dstW;
    for (let k = 0; k <= kMax; k++) {
      const p1 = k - 2 >= 0 && k - 2 < w ? src[srcRow + k - 2]! : 0;
      const z0 = k - 1 >= 0 && k - 1 < w ? src[srcRow + k - 1]! : 0;
      const n1 = k < w ? src[srcRow + k]! : 0;
      const r = ((((p1 + n1) >> 1) + z0) >> 1) | 0;
      dst[dstRow + k * 2] = ((((r + p1) >> 1) + z0 + 1) >> 1) | 0;
      dst[dstRow + k * 2 + 1] = ((((r + n1) >> 1) + z0 + 1) >> 1) | 0;
    }
  }
  return dstW;
}

function expandVert(dst: Int16Array, src: Int16Array, w: number, h: number): number {
  const dstH = h * 2 + 4;
  // Row-major iteration: for each output row the three source taps live on
  // contiguous rows.
  for (let y = 0; y < dstH; y++) {
    const k = y >> 1;
    const r0 = k - 2 >= 0 && k - 2 < h ? (k - 2) * w : -1;
    const r1 = k - 1 >= 0 && k - 1 < h ? (k - 1) * w : -1;
    const r2 = k < h ? k * w : -1;
    const dRow = y * w;
    const even = (y & 1) === 0;
    for (let x = 0; x < w; x++) {
      const p1 = r0 >= 0 ? src[r0 + x]! : 0;
      const z0 = r1 >= 0 ? src[r1 + x]! : 0;
      const n1 = r2 >= 0 ? src[r2 + x]! : 0;
      const r = ((((p1 + n1) >> 1) + z0) >> 1) | 0;
      dst[dRow + x] = even
        ? ((((r + p1) >> 1) + z0 + 1) >> 1) | 0
        : ((((r + n1) >> 1) + z0 + 1) >> 1) | 0;
    }
  }
  return dstH;
}

// Bounds-checked horizontal blur pixel; used only in the 2*radius-wide edge
// zones. Same expression/order as the reference, so bit-identical.
function blurHorzEdgePx(
  src: Int16Array,
  srcRow: number,
  cx: number,
  w: number,
  radius: number,
  coeff: Int16Array,
): number {
  const center = cx >= 0 && cx < w ? src[srcRow + cx]! : 0;
  let acc = 0x8000;
  for (let i = radius; i > 0; i--) {
    const leftIdx = cx - i;
    const rightIdx = cx + i;
    const left = leftIdx >= 0 && leftIdx < w ? src[srcRow + leftIdx]! : 0;
    const right = rightIdx >= 0 && rightIdx < w ? src[srcRow + rightIdx]! : 0;
    acc += (left + right - 2 * center) * coeff[i - 1]!;
  }
  return (center + (acc >> 16)) | 0;
}

function blurHorz(dst: Int16Array, src: Int16Array, w: number, h: number, radius: number, coeff: Int16Array): number {
  const dstW = w + 2 * radius;
  // Bounds checks only in the edge zones; the core loop is branch-free.
  const coreStart = Math.min(2 * radius, dstW);
  const coreEnd = Math.max(coreStart, Math.min(w, dstW));
  if (radius === 4) {
    const c0 = coeff[0]!, c1 = coeff[1]!, c2 = coeff[2]!, c3 = coeff[3]!;
    // The level-0 radius-4 filter (r2 < 0.5) has coeff[2] = coeff[3] = 0, so
    // taps 3 and 4 contribute exactly 0. Drop them: bit-identical, half the
    // work. This is by far the most common case (text/glyph blur).
    if (c2 === 0 && c3 === 0) {
      for (let y = 0; y < h; y++) {
        const srcRow = y * w;
        const dstRow = y * dstW;
        for (let x = 0; x < coreStart; x++) dst[dstRow + x] = blurHorzEdgePx(src, srcRow, x - 4, w, 4, coeff);
        for (let x = coreStart; x < coreEnd; x++) {
          const ci = srcRow + x - 4;
          const center = src[ci]!;
          const t2 = center + center;
          const acc =
            0x8000 +
            (src[ci - 1]! + src[ci + 1]! - t2) * c0 +
            (src[ci - 2]! + src[ci + 2]! - t2) * c1;
          dst[dstRow + x] = (center + (acc >> 16)) | 0;
        }
        for (let x = coreEnd; x < dstW; x++) dst[dstRow + x] = blurHorzEdgePx(src, srcRow, x - 4, w, 4, coeff);
      }
      return dstW;
    }
    for (let y = 0; y < h; y++) {
      const srcRow = y * w;
      const dstRow = y * dstW;
      for (let x = 0; x < coreStart; x++) dst[dstRow + x] = blurHorzEdgePx(src, srcRow, x - 4, w, 4, coeff);
      for (let x = coreStart; x < coreEnd; x++) {
        const ci = srcRow + x - 4;
        const center = src[ci]!;
        const t2 = center + center;
        const acc =
          0x8000 +
          (src[ci - 1]! + src[ci + 1]! - t2) * c0 +
          (src[ci - 2]! + src[ci + 2]! - t2) * c1 +
          (src[ci - 3]! + src[ci + 3]! - t2) * c2 +
          (src[ci - 4]! + src[ci + 4]! - t2) * c3;
        dst[dstRow + x] = (center + (acc >> 16)) | 0;
      }
      for (let x = coreEnd; x < dstW; x++) dst[dstRow + x] = blurHorzEdgePx(src, srcRow, x - 4, w, 4, coeff);
    }
    return dstW;
  }
  if (radius === 8) {
    const c0 = coeff[0]!, c1 = coeff[1]!, c2 = coeff[2]!, c3 = coeff[3]!;
    const c4 = coeff[4]!, c5 = coeff[5]!, c6 = coeff[6]!, c7 = coeff[7]!;
    for (let y = 0; y < h; y++) {
      const srcRow = y * w;
      const dstRow = y * dstW;
      for (let x = 0; x < coreStart; x++) dst[dstRow + x] = blurHorzEdgePx(src, srcRow, x - 8, w, 8, coeff);
      for (let x = coreStart; x < coreEnd; x++) {
        const ci = srcRow + x - 8;
        const center = src[ci]!;
        const t2 = center + center;
        const acc =
          0x8000 +
          (src[ci - 1]! + src[ci + 1]! - t2) * c0 +
          (src[ci - 2]! + src[ci + 2]! - t2) * c1 +
          (src[ci - 3]! + src[ci + 3]! - t2) * c2 +
          (src[ci - 4]! + src[ci + 4]! - t2) * c3 +
          (src[ci - 5]! + src[ci + 5]! - t2) * c4 +
          (src[ci - 6]! + src[ci + 6]! - t2) * c5 +
          (src[ci - 7]! + src[ci + 7]! - t2) * c6 +
          (src[ci - 8]! + src[ci + 8]! - t2) * c7;
        dst[dstRow + x] = (center + (acc >> 16)) | 0;
      }
      for (let x = coreEnd; x < dstW; x++) dst[dstRow + x] = blurHorzEdgePx(src, srcRow, x - 8, w, 8, coeff);
    }
    return dstW;
  }
  for (let y = 0; y < h; y++) {
    const srcRow = y * w;
    const dstRow = y * dstW;
    for (let x = 0; x < coreStart; x++) dst[dstRow + x] = blurHorzEdgePx(src, srcRow, x - radius, w, radius, coeff);
    for (let x = coreStart; x < coreEnd; x++) {
      const ci = srcRow + x - radius;
      const center = src[ci]!;
      let acc = 0x8000;
      for (let i = radius; i > 0; i--) {
        acc += (src[ci - i]! + src[ci + i]! - 2 * center) * coeff[i - 1]!;
      }
      dst[dstRow + x] = (center + (acc >> 16)) | 0;
    }
    for (let x = coreEnd; x < dstW; x++) dst[dstRow + x] = blurHorzEdgePx(src, srcRow, x - radius, w, radius, coeff);
  }
  return dstW;
}

let blurAccRow = new Int32Array(0);

// One output row of the vertical blur using the row-streaming accumulator.
// Used for the edge rows (some taps out of range) and the generic radius path.
// acc = 0x8000 + sum_i (top_i + bot_i) * c_i - center * 2*sum(c_i): the
// per-pixel expression with the sum reordered; all terms are exact integers,
// so the result is bit-identical.
function blurVertRowStream(
  dst: Int16Array,
  src: Int16Array,
  w: number,
  h: number,
  y: number,
  radius: number,
  coeff: Int16Array,
  acc: Int32Array,
  totalC: number,
): void {
  const cy = y - radius;
  const dRow = y * w;
  acc.fill(0x8000, 0, w);
  for (let i = radius; i > 0; i--) {
    const c = coeff[i - 1]!;
    const t = cy - i;
    const b = cy + i;
    if (t >= 0 && t < h) {
      const tr = t * w;
      for (let x = 0; x < w; x++) acc[x]! += src[tr + x]! * c;
    }
    if (b >= 0 && b < h) {
      const br = b * w;
      for (let x = 0; x < w; x++) acc[x]! += src[br + x]! * c;
    }
  }
  if (cy >= 0 && cy < h) {
    const cr = cy * w;
    for (let x = 0; x < w; x++) {
      const center = src[cr + x]!;
      dst[dRow + x] = (center + ((acc[x]! - center * totalC) >> 16)) | 0;
    }
  } else {
    for (let x = 0; x < w; x++) {
      dst[dRow + x] = (acc[x]! >> 16) | 0;
    }
  }
}

function blurVert(dst: Int16Array, src: Int16Array, w: number, h: number, radius: number, coeff: Int16Array): number {
  const dstH = h + 2 * radius;
  if (blurAccRow.length < w) {
    let cap = blurAccRow.length > 0 ? blurAccRow.length : 1024;
    while (cap < w) cap *= 2;
    blurAccRow = new Int32Array(cap);
  }
  const acc = blurAccRow;
  let totalC = 0;
  for (let i = 0; i < radius; i++) totalC += 2 * coeff[i]!;

  // Core rows have every tap (cy-radius .. cy+radius) inside [0,h): one fused
  // pass gathers all taps per pixel with hoisted coefficients. Edge rows fall
  // back to the row-streaming accumulator. Same exact integer sum either way.
  const coreStart = Math.min(2 * radius, dstH);
  const coreEnd = Math.max(coreStart, Math.min(h, dstH));

  if (radius === 4) {
    const c0 = coeff[0]!, c1 = coeff[1]!, c2 = coeff[2]!, c3 = coeff[3]!;
    // Same coeff[2]=coeff[3]=0 shortcut as blurHorz for the level-0 case.
    if (c2 === 0 && c3 === 0) {
      for (let y = 0; y < coreStart; y++) blurVertRowStream(dst, src, w, h, y, 4, coeff, acc, totalC);
      for (let y = coreStart; y < coreEnd; y++) {
        const cy = y - 4;
        const cr = cy * w;
        const r1 = cr - w, r1b = cr + w;
        const r2 = cr - 2 * w, r2b = cr + 2 * w;
        const dRow = y * w;
        for (let x = 0; x < w; x++) {
          const center = src[cr + x]!;
          const acc0 =
            0x8000 +
            (src[r1 + x]! + src[r1b + x]!) * c0 +
            (src[r2 + x]! + src[r2b + x]!) * c1;
          dst[dRow + x] = (center + ((acc0 - center * totalC) >> 16)) | 0;
        }
      }
      for (let y = coreEnd; y < dstH; y++) blurVertRowStream(dst, src, w, h, y, 4, coeff, acc, totalC);
      return dstH;
    }
    for (let y = 0; y < coreStart; y++) blurVertRowStream(dst, src, w, h, y, 4, coeff, acc, totalC);
    for (let y = coreStart; y < coreEnd; y++) {
      const cy = y - 4;
      const cr = cy * w;
      const r1 = cr - w, r1b = cr + w;
      const r2 = cr - 2 * w, r2b = cr + 2 * w;
      const r3 = cr - 3 * w, r3b = cr + 3 * w;
      const r4 = cr - 4 * w, r4b = cr + 4 * w;
      const dRow = y * w;
      for (let x = 0; x < w; x++) {
        const center = src[cr + x]!;
        const acc0 =
          0x8000 +
          (src[r1 + x]! + src[r1b + x]!) * c0 +
          (src[r2 + x]! + src[r2b + x]!) * c1 +
          (src[r3 + x]! + src[r3b + x]!) * c2 +
          (src[r4 + x]! + src[r4b + x]!) * c3;
        dst[dRow + x] = (center + ((acc0 - center * totalC) >> 16)) | 0;
      }
    }
    for (let y = coreEnd; y < dstH; y++) blurVertRowStream(dst, src, w, h, y, 4, coeff, acc, totalC);
    return dstH;
  }
  if (radius === 8) {
    const c0 = coeff[0]!, c1 = coeff[1]!, c2 = coeff[2]!, c3 = coeff[3]!;
    const c4 = coeff[4]!, c5 = coeff[5]!, c6 = coeff[6]!, c7 = coeff[7]!;
    for (let y = 0; y < coreStart; y++) blurVertRowStream(dst, src, w, h, y, 8, coeff, acc, totalC);
    for (let y = coreStart; y < coreEnd; y++) {
      const cy = y - 8;
      const cr = cy * w;
      const r1 = cr - w, r1b = cr + w;
      const r2 = cr - 2 * w, r2b = cr + 2 * w;
      const r3 = cr - 3 * w, r3b = cr + 3 * w;
      const r4 = cr - 4 * w, r4b = cr + 4 * w;
      const r5 = cr - 5 * w, r5b = cr + 5 * w;
      const r6 = cr - 6 * w, r6b = cr + 6 * w;
      const r7 = cr - 7 * w, r7b = cr + 7 * w;
      const r8 = cr - 8 * w, r8b = cr + 8 * w;
      const dRow = y * w;
      for (let x = 0; x < w; x++) {
        const center = src[cr + x]!;
        const acc0 =
          0x8000 +
          (src[r1 + x]! + src[r1b + x]!) * c0 +
          (src[r2 + x]! + src[r2b + x]!) * c1 +
          (src[r3 + x]! + src[r3b + x]!) * c2 +
          (src[r4 + x]! + src[r4b + x]!) * c3 +
          (src[r5 + x]! + src[r5b + x]!) * c4 +
          (src[r6 + x]! + src[r6b + x]!) * c5 +
          (src[r7 + x]! + src[r7b + x]!) * c6 +
          (src[r8 + x]! + src[r8b + x]!) * c7;
        dst[dRow + x] = (center + ((acc0 - center * totalC) >> 16)) | 0;
      }
    }
    for (let y = coreEnd; y < dstH; y++) blurVertRowStream(dst, src, w, h, y, 8, coeff, acc, totalC);
    return dstH;
  }
  for (let y = 0; y < dstH; y++) blurVertRowStream(dst, src, w, h, y, radius, coeff, acc, totalC);
  return dstH;
}

// Fused vertical blur + dither/pack for the level-0 fast path. `mid` is the
// horizontal-blurred intermediate laid out with 2*radius zero rows of padding
// above and below the h real rows (real rows occupy [2*radius, 2*radius+h)).
// The padding lets every output row read all its taps with no bounds checks,
// so there is no separate edge path (the small-glyph killer in the generic
// blurVert). Output is written straight to the packed Uint8 buffer, folding in
// the final dither pass. Results are bit-identical to blurVert followed by the
// standalone pack loop: taps that fall on padding contribute exactly 0 (same as
// the generic out-of-range taps), the accumulator sum is the same exact integer
// (order-independent, reduced mod 2^32 by >>16), the Int16 truncation is applied
// before packing to match Int16Array storage, and the dither/clamp math matches.
function blurVertPackPadded(
  out: Uint8Array,
  mid: Int16Array,
  outW: number,
  h: number,
  outH: number,
  radius: number,
  coeff: Int16Array,
): void {
  let totalC = 0;
  for (let i = 0; i < radius; i++) totalC += 2 * coeff[i]!;
  const c0 = coeff[0]!, c1 = coeff[1]!, c2 = coeff[2]!, c3 = coeff[3]!;
  const two = radius === 4 && c2 === 0 && c3 === 0;
  for (let y = 0; y < outH; y++) {
    const cbRow = (y + radius) * outW;
    const oRow = y * outW;
    const ditherRow = (y & 1) << 4;
    if (two) {
      const t1 = cbRow - outW, b1 = cbRow + outW;
      const t2 = cbRow - 2 * outW, b2 = cbRow + 2 * outW;
      for (let x = 0; x < outW; x++) {
        const center = mid[cbRow + x]!;
        const acc =
          0x8000 +
          (mid[t1 + x]! + mid[b1 + x]!) * c0 +
          (mid[t2 + x]! + mid[b2 + x]!) * c1;
        let v = (center + ((acc - center * totalC) >> 16)) | 0;
        v = (v << 16) >> 16;
        let o = (v - (v >> 8) + DITHER_LINE[ditherRow + (x & 15)]!) >> 6;
        if (o < 0) o = 0;
        else if (o > 255) o = 255;
        out[oRow + x] = o;
      }
    } else if (radius === 4) {
      const t1 = cbRow - outW, b1 = cbRow + outW;
      const t2 = cbRow - 2 * outW, b2 = cbRow + 2 * outW;
      const t3 = cbRow - 3 * outW, b3 = cbRow + 3 * outW;
      const t4 = cbRow - 4 * outW, b4 = cbRow + 4 * outW;
      for (let x = 0; x < outW; x++) {
        const center = mid[cbRow + x]!;
        const acc =
          0x8000 +
          (mid[t1 + x]! + mid[b1 + x]!) * c0 +
          (mid[t2 + x]! + mid[b2 + x]!) * c1 +
          (mid[t3 + x]! + mid[b3 + x]!) * c2 +
          (mid[t4 + x]! + mid[b4 + x]!) * c3;
        let v = (center + ((acc - center * totalC) >> 16)) | 0;
        v = (v << 16) >> 16;
        let o = (v - (v >> 8) + DITHER_LINE[ditherRow + (x & 15)]!) >> 6;
        if (o < 0) o = 0;
        else if (o > 255) o = 255;
        out[oRow + x] = o;
      }
    } else if (radius === 8) {
      const c4 = coeff[4]!, c5 = coeff[5]!, c6 = coeff[6]!, c7 = coeff[7]!;
      const t1 = cbRow - outW, b1 = cbRow + outW;
      const t2 = cbRow - 2 * outW, b2 = cbRow + 2 * outW;
      const t3 = cbRow - 3 * outW, b3 = cbRow + 3 * outW;
      const t4 = cbRow - 4 * outW, b4 = cbRow + 4 * outW;
      const t5 = cbRow - 5 * outW, b5 = cbRow + 5 * outW;
      const t6 = cbRow - 6 * outW, b6 = cbRow + 6 * outW;
      const t7 = cbRow - 7 * outW, b7 = cbRow + 7 * outW;
      const t8 = cbRow - 8 * outW, b8 = cbRow + 8 * outW;
      for (let x = 0; x < outW; x++) {
        const center = mid[cbRow + x]!;
        const acc =
          0x8000 +
          (mid[t1 + x]! + mid[b1 + x]!) * c0 +
          (mid[t2 + x]! + mid[b2 + x]!) * c1 +
          (mid[t3 + x]! + mid[b3 + x]!) * c2 +
          (mid[t4 + x]! + mid[b4 + x]!) * c3 +
          (mid[t5 + x]! + mid[b5 + x]!) * c4 +
          (mid[t6 + x]! + mid[b6 + x]!) * c5 +
          (mid[t7 + x]! + mid[b7 + x]!) * c6 +
          (mid[t8 + x]! + mid[b8 + x]!) * c7;
        let v = (center + ((acc - center * totalC) >> 16)) | 0;
        v = (v << 16) >> 16;
        let o = (v - (v >> 8) + DITHER_LINE[ditherRow + (x & 15)]!) >> 6;
        if (o < 0) o = 0;
        else if (o > 255) o = 255;
        out[oRow + x] = o;
      }
    } else {
      for (let x = 0; x < outW; x++) {
        const center = mid[cbRow + x]!;
        let acc = 0x8000;
        for (let i = 1; i <= radius; i++) {
          acc += (mid[cbRow - i * outW + x]! + mid[cbRow + i * outW + x]!) * coeff[i - 1]!;
        }
        let v = (center + ((acc - center * totalC) >> 16)) | 0;
        v = (v << 16) >> 16;
        let o = (v - (v >> 8) + DITHER_LINE[ditherRow + (x & 15)]!) >> 6;
        if (o < 0) o = 0;
        else if (o > 255) o = 255;
        out[oRow + x] = o;
      }
    }
  }
}

// Level-0 fast path (blurX.level == blurY.level == 0): no shrink/expand passes.
// Fuses the unpack sweep into the horizontal pass' input and the dither/pack
// sweep into the vertical pass, and uses a zero-padded intermediate so the
// vertical pass is fully branch-free. Byte-identical to the generic path for
// level-0 inputs. This is where ~100% of real-content blur calls land.
function blurLevel0(
  bitmap: GrayBitmap,
  blurX: BlurMethod,
  blurY: BlurMethod,
): { bitmap: GrayBitmap; shiftX: number; shiftY: number } {
  const w = bitmap.width;
  const h = bitmap.rows;
  const rx = blurX.radius;
  const ry = blurY.radius;
  const outW = w + 2 * rx;
  const outH = h + 2 * ry;

  if (
    rx === 4 &&
    ry === 4 &&
    blurX.coeff[2] === 0 &&
    blurX.coeff[3] === 0 &&
    blurY.coeff[2] === 0 &&
    blurY.coeff[3] === 0
  ) {
    const area = w * h;
    const bounds = findNonZeroBounds(bitmap);
    if (!bounds) return blurLevel0R4TwoEmpty(bitmap);
    const fullWork = (w + 8) * (h + 8);
    const cropWork = (bounds.maxX - bounds.minX + 9) * (bounds.maxY - bounds.minY + 9);
    if (cropWork * 2 < fullWork) return blurLevel0R4TwoCropped(bitmap, blurX, blurY, bounds);
    if (area <= 4096) return blurLevel0R4Two(bitmap, blurX, blurY);
    if (area <= 32768) return blurLevel0R4TwoUnpack(bitmap, blurX, blurY);
  }

  const unpackSize = w * h;
  const midSize = (h + 4 * ry) * outW;
  const unpacked = acquireBlurScratchB(unpackSize);
  const mid = acquireBlurScratchA(midSize);

  unpackToInt16(bitmap.buffer, w, h, bitmap.pitch, unpacked);

  // Horizontal blur writes the h real rows into the padded band [2*ry, 2*ry+h).
  const padTop = 2 * ry * outW;
  blurHorz(mid.subarray(padTop), unpacked, w, h, rx, blurX.coeff);
  // Zero the padding rows the vertical pass reads for out-of-range taps.
  mid.fill(0, 0, padTop);
  mid.fill(0, padTop + h * outW, midSize);

  const outBuffer = new Uint8Array(outW * outH);
  if ((globalThis as any).__SUBFRAME_ALLOC_CENSUS__)
    recordAllocCensus("blur.output.alloc", outBuffer.length);
  blurVertPackPadded(outBuffer, mid, outW, h, outH, ry, blurY.coeff);

  const outBitmap = {
    buffer: outBuffer,
    width: outW,
    rows: outH,
    pitch: outW,
    pixelMode: PixelMode.Gray,
    numGrays: 256,
  };
  return { bitmap: outBitmap, shiftX: rx, shiftY: ry };
}

export function libassGaussianBlur(
  bitmap: GrayBitmap,
  r2x: number,
  r2y: number,
): { bitmap: GrayBitmap; shiftX: number; shiftY: number } {
  if (bitmap.width <= 0 || bitmap.rows <= 0) {
    return { bitmap, shiftX: 0, shiftY: 0 };
  }
  if (bitmap.pixelMode !== PixelMode.Gray) {
    return { bitmap, shiftX: 0, shiftY: 0 };
  }
  if (!(r2x > 0.001 || r2y > 0.001)) {
    return { bitmap, shiftX: 0, shiftY: 0 };
  }

  const blurX = findBestMethod(r2x);
  const blurY = r2y === r2x ? blurX : findBestMethod(r2y);

  // Level-0 fast path: fused unpack/pack + padded branch-free vertical pass.
  if (blurX.level === 0 && blurY.level === 0) {
    // Optional WASM-SIMD kernel, byte-identical to blurLevel0 (proven at init).
    // Falls back to the pure-JS blurLevel0 whenever it is unavailable/unproven.
    if (!blurWasmInit) {
      blurWasmInit = true;
      ensureBlurWasmReady(blurLevel0, findBestMethod);
    }
    const wasmRes = wasmBlurLevel0(bitmap, blurX, blurY);
    if (wasmRes) return wasmRes;
    return blurLevel0(bitmap, blurX, blurY);
  }

  let w = bitmap.width;
  let h = bitmap.rows;
  const offsetX = ((2 * blurX.radius + 9) << blurX.level) - 5;
  const offsetY = ((2 * blurY.radius + 9) << blurY.level) - 5;
  const endW = ((w + offsetX) & ~((1 << blurX.level) - 1)) - 4;
  const endH = ((h + offsetY) & ~((1 << blurY.level) - 1)) - 4;

  const maxSize = Math.max(w * h, endW * endH);
  const scratch = acquireBlurScratchPair(maxSize);
  let src = scratch.a;
  let dst = scratch.b;

  unpackToInt16(bitmap.buffer, w, h, bitmap.pitch, src);

  for (let i = 0; i < blurY.level; i++) {
    h = shrinkVert(dst, src, w, h);
    const tmp = src;
    src = dst;
    dst = tmp;
  }

  for (let i = 0; i < blurX.level; i++) {
    w = shrinkHorz(dst, src, w, h);
    const tmp = src;
    src = dst;
    dst = tmp;
  }

  w = blurHorz(dst, src, w, h, blurX.radius, blurX.coeff);
  {
    const tmp = src;
    src = dst;
    dst = tmp;
  }

  h = blurVert(dst, src, w, h, blurY.radius, blurY.coeff);
  {
    const tmp = src;
    src = dst;
    dst = tmp;
  }

  for (let i = 0; i < blurX.level; i++) {
    w = expandHorz(dst, src, w, h);
    const tmp = src;
    src = dst;
    dst = tmp;
  }

  for (let i = 0; i < blurY.level; i++) {
    h = expandVert(dst, src, w, h);
    const tmp = src;
    src = dst;
    dst = tmp;
  }

  const outW = w < endW ? w : endW;
  const outH = h < endH ? h : endH;
  const outBuffer = new Uint8Array(outW * outH);
  if ((globalThis as any).__SUBFRAME_ALLOC_CENSUS__)
    recordAllocCensus("blur.output.alloc", outBuffer.length);

  for (let y = 0; y < outH; y++) {
    const srcRow = y * w;
    const dstRow = y * outW;
    const ditherRow = (y & 1) << 4;
    for (let x = 0; x < outW; x++) {
      const v = src[srcRow + x]!;
      let out = (v - (v >> 8) + DITHER_LINE[ditherRow + (x & 15)]!) >> 6;
      if (out < 0) out = 0;
      else if (out > 255) out = 255;
      outBuffer[dstRow + x] = out;
    }
  }

  const shiftX = ((blurX.radius + 4) << blurX.level) - 4;
  const shiftY = ((blurY.radius + 4) << blurY.level) - 4;

  const outBitmap = {
    buffer: outBuffer,
    width: outW,
    rows: outH,
    pitch: outW,
    pixelMode: PixelMode.Gray,
    numGrays: 256,
  };

  return { bitmap: outBitmap, shiftX, shiftY };
}
