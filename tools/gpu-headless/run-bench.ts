// Headless in-browser performance benchmark driver. Serves the benchmark page
// with explicit COOP/COEP headers, launches
// headless Chrome with WebGPU enabled, waits for the page to POST measurements
// to /result, and prints p50/p95/max tables per fixture/config.
//
// Usage: bun run tools/gpu-headless/run-bench.ts [--keep] [--out result.json]
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { setFontSearchPaths, resolveFontPath } from "../../src/io/fonts/resolve";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "../..");
const FIXTURES = join(ROOT, "test/fixtures/jassub-benchmark");
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const PORT = 8794;
const TIMEOUT_MS = 600_000;
const FRAME_BUDGET_MS = 1000 / 60; // 16.67ms — the 60fps period a frame must fit
const ISOLATION_HEADERS = {
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Embedder-Policy": "require-corp",
} as const;
const argv = process.argv.slice(2);
const keep = argv.includes("--keep");
const allocCensus = argv.includes("--alloc-census") || process.env.SUBFRAME_ALLOC_CENSUS === "1";
const outIdx = argv.indexOf("--out");
const outPath = outIdx !== -1 ? argv[outIdx + 1]! : null;
// Focus filters forwarded to the page as query params for fast iteration:
//   --only beastars --configs default,gpu-filters-off --frames 200
function argVal(flag: string): string | null {
  const i = argv.indexOf(flag);
  return i !== -1 ? (argv[i + 1] ?? null) : null;
}
const qs = new URLSearchParams();
{
  const only = argVal("--only");
  const configs = argVal("--configs");
  const frames = argVal("--frames");
  if (only) qs.set("only", only);
  if (configs) qs.set("configs", configs);
  if (frames) qs.set("frames", frames);
  if (allocCensus) qs.set("allocCensus", "1");
  if (process.env.SUBFRAME_SAB_ARENAS === "0" || process.env.SUBFRAME_SAB_ARENAS === "1") {
    qs.set("sabArenas", process.env.SUBFRAME_SAB_ARENAS);
  }
}
const QUERY = qs.toString() ? `?${qs.toString()}` : "";

setFontSearchPaths([join(FIXTURES, "fonts")]);

// Bundle the worker entry once at startup and serve it at /worker-entry.js —
// the same wiring as playground/server.ts — so bench numbers include a live
// worker pool exactly like the playground.
const workerBuild = await Bun.build({
  entrypoints: [join(ROOT, "src/core/worker-entry.ts")],
  target: "browser",
  format: "esm",
  minify: false,
});
if (!workerBuild.success) {
  for (const l of workerBuild.logs) console.error(l);
  throw new Error("worker-entry bundle failed");
}
const workerJs = await workerBuild.outputs[0]!.text();
const benchBuild = await Bun.build({
  entrypoints: [join(HERE, "bench-entry.ts")],
  target: "browser",
  format: "esm",
  minify: false,
});
if (!benchBuild.success) {
  for (const l of benchBuild.logs) console.error(l);
  throw new Error("bench-entry bundle failed");
}
const benchEntryJs = await benchBuild.outputs[0]!.text();
const benchHtml = `<!doctype html>
<meta charset="utf-8">
<title>subframe gpu bench</title>
<body>
  <script type="module" src="/bench-entry.js"></script>
</body>
`;

function withIsolation(init?: ResponseInit): ResponseInit {
  const headers = new Headers(init?.headers);
  for (const [key, value] of Object.entries(ISOLATION_HEADERS)) headers.set(key, value);
  return { ...init, headers };
}

let resolveResult: (r: any) => void;
const resultPromise = new Promise<any>((res) => {
  resolveResult = res;
});

const fontLog: Array<{ name: string; resolved: string | null }> = [];

const server = Bun.serve({
  port: PORT,
  development: true,
  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === "/" || url.pathname === "/index.html") {
      return new Response(benchHtml, withIsolation({
        headers: { "content-type": "text/html; charset=utf-8" },
      }));
    }
    if (url.pathname === "/bench-entry.js") {
      return new Response(benchEntryJs, withIsolation({
        headers: { "content-type": "text/javascript; charset=utf-8" },
      }));
    }
    if (url.pathname === "/worker-entry.js") {
      return new Response(workerJs, withIsolation({
        headers: { "content-type": "text/javascript; charset=utf-8" },
      }));
    }
    if (url.pathname.startsWith("/ass/")) {
      const name = url.pathname.slice(5);
      if (name.includes("..") || name.includes("/")) {
        return new Response("bad", withIsolation({ status: 400 }));
      }
      const f = Bun.file(join(FIXTURES, "subtitles", name));
      if (!(await f.exists())) return new Response("not found", withIsolation({ status: 404 }));
      return new Response(f, withIsolation({
        headers: { "content-type": "text/plain; charset=utf-8" },
      }));
    }
    if (url.pathname === "/font") {
      const name = url.searchParams.get("name") ?? "";
      try {
        const resolved = resolveFontPath(name);
        const hash = resolved.lastIndexOf("#");
        const filePath = hash > 0 ? resolved.slice(0, hash) : resolved;
        fontLog.push({ name, resolved });
        return new Response(readFileSync(filePath), withIsolation({
          headers: { "content-type": "application/octet-stream" },
        }));
      } catch (err) {
        fontLog.push({ name, resolved: null });
        return new Response("not found", withIsolation({ status: 404 }));
      }
    }
    if (url.pathname === "/log" && req.method === "POST") {
      const body = await req.json();
      console.log(`[page] ${body.msg}`);
      return new Response("ok", withIsolation());
    }
    if (url.pathname === "/result" && req.method === "POST") {
      resolveResult(await req.json());
      return new Response("ok", withIsolation());
    }
    return new Response("not found", withIsolation({ status: 404 }));
  },
});

// Evidence pass: fetch the served page + JS chunk and show what the dev bundler
// did to the Worker constructor (does the worker chunk resolve, or is it a
// dead file:// URL?).
async function inspectServedBundle(): Promise<void> {
  const html = await (await fetch(`http://localhost:${PORT}/`)).text();
  const isolated =
    (await fetch(`http://localhost:${PORT}/`)).headers.get("cross-origin-embedder-policy") ??
    "missing";
  const m = html.match(/src="([^"]+bench-entry\.js)"/);
  if (!m) {
    console.log(`bundle-inspect: no bench-entry script tag found; coep=${isolated}`);
    return;
  }
  const js = await (await fetch(`http://localhost:${PORT}${m[1]}`)).text();
  const workerLines = js.match(/new Worker\([^;]*/g) ?? [];
  console.log(`bundle-inspect: chunk ${m[1]} (${js.length} bytes) coep=${isolated}`);
  for (const line of workerLines) console.log(`bundle-inspect: ${line}`);
}

function percentile(sortedAsc: number[], p: number): number {
  if (sortedAsc.length === 0) return 0;
  const idx = Math.min(
    sortedAsc.length - 1,
    Math.max(0, Math.round((p / 100) * (sortedAsc.length - 1))),
  );
  return sortedAsc[idx]!;
}

function summarize(values: number[]): { p50: number; p95: number; max: number; mean: number } {
  const sorted = [...values].sort((a, b) => a - b);
  const mean = values.reduce((a, b) => a + b, 0) / (values.length || 1);
  return {
    p50: percentile(sorted, 50),
    p95: percentile(sorted, 95),
    max: sorted[sorted.length - 1] ?? 0,
    mean,
  };
}

function bytesToMiB(bytes: number): number {
  return bytes / (1024 * 1024);
}

function printAllocCensus(run: any): void {
  const census = run.allocCensusDelta;
  if (!census || typeof census !== "object") return;
  const rows = Object.entries(census as Record<string, { bytes: number; count: number }>)
    .map(([site, entry]) => ({
      site,
      bytes: Number(entry.bytes ?? 0),
      count: Number(entry.count ?? 0),
    }))
    .filter((r) => r.bytes !== 0 || r.count !== 0)
    .sort((a, b) => b.bytes - a.bytes)
    .slice(0, 16);
  if (rows.length === 0) return;
  console.log("allocation census (worker deltas; top sites):");
  console.log("  site,totalMiB,MiB/frame,count,bytes/op");
  for (const row of rows) {
    const perFrame = bytesToMiB(row.bytes) / (run.frames || 1);
    const bytesPerOp = row.count > 0 ? row.bytes / row.count : 0;
    console.log(
      `  ${row.site},${bytesToMiB(row.bytes).toFixed(2)},${perFrame.toFixed(3)},${row.count},${bytesPerOp.toFixed(0)}`,
    );
  }
}

function slopeMiBPerMin(samples: Array<{ wallMs?: number; timeMs?: number; usedJSHeapSize: number }>): number {
  if (samples.length < 2) return 0;
  let sumX = 0;
  let sumY = 0;
  let sumXX = 0;
  let sumXY = 0;
  for (let i = 0; i < samples.length; i++) {
    const s = samples[i]!;
    const x = Number(s.wallMs ?? s.timeMs ?? 0) / 60_000;
    const y = bytesToMiB(Number(s.usedJSHeapSize ?? 0));
    sumX += x;
    sumY += y;
    sumXX += x * x;
    sumXY += x * y;
  }
  const n = samples.length;
  const denom = n * sumXX - sumX * sumX;
  return denom === 0 ? 0 : (n * sumXY - sumX * sumY) / denom;
}

function summarizeHeap(samples: Array<{ wallMs?: number; timeMs?: number; usedJSHeapSize: number }>): {
  samples: number;
  peakMiB: number;
  steadyMiB: number;
  lastMiB: number;
  slopeMiBPerMin: number;
  curve: "plateau" | "growth";
} | null {
  const valid = samples.filter((s) => Number.isFinite(Number(s.usedJSHeapSize)));
  if (valid.length === 0) return null;
  const mib = valid.map((s) => bytesToMiB(Number(s.usedJSHeapSize)));
  const lastThird = valid.slice(Math.floor(valid.length * (2 / 3)));
  const steadyVals = mib.slice(Math.floor(mib.length * (2 / 3)));
  const steadyMiB = steadyVals.reduce((a, b) => a + b, 0) / (steadyVals.length || 1);
  const slope = slopeMiBPerMin(lastThird.length >= 2 ? lastThird : valid);
  return {
    samples: valid.length,
    peakMiB: Math.max(...mib),
    steadyMiB,
    lastMiB: mib[mib.length - 1] ?? 0,
    slopeMiBPerMin: slope,
    curve: slope > 5 ? "growth" : "plateau",
  };
}

async function main() {
  await inspectServedBundle();

  const userDataDir = mkdtempSync(join(tmpdir(), "gpu-bench-"));
  const flags = [
    "--headless=new",
    "--use-angle=metal",
    "--enable-features=Vulkan",
    "--enable-unsafe-webgpu",
    "--enable-precise-memory-info",
    "--no-sandbox",
    `--user-data-dir=${userDataDir}`,
    "--no-first-run",
    "--disable-gpu-sandbox",
    `http://localhost:${PORT}/${QUERY}`,
  ];
  const chrome = spawn(CHROME, flags, { stdio: keep ? "inherit" : "ignore" });
  const timer = setTimeout(
    () => resolveResult({ ok: false, error: "timeout waiting for /result" }),
    TIMEOUT_MS,
  );

  const result = await resultPromise;
  clearTimeout(timer);
  chrome.kill("SIGKILL");
  server.stop(true);
  if (!keep) {
    try {
      rmSync(userDataDir, { recursive: true, force: true });
    } catch {}
  }

  if (outPath) {
    writeFileSync(outPath, JSON.stringify({ result, fontLog }, null, 2));
    console.log(`raw result written to ${outPath}`);
  }

  console.log("\n=== headless Chrome bench result ===");
  if (!result.ok) {
    console.log(`ERROR: ${result.error}`);
    if (result.stack) console.log(result.stack);
    if (result.warnings?.length) console.log("warnings:", result.warnings);
    process.exit(1);
  }
  console.log(`env: ${JSON.stringify(result.env)}`);
  console.log(`fonts requested: ${JSON.stringify(fontLog)}`);
  for (const run of result.runs) {
    const r = summarize(run.renderMs);
    const c = summarize(run.compositeMs);
    const reassembleArr: number[] = run.reassembleMs ?? new Array(run.compositeMs.length).fill(0);
    const ra = summarize(reassembleArr);
    // Full main-thread composite budget the frame-ring must fit under the 16.7ms
    // period: reassemble+sort (currently billed to renderMs) + backend.render.
    const mc = summarize(run.compositeMs.map((v: number, i: number) => v + (reassembleArr[i] ?? 0)));
    const t = summarize(run.renderMs.map((v: number, i: number) => v + run.compositeMs[i]));
    console.log(`\n--- ${run.fixture} / ${run.config} ---`);
    console.log(
      `render:    p50 ${r.p50.toFixed(2)}  p95 ${r.p95.toFixed(2)}  max ${r.max.toFixed(2)}  mean ${r.mean.toFixed(2)} ms`,
    );
    console.log(
      `backend.render: p50 ${c.p50.toFixed(2)}  p95 ${c.p95.toFixed(2)}  max ${c.max.toFixed(2)}  mean ${c.mean.toFixed(2)} ms`,
    );
    console.log(
      `reassemble+sort: p50 ${ra.p50.toFixed(2)}  p95 ${ra.p95.toFixed(2)}  max ${ra.max.toFixed(2)}  mean ${ra.mean.toFixed(2)} ms`,
    );
    console.log(
      `COMPOSITE (sort+render): p50 ${mc.p50.toFixed(2)}  p95 ${mc.p95.toFixed(2)}  max ${mc.max.toFixed(2)}  mean ${mc.mean.toFixed(2)} ms`,
    );
    console.log(
      `total:     p50 ${t.p50.toFixed(2)}  p95 ${t.p95.toFixed(2)}  max ${t.max.toFixed(2)}  mean ${t.mean.toFixed(2)} ms`,
    );
    console.log(
      `wall ${run.wallTotalMs.toFixed(0)}ms achievedFps ${run.achievedFps.toFixed(1)} layersMax ${Math.max(...run.layerCounts)} gpuRoutedMax ${Math.max(...run.gpuRoutedCounts)} activeEventsMax ${run.activeEventsMax}`,
    );
    if (typeof run.prepareMs === "number") {
      console.log(`prepareDocument: ${run.prepareMs.toFixed(1)} ms`);
    }
    if (Array.isArray(run.heapSamples)) {
      const heap = summarizeHeap(run.heapSamples);
      if (heap) {
        console.log(
          `heap(main): samples ${heap.samples} peak ${heap.peakMiB.toFixed(1)} MiB steady ${heap.steadyMiB.toFixed(1)} MiB last ${heap.lastMiB.toFixed(1)} MiB slope ${heap.slopeMiBPerMin.toFixed(1)} MiB/min curve ${heap.curve}`,
        );
      } else {
        console.log("heap(main): unavailable");
      }
      const wpHeap = run.workerPoolAfter;
      if (run.workerHeapMeasured && wpHeap) {
        console.log(
          `heap(worker): measuredWorkers ${wpHeap.workerHeapWorkers ?? 0}/${wpHeap.workers ?? 0} latest ${bytesToMiB(Number(wpHeap.workerHeapLatestBytes ?? 0)).toFixed(1)} MiB peakSum ${bytesToMiB(Number(wpHeap.workerHeapPeakBytes ?? 0)).toFixed(1)} MiB total ${bytesToMiB(Number(wpHeap.workerHeapTotalBytes ?? 0)).toFixed(1)} MiB`,
        );
      } else {
        console.log("heap(worker): unmeasured (Worker heap is not exposed through performance.memory)");
      }
    }
    if (Array.isArray(run.gpuFilterStats)) {
      const gpuStats = run.gpuFilterStats.filter((s: any) => s && s.routedLayers > 0);
      if (gpuStats.length > 0) {
        const vals = (name: string) => gpuStats.map((s: any) => Number(s[name] ?? 0));
        const input = summarize(vals("inputCpuMs"));
        const filter = summarize(vals("filterCpuMs"));
        const copy = summarize(vals("copyCpuMs"));
        const totalGpu = summarize(vals("totalCpuMs"));
        const copyBytes = vals("copyBytes");
        const copyMeanMb = copyBytes.reduce((a: number, b: number) => a + b, 0) / (copyBytes.length || 1) / (1024 * 1024);
        const copyMaxMb = Math.max(...copyBytes) / (1024 * 1024);
        const filterSubmits = vals("filterSubmitted").reduce((a: number, b: number) => a + b, 0);
        const cacheHits = vals("cacheHits").reduce((a: number, b: number) => a + b, 0);
        const cacheMisses = vals("cacheMisses").reduce((a: number, b: number) => a + b, 0);
        const copiesMax = Math.max(...vals("copies"));
        const groupsMax = Math.max(...vals("groups"));
        const requestsMax = Math.max(...vals("requests"));
        const filterRoundsMax = Math.max(...vals("filterRounds"));
        const filterJobsMax = Math.max(...vals("filterJobs"));
        const filterPixels = vals("filterPixels");
        const filterPixelsMeanMp =
          filterPixels.reduce((a: number, b: number) => a + b, 0) /
          (filterPixels.length || 1) /
          1_000_000;
        const maskRequestsMax = Math.max(...vals("maskRequests"));
        const maskUploadsMax = Math.max(...vals("maskUploads"));
        const maskPixels = vals("maskPixels");
        const maskPixelsMeanMp =
          maskPixels.reduce((a: number, b: number) => a + b, 0) /
          (maskPixels.length || 1) /
          1_000_000;
        const bucketSum = (name: string) => vals(name).reduce((a: number, b: number) => a + b, 0);
        const b1 = bucketSum("areaLt1k");
        const b4 = bucketSum("areaLt4k");
        const b16 = bucketSum("areaLt16k");
        const bBig = bucketSum("areaGte16k");
        console.log(
          `gpuFilter routedFrames ${gpuStats.length}/${run.gpuFilterStats.length} groupsMax ${groupsMax} requestsMax ${requestsMax} copiesMax ${copiesMax} cacheHits ${cacheHits} cacheMisses ${cacheMisses} filterSubmits ${filterSubmits}`,
        );
        console.log(
          `  batch roundsMax ${filterRoundsMax} jobsMax ${filterJobsMax} pixelsMean ${filterPixelsMeanMp.toFixed(2)} MP | mask requestsMax ${maskRequestsMax} uploadsMax ${maskUploadsMax} pixelsMean ${maskPixelsMeanMp.toFixed(2)} MP`,
        );
        console.log(
          `  cpu input p50 ${input.p50.toFixed(2)} mean ${input.mean.toFixed(2)} | filter p50 ${filter.p50.toFixed(2)} p95 ${filter.p95.toFixed(2)} mean ${filter.mean.toFixed(2)} | copy p50 ${copy.p50.toFixed(2)} p95 ${copy.p95.toFixed(2)} mean ${copy.mean.toFixed(2)} | total mean ${totalGpu.mean.toFixed(2)} ms`,
        );
        console.log(
          `  copyBytes mean ${copyMeanMb.toFixed(2)} MiB max ${copyMaxMb.toFixed(2)} MiB`,
        );
        console.log(
          `  area buckets over routed layers: <1k ${b1} 1k-4k ${b4} 4k-16k ${b16} >=16k ${bBig}`,
        );
      }
    }
    // Cheap vs heavy split: classify a frame by its layer count against the
    // run's median layer count. Cheap frames are where GPU setup cost (if any)
    // dominates; heavy frames are the dense blur frames. Reported so CHANGE 1
    // (stop penalizing cheap frames) and CHANGE 3 (heavy-frame batching) are
    // separately visible.
    {
      const lcSorted = [...run.layerCounts].sort((a: number, b: number) => a - b);
      const medLayers = lcSorted[Math.floor(lcSorted.length / 2)] ?? 0;
      const cheapR: number[] = [];
      const heavyR: number[] = [];
      for (let i = 0; i < run.renderMs.length; i++) {
        (run.layerCounts[i] <= medLayers ? cheapR : heavyR).push(run.renderMs[i]);
      }
      const cs = summarize(cheapR);
      const hs = summarize(heavyR);
      console.log(
        `cheap frames (<=${medLayers} layers, n=${cheapR.length}): render p50 ${cs.p50.toFixed(2)} p95 ${cs.p95.toFixed(2)} max ${cs.max.toFixed(2)} ms`,
      );
      console.log(
        `heavy frames (> ${medLayers} layers, n=${heavyR.length}): render p50 ${hs.p50.toFixed(2)} p95 ${hs.p95.toFixed(2)} max ${hs.max.toFixed(2)} ms`,
      );
    }
    console.log(
      `workerPool after: ${JSON.stringify(run.workerPoolAfter)} usable=${run.workerPoolUsableAfter}`,
    );
    if (run.workerPoolAfter) {
      const wp = run.workerPoolAfter;
      const wp0 = run.workerPoolBefore ?? {};
      const dh = Number(wp.bitmapPoolHits ?? 0) - Number(wp0.bitmapPoolHits ?? 0);
      const dm = Number(wp.bitmapPoolMisses ?? 0) - Number(wp0.bitmapPoolMisses ?? 0);
      const dr = Number(wp.bitmapPoolReleased ?? 0) - Number(wp0.bitmapPoolReleased ?? 0);
      const dd = Number(wp.bitmapPoolDropped ?? 0) - Number(wp0.bitmapPoolDropped ?? 0);
      console.log(
        `arenaFreelist: returned=${wp.arenaReturned ?? 0} reused=${wp.arenaReused ?? 0} dropped=${wp.arenaDropped ?? 0}`,
      );
      console.log(
        `sabArenas: wanted=${wp.sabArenasWanted === true} workers=${wp.sabArenaWorkers ?? 0}/${wp.workers ?? 0} packed=${wp.sabArenaPacked ?? 0} fallbacks=${wp.sabArenaFallbacks ?? 0} grows=${wp.sabArenaGrows ?? 0} bytes=${bytesToMiB(Number(wp.sabArenaBytes ?? 0)).toFixed(1)} MiB slots=${wp.sabArenaAllocatedSlots ?? 0} held=${wp.sabArenaHeldSlots ?? 0} slotReleased=${wp.sabArenaSlotReleased ?? 0} slotDropped=${wp.sabArenaSlotDropped ?? 0}`,
      );
      console.log(
        `bitmapPool: bytes=${bytesToMiB(Number(wp.bitmapPoolBytes ?? 0)).toFixed(1)} MiB buckets=${wp.bitmapPoolBuckets ?? 0} hit=${dh} miss=${dm} released=${dr} dropped=${dd}`,
      );
    }
    printAllocCensus(run);
    // Frame-pipeline saturation instrument (hybrid: ring hit% vs scatter% + ring
    // occupancy + whole-frame production/per-worker ms).
    const fp = run.framePipelineAfter;
    if (fp) {
      const fd = run.framePipelineDelta ?? fp;
      const dedupPct =
        (fd.dedupFrames ?? 0) > 0 ? (100 * (fd.dedupHits ?? 0)) / fd.dedupFrames : 0;
      const parkedPct =
        (fd.boundaryHits ?? 0) > 0
          ? (100 * ((fd.boundaryHits ?? 0) - (fd.boundaryAwaited ?? 0))) / fd.boundaryHits
          : 0;
      const served = (fp.hits ?? 0) + (fp.scatterFrames ?? 0) + (fp.scatterSingle ?? 0);
      const pct = (x: number) => (served > 0 ? ((100 * x) / served).toFixed(1) : "0.0");
      const dropped = run.renderMs.filter((v: number) => v > FRAME_BUDGET_MS).length;
      console.log(
        `frameDedup: ${fd.dedupHits ?? 0}/${fd.dedupFrames ?? 0} (${dedupPct.toFixed(1)}%)`,
      );
      console.log(
        `boundary: hits=${fd.boundaryHits ?? 0} awaited=${fd.boundaryAwaited ?? 0} misfires=${fd.boundaryMisfires ?? 0} stale=${fd.boundaryStale ?? 0} firedEarly=${fd.boundaryFiredEarly ?? 0} suppressed=${fd.boundaryPrewarmSuppressed ?? 0} depth=${fd.boundaryDepth ?? fp.boundaryDepth ?? 0} parkedInTime=${parkedPct.toFixed(1)}% slots=${fp.boundarySlots ?? 0} ready=${fp.boundaryReady ?? 0} inFlight=${fp.boundaryInFlight ?? 0}`,
      );
      if (Array.isArray(fp.boundaryTimingSamples) && fp.boundaryTimingSamples.length) {
        console.log(`  boundary timing samples: ${fp.boundaryTimingSamples.join(" | ")}`);
      }
      console.log(
        `framePipeline: served ${served}  ring-hit ${fp.hits ?? 0} (${pct(fp.hits ?? 0)}%) [awaited ${fp.ringAwaited ?? 0}]  scatter ${fp.scatterFrames ?? 0} (${pct(fp.scatterFrames ?? 0)}%)  single ${fp.scatterSingle ?? 0} (${pct(fp.scatterSingle ?? 0)}%)  misses ${fp.misses ?? 0} seeks ${fp.seeks ?? 0} conceded ${fp.ringConceded ?? 0} coldScatter ${fp.hybridColdScatter ?? 0} seekScatter ${fp.hybridSeekScatter ?? 0}`,
      );
      console.log(
        `  ring: readyAvg ${(fp.ringReadyAvg ?? 0).toFixed(1)} inFlightAvg ${(fp.ringInFlightAvg ?? 0).toFixed(1)} readyMax ${fp.ringReadyMax ?? 0} staleDrops ${fp.staleDrops ?? 0} errors ${fp.errors ?? 0} delta ${typeof fp.delta === "number" ? fp.delta.toFixed(3) : fp.delta}`,
      );
      console.log(
        `  frames produced ${fp.frameProduced ?? 0} (errors ${fp.frameErrors ?? 0})  per-worker frame ms ~${(fp.frameCpuEmaMs ?? 0).toFixed(1)}  droppedRender(>16.7ms) ${dropped}/${run.renderMs.length} (${((100 * dropped) / run.renderMs.length).toFixed(1)}%)`,
      );
    }
    console.log(`cacheDelta: ${JSON.stringify(run.cacheDelta)}`);
    if (run.newWarnings?.length) {
      for (const w of run.newWarnings) console.log(`warn: ${String(w).slice(0, 300)}`);
    }
    if (run.stages) {
      const s = run.stages;
      const sum = s.frameMs.reduce((a: number, b: number) => a + b, 0);
      console.log(
        `stages over ${s.frames} frames: frame ${sum.toFixed(0)}ms | layout ${s.layoutMs.toFixed(0)} raster ${s.rasterMs.toFixed(0)} blur ${s.blurMs.toFixed(0)} shape ${s.shapeMs.toFixed(0)} font ${s.fontMs.toFixed(0)} other ${(sum - s.layoutMs - s.rasterMs - s.blurMs - s.shapeMs - s.fontMs).toFixed(0)}`,
      );
    }
  }
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
