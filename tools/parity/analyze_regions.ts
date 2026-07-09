import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { PNG } from "pngjs";

type SweepRow = {
  fixture: string;
  timeMs: number;
  refPath: string;
  subPath: string;
  diffPath: string;
};

type TraceLayer = {
  index: number;
  width: number;
  height: number;
  originX: number;
  originY: number;
  kind: "shadow" | "outline" | "fill";
  text: string;
  isDrawing: boolean;
  blur: number;
  edgeBlur: number;
  outline: number;
  shadowX: number;
  shadowY: number;
};

type TraceEvent = {
  eventId: number;
  style: string;
  start: number;
  end: number;
  layer: number;
  pos: [number | null, number | null];
  move: [number, number] | null;
  clip: "rect" | "mask" | null;
  layers: TraceLayer[];
};

type TracePayload = {
  trace: {
    events: TraceEvent[];
  };
};

type Region = {
  x: number;
  y: number;
  w: number;
  h: number;
  pixelsOver: number;
  density: number;
};

const args = process.argv.slice(2);

function arg(name: string, fallback?: string): string | undefined {
  const idx = args.indexOf(name);
  return idx >= 0 ? args[idx + 1] : fallback;
}

function readPng(path: string): PNG {
  return PNG.sync.read(readFileSync(path));
}

function pixelOver(diff: PNG, x: number, y: number, tolerance: number): boolean {
  if (x < 0 || x >= diff.width || y < 0 || y >= diff.height) return false;
  return diff.data[(y * diff.width + x) * 4] > tolerance;
}

function hotRegions(diff: PNG, tolerance: number, minPixels: number): Region[] {
  const w = diff.width;
  const h = diff.height;
  const seen = new Uint8Array(w * h);
  const queueX = new Int32Array(w * h);
  const queueY = new Int32Array(w * h);
  const regions: Region[] = [];
  for (let sy = 0; sy < h; sy++) {
    for (let sx = 0; sx < w; sx++) {
      const start = sy * w + sx;
      if (seen[start] || !pixelOver(diff, sx, sy, tolerance)) continue;
      let head = 0;
      let tail = 0;
      let minX = sx;
      let maxX = sx;
      let minY = sy;
      let maxY = sy;
      let count = 0;
      seen[start] = 1;
      queueX[tail] = sx;
      queueY[tail] = sy;
      tail++;
      while (head < tail) {
        const x = queueX[head]!;
        const y = queueY[head]!;
        head++;
        count++;
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            if (dx === 0 && dy === 0) continue;
            const nx = x + dx;
            const ny = y + dy;
            if (nx < 0 || nx >= w || ny < 0 || ny >= h) continue;
            const ni = ny * w + nx;
            if (seen[ni] || !pixelOver(diff, nx, ny, tolerance)) continue;
            seen[ni] = 1;
            queueX[tail] = nx;
            queueY[tail] = ny;
            tail++;
          }
        }
      }
      if (count >= minPixels) {
        const rw = maxX - minX + 1;
        const rh = maxY - minY + 1;
        regions[regions.length] = {
          x: minX,
          y: minY,
          w: rw,
          h: rh,
          pixelsOver: count,
          density: count / (rw * rh),
        };
      }
    }
  }
  regions.sort((a, b) => b.pixelsOver - a.pixelsOver);
  return regions;
}

function expanded(region: Region, width: number, height: number, pad: number): Region {
  const x = Math.max(0, region.x - pad);
  const y = Math.max(0, region.y - pad);
  const x2 = Math.min(width, region.x + region.w + pad);
  const y2 = Math.min(height, region.y + region.h + pad);
  return { ...region, x, y, w: x2 - x, h: y2 - y };
}

function writeTriptych(ref: PNG, sub: PNG, diff: PNG, region: Region, outPath: string): void {
  const gap = 8;
  const out = new PNG({ width: region.w * 3 + gap * 2, height: region.h });
  out.data.fill(255);
  const copy = (src: PNG, dstX: number) => {
    for (let y = 0; y < region.h; y++) {
      const sy = region.y + y;
      if (sy < 0 || sy >= src.height) continue;
      for (let x = 0; x < region.w; x++) {
        const sx = region.x + x;
        if (sx < 0 || sx >= src.width) continue;
        const si = (sy * src.width + sx) * 4;
        const di = (y * out.width + dstX + x) * 4;
        out.data[di] = src.data[si]!;
        out.data[di + 1] = src.data[si + 1]!;
        out.data[di + 2] = src.data[si + 2]!;
        out.data[di + 3] = src.data[si + 3]!;
      }
    }
  };
  copy(ref, 0);
  copy(sub, region.w + gap);
  copy(diff, region.w * 2 + gap * 2);
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, PNG.sync.write(out));
}

function overlapArea(a: Region, b: Region): number {
  const x1 = Math.max(a.x, b.x);
  const y1 = Math.max(a.y, b.y);
  const x2 = Math.min(a.x + a.w, b.x + b.w);
  const y2 = Math.min(a.y + a.h, b.y + b.h);
  return Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
}

function layerRegion(layer: TraceLayer): Region {
  return {
    x: Math.floor(layer.originX),
    y: Math.floor(layer.originY),
    w: Math.ceil(layer.width),
    h: Math.ceil(layer.height),
    pixelsOver: 0,
    density: 0,
  };
}

function regionLayers(trace: TracePayload, region: Region) {
  const hits: Array<{
    eventId: number;
    style: string;
    start: number;
    end: number;
    layer: number;
    kind: TraceLayer["kind"];
    isDrawing: boolean;
    text: string;
    blur: number;
    edgeBlur: number;
    outline: number;
    shadowX: number;
    shadowY: number;
    overlap: number;
  }> = [];
  for (const ev of trace.trace.events) {
    for (const layer of ev.layers) {
      const overlap = overlapArea(region, layerRegion(layer));
      if (overlap <= 0) continue;
      hits[hits.length] = {
        eventId: ev.eventId,
        style: ev.style,
        start: ev.start,
        end: ev.end,
        layer: ev.layer,
        kind: layer.kind,
        isDrawing: layer.isDrawing,
        text: layer.text.slice(0, 60),
        blur: layer.blur,
        edgeBlur: layer.edgeBlur,
        outline: layer.outline,
        shadowX: layer.shadowX,
        shadowY: layer.shadowY,
        overlap,
      };
    }
  }
  hits.sort((a, b) => b.overlap - a.overlap);
  return hits.slice(0, 8);
}

const sweepPath = arg("--sweep");
const traceDir = arg("--trace-dir");
const outDir = arg("--out-dir", "tools/parity/results/regions")!;
const timesArg = arg("--times");
const top = Number(arg("--top", "5"));
const tolerance = Number(arg("--tolerance", "1"));
const minPixels = Number(arg("--min-pixels", "64"));
const pad = Number(arg("--pad", "32"));

if (!sweepPath || !traceDir || !timesArg) {
  console.error(
    "Usage: bun run tools/parity/analyze_regions.ts --sweep <sweep.json> --trace-dir <dir> --times <comma-ms> [--out-dir <dir>] [--top 5]",
  );
  process.exit(1);
}

const sweep = JSON.parse(readFileSync(sweepPath, "utf8")) as { rows: SweepRow[] };
const times = new Set(timesArg.split(",").map((v) => Number(v.trim())));
const report: unknown[] = [];

for (const row of sweep.rows) {
  if (!times.has(row.timeMs)) continue;
  const ref = readPng(row.refPath);
  const sub = readPng(row.subPath);
  const diff = readPng(row.diffPath);
  const tracePath = join(traceDir, `${row.fixture}-${row.timeMs}-trace.json`);
  const trace = JSON.parse(readFileSync(tracePath, "utf8")) as TracePayload;
  const regions = hotRegions(diff, tolerance, minPixels).slice(0, top);
  const rows = [];
  for (let i = 0; i < regions.length; i++) {
    const raw = regions[i]!;
    const crop = expanded(raw, diff.width, diff.height, pad);
    const cropPath = join(outDir, `${row.fixture}-${row.timeMs}-region-${i + 1}.png`);
    writeTriptych(ref, sub, diff, crop, cropPath);
    rows[rows.length] = {
      rank: i + 1,
      region: raw,
      crop,
      cropPath,
      layers: regionLayers(trace, crop),
    };
  }
  report[report.length] = {
    fixture: row.fixture,
    timeMs: row.timeMs,
    refPath: row.refPath,
    subPath: row.subPath,
    diffPath: row.diffPath,
    regions: rows,
  };
}

mkdirSync(outDir, { recursive: true });
const reportPath = join(outDir, "regions.json");
writeFileSync(reportPath, JSON.stringify(report, null, 2));

for (const frame of report as any[]) {
  console.log(`${frame.fixture} ${frame.timeMs}`);
  for (const region of frame.regions) {
    const r = region.region;
    const topLayer = region.layers[0];
    console.log(
      `  #${region.rank} x=${r.x} y=${r.y} w=${r.w} h=${r.h} px=${r.pixelsOver} density=${r.density.toFixed(3)} crop=${region.cropPath}`,
    );
    if (topLayer) {
      console.log(
        `     top layer event=${topLayer.eventId} kind=${topLayer.kind} drawing=${topLayer.isDrawing} style=${topLayer.style} text=${JSON.stringify(topLayer.text)} blur=${topLayer.blur} outline=${topLayer.outline}`,
      );
    }
  }
}
