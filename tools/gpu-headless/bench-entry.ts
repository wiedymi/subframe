// Headless in-browser benchmark page. Served by run-bench.ts through Bun's dev
// bundler (same pipeline as `bun playground/index.html`) so worker/env behavior
// matches what a playground user actually gets. Runs a paced 60fps playback of
// the jassub-benchmark fixtures through the WebGPU backend, measuring
// renderFrame + backend.render per frame across configs, and POSTs JSON to
// /result.
import { parseASS } from "subforge/ass";
import type { SubtitleDocument } from "subforge/core";
import {
  renderFrame,
  prepareDocument,
  createWebGPUBackend,
  setFontResolver,
  setWorkerPool,
  setWorkerSource,
  releaseRenderResult,
  registerFontSource,
  Subframe,
  type CompositorBackend,
} from "../../src";
import {
  clearEventLayerCache,
  clearRasterCaches,
  getEventLayerCacheStats,
} from "../../src/core/pipeline";
import {
  getGpuFilterProvider,
  setGpuFilterDeferEnabled,
  setGpuFilterProvider,
} from "../../src/core/filters/gpu-provider";
import { getWorkerPoolStats, isWorkerPoolUsable, setWorkerCount } from "../../src/core/worker-pool";
import { getFramePipelineStats, resetFramePipeline, setFrameScatter, setFrameHybrid } from "../../src/core/pipeline";
import { setAllocCensusEnabled } from "../../src/core/raster/bitmap";

const W = 1920;
const H = 1080;
const QS = new URLSearchParams(location.search);
const FRAMES = Number(QS.get("frames")) > 0 ? Number(QS.get("frames")) : 300;
const FRAME_MS = 1000 / 60;
// Optional focus filters (fast iteration): ?only=beastars&configs=default,gpu-filters-off
const ONLY_FIXTURES = (QS.get("only") ?? "").split(",").map((s) => s.trim()).filter(Boolean);
const ONLY_CONFIGS = (QS.get("configs") ?? "").split(",").map((s) => s.trim()).filter(Boolean);
const ALLOC_CENSUS_ENABLED = QS.get("allocCensus") === "1";
const USE_CLASS_PATH = QS.get("classPath") === "1";
if (QS.get("sabArenas") === "0" || QS.get("sabArenas") === "1") {
  (globalThis as any).__SUBFRAME_SAB_ARENAS__ = QS.get("sabArenas");
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Reassembly + z-sort proxy for the frame-ring's main thread. In the ring the
// worker returns the frame's fills and the main thread must z-sort the full
// layer set (sortLayersStable in pipeline.ts) before backend.render. That sort
// currently runs inside renderFrameInternal, so it is billed to renderMs, not
// compositeMs. Measure it separately here so the reported composite budget is
// the true "everything the main thread does after fills are available" =
// reassemble+sort + backend.render. Timed on a shuffled copy so the cost
// reflects a real unsorted input, not the already-sorted array renderFrame
// returns (V8 TimSort would fast-path a sorted input and under-report). The
// shuffle/rebuild is outside the timed region; only the sort+rebuild that
// sortLayersStable itself performs is timed.
let sortShuffleScratch = new Int32Array(8192);
function measureReassembleMs(layers: Array<{ z: number }>): number {
  const n = layers.length;
  if (n <= 1) return 0;
  if (sortShuffleScratch.length < n) sortShuffleScratch = new Int32Array(n);
  const perm = sortShuffleScratch;
  for (let i = 0; i < n; i++) perm[i] = i;
  // Deterministic shuffle (untimed) to defeat the sorted-input fast path.
  for (let i = n - 1; i > 0; i--) {
    const j = (Math.imul(i, 2654435761) >>> 0) % (i + 1);
    const t = perm[i]!;
    perm[i] = perm[j]!;
    perm[j] = t;
  }
  const shuffled = new Array<{ z: number }>(n);
  for (let i = 0; i < n; i++) shuffled[i] = layers[perm[i]!]!;
  // Timed region: identical shape to sortLayersStable (Int32 index sort with
  // z-then-original-index tie-break, then materialize the sorted array).
  const t0 = performance.now();
  const idx = new Int32Array(n);
  for (let i = 0; i < n; i++) idx[i] = i;
  idx.sort((a, b) => {
    const za = shuffled[a]!.z;
    const zb = shuffled[b]!.z;
    if (za !== zb) return za - zb;
    return a - b;
  });
  const out = new Array<{ z: number }>(n);
  for (let i = 0; i < n; i++) out[i] = shuffled[idx[i]!]!;
  const el = performance.now() - t0;
  // Keep `out` observable so the sort/rebuild is not dead-code-eliminated.
  if (out.length !== n) throw new Error("unreachable");
  reassembleSink += out[n - 1]!.z;
  return el;
}
let reassembleSink = 0;

async function post(path: string, body: unknown): Promise<void> {
  try {
    await fetch(path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch {
    /* ignore */
  }
}

const capturedWarnings: string[] = [];
const origWarn = console.warn.bind(console);
console.warn = (...args: unknown[]) => {
  capturedWarnings.push(args.map((a) => String(a)).join(" "));
  origWarn(...args);
};

async function resolveBenchFont(name: string): Promise<ArrayBuffer | null> {
  // Retry: transient network-level fetch failures were observed in headless
  // Chrome while the page is under full render + worker-boot load.
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(`/font?name=${encodeURIComponent(name)}`);
      if (!res.ok) return null;
      const buf = await res.arrayBuffer();
      // Register the source so the pool's font sync can forward it to workers
      // (mirrors the playground resolver, which registers everything it loads).
      registerFontSource(name, buf);
      return buf;
    } catch (err) {
      await post("/log", {
        msg: `font fetch failed attempt=${attempt} name=${name}: ${String(err)}`,
      });
      await sleep(100);
    }
  }
  return null;
}

type Fixture = { id: string; file: string; t0: number };
type Config = {
  id: string;
  workers: boolean;
  gpuFilters: boolean;
  profile: boolean;
  // Pin the pool size (setWorkerCount). undefined => adaptive base/auto-scale.
  workerCount?: number | null;
  // Provider registered but deferral disabled: isolates the deferral overhead
  // (buffer retention / GPU dispatch) from the provider's other effects (the
  // copy-elimination adopt guard, which stays disabled while a provider exists).
  deferOff?: boolean;
  // Per-frame event-scatter fork-join. Defaults ON when workers are on; set
  // false to measure the whole-frame ring baseline instead.
  scatter?: boolean;
  // HYBRID (ring primary + scatter miss-fallback) — the product path. When true
  // it overrides scatter/ring selection inside renderFrame.
  hybrid?: boolean;
};

const FIXTURES: Fixture[] = [
  { id: "beastars", file: "beastars.ass", t0: 246350 },
  { id: "FGOBD", file: "FGOBD.ass", t0: 39000 },
  // URL-safe symlink to "Kusriya S2 OP1v3.ass" (spaces percent-encode in the
  // fetch path but the /ass/ route reads the raw pathname).
  { id: "kusriya", file: "kusriya-s2-op1v3.ass", t0: 35000 },
];

// GPU filters default ON (the shared backend registers the provider at
// creation), so "default" measures the shipped configuration and
// "gpu-filters-off" measures the opt-out (provider detached for the run).
const CONFIGS: Config[] = [
  // "default" now exercises the browser-only capacity-loss auto-scaling
  // (workerCount undefined => adaptive base 6 -> cap hc-2). w6/w8 pin the
  // endpoints for the worker-count A/B.
  { id: "default", workers: true, gpuFilters: true, profile: false, hybrid: true },
  { id: "w6", workers: true, gpuFilters: true, profile: false, workerCount: 6, hybrid: true },
  { id: "w8", workers: true, gpuFilters: true, profile: false, workerCount: 8, hybrid: true },
  // Per-frame event-scatter N-sweep (fallback path A/B) — the fork-join at 4/6/8.
  { id: "s4", workers: true, gpuFilters: true, profile: false, workerCount: 4, scatter: true, hybrid: false },
  { id: "s6", workers: true, gpuFilters: true, profile: false, workerCount: 6, scatter: true, hybrid: false },
  { id: "s8", workers: true, gpuFilters: true, profile: false, workerCount: 8, scatter: true, hybrid: false },
  // HYBRID (ring primary + scatter miss-fallback) — the product path, N-sweep.
  { id: "h6", workers: true, gpuFilters: true, profile: false, workerCount: 6, hybrid: true },
  { id: "h8", workers: true, gpuFilters: true, profile: false, workerCount: 8, hybrid: true },
  // Whole-frame ring baseline (scatter OFF, miss -> single-thread) for the A/B.
  { id: "ring6", workers: true, gpuFilters: true, profile: false, workerCount: 6, scatter: false, hybrid: false },
  { id: "ring8", workers: true, gpuFilters: true, profile: false, workerCount: 8, scatter: false, hybrid: false },
  { id: "workers-off", workers: false, gpuFilters: true, profile: false, hybrid: false },
  { id: "gpu-filters-off", workers: true, gpuFilters: false, profile: false, hybrid: true },
  { id: "profiled", workers: true, gpuFilters: true, profile: true, hybrid: true },
  { id: "profiled-off", workers: true, gpuFilters: false, profile: true, hybrid: true },
  // Provider ON but deferral OFF: measures the "GPU provider present, all blur
  // on CPU" cost. If this matches gpu-filters-off, the deferral (not the adopt
  // guard) is the overhead; if it matches default, the adopt guard is.
  { id: "defer-off", workers: true, gpuFilters: true, profile: false, deferOff: true, hybrid: true },
];

function makeCanvas(): HTMLCanvasElement {
  const c = document.createElement("canvas");
  c.width = W;
  c.height = H;
  document.body.appendChild(c);
  return c;
}

type StageTotals = {
  frames: number;
  frameMs: number[];
  layoutMs: number;
  rasterMs: number;
  blurMs: number;
  shapeMs: number;
  fontMs: number;
};

type AllocCensus = Record<string, { bytes: number; count: number }>;

function diffAllocCensus(before: unknown, after: unknown): AllocCensus | undefined {
  const b = (before && typeof before === "object" ? before : {}) as AllocCensus;
  const a = (after && typeof after === "object" ? after : {}) as AllocCensus;
  const out: AllocCensus = {};
  const keys = new Set([...Object.keys(b), ...Object.keys(a)]);
  for (const key of keys) {
    const be = b[key] ?? { bytes: 0, count: 0 };
    const ae = a[key] ?? { bytes: 0, count: 0 };
    const bytes = ae.bytes - be.bytes;
    const count = ae.count - be.count;
    if (bytes !== 0 || count !== 0) out[key] = { bytes, count };
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

type HeapSample = {
  frame: number;
  timeMs: number;
  wallMs: number;
  usedJSHeapSize: number;
  totalJSHeapSize?: number;
  jsHeapSizeLimit?: number;
};

function readMainHeapSample(frame: number, timeMs: number, wallMs: number): HeapSample | null {
  const memory = (performance as Performance & {
    memory?: {
      usedJSHeapSize?: number;
      totalJSHeapSize?: number;
      jsHeapSizeLimit?: number;
    };
  }).memory;
  if (!memory || typeof memory.usedJSHeapSize !== "number") return null;
  const sample: HeapSample = {
    frame,
    timeMs,
    wallMs,
    usedJSHeapSize: memory.usedJSHeapSize,
  };
  if (typeof memory.totalJSHeapSize === "number") sample.totalJSHeapSize = memory.totalJSHeapSize;
  if (typeof memory.jsHeapSizeLimit === "number") sample.jsHeapSizeLimit = memory.jsHeapSizeLimit;
  return sample;
}

async function runOne(
  fixture: Fixture,
  config: Config,
  sharedBackend: CompositorBackend,
): Promise<Record<string, unknown>> {
  await post("/log", { msg: `start ${fixture.id}/${config.id}` });

  const text = await (await fetch(`/ass/${fixture.file}`)).text();
  const parsed = parseASS(text, { onError: "collect", strict: false, preserveOrder: true });
  const doc: SubtitleDocument = parsed.document;

  clearEventLayerCache();
  clearRasterCaches();
  resetFramePipeline();
  setAllocCensusEnabled(ALLOC_CENSUS_ENABLED);
  // Tear down any prior config's pool first so the new worker count takes
  // effect from a fresh init (growing a live pool would not re-init). Safe in
  // the browser (results arrive via onmessage; no sync-drain segfault risk).
  setWorkerPool(false);
  setWorkerCount(config.workerCount === undefined ? null : config.workerCount);
  if (!USE_CLASS_PATH) setWorkerPool(config.workers);
  // Choose the frame-pipeline path. Hybrid (ring primary + scatter fallback)
  // overrides the scatter/ring selection when set; otherwise scatter (default)
  // vs whole-frame ring baseline.
  setFrameHybrid(config.hybrid !== false);
  setFrameScatter(config.scatter !== false);
  const warningsBefore = capturedWarnings.length;

  // The shared backend registers the global GPU filter provider at creation
  // (filters default ON). The opt-out config detaches the provider for the
  // run so the core does CPU filtering; restore afterwards.
  const savedProvider = getGpuFilterProvider();
  if (!config.gpuFilters) setGpuFilterProvider(null);
  // Provider stays registered for deferOff (adopt guard unchanged) but no layer
  // routes to the GPU.
  setGpuFilterDeferEnabled(!config.deferOff);
  const backend = sharedBackend;

  // Per-stage profiling: SUBFRAME_PROFILE is read per frame off `process.env`;
  // in the browser we can materialize it on globalThis and parse the log lines.
  let stages: StageTotals | null = null;
  const origLog = console.log.bind(console);
  if (config.profile) {
    (globalThis as any).process = { env: { SUBFRAME_PROFILE: "1" } };
    stages = { frames: 0, frameMs: [], layoutMs: 0, rasterMs: 0, blurMs: 0, shapeMs: 0, fontMs: 0 };
    console.log = (...args: unknown[]) => {
      const line = String(args[0] ?? "");
      if (line.startsWith("[subframe] frame=")) {
        const grab = (name: string): number => {
          const m = line.match(new RegExp(`${name}=([\\d.]+)ms`));
          return m ? Number(m[1]) : 0;
        };
        stages!.frames++;
        stages!.frameMs.push(grab("frame"));
        stages!.layoutMs += grab("layout");
        stages!.rasterMs += grab("raster");
        stages!.blurMs += grab("blur");
        stages!.shapeMs += grab("shape");
        stages!.fontMs += grab("font");
        return;
      }
      origLog(...args);
    };
  }

  const sf = USE_CLASS_PATH
    ? new Subframe({ workers: config.workers, fontResolver: resolveBenchFont })
    : null;
  if (sf) {
    sf.resize(W, H);
    sf.setDocument(doc, { timeMs: fixture.t0, playbackFps: 60 });
    await sf.ready;
  }

  const prepareStart = performance.now();
  if (sf) {
    const prepared = await sf.frame(fixture.t0);
    prepared.release();
  } else {
    const prepared = await prepareDocument(doc, W, H, { timeMs: fixture.t0, boundaryWarmupMs: 500 });
    releaseRenderResult(prepared);
  }
  const prepareMs = performance.now() - prepareStart;

  const cache0 = getEventLayerCacheStats();
  const pool0 = getWorkerPoolStats();
  const framePipeline0 = getFramePipelineStats();

  const renderMs = new Array<number>(FRAMES);
  const compositeMs = new Array<number>(FRAMES);
  const reassembleMs = new Array<number>(FRAMES);
  const layerCounts = new Array<number>(FRAMES);
  const gpuRoutedCounts = new Array<number>(FRAMES);
  const gpuFilterStats = new Array<unknown>(FRAMES);
  const heapSamples: HeapSample[] = [];
  let activeEventsMax = 0;

  const wallStart = performance.now();
  {
    const s = readMainHeapSample(0, 0, 0);
    if (s) heapSamples.push(s);
  }
  for (let i = 0; i < FRAMES; i++) {
    const target = wallStart + i * FRAME_MS;
    const now = performance.now();
    if (now < target) await sleep(target - now);
    const t = fixture.t0 + i * FRAME_MS;
    const a = performance.now();
    const result = sf ? await sf.frame(t) : await renderFrame(doc, t, W, H);
    const b = performance.now();
    reassembleMs[i] = measureReassembleMs(result.layers);
    const b2 = performance.now();
    backend.render(result.layers, result.frame);
    const c = performance.now();
    gpuFilterStats[i] = backend.stats?.().gpuFilter ?? null;
    renderMs[i] = b - a;
    compositeMs[i] = c - b2;
    let routed = 0;
    for (let l = 0; l < result.layers.length; l++) {
      if ((result.layers[l] as any).gpuFilter) routed++;
    }
    layerCounts[i] = result.layers.length;
    gpuRoutedCounts[i] = routed;
    if ("release" in result) (result.release as () => void)();
    else releaseRenderResult(result);
    if (result.activeEvents.length > activeEventsMax) activeEventsMax = result.activeEvents.length;
    const rendered = i + 1;
    if (rendered % 60 === 0 || rendered === FRAMES) {
      const elapsedWall = performance.now() - wallStart;
      const s = readMainHeapSample(rendered, rendered * FRAME_MS, elapsedWall);
      if (s && (heapSamples.length === 0 || heapSamples[heapSamples.length - 1]!.frame !== s.frame)) {
        heapSamples.push(s);
      }
    }
  }
  const wallTotalMs = performance.now() - wallStart;

  const cache1 = getEventLayerCacheStats();
  const pool1 = getWorkerPoolStats();
  const framePipeline1 = getFramePipelineStats();
  if (USE_CLASS_PATH && config.workers && !pool1.active) {
    throw new Error("Subframe class path worker pool is inactive");
  }
  const workerPoolUsableAfter = isWorkerPoolUsable();
  sf?.dispose();

  if (config.profile) {
    console.log = origLog;
    delete (globalThis as any).process;
  }
  setGpuFilterProvider(savedProvider);
  setGpuFilterDeferEnabled(true);

  await post("/log", { msg: `done ${fixture.id}/${config.id} wall=${wallTotalMs.toFixed(0)}ms` });

  return {
    fixture: fixture.id,
    config: config.id,
    frames: FRAMES,
    prepareMs,
    wallTotalMs,
    achievedFps: (FRAMES / wallTotalMs) * 1000,
    renderMs,
    compositeMs,
    reassembleMs,
    layerCounts,
    gpuRoutedCounts,
    gpuFilterStats,
    heapSamples,
    workerHeapMeasured: pool1.workerHeapMeasured === true,
    activeEventsMax,
    workerPoolBefore: pool0,
    workerPoolAfter: pool1,
    allocCensusDelta: diffAllocCensus(pool0.allocCensus, pool1.allocCensus),
    framePipelineAfter: framePipeline1,
    framePipelineDelta: {
      dedupHits: framePipeline1.dedupHits - framePipeline0.dedupHits,
      dedupFrames: framePipeline1.dedupFrames - framePipeline0.dedupFrames,
      boundaryHits: framePipeline1.boundaryHits - framePipeline0.boundaryHits,
      boundaryAwaited: framePipeline1.boundaryAwaited - framePipeline0.boundaryAwaited,
      boundaryMisfires: framePipeline1.boundaryMisfires - framePipeline0.boundaryMisfires,
      boundaryFiredEarly: framePipeline1.boundaryFiredEarly - framePipeline0.boundaryFiredEarly,
      boundaryStale: framePipeline1.boundaryStale - framePipeline0.boundaryStale,
      boundaryDepth: framePipeline1.boundaryDepth,
    },
    workerPoolUsableAfter,
    newWarnings: capturedWarnings.slice(warningsBefore),
    cacheDelta: {
      hits: cache1.hits - cache0.hits,
      misses: cache1.misses - cache0.misses,
      evictions: cache1.evictions - cache0.evictions,
      entriesEnd: cache1.entries,
      bytesEnd: cache1.bytes,
    },
    stages,
  };
}

async function main() {
  const env = {
    userAgent: navigator.userAgent,
    typeofProcess: typeof (globalThis as any).process,
    hasWorker: typeof Worker !== "undefined",
    crossOriginIsolated: (globalThis as { crossOriginIsolated?: boolean }).crossOriginIsolated === true,
    sharedArrayBuffer: typeof SharedArrayBuffer !== "undefined",
    sabArenasFlag: (globalThis as any).__SUBFRAME_SAB_ARENAS__ ?? "default",
    classPath: USE_CLASS_PATH,
    hardwareConcurrency: navigator.hardwareConcurrency,
    webgpu: "gpu" in navigator,
    devicePixelRatio: devicePixelRatio,
  };

  // Same wiring as the playground: the driver serves a bundled worker entry at
  // /worker-entry.js; point the pool at it before the first render.
  if (!USE_CLASS_PATH) setWorkerSource("/worker-entry.js");

  setFontResolver(resolveBenchFont);

  const sharedBackend = await createWebGPUBackend({ canvas: makeCanvas() });

  const fixtures = ONLY_FIXTURES.length ? FIXTURES.filter((f) => ONLY_FIXTURES.includes(f.id)) : FIXTURES;
  const configs = ONLY_CONFIGS.length ? CONFIGS.filter((c) => ONLY_CONFIGS.includes(c.id)) : CONFIGS;
  const runs: Array<Record<string, unknown>> = [];
  for (const fixture of fixtures) {
    for (const config of configs) {
      runs.push(await runOne(fixture, config, sharedBackend));
    }
  }

  await post("/result", { ok: true, env, runs, warnings: capturedWarnings });
}

main().catch(async (err) => {
  await post("/result", {
    ok: false,
    error: String(err),
    stack: (err as Error)?.stack,
    warnings: capturedWarnings,
  });
});
