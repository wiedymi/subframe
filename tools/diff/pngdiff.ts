import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { PNG } from "pngjs";

type DiffStats = {
  space: "premultiplied-rgba";
  width: number;
  height: number;
  maxError: number;
  meanError: number;
  pixelsOver: number;
  pctOver: number;
  tolerance: number;
};

function premultiply(channel: number, alpha: number): number {
  return Math.floor((channel * alpha + 127) / 255);
}

function readPng(path: string) {
  const buf = readFileSync(path);
  return PNG.sync.read(buf);
}

export function diffPng(
  aPath: string,
  bPath: string,
  outPath: string,
  statsPath: string,
  tolerance = 1
): DiffStats {
  const a = readPng(aPath);
  const b = readPng(bPath);

  if (a.width !== b.width || a.height !== b.height) {
    throw new Error(`Size mismatch: ${aPath} (${a.width}x${a.height}) vs ${bPath} (${b.width}x${b.height})`);
  }

  const out = new PNG({ width: a.width, height: a.height });

  const total = a.width * a.height;
  let maxError = 0;
  let sum = 0;
  let over = 0;

  for (let y = 0; y < a.height; y++) {
    for (let x = 0; x < a.width; x++) {
      const i = (y * a.width + x) * 4;
      const aa = a.data[i + 3]!;
      const ba = b.data[i + 3]!;
      // PNG stores straight alpha, but Subframe and libass both composite in
      // premultiplied space. RGB in a fully transparent (or barely covered)
      // edge pixel is not visible and can explode a meaningful one-level mask
      // difference into a false 255-channel failure after unpremultiplication.
      const dr = Math.abs(
        premultiply(a.data[i + 0]!, aa) - premultiply(b.data[i + 0]!, ba),
      );
      const dg = Math.abs(
        premultiply(a.data[i + 1]!, aa) - premultiply(b.data[i + 1]!, ba),
      );
      const db = Math.abs(
        premultiply(a.data[i + 2]!, aa) - premultiply(b.data[i + 2]!, ba),
      );
      const da = Math.abs(aa - ba);
      const d = Math.max(dr, dg, db, da);
      if (d > maxError) maxError = d;
      sum += d;
      if (d > tolerance) over++;

      out.data[i + 0] = d;
      out.data[i + 1] = 0;
      out.data[i + 2] = 0;
      out.data[i + 3] = 255;
    }
  }

  const stats: DiffStats = {
    space: "premultiplied-rgba",
    width: a.width,
    height: a.height,
    maxError,
    meanError: sum / total,
    pixelsOver: over,
    pctOver: (over / total) * 100,
    tolerance,
  };

  mkdirSync(dirname(outPath), { recursive: true });
  mkdirSync(dirname(statsPath), { recursive: true });
  writeFileSync(outPath, PNG.sync.write(out));
  writeFileSync(statsPath, JSON.stringify(stats, null, 2));
  return stats;
}

function getArg(args: string[], name: string, fallback: string): string;
function getArg(args: string[], name: string): string | undefined;
function getArg(args: string[], name: string, fallback?: string): string | undefined {
  const idx = args.indexOf(name);
  if (idx === -1) return fallback;
  return args[idx + 1] ?? fallback;
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const a = getArg(args, "--a");
  const b = getArg(args, "--b");
  const out = getArg(args, "--out", "./diff.png");
  const stats = getArg(args, "--stats", "./diff.json");
  const tolStr = getArg(args, "--tolerance", "1");

  if (!a || !b) {
    console.error("Usage: bun run tools/diff/pngdiff.ts --a <ref.png> --b <out.png> --out <diff.png> --stats <diff.json> [--tolerance 1]");
    process.exit(1);
  }

  const tolerance = Number(tolStr);
  const res = diffPng(a, b, out, stats, Number.isFinite(tolerance) ? tolerance : 1);
  console.log(JSON.stringify(res));
}
