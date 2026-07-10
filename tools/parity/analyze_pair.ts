import { readFileSync } from "node:fs";
import { PNG } from "pngjs";

type BBox = {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  width: number;
  height: number;
};

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function read(path: string): PNG {
  return PNG.sync.read(readFileSync(path));
}

function alpha(png: PNG, x: number, y: number): number {
  if (x < 0 || y < 0 || x >= png.width || y >= png.height) return 0;
  return png.data[(y * png.width + x) * 4 + 3]!;
}

function bbox(png: PNG): BBox | null {
  let minX = png.width;
  let minY = png.height;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < png.height; y++) {
    for (let x = 0; x < png.width; x++) {
      if (alpha(png, x, y) === 0) continue;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  if (maxX < minX) return null;
  return {
    minX,
    minY,
    maxX,
    maxY,
    width: maxX - minX + 1,
    height: maxY - minY + 1,
  };
}

function compare(a: PNG, b: PNG, dx: number, dy: number) {
  let abs = 0;
  let squared = 0;
  let different = 0;
  let maxAbsAlpha = 0;
  let alphaA = 0;
  let alphaB = 0;
  for (let y = 0; y < a.height; y++) {
    for (let x = 0; x < a.width; x++) {
      const av = alpha(a, x, y);
      const bv = alpha(b, x + dx, y + dy);
    const delta = av - bv;
      const absDelta = Math.abs(delta);
      abs += absDelta;
      if (absDelta > maxAbsAlpha) maxAbsAlpha = absDelta;
      squared += delta * delta;
      if (delta !== 0) different++;
      alphaA += av;
      alphaB += bv;
    }
  }
  const pixels = a.width * a.height;
  return {
    dx,
    dy,
    meanAbsAlpha: abs / pixels,
    meanSquaredAlpha: squared / pixels,
    maxAbsAlpha,
    differentPixels: different,
    alphaSumA: alphaA,
    alphaSumB: alphaB,
  };
}

const aPath = arg("--a");
const bPath = arg("--b");
if (!aPath || !bPath) {
  console.error("Usage: bun tools/parity/analyze_pair.ts --a <libass.png> --b <subframe.png>");
  process.exit(1);
}

const a = read(aPath);
const b = read(bPath);
if (a.width !== b.width || a.height !== b.height) {
  throw new Error(`size mismatch: ${a.width}x${a.height} vs ${b.width}x${b.height}`);
}

let best = compare(a, b, 0, 0);
for (let dy = -4; dy <= 4; dy++) {
  for (let dx = -4; dx <= 4; dx++) {
    const candidate = compare(a, b, dx, dy);
    if (candidate.meanSquaredAlpha < best.meanSquaredAlpha) best = candidate;
  }
}

console.log(JSON.stringify({ a: bbox(a), b: bbox(b), best }, null, 2));
