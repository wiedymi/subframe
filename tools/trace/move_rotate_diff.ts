import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { PNG } from "pngjs";
import { parseASS } from "subforge/ass";
import { renderFrameFromDocumentWithTrace } from "../../src/core/render";
import { resetFontCache } from "../../src/io/fonts/cache";
import { setFontSearchPaths } from "../../src/io/fonts/resolve";

type Manifest = {
  renderers: { libass: { cmd: string[] } };
};

type DiffStats = {
  x: number;
  y: number;
  width: number;
  height: number;
  maxError: number;
  meanError: number;
  pixelsOver: number;
};

function getArg(args: string[], name: string, fallback: string): string;
function getArg(args: string[], name: string): string | undefined;
function getArg(args: string[], name: string, fallback?: string): string | undefined {
  const idx = args.indexOf(name);
  if (idx === -1) return fallback;
  return args[idx + 1] ?? fallback;
}

function readPng(path: string) {
  return PNG.sync.read(readFileSync(path));
}

function diffRegion(a: PNG, b: PNG, x0: number, y0: number, width: number, height: number, tolerance = 1): DiffStats {
  const xStart = Math.max(0, x0);
  const yStart = Math.max(0, y0);
  const xEnd = Math.min(a.width, x0 + width);
  const yEnd = Math.min(a.height, y0 + height);
  let maxError = 0;
  let sum = 0;
  let over = 0;
  let count = 0;

  for (let y = yStart; y < yEnd; y++) {
    const row = y * a.width * 4;
    for (let x = xStart; x < xEnd; x++) {
      const i = row + x * 4;
      const dr = Math.abs(a.data[i + 0] - b.data[i + 0]);
      const dg = Math.abs(a.data[i + 1] - b.data[i + 1]);
      const db = Math.abs(a.data[i + 2] - b.data[i + 2]);
      const da = Math.abs(a.data[i + 3] - b.data[i + 3]);
      const d = Math.max(dr, dg, db, da);
      if (d > maxError) maxError = d;
      sum += d;
      if (d > tolerance) over++;
      count++;
    }
  }

  return {
    x: xStart,
    y: yStart,
    width: Math.max(0, xEnd - xStart),
    height: Math.max(0, yEnd - yStart),
    maxError,
    meanError: count > 0 ? sum / count : 0,
    pixelsOver: over,
  };
}

function cropPng(png: PNG, x0: number, y0: number, width: number, height: number): PNG {
  const xStart = Math.max(0, x0);
  const yStart = Math.max(0, y0);
  const xEnd = Math.min(png.width, x0 + width);
  const yEnd = Math.min(png.height, y0 + height);
  const outW = Math.max(1, xEnd - xStart);
  const outH = Math.max(1, yEnd - yStart);
  const out = new PNG({ width: outW, height: outH });
  for (let y = 0; y < outH; y++) {
    const srcRow = (yStart + y) * png.width * 4;
    const dstRow = y * outW * 4;
    for (let x = 0; x < outW; x++) {
      const src = srcRow + (xStart + x) * 4;
      const dst = dstRow + x * 4;
      out.data[dst + 0] = png.data[src + 0]!;
      out.data[dst + 1] = png.data[src + 1]!;
      out.data[dst + 2] = png.data[src + 2]!;
      out.data[dst + 3] = png.data[src + 3]!;
    }
  }
  return out;
}

function diffCrop(a: PNG, b: PNG): PNG {
  const out = new PNG({ width: a.width, height: a.height });
  for (let y = 0; y < a.height; y++) {
    const row = y * a.width * 4;
    for (let x = 0; x < a.width; x++) {
      const i = row + x * 4;
      const dr = Math.abs(a.data[i + 0] - b.data[i + 0]);
      const dg = Math.abs(a.data[i + 1] - b.data[i + 1]);
      const db = Math.abs(a.data[i + 2] - b.data[i + 2]);
      const da = Math.abs(a.data[i + 3] - b.data[i + 3]);
      const d = Math.max(dr, dg, db, da);
      out.data[i + 0] = d;
      out.data[i + 1] = 0;
      out.data[i + 2] = 0;
      out.data[i + 3] = 255;
    }
  }
  return out;
}

async function renderLibass(
  manifest: Manifest,
  ass: string,
  timeMs: number,
  width: number,
  height: number,
  outPath: string,
  fontsDir?: string
) {
  mkdirSync(dirname(outPath), { recursive: true });
  const args = ["--ass", ass, "--time", String(timeMs), "--w", String(width), "--h", String(height), "--out", outPath];
  if (fontsDir) args.splice(args.length - 1, 0, "--fonts", fontsDir);
  const proc = Bun.spawn({ cmd: [...manifest.renderers.libass.cmd, ...args], stdout: "inherit", stderr: "inherit" });
  return proc.exited;
}

async function renderSubframeWithTrace(
  ass: string,
  timeMs: number,
  width: number,
  height: number,
  fontsDir?: string
) {
  if (fontsDir) {
    setFontSearchPaths(fontsDir.split(","));
    resetFontCache();
  }
  const text = await Bun.file(ass).text();
  const parsed = parseASS(text, { onError: "collect", strict: false, preserveOrder: true });
  const rendered = await renderFrameFromDocumentWithTrace(parsed.document, timeMs, width, height);
  return rendered;
}

function compositeLayers(width: number, height: number, layers: any[]): PNG {
  const png = new PNG({ width, height });
  png.data.fill(0);
  for (let i = 0; i < layers.length; i++) {
    const layer = layers[i]!;
    const lw = layer.width;
    const lh = layer.height;
    const stride = layer.stride;
    const src = layer.bitmap;
    const baseX = Math.round(layer.originX);
    const baseY = Math.round(layer.originY);
    const r = layer.color[0];
    const g = layer.color[1];
    const b = layer.color[2];
    const a = layer.color[3];
    for (let y = 0; y < lh; y++) {
      const dstY = baseY + y;
      if (dstY < 0 || dstY >= height) continue;
      const srcRow = y * stride;
      const dstRow = dstY * width * 4;
      for (let x = 0; x < lw; x++) {
        const dstX = baseX + x;
        if (dstX < 0 || dstX >= width) continue;
        const mask = src[srcRow + x];
        if (mask === 0) continue;
        const k = mask * a;
        const di = dstRow + dstX * 4;
        const dr = png.data[di + 0];
        const dg = png.data[di + 1];
        const db = png.data[di + 2];
        const da = png.data[di + 3];
        const rounding = 255 * 255 / 2;
        png.data[di + 0] = (k * r + (255 * 255 - k) * dr + rounding) / (255 * 255);
        png.data[di + 1] = (k * g + (255 * 255 - k) * dg + rounding) / (255 * 255);
        png.data[di + 2] = (k * b + (255 * 255 - k) * db + rounding) / (255 * 255);
        png.data[di + 3] = (k * 255 + (255 * 255 - k) * da + rounding) / (255 * 255);
      }
    }
  }
  // Convert from premultiplied to straight alpha
  for (let y = 0; y < height; y++) {
    const row = y * width * 4;
    for (let x = 0; x < width; x++) {
      const idx = row + x * 4;
      const alpha = png.data[idx + 3]!;
      if (alpha) {
        const inv = Math.floor(((255 << 16) / alpha) + 1);
        const offs = 1 << 15;
        png.data[idx + 0] = (png.data[idx + 0]! * inv + offs) >> 16;
        png.data[idx + 1] = (png.data[idx + 1]! * inv + offs) >> 16;
        png.data[idx + 2] = (png.data[idx + 2]! * inv + offs) >> 16;
      }
    }
  }
  return png;
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const ass = getArg(args, "--ass");
  const timeMs = Number(getArg(args, "--time", "0"));
  const w = Number(getArg(args, "--w", "0"));
  const h = Number(getArg(args, "--h", "0"));
  const fonts = getArg(args, "--fonts");
  const eventIndex = getArg(args, "--event");
  const textMatch = getArg(args, "--text");
  const glyphIndexArg = getArg(args, "--glyph");
  const glyphIdArg = getArg(args, "--glyph-id");
  const outDir = getArg(args, "--out", "test/expected/trace/move_rotate");
  const kind = (getArg(args, "--kind", "fill") ?? "fill") as "fill" | "outline" | "shadow";
  const topN = Number(getArg(args, "--top", "10"));
  const manifestPath = getArg(args, "--manifest", "test/manifest.json")!;

  if (!ass || !w || !h) {
    console.error(
      "Usage: bun run tools/trace/move_rotate_diff.ts --ass <file.ass> --time <ms> --w <width> --h <height> [--fonts <dir>] [--event <index>|--text <match>] [--glyph <i>] [--glyph-id <id>] [--out <dir>]"
    );
    process.exit(1);
  }

  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as Manifest;

  const libassPath = join(outDir, "libass.png");
  const subframePath = join(outDir, "subframe.png");
  mkdirSync(outDir, { recursive: true });

  const rendered = await renderSubframeWithTrace(ass, timeMs, w, h, fonts);
  const subframePng = compositeLayers(w, h, rendered.result.layers);
  writeFileSync(subframePath, PNG.sync.write(subframePng));

  const libassCode = await renderLibass(manifest, ass, timeMs, w, h, libassPath, fonts);
  if (libassCode !== 0) {
    console.error("libass render failed");
    process.exit(1);
  }
  const libassPng = readPng(libassPath);

  let targetEvent = null as any;
  if (eventIndex !== undefined) {
    const idx = Number(eventIndex);
    targetEvent = rendered.trace.events[idx] ?? null;
  } else if (textMatch) {
    for (const ev of rendered.trace.events) {
      for (const line of ev.lines) {
        if (line.items.some((item) => item.text.includes(textMatch))) {
          targetEvent = ev;
          break;
        }
      }
      if (targetEvent) break;
    }
  } else {
    targetEvent = rendered.trace.events[0] ?? null;
  }

  if (!targetEvent) {
    console.error("No trace event matched.");
    process.exit(1);
  }

  const layerReports: Array<any> = [];
  const glyphIndexFilter = glyphIndexArg !== undefined ? Number(glyphIndexArg) : null;
  const glyphIdFilter = glyphIdArg !== undefined ? Number(glyphIdArg) : null;
  const layers = targetEvent.layers.filter((l: any) => {
    if (l.kind !== kind) return false;
    if (glyphIndexFilter !== null && l.glyphIndex !== glyphIndexFilter) return false;
    if (glyphIdFilter !== null && l.glyphId !== glyphIdFilter) return false;
    return true;
  });
  for (let i = 0; i < layers.length; i++) {
    const layer = layers[i]!;
    const x0 = Math.round(layer.originX);
    const y0 = Math.round(layer.originY);
    const stats = diffRegion(libassPng, subframePng, x0, y0, layer.width, layer.height, 1);
    layerReports[layerReports.length] = {
      index: layer.index,
      text: layer.text,
      kind: layer.kind,
      segmentIndex: layer.segmentIndex,
      glyphIndex: layer.glyphIndex ?? null,
      glyphId: layer.glyphId ?? null,
      originX: x0,
      originY: y0,
      width: layer.width,
      height: layer.height,
      stats,
    };
  }

  layerReports.sort((a, b) => b.stats.meanError - a.stats.meanError);
  const worst = layerReports.slice(0, Number.isFinite(topN) && topN > 0 ? topN : 10);

  for (let i = 0; i < worst.length; i++) {
    const entry = worst[i]!;
    const cropA = cropPng(libassPng, entry.originX, entry.originY, entry.width, entry.height);
    const cropB = cropPng(subframePng, entry.originX, entry.originY, entry.width, entry.height);
    const cropDiff = diffCrop(cropA, cropB);
    const base = join(outDir, `layer_${entry.index}`);
    writeFileSync(`${base}_libass.png`, PNG.sync.write(cropA));
    writeFileSync(`${base}_subframe.png`, PNG.sync.write(cropB));
    writeFileSync(`${base}_diff.png`, PNG.sync.write(cropDiff));
  }

  const reportPath = join(outDir, "layer_diff.json");
  writeFileSync(reportPath, JSON.stringify({ event: targetEvent.eventId, kind, layers: layerReports }, null, 2));
  console.log(`move/rotate diff: ${reportPath}`);
}
