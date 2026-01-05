import type { ClipMask } from "../tags/types";
import { PathBuilder, computeTightBounds, PixelMode } from "text-shaper";

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
  started: boolean,
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

  if (!started) commands[commands.length] = { type: "M", x: p0x, y: p0y };
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
  let penX = 0;
  let penY = 0;
  let started = false;
  let splineActive = false;
  let splineStart: Point[] = [];
  let splinePoints: Point[] = [];

  const flushSpline = (close: boolean) => {
    if (!splineActive || splinePoints.length < 4) {
      splineActive = false;
      splinePoints = [];
      splineStart = [];
      return;
    }
    if (close && splineStart.length === 3) {
      splinePoints[splinePoints.length] = splineStart[0]!;
      splinePoints[splinePoints.length] = splineStart[1]!;
      splinePoints[splinePoints.length] = splineStart[2]!;
    }
    let p0 = splinePoints[0]!;
    let p1 = splinePoints[1]!;
    let p2 = splinePoints[2]!;
    for (let i = 3; i < splinePoints.length; i++) {
      const p3 = splinePoints[i]!;
      started = addSplineSegment(commands, p0, p1, p2, p3, started);
      p0 = p1;
      p1 = p2;
      p2 = p3;
    }
    if (close) commands[commands.length] = { type: "Z" };
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
        const x = nums[vi]! * scaleFactor;
        const y = nums[vi + 1]! * scaleFactor;
        if (started && vi === 0 && cmd === "m")
          commands[commands.length] = { type: "Z" };
        commands[commands.length] = { type: "M", x, y };
        penX = x;
        penY = y;
        started = true;
      }
      continue;
    }
    if (cmd === "l") {
      flushSpline(false);
      for (let vi = 0; vi + 1 < nums.length; vi += 2) {
        const x = nums[vi]! * scaleFactor;
        const y = nums[vi + 1]! * scaleFactor;
        if (!started) {
          commands[commands.length] = { type: "M", x: penX, y: penY };
          started = true;
        }
        commands[commands.length] = { type: "L", x, y };
        penX = x;
        penY = y;
      }
      continue;
    }
    if (cmd === "b") {
      flushSpline(false);
      for (let vi = 0; vi + 5 < nums.length; vi += 6) {
        const x1 = nums[vi]! * scaleFactor;
        const y1 = nums[vi + 1]! * scaleFactor;
        const x2 = nums[vi + 2]! * scaleFactor;
        const y2 = nums[vi + 3]! * scaleFactor;
        const x = nums[vi + 4]! * scaleFactor;
        const y = nums[vi + 5]! * scaleFactor;
        if (!started) {
          commands[commands.length] = { type: "M", x: penX, y: penY };
          started = true;
        }
        commands[commands.length] = { type: "C", x1, y1, x2, y2, x, y };
        penX = x;
        penY = y;
      }
      continue;
    }
    if (cmd === "s") {
      flushSpline(false);
      if (nums.length < 6) continue;
      splineActive = true;
      splinePoints = [];
      splineStart = [];
      const startPoint = { x: penX, y: penY };
      splinePoints[splinePoints.length] = startPoint;
      splineStart[splineStart.length] = startPoint;
      for (let vi = 0; vi + 1 < nums.length; vi += 2) {
        const x = nums[vi]! * scaleFactor;
        const y = nums[vi + 1]! * scaleFactor;
        const pt = { x, y };
        splinePoints[splinePoints.length] = pt;
        if (splineStart.length < 3) splineStart[splineStart.length] = pt;
        penX = x;
        penY = y;
      }
      continue;
    }
    if (cmd === "p") {
      if (!splineActive || splinePoints.length < 3) continue;
      for (let vi = 0; vi + 1 < nums.length; vi += 2) {
        const x = nums[vi]! * scaleFactor;
        const y = nums[vi + 1]! * scaleFactor;
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

  if (commands.length === 0) return null;
  const last = commands[commands.length - 1]!;
  if (last.type !== "Z" && last.type !== "M")
    commands[commands.length] = { type: "Z" };

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
  return {
    type: "mask",
    bitmap: raster.bitmap.buffer,
    width: raster.bitmap.width,
    height: raster.bitmap.rows,
    stride: raster.bitmap.pitch,
    originX: raster.bearingX,
    originY: raster.bearingY,
    inverse,
  };
}
