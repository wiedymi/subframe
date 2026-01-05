import { readFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { PNG } from "pngjs";

type Manifest = {
  viewport: { width: number; height: number };
  fontsDir?: string;
  renderers: {
    libass: { cmd: string[] };
    subframe: { cmd: string[] };
  };
  cases: Array<{ id: string; ass: string; timestampsMs: number[] }>;
};

type BBox = { minX: number; minY: number; maxX: number; maxY: number; width: number; height: number };

function readPng(path: string) {
  return PNG.sync.read(readFileSync(path));
}

function computeBBox(path: string): BBox | null {
  const png = readPng(path);
  let minX = png.width;
  let minY = png.height;
  let maxX = -1;
  let maxY = -1;
  const data = png.data;
  for (let y = 0; y < png.height; y++) {
    const row = y * png.width * 4;
    for (let x = 0; x < png.width; x++) {
      const i = row + x * 4;
      const a = data[i + 3]!;
      const r = data[i + 0]!;
      const g = data[i + 1]!;
      const b = data[i + 2]!;
      if (a === 0 && r === 0 && g === 0 && b === 0) continue;
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
    }
  }
  if (maxX < minX || maxY < minY) return null;
  return {
    minX,
    minY,
    maxX,
    maxY,
    width: maxX - minX + 1,
    height: maxY - minY + 1,
  };
}

function getArg(args: string[], name: string, fallback?: string): string | undefined {
  const idx = args.indexOf(name);
  if (idx === -1) return fallback;
  return args[idx + 1] ?? fallback;
}

function collectArgs(args: string[], name: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === name && args[i + 1]) {
      out[out.length] = args[i + 1]!;
      i++;
    }
  }
  return out;
}

function run(cmd: string[], args: string[]) {
  const proc = Bun.spawn({ cmd: [...cmd, ...args], stdout: "inherit", stderr: "inherit" });
  return proc.exited;
}

async function renderIfNeeded(
  cmd: string[],
  ass: string,
  timeMs: number,
  width: number,
  height: number,
  outPath: string,
  fontsDir?: string,
  force = false
) {
  if (!force && existsSync(outPath)) return 0;
  mkdirSync(dirname(outPath), { recursive: true });
  const args = ["--ass", ass, "--time", String(timeMs), "--w", String(width), "--h", String(height), "--out", outPath];
  if (fontsDir) {
    args.splice(args.length - 1, 0, "--fonts", fontsDir);
  }
  return await run(cmd, args);
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const manifestPath = getArg(args, "--manifest", "test/manifest.json")!;
  const caseArgs = collectArgs(args, "--case");
  const timeArgs = collectArgs(args, "--time");
  const fontsOverride = getArg(args, "--fonts");
  const outRoot = getArg(args, "--root", "test/expected")!;
  const tolRatio = Number(getArg(args, "--tol", "0.02"));
  const useExisting = args.includes("--use-existing");

  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as Manifest;
  const { width, height } = manifest.viewport;
  const fontsDir = fontsOverride ?? manifest.fontsDir;
  const caseFilter = new Set(caseArgs.flatMap((v) => v.split(",").map((s) => s.trim()).filter(Boolean)));
  const timeFilter = new Set(
    timeArgs.flatMap((v) => v.split(",").map((s) => s.trim()).filter(Boolean).map((t) => Number(t)))
  );

  const report: Array<{
    id: string;
    t: number;
    libass: BBox | null;
    subframe: BBox | null;
    ratio: { w: number; h: number };
    delta: { w: number; h: number; x: number; y: number };
    mismatch: boolean;
  }> = [];

  for (const c of manifest.cases) {
    if (caseFilter.size > 0 && !caseFilter.has(c.id)) continue;
    const timestamps = timeFilter.size > 0 ? c.timestampsMs.filter((t) => timeFilter.has(t)) : c.timestampsMs;
    if (timestamps.length === 0) continue;

    for (const t of timestamps) {
      const libassPath = join(outRoot, "libass", c.id, `${t}.png`);
      const subframePath = join(outRoot, "subframe", c.id, `${t}.png`);
      if (!useExisting) {
        const libassCode = await renderIfNeeded(manifest.renderers.libass.cmd, c.ass, t, width, height, libassPath, fontsDir, true);
        if (libassCode !== 0) {
          console.error(`libass render failed for ${c.id} @ ${t}ms`);
          continue;
        }
        const subCode = await renderIfNeeded(manifest.renderers.subframe.cmd, c.ass, t, width, height, subframePath, fontsDir, true);
        if (subCode !== 0) {
          console.error(`subframe render failed for ${c.id} @ ${t}ms`);
          continue;
        }
      } else {
        if (!existsSync(libassPath) || !existsSync(subframePath)) {
          console.error(`missing existing PNGs for ${c.id} @ ${t}ms`);
          continue;
        }
      }

      const libassBox = computeBBox(libassPath);
      const subframeBox = computeBBox(subframePath);
      const ratioW = libassBox && subframeBox ? subframeBox.width / libassBox.width : 1;
      const ratioH = libassBox && subframeBox ? subframeBox.height / libassBox.height : 1;
      const delta = {
        w: (subframeBox?.width ?? 0) - (libassBox?.width ?? 0),
        h: (subframeBox?.height ?? 0) - (libassBox?.height ?? 0),
        x: (subframeBox?.minX ?? 0) - (libassBox?.minX ?? 0),
        y: (subframeBox?.minY ?? 0) - (libassBox?.minY ?? 0),
      };
      const mismatch = Math.abs(ratioW - 1) > tolRatio || Math.abs(ratioH - 1) > tolRatio;

      report[report.length] = {
        id: c.id,
        t,
        libass: libassBox,
        subframe: subframeBox,
        ratio: { w: ratioW, h: ratioH },
        delta,
        mismatch,
      };

      const flag = mismatch ? "MISMATCH" : "ok";
      console.log(
        `${flag} ${c.id} @ ${t}ms ` +
          `ratio(w=${ratioW.toFixed(4)}, h=${ratioH.toFixed(4)}) ` +
          `delta(w=${delta.w}, h=${delta.h}, x=${delta.x}, y=${delta.y})`
      );
    }
  }

  const outPath = join(outRoot, "bbox_report.json");
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, JSON.stringify(report, null, 2));
  console.log(`bbox report: ${outPath}`);
}
