import type { Effect } from "subforge/core";
import type { ClipShape } from "../tags/types";
import { buildClipMask, parseClipRect } from "./parser";

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
        const x0 = Math.round(rect.x0 * screenScaleX);
        const y0 = Math.round(rect.y0 * screenScaleY);
        const x1 = Math.round(rect.x1 * screenScaleX);
        const y1 = Math.round(rect.y1 * screenScaleY);
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
  const { bitmap, width, height, stride, originX, originY } = layer;
  // Match libass-style integer placement: clip should use the same rounded origin as compositing.
  const baseX = Math.round(originX);
  const baseY = Math.round(originY);
  if (clip.type === "rect") {
    const x0 = clip.x0;
    const y0 = clip.y0;
    const x1 = clip.x1;
    const y1 = clip.y1;
    const inv = clip.inverse;
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
