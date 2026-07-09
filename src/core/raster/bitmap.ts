import { SUBPIXEL_SCALE, toFixed26_6 } from "../math/fixed";

// Per-realm frame-local raster buffer pool. Module-level state is per-realm by
// construction (a worker realm loads this module independently), so no extra
// wiring is needed for the "per realm" requirement.
//
// ONLY buffers with a frame-local lifetime that NEVER enter a cache may be
// released here: pre-blur transform-glyph raster inputs after Gaussian blur has
// allocated its output, and worker frame/scatter layer source masks after
// packFrameArena has copied them into the transfer arena. Callers must prove the
// buffer is dead before releasing, and must pass a zeroed buffer contract to
// whatever writes into an acquired buffer.
//
// Keyed by EXACT byte length: a reused buffer is therefore always the precise
// size a fresh `new Uint8Array(n)` would have been, so pooling is byte-identical
// to allocation (acquire zeroes reused buffers; a fresh one is already zero).
// Rounded buckets were measured in Phase O and regressed realtime by churning
// the boundary scheduler, so keep the exact-size contract.
const BITMAP_POOL = new Map<number, Uint8Array[]>();
const FRAME_LOCAL_BITMAPS = new WeakSet<Uint8Array>();
let bitmapPoolBytes = 0;
let bitmapPoolHits = 0;
let bitmapPoolMisses = 0;
let bitmapPoolReleased = 0;
let bitmapPoolDropped = 0;
// Reuse for these transient raster inputs is dominated by intra-frame recycling
// (a raster is released right after its blur and reacquired by the next glyph of
// the same size), so a small pool captures almost all of it. Keep the retained
// footprint bounded rather than hoarding one buffer per distinct glyph size.
let BITMAP_POOL_BYTES_LIMIT = 8 * 1024 * 1024;
const BITMAP_POOL_PER_BUCKET = 32;

export type AllocCensusEntry = { bytes: number; count: number };
export type AllocCensusSnapshot = Record<string, AllocCensusEntry>;

let allocCensusEnabled =
  (globalThis as any)?.process?.env?.SUBFRAME_ALLOC_CENSUS === "1";
(globalThis as any).__SUBFRAME_ALLOC_CENSUS__ = allocCensusEnabled;
const allocCensus = new Map<string, AllocCensusEntry>();

export function setAllocCensusEnabled(enabled: boolean): void {
  allocCensusEnabled = enabled;
  (globalThis as any).__SUBFRAME_ALLOC_CENSUS__ = enabled;
  if (!enabled) allocCensus.clear();
}

export function isAllocCensusEnabled(): boolean {
  return allocCensusEnabled;
}

export function recordAllocCensus(site: string, bytes: number, count: number = 1): void {
  if (!allocCensusEnabled || bytes <= 0 || count <= 0) return;
  const prev = allocCensus.get(site);
  if (prev) {
    prev.bytes += bytes;
    prev.count += count;
  } else {
    allocCensus.set(site, { bytes, count });
  }
}

export function takeAllocCensusStats(): AllocCensusSnapshot | undefined {
  if (!allocCensusEnabled || allocCensus.size === 0) return undefined;
  const out: AllocCensusSnapshot = {};
  for (const [site, entry] of allocCensus) {
    out[site] = { bytes: entry.bytes, count: entry.count };
  }
  allocCensus.clear();
  return out;
}

// Acquire a zeroed buffer of exactly `n` bytes: a pooled one if available,
// otherwise a fresh allocation. Reused buffers are zeroed because the raster
// writes coverage sparsely and leaves uncovered pixels untouched.
export function acquireBitmapBuffer(n: number, site: string = "bitmapPool"): Uint8Array {
  if (n <= 0) return new Uint8Array(0);
  const list = BITMAP_POOL.get(n);
  if (list !== undefined && list.length > 0) {
    const buf = list.pop()!;
    bitmapPoolBytes -= n;
    bitmapPoolHits++;
    if ((globalThis as any).__SUBFRAME_ALLOC_CENSUS__)
      recordAllocCensus(`${site}.poolHit`, n);
    buf.fill(0);
    return buf;
  }
  bitmapPoolMisses++;
  if ((globalThis as any).__SUBFRAME_ALLOC_CENSUS__)
    recordAllocCensus(`${site}.poolMiss`, n);
  return new Uint8Array(n);
}

// Return a PROVABLY-DEAD buffer to the pool. Never call with a buffer that is
// still referenced by a layer, a cache entry, or another live glyph.
export function releaseBitmapBuffer(buf: Uint8Array): void {
  FRAME_LOCAL_BITMAPS.delete(buf);
  const n = buf.length;
  if (n <= 0) return;
  if (bitmapPoolBytes + n > BITMAP_POOL_BYTES_LIMIT) {
    bitmapPoolDropped++;
    if ((globalThis as any).__SUBFRAME_ALLOC_CENSUS__)
      recordAllocCensus("bitmapPool.dropLimit", n);
    return;
  }
  let list = BITMAP_POOL.get(n);
  if (list === undefined) {
    list = [];
    BITMAP_POOL.set(n, list);
  }
  if (list.length >= BITMAP_POOL_PER_BUCKET) {
    bitmapPoolDropped++;
    if ((globalThis as any).__SUBFRAME_ALLOC_CENSUS__)
      recordAllocCensus("bitmapPool.dropBucket", n);
    return;
  }
  list.push(buf);
  bitmapPoolBytes += n;
  bitmapPoolReleased++;
  if ((globalThis as any).__SUBFRAME_ALLOC_CENSUS__)
    recordAllocCensus("bitmapPool.release", n);
}

export function markFrameLocalBitmapBuffer(buf: Uint8Array): boolean {
  if (buf.length <= 0) return false;
  // Only exact full-view buffers enter the pool. Rect clips can replace a layer
  // mask with a subarray view whose logical stride and underlying ArrayBuffer no
  // longer match the exact-size pool contract.
  if (buf.byteOffset !== 0 || buf.byteLength !== buf.buffer.byteLength) return false;
  FRAME_LOCAL_BITMAPS.add(buf);
  return true;
}

export function releaseFrameLocalBitmapBuffer(buf: Uint8Array): boolean {
  if (!FRAME_LOCAL_BITMAPS.has(buf)) return false;
  releaseBitmapBuffer(buf);
  return true;
}

// Drop all pooled buffers (e.g. a prewarm worker shedding memory between
// bursts). No rendering-semantics change.
export function clearBitmapPool(): void {
  BITMAP_POOL.clear();
  bitmapPoolBytes = 0;
  bitmapPoolHits = 0;
  bitmapPoolMisses = 0;
  bitmapPoolReleased = 0;
  bitmapPoolDropped = 0;
}

export function setBitmapPoolLimit(bytes: number): void {
  BITMAP_POOL_BYTES_LIMIT = Math.max(0, bytes);
  if (bitmapPoolBytes <= BITMAP_POOL_BYTES_LIMIT) return;
  for (const list of BITMAP_POOL.values()) {
    while (list.length > 0 && bitmapPoolBytes > BITMAP_POOL_BYTES_LIMIT) {
      const buf = list.pop()!;
      bitmapPoolBytes -= buf.length;
    }
    if (bitmapPoolBytes <= BITMAP_POOL_BYTES_LIMIT) break;
  }
}

export function getBitmapPoolStats(): {
  bytes: number;
  buckets: number;
  hits: number;
  misses: number;
  released: number;
  dropped: number;
} {
  return {
    bytes: bitmapPoolBytes,
    buckets: BITMAP_POOL.size,
    hits: bitmapPoolHits,
    misses: bitmapPoolMisses,
    released: bitmapPoolReleased,
    dropped: bitmapPoolDropped,
  };
}

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
  if (sx === 0 && sy === 0) return;
  if (sx) {
    const mix = sx;
    for (let y = 0; y < height; y++) {
      const row = y * stride;
      let idx = row + width - 1;
      let prevIdx = idx - 1;
      for (; idx > row; idx--, prevIdx--) {
        const prev = buf[prevIdx]!;
        const b = (prev * mix) >> 6;
        if (b !== 0) {
          buf[prevIdx] = prev - b;
          buf[idx] = buf[idx]! + b;
        }
      }
    }
  }
  if (sy) {
    const mix = sy;
    // Row-major (columns are independent, per-column step order preserved).
    for (let y = height - 1; y > 0; y--) {
      const row = y * stride;
      const prevRow = row - stride;
      for (let x = 0; x < width; x++) {
        const prevIdx = prevRow + x;
        const prev = buf[prevIdx]!;
        const b = (prev * mix) >> 6;
        if (b !== 0) {
          buf[prevIdx] = prev - b;
          buf[row + x] = buf[row + x]! + b;
        }
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
