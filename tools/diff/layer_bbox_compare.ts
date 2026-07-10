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

type BBox = { minX: number; minY: number; maxX: number; maxY: number; width: number; height: number };

type LayerReport = {
  index: number;
  text: string;
  kind: string;
  segmentIndex: number;
  glyphIndex: number | null;
  glyphId: number | null;
  originX: number;
  originY: number;
  width: number;
  height: number;
  libass: BBox | null;
  subframe: BBox | null;
  ratio: { w: number; h: number };
  delta: { w: number; h: number; x: number; y: number };
  mismatch: boolean;
};

function getArg(args: string[], name: string, fallback?: string) {
  const idx = args.indexOf(name);
  if (idx === -1) return fallback;
  return args[idx + 1];
}

function readPng(path: string) {
  return PNG.sync.read(readFileSync(path));
}

function computeBBoxInRegion(png: PNG, x0: number, y0: number, width: number, height: number): BBox | null {
  const xStart = Math.max(0, x0);
  const yStart = Math.max(0, y0);
  const xEnd = Math.min(png.width, x0 + width);
  const yEnd = Math.min(png.height, y0 + height);
  let minX = xEnd;
  let minY = yEnd;
  let maxX = -1;
  let maxY = -1;

  for (let y = yStart; y < yEnd; y++) {
    const row = y * png.width * 4;
    for (let x = xStart; x < xEnd; x++) {
      const i = row + x * 4;
      const a = png.data[i + 3]!;
      const r = png.data[i + 0]!;
      const g = png.data[i + 1]!;
      const b = png.data[i + 2]!;
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

async function renderLibass(manifest: Manifest, ass: string, timeMs: number, width: number, height: number, outPath: string, fontsDir?: string) {
  mkdirSync(dirname(outPath), { recursive: true });
  const args = ["--ass", ass, "--time", String(timeMs), "--w", String(width), "--h", String(height), "--out", outPath];
  if (fontsDir) args.splice(args.length - 2, 0, "--fonts", fontsDir);
  const proc = Bun.spawn({ cmd: [...manifest.renderers.libass.cmd, ...args], stdout: "inherit", stderr: "inherit" });
  return proc.exited;
}

async function renderSubframeWithTrace(ass: string, timeMs: number, width: number, height: number, fontsDir?: string) {
  if (fontsDir) {
    setFontSearchPaths(fontsDir.split(","));
    resetFontCache();
  }
  const text = await Bun.file(ass).text();
  const parsed = parseASS(text, { onError: "collect", strict: false, preserveOrder: true });
  return renderFrameFromDocumentWithTrace(parsed.document, timeMs, width, height);
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
        const rounding = (255 * 255) / 2;
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
  const kind = (getArg(args, "--kind", "fill") ?? "fill") as "fill" | "outline" | "shadow";
  const glyphIndexArg = getArg(args, "--glyph");
  const glyphIdArg = getArg(args, "--glyph-id");
  const outDir = getArg(args, "--out", "test/expected/trace/layer_bbox")!;
  const tolRatio = Number(getArg(args, "--tol", "0.02"));
  const manifestPath = getArg(args, "--manifest", "test/manifest.json")!;

  if (!ass || !w || !h) {
    console.error(
      "Usage: bun run tools/diff/layer_bbox_compare.ts --ass <file.ass> --time <ms> --w <width> --h <height> [--fonts <dir>] [--event <index>|--text <match>] [--kind <fill|outline|shadow>] [--glyph <i>] [--glyph-id <id>] [--out <dir>]"
    );
    process.exit(1);
  }

  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as Manifest;
  mkdirSync(outDir, { recursive: true });

  const rendered = await renderSubframeWithTrace(ass, timeMs, w, h, fonts);
  const subframePng = compositeLayers(w, h, rendered.result.layers);
  const subframePath = join(outDir, "subframe.png");
  writeFileSync(subframePath, PNG.sync.write(subframePng));

  const libassPath = join(outDir, "libass.png");
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

  const glyphIndexFilter = glyphIndexArg !== undefined ? Number(glyphIndexArg) : null;
  const glyphIdFilter = glyphIdArg !== undefined ? Number(glyphIdArg) : null;
  const layers = targetEvent.layers.filter((l: any) => {
    if (l.kind !== kind) return false;
    if (glyphIndexFilter !== null && l.glyphIndex !== glyphIndexFilter) return false;
    if (glyphIdFilter !== null && l.glyphId !== glyphIdFilter) return false;
    return true;
  });

  const reports: LayerReport[] = [];
  for (let i = 0; i < layers.length; i++) {
    const layer = layers[i]!;
    const x0 = Math.round(layer.originX);
    const y0 = Math.round(layer.originY);
    const subBox = computeBBoxInRegion(subframePng, x0, y0, layer.width, layer.height);
    const libBox = computeBBoxInRegion(libassPng, x0, y0, layer.width, layer.height);
    const ratioW = subBox && libBox ? subBox.width / libBox.width : 1;
    const ratioH = subBox && libBox ? subBox.height / libBox.height : 1;
    const delta = {
      w: (subBox?.width ?? 0) - (libBox?.width ?? 0),
      h: (subBox?.height ?? 0) - (libBox?.height ?? 0),
      x: (subBox?.minX ?? 0) - (libBox?.minX ?? 0),
      y: (subBox?.minY ?? 0) - (libBox?.minY ?? 0),
    };
    const mismatch = Math.abs(ratioW - 1) > tolRatio || Math.abs(ratioH - 1) > tolRatio;
    reports[reports.length] = {
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
      libass: libBox,
      subframe: subBox,
      ratio: { w: ratioW, h: ratioH },
      delta,
      mismatch,
    };
  }

  reports.sort((a, b) => Math.abs(b.ratio.w - 1) - Math.abs(a.ratio.w - 1));
  const reportPath = join(outDir, "layer_bbox.json");
  writeFileSync(reportPath, JSON.stringify({ event: targetEvent.eventId, kind, layers: reports }, null, 2));
  console.log(`layer bbox report: ${reportPath}`);
}
