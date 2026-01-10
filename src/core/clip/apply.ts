import type { Effect } from "subforge/core";
import type { ClipShape } from "../tags/types";
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
  for (let y = 0; y < height; y++) {
    const dstY = baseY + y;
    const my = dstY - mask.originY;
    const row = y * stride;
    if (my < 0 || my >= mask.height) {
      if (!inv) {
        bitmap.fill(0, row, row + width);
      }
      continue;
    }
    const maskRow = my * mask.stride;
    for (let x = 0; x < width; x++) {
      const dstX = baseX + x;
      const mx = dstX - mask.originX;
      let maskAlpha = 0;
      if (mx >= 0 && mx < mask.width) maskAlpha = mask.bitmap[maskRow + mx]!;
      const alpha = inv ? 255 - maskAlpha : maskAlpha;
      if (alpha === 0) {
        bitmap[row + x] = 0;
      } else if (alpha < 255) {
        bitmap[row + x] = Math.round((bitmap[row + x]! * alpha) / 255);
      }
    }
  }
}
