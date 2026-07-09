import { readFileSync } from "node:fs";
import { basename } from "node:path";

type CpuNode = {
  id: number;
  callFrame?: {
    functionName?: string;
    url?: string;
    lineNumber?: number;
    columnNumber?: number;
  };
  hitCount?: number;
};

type CpuProfile = {
  nodes: CpuNode[];
  samples?: number[];
  timeDeltas?: number[];
};

type Row = {
  id: number;
  fn: string;
  url: string;
  line: number;
  selfMs: number;
  pct: number;
  group: string;
};

const path = process.argv[2];
if (!path) {
  console.error("usage: bun run tools/gpu-headless/analyze-cpuprofile.ts profile.cpuprofile [topN]");
  process.exit(1);
}
const topN = Number(process.argv[3] ?? "20");
const profile = JSON.parse(readFileSync(path, "utf8")) as CpuProfile;
const nodesById = new Map<number, CpuNode>();
for (const node of profile.nodes) nodesById.set(node.id, node);

const selfById = new Map<number, number>();
if (profile.samples && profile.samples.length > 0) {
  for (let i = 0; i < profile.samples.length; i++) {
    const id = profile.samples[i]!;
    const deltaUs = profile.timeDeltas?.[i] ?? 1000;
    selfById.set(id, (selfById.get(id) ?? 0) + deltaUs / 1000);
  }
} else {
  for (const node of profile.nodes) {
    if (node.hitCount) selfById.set(node.id, node.hitCount);
  }
}

function classify(fn: string, url: string): string {
  const s = `${fn} ${url}`.toLowerCase();
  if (
    s.includes("gc") ||
    s.includes("garbage") ||
    s.includes("mark") && s.includes("sweep") ||
    s.includes("collect")
  ) {
    return "GC";
  }
  if (
    s.includes("libassgaussianblur") ||
    s.includes("applylibassgaussianblur") ||
    s.includes("applybeblur") ||
    s.includes("beblur") ||
    s.includes("blur.wasm") ||
    s.includes("blur_level") ||
    s.includes("runkernel") && s.includes("blur") ||
    s.includes("blur") && s.includes("libass")
  ) {
    return "blur";
  }
  if (
    s.includes("stroke") ||
    s.includes("outline") ||
    s.includes("fixoutline") ||
    s.includes("subbitmap") ||
    s.includes("maxbitmap")
  ) {
    return "outline/stroker";
  }
  if (
    s.includes("rasterizepath") ||
    s.includes("rasterizefillfrompath") ||
    s.includes("rasterizeauto") ||
    s.includes("path-builder") ||
    s.includes("quantizepathinplace") ||
    s.includes("renderScanline".toLowerCase()) ||
    s.includes("fillspan") ||
    s.includes("setcurrentcellpixel") ||
    s.includes("scan") ||
    s.includes("fillrule") ||
    s.includes("edgebucket")
  ) {
    return "drawing path scan-conversion";
  }
  if (
    s.includes("clip/apply") ||
    s.includes("computemaskboxes") ||
    s.includes("getmaskboxes") ||
    s.includes("applyclip") ||
    s.includes("settransformglyphcache") ||
    s.includes("transformrastercachekey") ||
    s.includes("gettransformglyphcache") ||
    s.includes("uint8array") ||
    s.includes("arraybuffer") ||
    s.includes("slice") ||
    s.includes("copy") ||
    s.includes("bitmapbuilder") ||
    s.includes("createbitmap") ||
    s.includes("pad") ||
    s.includes("pack") ||
    s.includes("shiftbitmap") ||
    s.includes("normalizelayerorigin") ||
    s.includes("acquirebitmapbuffer")
  ) {
    return "bitmap alloc/copy/pack";
  }
  if (
    s.includes("glyph") ||
    s.includes("font") ||
    s.includes("hint") ||
    s.includes("truetype") ||
    s.includes("cff")
  ) {
    return "glyph rasterization";
  }
  if (
    s.includes("layout") ||
    s.includes("shape") ||
    s.includes("resolve") ||
    s.includes("segments") ||
    s.includes("activeevents") ||
    s.includes("line") ||
    s.includes("tokenize")
  ) {
    return "layout/shaping";
  }
  return "other";
}

function shortUrl(url: string): string {
  if (!url) return "";
  const marker = "/subframe/";
  const idx = url.indexOf(marker);
  if (idx !== -1) return url.slice(idx + marker.length);
  return basename(url);
}

let totalMs = 0;
for (const ms of selfById.values()) totalMs += ms;

const rows: Row[] = [];
for (const [id, selfMs] of selfById) {
  const node = nodesById.get(id);
  const cf = node?.callFrame;
  const fn = cf?.functionName || "(anonymous)";
  const url = shortUrl(cf?.url ?? "");
  const line = cf?.lineNumber ?? 0;
  rows.push({
    id,
    fn,
    url,
    line,
    selfMs,
    pct: totalMs > 0 ? (100 * selfMs) / totalMs : 0,
    group: classify(fn, url),
  });
}
rows.sort((a, b) => b.selfMs - a.selfMs);

const groups = new Map<string, number>();
for (const row of rows) groups.set(row.group, (groups.get(row.group) ?? 0) + row.selfMs);

console.log(`profile: ${path}`);
console.log(`totalSelfMs: ${totalMs.toFixed(1)} samples=${profile.samples?.length ?? 0}`);
console.log("\n=== group self time ===");
console.log("group,selfMs,share%");
for (const [group, ms] of [...groups.entries()].sort((a, b) => b[1] - a[1])) {
  console.log(`${group},${ms.toFixed(1)},${totalMs > 0 ? ((100 * ms) / totalMs).toFixed(1) : "0.0"}`);
}

console.log(`\n=== top ${topN} self-time functions ===`);
console.log("rank,selfMs,share%,group,function,location");
for (let i = 0; i < Math.min(topN, rows.length); i++) {
  const row = rows[i]!;
  const loc = row.url ? `${row.url}:${row.line}` : "";
  console.log(
    `${i + 1},${row.selfMs.toFixed(1)},${row.pct.toFixed(1)},${row.group},${JSON.stringify(row.fn)},${loc}`,
  );
}
