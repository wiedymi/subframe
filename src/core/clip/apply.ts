import type { Effect } from "subforge/core";
import type { ClipShape, ClipMask, ClipMaskBoxes } from "../tags/types";
import { buildClipMask, parseClipRect } from "./parser";

function roundAwayFromZero(value: number): number {
  if (!Number.isFinite(value)) return 0;
  const abs = Math.abs(value);
  const rounded = Math.floor(abs + 0.5);
  return value < 0 ? -rounded : rounded;
}

export function findClipEffect(
  effects: Effect[],
  screenScaleX: number,
  screenScaleY: number,
): ClipShape | null {
  for (let i = effects.length - 1; i >= 0; i--) {
    const ef = effects[i]!;
    if (ef.type === "clip") {
      const params = ef.params as { path: string; inverse: boolean };
      const rect = parseClipRect(params.path);
      if (rect) {
        // libass rounds clip bounds to integer screen coordinates.
        const x0 = roundAwayFromZero(rect.x0 * screenScaleX);
        const y0 = roundAwayFromZero(rect.y0 * screenScaleY);
        const x1 = roundAwayFromZero(rect.x1 * screenScaleX);
        const y1 = roundAwayFromZero(rect.y1 * screenScaleY);
        return { type: "rect", x0, y0, x1, y1, inverse: params.inverse };
      }
      const mask = buildClipMask(
        params.path,
        params.inverse,
        screenScaleX,
        screenScaleY,
      );
      if (mask) return mask;
    }
  }
  return null;
}

// Per-mask precomputed extents, memoized by mask identity. A clip mask is built
// once per event (findClipEffect) and reused for every layer of that event, so
// this is computed once and read for every clipped layer.
//   nz*  : tight bbox (mask-local) of any pixel > 0 — the only region an inverse
//          clip can dim (outside it alpha=255 => untouched) and the only region a
//          non-inverse clip leaves nonzero.
//   op*  : the maximal axis-aligned rectangle where every pixel == 255 — a region
//          a non-inverse clip leaves fully untouched (alpha=255 => no write).
// Both feed pure fast-path SKIPS that never alter a pixel a byte differently from
// the exact per-pixel loop below; they only avoid work the loop would prove a
// no-op. hasNz/hasOpaque false => that extent is empty.
const maskBoxCache = new WeakMap<ClipMask, ClipMaskBoxes>();
const OPAQUE_RECT_MIN_AREA = 64 * 1024;

function computeMaskBoxes(mask: ClipMask): ClipMaskBoxes {
  const { bitmap, width, height, stride } = mask;
  let nzX0 = Infinity;
  let nzY0 = Infinity;
  let nzX1 = -Infinity;
  let nzY1 = -Infinity;
  for (let y = 0; y < height; y++) {
    const row = y * stride;
    for (let x = 0; x < width; x++) {
      if (bitmap[row + x]! > 0) {
        if (x < nzX0) nzX0 = x;
        if (x + 1 > nzX1) nzX1 = x + 1;
        if (y < nzY0) nzY0 = y;
        if (y + 1 > nzY1) nzY1 = y + 1;
      }
    }
  }
  const hasNz = nzX1 > nzX0 && nzY1 > nzY0;

  // Maximal all-255 rectangle: largest-rectangle-in-histogram per row, treating
  // a 255 pixel as a filled cell. Bounds the region a non-inverse clip skips.
  // Only non-inverse masks consult it, so an inverse mask (the complex \iclip
  // paths) skips this second pass entirely.
  let bestArea = 0;
  let opX0 = 0;
  let opY0 = 0;
  let opX1 = 0;
  let opY1 = 0;
  // Small masks are cheap to scan exactly in applyClip; skip this second pass
  // there. Losing hasOpaque only loses a no-op fast path, not output bytes.
  if (hasNz && !mask.inverse && width * height >= OPAQUE_RECT_MIN_AREA) {
    const hist = new Int32Array(width);
    const stackX = new Int32Array(width + 1);
    const stackH = new Int32Array(width + 1);
    for (let y = 0; y < height; y++) {
      const row = y * stride;
      for (let x = 0; x < width; x++) {
        hist[x] = bitmap[row + x] === 255 ? hist[x]! + 1 : 0;
      }
      let sp = 0;
      for (let x = 0; x <= width; x++) {
        const h = x < width ? hist[x]! : 0;
        let startX = x;
        while (sp > 0 && stackH[sp - 1]! >= h) {
          sp--;
          const ph = stackH[sp]!;
          const px = stackX[sp]!;
          const area = ph * (x - px);
          if (area > bestArea) {
            bestArea = area;
            opX0 = px;
            opY0 = y - ph + 1;
            opX1 = x;
            opY1 = y + 1;
          }
          startX = px;
        }
        stackX[sp] = startX;
        stackH[sp] = h;
        sp++;
      }
    }
  }
  const boxes: ClipMaskBoxes = {
    hasNz,
    nzX0: hasNz ? nzX0 : 0,
    nzY0: hasNz ? nzY0 : 0,
    nzX1: hasNz ? nzX1 : 0,
    nzY1: hasNz ? nzY1 : 0,
    hasOpaque: bestArea > 0,
    opX0,
    opY0,
    opX1,
    opY1,
  };
  return boxes;
}

function getMaskBoxes(mask: ClipMask): ClipMaskBoxes {
  let boxes = mask.boxes;
  if (boxes) return boxes;
  boxes = maskBoxCache.get(mask);
  if (!boxes) {
    boxes = computeMaskBoxes(mask);
    maskBoxCache.set(mask, boxes);
  }
  return boxes;
}

export function applyClip(
  layer: {
    bitmap: Uint8Array;
    width: number;
    height: number;
    stride: number;
    originX: number;
    originY: number;
  },
  clip: ClipShape,
): void {
  // Match libass-style integer placement: clip should use the same rounded origin as compositing.
  const baseX = roundAwayFromZero(layer.originX);
  const baseY = roundAwayFromZero(layer.originY);
  if (clip.type === "rect") {
    const x0 = clip.x0;
    const y0 = clip.y0;
    const x1 = clip.x1;
    const y1 = clip.y1;
    const inv = clip.inverse;
    if (!inv) {
      const layerX0 = baseX;
      const layerY0 = baseY;
      const layerX1 = baseX + layer.width;
      const layerY1 = baseY + layer.height;
      const ix0 = Math.max(x0, layerX0);
      const iy0 = Math.max(y0, layerY0);
      const ix1 = Math.min(x1, layerX1);
      const iy1 = Math.min(y1, layerY1);
      if (ix0 <= layerX0 && iy0 <= layerY0 && ix1 >= layerX1 && iy1 >= layerY1) {
        return;
      }
      if (ix1 <= ix0 || iy1 <= iy0) {
        layer.width = 0;
        layer.height = 0;
        layer.bitmap = layer.bitmap.subarray(0, 0);
        return;
      }
      const offsetX = ix0 - layerX0;
      const offsetY = iy0 - layerY0;
      layer.bitmap = layer.bitmap.subarray(offsetY * layer.stride + offsetX);
      layer.width = ix1 - ix0;
      layer.height = iy1 - iy0;
      layer.originX = ix0;
      layer.originY = iy0;
      return;
    }
    const { bitmap, width, height, stride } = layer;
    for (let y = 0; y < height; y++) {
      const dstY = baseY + y;
      const row = y * stride;
      for (let x = 0; x < width; x++) {
        const dstX = baseX + x;
        const inside = dstX >= x0 && dstX < x1 && dstY >= y0 && dstY < y1;
        if (inv ? inside : !inside) {
          bitmap[row + x] = 0;
        }
      }
    }
    return;
  }

  const mask = clip;
  const { bitmap, width, height, stride } = layer;
  const inv = mask.inverse;
  const mOX = mask.originX;
  const mOY = mask.originY;
  const mW = mask.width;
  const mBmp = mask.bitmap;
  const mStride = mask.stride;
  const boxes = getMaskBoxes(mask);

  // Whole-layer fast paths. Every pixel these skip is one the exact loop below
  // would leave byte-identical (alpha resolves to 255 => no write), or, for an
  // all-zero non-inverse mask, uniformly zeroed.
  const lx0 = baseX;
  const ly0 = baseY;
  const lx1 = baseX + width;
  const ly1 = baseY + height;
  if (inv) {
    // Inverse: alpha = 255 - maskAlpha. Outside the mask's nonzero bbox the mask
    // is 0 => alpha 255 => untouched. Whole layer outside it (or an all-zero
    // mask) => no writes.
    if (!boxes.hasNz) return;
    const nzsx0 = mOX + boxes.nzX0;
    const nzsy0 = mOY + boxes.nzY0;
    const nzsx1 = mOX + boxes.nzX1;
    const nzsy1 = mOY + boxes.nzY1;
    if (lx1 <= nzsx0 || lx0 >= nzsx1 || ly1 <= nzsy0 || ly0 >= nzsy1) return;
  } else {
    // Non-inverse: alpha = maskAlpha. An all-zero mask zeroes everything; a layer
    // fully inside a solid-255 region is left untouched.
    if (!boxes.hasNz) {
      for (let y = 0; y < height; y++) {
        const row = y * stride;
        bitmap.fill(0, row, row + width);
      }
      return;
    }
    if (boxes.hasOpaque) {
      const opsx0 = mOX + boxes.opX0;
      const opsy0 = mOY + boxes.opY0;
      const opsx1 = mOX + boxes.opX1;
      const opsy1 = mOY + boxes.opY1;
      if (lx0 >= opsx0 && ly0 >= opsy0 && lx1 <= opsx1 && ly1 <= opsy1) return;
    }
  }

  // Bound per-row work to the mask's nonzero extent. Layer rows/cols outside it
  // resolve to a uniform result (0 for non-inverse, unchanged for inverse); only
  // the intersection needs the per-pixel mask read.
  const rowY0 = mOY + boxes.nzY0;
  const rowY1 = mOY + boxes.nzY1;
  // Layer-x window that maps into the mask's nonzero columns.
  let cx0 = mOX + boxes.nzX0 - baseX;
  let cx1 = mOX + boxes.nzX1 - baseX;
  if (cx0 < 0) cx0 = 0;
  if (cx1 > width) cx1 = width;
  for (let y = 0; y < height; y++) {
    const dstY = baseY + y;
    const row = y * stride;
    if (dstY < rowY0 || dstY >= rowY1) {
      // Row has no nonzero mask pixel.
      if (!inv) bitmap.fill(0, row, row + width);
      continue;
    }
    const maskRow = (dstY - mOY) * mStride;
    if (!inv) {
      // Columns outside the nonzero window map to maskAlpha 0 => zeroed.
      if (cx0 > 0) bitmap.fill(0, row, row + cx0);
      if (cx1 < width) bitmap.fill(0, row + cx1, row + width);
    }
    for (let x = cx0; x < cx1; x++) {
      const mx = baseX + x - mOX;
      let maskAlpha = 0;
      if (mx >= 0 && mx < mW) maskAlpha = mBmp[maskRow + mx]!;
      const alpha = inv ? 255 - maskAlpha : maskAlpha;
      if (alpha === 0) {
        bitmap[row + x] = 0;
      } else if (alpha < 255) {
        bitmap[row + x] = Math.round((bitmap[row + x]! * alpha) / 255);
      }
    }
  }
}
