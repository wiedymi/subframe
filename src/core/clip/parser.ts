import type { ClipMask, ClipMaskBoxes } from "../tags/types";
import { PathBuilder, computeTightBounds, PixelMode } from "text-shaper";

// Cross-event clip mask reuse for frame-by-frame typeset scripts. The cache key
// is exactly buildClipMask's semantic inputs; a hit returns the same ClipMask
// object so apply.ts's WeakMap box cache also hits. Normal render consumers read
// ClipMask fields only. Worker transfer code clones the clip object before
// replacing bitmap buffers, so cached masks are not detached.
let CLIP_MASK_CACHE_BYTES_LIMIT = 16 * 1024 * 1024;
const CLIP_MASK_CACHE = new Map<string, { mask: ClipMask; bytes: number }>();
let clipMaskCacheBytes = 0;
const CLIP_MASK_BOX_CACHE_LIMIT = 4096;
const CLIP_MASK_BOX_CACHE = new Map<
  string,
  { width: number; height: number; stride: number; boxes: ClipMaskBoxes }
>();

function clipMaskCacheKey(
  path: string,
  inverse: boolean,
  screenScaleX: number,
  screenScaleY: number,
): string {
  return `${inverse ? 1 : 0}|${screenScaleX}|${screenScaleY}|${path}`;
}

function trimClipMaskCache(): void {
  while (clipMaskCacheBytes > CLIP_MASK_CACHE_BYTES_LIMIT && CLIP_MASK_CACHE.size > 0) {
    const first = CLIP_MASK_CACHE.keys().next();
    if (first.done) break;
    const removed = CLIP_MASK_CACHE.get(first.value);
    if (removed) clipMaskCacheBytes -= removed.bytes;
    CLIP_MASK_CACHE.delete(first.value);
  }
}

export function setClipMaskCacheLimit(bytes: number): void {
  CLIP_MASK_CACHE_BYTES_LIMIT = Math.max(0, bytes);
  trimClipMaskCache();
}

export function clearClipMaskCache(): void {
  CLIP_MASK_CACHE.clear();
  CLIP_MASK_BOX_CACHE.clear();
  clipMaskCacheBytes = 0;
}

export function getClipMaskCacheStats(): {
  bytes: number;
  entries: number;
  limitBytes: number;
} {
  return {
    bytes: clipMaskCacheBytes,
    entries: CLIP_MASK_CACHE.size,
    limitBytes: CLIP_MASK_CACHE_BYTES_LIMIT,
  };
}

function getCachedClipMaskBoxes(
  key: string,
  width: number,
  height: number,
  stride: number,
): ClipMaskBoxes | null {
  const cached = CLIP_MASK_BOX_CACHE.get(key);
  if (!cached) return null;
  if (
    cached.width !== width ||
    cached.height !== height ||
    cached.stride !== stride
  ) {
    CLIP_MASK_BOX_CACHE.delete(key);
    return null;
  }
  CLIP_MASK_BOX_CACHE.delete(key);
  CLIP_MASK_BOX_CACHE.set(key, cached);
  return cached.boxes;
}

function setCachedClipMaskBoxes(
  key: string,
  width: number,
  height: number,
  stride: number,
  boxes: ClipMaskBoxes,
): void {
  if (CLIP_MASK_BOX_CACHE.has(key)) CLIP_MASK_BOX_CACHE.delete(key);
  CLIP_MASK_BOX_CACHE.set(key, { width, height, stride, boxes });
  while (CLIP_MASK_BOX_CACHE.size > CLIP_MASK_BOX_CACHE_LIMIT) {
    const first = CLIP_MASK_BOX_CACHE.keys().next();
    if (first.done) break;
    CLIP_MASK_BOX_CACHE.delete(first.value);
  }
}

function deriveTightClipMaskBoxes(
  width: number,
  height: number,
): ClipMaskBoxes {
  const hasNz = width > 0 && height > 0;
  // text-shaper's rasterized clip bitmap is already cropped to the path's
  // raster bounds. Treating that whole bitmap as the nonzero extent is a
  // conservative box: if an edge row/column is actually zero, applyClip's exact
  // per-pixel loop will still read alpha 0 and produce the same bytes. We skip
  // the maximal-opaque rectangle on purpose; it is only a no-op fast path, and
  // computing it cost more than it saved on frame-by-frame typesets.
  return {
    hasNz,
    nzX0: 0,
    nzY0: 0,
    nzX1: hasNz ? width : 0,
    nzY1: hasNz ? height : 0,
    hasOpaque: false,
    opX0: 0,
    opY0: 0,
    opX1: 0,
    opY1: 0,
  };
}

export function parseClipRect(
  path: string,
): { x0: number; y0: number; x1: number; y1: number } | null {
  const raw = path.trim();
  const s = raw.startsWith("(") && raw.endsWith(")") ? raw.slice(1, -1) : raw;
  const parts = s.split(",").map((p) => p.trim());
  if (parts.length !== 4) return null;
  const n0 = Number(parts[0]);
  const n1 = Number(parts[1]);
  const n2 = Number(parts[2]);
  const n3 = Number(parts[3]);
  if (
    !Number.isFinite(n0) ||
    !Number.isFinite(n1) ||
    !Number.isFinite(n2) ||
    !Number.isFinite(n3)
  )
    return null;
  const x0 = Math.min(n0, n2);
  const x1 = Math.max(n0, n2);
  const y0 = Math.min(n1, n3);
  const y1 = Math.max(n1, n3);
  return { x0, y0, x1, y1 };
}

function tokenizeDrawing(source: string): Array<string | number> {
  const tokens: Array<string | number> = [];
  let i = 0;
  while (i < source.length) {
    const c = source[i]!;
    if ((c >= "a" && c <= "z") || (c >= "A" && c <= "Z")) {
      tokens[tokens.length] = c.toLowerCase();
      i++;
      continue;
    }
    if (c === "-" || c === "+" || (c >= "0" && c <= "9") || c === ".") {
      let j = i + 1;
      while (j < source.length) {
        const d = source[j]!;
        if (
          (d >= "0" && d <= "9") ||
          d === "." ||
          d === "e" ||
          d === "E" ||
          d === "+" ||
          d === "-"
        ) {
          j++;
        } else {
          break;
        }
      }
      const num = Number(source.slice(i, j));
      if (Number.isFinite(num)) tokens[tokens.length] = num;
      i = j;
      continue;
    }
    i++;
  }
  return tokens;
}

type Point = { x: number; y: number };

type PathCommand =
  | { type: "M"; x: number; y: number }
  | { type: "L"; x: number; y: number }
  | {
      type: "C";
      x1: number;
      y1: number;
      x2: number;
      y2: number;
      x: number;
      y: number;
    }
  | { type: "Z" };

function addSplineSegment(
  commands: PathCommand[],
  p0: Point,
  p1: Point,
  p2: Point,
  p3: Point,
  contourStarted: boolean,
): boolean {
  const x01 = (p1.x - p0.x) / 3;
  const y01 = (p1.y - p0.y) / 3;
  const x12 = (p2.x - p1.x) / 3;
  const y12 = (p2.y - p1.y) / 3;
  const x23 = (p3.x - p2.x) / 3;
  const y23 = (p3.y - p2.y) / 3;

  const p0x = p1.x + (x12 - x01) / 2;
  const p0y = p1.y + (y12 - y01) / 2;
  const p3x = p2.x + (x23 - x12) / 2;
  const p3y = p2.y + (y23 - y12) / 2;
  const p1x = p1.x + x12;
  const p1y = p1.y + y12;
  const p2x = p2.x - x12;
  const p2y = p2.y - y12;

  if (!contourStarted)
    commands[commands.length] = { type: "M", x: p0x, y: p0y };
  commands[commands.length] = {
    type: "C",
    x1: p1x,
    y1: p1y,
    x2: p2x,
    y2: p2y,
    x: p3x,
    y: p3y,
  };
  return true;
}

export function parseDrawingPath(
  source: string,
  scaleFactor: number,
): { commands: PathCommand[]; bounds: any } | null {
  const tokens = tokenizeDrawing(source);
  const commands: PathCommand[] = [];
  const coord = (value: number) => (Math.round(value * 64) / 64) * scaleFactor;
  let penX = 0;
  let penY = 0;
  let rootSeen = false;
  let contourStarted = false;
  let moveEmitted = false;
  let splineActive = false;
  let splineStart: Point[] = [];
  let splinePoints: Point[] = [];

  const moveTo = (x: number, y: number) => {
    commands[commands.length] = { type: "M", x, y };
    moveEmitted = true;
  };

  const closeContour = () => {
    if (!contourStarted) return;
    commands[commands.length] = { type: "Z" };
    contourStarted = false;
    moveEmitted = false;
  };

  // Match libass ass_drawing.c: `m` closes a started contour, `n` only moves
  // the pen, and finalization closes any still-started contour. B-spline `c`
  // closes the spline by repeating its first points, but contour closure still
  // happens only through `m` or finalization.
  const flushSpline = (closeSpline: boolean) => {
    if (!splineActive || splinePoints.length < 4) {
      splineActive = false;
      splinePoints = [];
      splineStart = [];
      return;
    }
    if (closeSpline && splineStart.length === 3) {
      splinePoints[splinePoints.length] = splineStart[0]!;
      splinePoints[splinePoints.length] = splineStart[1]!;
      splinePoints[splinePoints.length] = splineStart[2]!;
    }
    let p0 = splinePoints[0]!;
    let p1 = splinePoints[1]!;
    let p2 = splinePoints[2]!;
    for (let i = 3; i < splinePoints.length; i++) {
      const p3 = splinePoints[i]!;
      contourStarted = addSplineSegment(
        commands,
        p0,
        p1,
        p2,
        p3,
        contourStarted,
      );
      p0 = p1;
      p1 = p2;
      p2 = p3;
    }
    splineActive = false;
    splinePoints = [];
    splineStart = [];
  };

  let i = 0;
  while (i < tokens.length) {
    const tok = tokens[i]!;
    if (typeof tok !== "string") {
      i++;
      continue;
    }
    const cmd = tok;
    i++;
    const nums: number[] = [];
    while (i < tokens.length && typeof tokens[i] === "number") {
      nums[nums.length] = tokens[i] as number;
      i++;
    }

    if (cmd === "m" || cmd === "n") {
      flushSpline(false);
      for (let vi = 0; vi + 1 < nums.length; vi += 2) {
        const x = coord(nums[vi]!);
        const y = coord(nums[vi + 1]!);
        if (cmd === "m") {
          rootSeen = true;
          closeContour();
          moveTo(x, y);
        } else if (!rootSeen) {
          return null;
        } else if (!contourStarted) {
          moveTo(x, y);
        }
        penX = x;
        penY = y;
      }
      continue;
    }
    if (cmd === "l") {
      if (!rootSeen) continue;
      flushSpline(false);
      for (let vi = 0; vi + 1 < nums.length; vi += 2) {
        const x = coord(nums[vi]!);
        const y = coord(nums[vi + 1]!);
        if (!contourStarted && !moveEmitted) moveTo(penX, penY);
        commands[commands.length] = { type: "L", x, y };
        contourStarted = true;
        moveEmitted = true;
        penX = x;
        penY = y;
      }
      continue;
    }
    if (cmd === "b") {
      if (!rootSeen) continue;
      flushSpline(false);
      for (let vi = 0; vi + 5 < nums.length; vi += 6) {
        const x1 = coord(nums[vi]!);
        const y1 = coord(nums[vi + 1]!);
        const x2 = coord(nums[vi + 2]!);
        const y2 = coord(nums[vi + 3]!);
        const x = coord(nums[vi + 4]!);
        const y = coord(nums[vi + 5]!);
        if (!contourStarted && !moveEmitted) moveTo(penX, penY);
        commands[commands.length] = { type: "C", x1, y1, x2, y2, x, y };
        contourStarted = true;
        moveEmitted = true;
        penX = x;
        penY = y;
      }
      continue;
    }
    if (cmd === "s") {
      if (!rootSeen) continue;
      flushSpline(false);
      if (nums.length < 6) continue;
      splineActive = true;
      splinePoints = [];
      splineStart = [];
      const startPoint = { x: penX, y: penY };
      splinePoints[splinePoints.length] = startPoint;
      splineStart[splineStart.length] = startPoint;
      for (let vi = 0; vi + 1 < nums.length; vi += 2) {
        const x = coord(nums[vi]!);
        const y = coord(nums[vi + 1]!);
        const pt = { x, y };
        splinePoints[splinePoints.length] = pt;
        if (splineStart.length < 3) splineStart[splineStart.length] = pt;
        penX = x;
        penY = y;
      }
      continue;
    }
    if (cmd === "p") {
      if (!rootSeen) continue;
      if (!splineActive || splinePoints.length < 3) continue;
      for (let vi = 0; vi + 1 < nums.length; vi += 2) {
        const x = coord(nums[vi]!);
        const y = coord(nums[vi + 1]!);
        splinePoints[splinePoints.length] = { x, y };
        penX = x;
        penY = y;
      }
      continue;
    }
    if (cmd === "c") {
      flushSpline(true);
      continue;
    }
  }

  flushSpline(false);
  closeContour();

  if (commands.length === 0) return null;

  const pathObj = { commands, bounds: null as any };
  pathObj.bounds = computeTightBounds(pathObj as any);
  if (!pathObj.bounds) return null;
  return pathObj;
}

export function buildClipMask(
  path: string,
  inverse: boolean,
  screenScaleX: number,
  screenScaleY: number,
): ClipMask | null {
  const key = clipMaskCacheKey(path, inverse, screenScaleX, screenScaleY);
  const cached = CLIP_MASK_CACHE.get(key);
  if (cached) {
    CLIP_MASK_CACHE.delete(key);
    CLIP_MASK_CACHE.set(key, cached);
    return cached.mask;
  }

  const raw = path.trim();
  const s = raw.startsWith("(") && raw.endsWith(")") ? raw.slice(1, -1) : raw;
  let scale = 1;
  let body = s;
  const scaleMatch = body.match(/^(-?\d+(?:\.\d+)?),(.*)$/);
  if (scaleMatch) {
    scale = parseFloat(scaleMatch[1]!);
    body = scaleMatch[2]!;
  }
  let scaleFactor = 1;
  if (Number.isFinite(scale) && scale > 1)
    scaleFactor = 1 / (1 << (Math.round(scale) - 1));

  const pathObj = parseDrawingPath(body, scaleFactor);
  if (!pathObj) return null;

  let builder = PathBuilder.fromPath(pathObj as any);
  if (screenScaleX !== 1 || screenScaleY !== 1) {
    builder = builder.scale(screenScaleX, screenScaleY);
  }
  const raster = builder
    .rasterizeAuto({ padding: 0, pixelMode: PixelMode.Gray, flipY: false })
    .toRasterizedGlyph();
  let boxes = getCachedClipMaskBoxes(
    key,
    raster.bitmap.width,
    raster.bitmap.rows,
    raster.bitmap.pitch,
  );
  if (!boxes) {
    boxes = deriveTightClipMaskBoxes(
      raster.bitmap.width,
      raster.bitmap.rows,
    );
    setCachedClipMaskBoxes(
      key,
      raster.bitmap.width,
      raster.bitmap.rows,
      raster.bitmap.pitch,
      boxes,
    );
  }
  const mask: ClipMask = {
    type: "mask",
    bitmap: raster.bitmap.buffer,
    width: raster.bitmap.width,
    height: raster.bitmap.rows,
    stride: raster.bitmap.pitch,
    originX: raster.bearingX,
    // text-shaper reports bearingY as -(bitmap top): negate to get the
    // screen-space y of the mask bitmap's top-left corner.
    originY: -raster.bearingY,
    inverse,
    boxes,
  };
  const bytes = mask.bitmap.byteLength;
  if (CLIP_MASK_CACHE_BYTES_LIMIT > 0 && bytes <= CLIP_MASK_CACHE_BYTES_LIMIT) {
    CLIP_MASK_CACHE.set(key, { mask, bytes });
    clipMaskCacheBytes += bytes;
    trimClipMaskCache();
  }
  return mask;
}
