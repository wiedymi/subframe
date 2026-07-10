import JASSUB from "jassub";
import { parseASS } from "subforge/ass";
import type { SubtitleDocument } from "subforge/core";
import {
  createWebGPUBackend,
  attachDocument,
  registerFontSource,
  releaseRenderResult,
  renderFrame,
  setFontResolver,
  setWorkerPool,
  setWorkerSource,
  type CompositorBackend,
} from "../../src";
import { clearEventLayerCache, clearRasterCaches } from "../../src/core/pipeline";
import { getFramePipelineStats, resetFramePipeline, setFrameHybrid, setFrameScatter } from "../../src/core/pipeline";
import { setWorkerCount } from "../../src/core/worker-pool";

type ManifestCase = {
  id: string;
  upstreamId?: string;
  ass: string;
  timestampsMs: number[];
  fonts?: string[];
};

type Manifest = {
  viewport: { width: number; height: number };
  fontsDir: string;
  cases: ManifestCase[];
};

type HeapSample = {
  frame: number;
  timeMs: number;
  wallMs: number;
  usedJSHeapSize: number;
};

type RendererResult = {
  caseId: string;
  renderer: "subframe" | "jassub";
  frames: number;
  windows: number;
  achievedFps: number;
  frameMs: number[];
  heapSamples: HeapSample[];
  peakHeapBytes: number;
  steadyHeapBytes: number;
  diagnostics?: Record<string, unknown>;
  notes?: string[];
};

const QS = new URLSearchParams(location.search);
const FRAMES = Number(QS.get("frames")) > 0 ? Number(QS.get("frames")) : 300;
const WARMUP = Number(QS.get("warmup")) >= 0 ? Number(QS.get("warmup")) : 120;
const ONLY = (QS.get("only") ?? "").split(",").map((s) => s.trim()).filter(Boolean);
const W = 1920;
const H = 1080;
const FRAME_MS = 1000 / 60;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function post(path: string, body: unknown): Promise<void> {
  await fetch(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }).catch(() => {});
}

function makeCanvas(): HTMLCanvasElement {
  const c = document.createElement("canvas");
  c.width = W;
  c.height = H;
  document.body.appendChild(c);
  return c;
}

function heapSample(frame: number, timeMs: number, wallMs: number): HeapSample | null {
  const memory = (performance as Performance & {
    memory?: { usedJSHeapSize?: number };
  }).memory;
  if (!memory || typeof memory.usedJSHeapSize !== "number") return null;
  return { frame, timeMs, wallMs, usedJSHeapSize: memory.usedJSHeapSize };
}

function heapSummary(samples: HeapSample[]): { peak: number; steady: number } {
  if (samples.length === 0) return { peak: 0, steady: 0 };
  let peak = 0;
  for (let i = 0; i < samples.length; i++) {
    const v = samples[i]!.usedJSHeapSize;
    if (v > peak) peak = v;
  }
  const tail = samples.slice(Math.floor(samples.length * (2 / 3)));
  let sum = 0;
  for (let i = 0; i < tail.length; i++) sum += tail[i]!.usedJSHeapSize;
  return { peak, steady: sum / (tail.length || 1) };
}

function assetUrl(path: string): string {
  return `/asset/${path.split("/").map(encodeURIComponent).join("/")}`;
}

async function fetchTextAsset(path: string): Promise<string> {
  const res = await fetch(assetUrl(path));
  if (!res.ok) throw new Error(`asset fetch failed ${path}: ${res.status}`);
  return await res.text();
}

async function pacedSerialLoop(
  t0: number,
  frames: number,
  draw: (timeMs: number, frame: number) => Promise<void>,
  samples: HeapSample[],
): Promise<{ frameMs: number[]; wallMs: number }> {
  const frameMs = new Array<number>(frames);
  const wallStart = performance.now();
  const s0 = heapSample(0, t0, 0);
  if (s0) samples.push(s0);
  for (let i = 0; i < frames; i++) {
    const target = wallStart + i * FRAME_MS;
    const now = performance.now();
    if (now < target) await sleep(target - now);
    const timeMs = t0 + i * FRAME_MS;
    const a = performance.now();
    await draw(timeMs, i);
    frameMs[i] = performance.now() - a;
    if ((i + 1) % 60 === 0 || i + 1 === frames) {
      const s = heapSample(i + 1, timeMs, performance.now() - wallStart);
      if (s) samples.push(s);
    }
  }
  return { frameMs, wallMs: performance.now() - wallStart };
}

async function runWarmup(
  t0: number,
  draw: (timeMs: number, frame: number) => Promise<void>,
): Promise<void> {
  const start = Math.max(0, t0 - WARMUP * FRAME_MS);
  for (let i = 0; i < WARMUP; i++) {
    await draw(start + i * FRAME_MS, i);
  }
}

async function runSubframeCase(
  c: ManifestCase,
  backend: CompositorBackend,
): Promise<RendererResult> {
  await post("/log", { msg: `subframe ${c.id}` });
  const ass = await fetchTextAsset(c.ass);
  const doc: SubtitleDocument = parseASS(ass, {
    onError: "collect",
    strict: false,
    preserveOrder: true,
  }).document;
  const allTimes: number[] = [];
  const heapSamples: HeapSample[] = [];
  const layerCounts: number[] = [];
  const gpuRoutedCounts: number[] = [];
  const framePipelineWindows: Array<Record<string, number>> = [];
  let activeEventsMax = 0;
  let wallMs = 0;

  clearEventLayerCache();
  clearRasterCaches();
  resetFramePipeline();
  setWorkerPool(false);
  setWorkerCount(null);
  setWorkerPool(true);
  setFrameHybrid(true);
  setFrameScatter(true);

  for (let w = 0; w < c.timestampsMs.length; w++) {
    const t0 = c.timestampsMs[w]!;
    const attach = await attachDocument(doc, W, H, {
      timeMs: t0,
      boundaryWarmupMs: 500,
      playbackFps: 60,
    });
    await post("/log", {
      msg: `attach ${c.id} window=${w} total=${attach.totalMs.toFixed(1)}ms fonts=${attach.fontMs.toFixed(1)}ms workers=${attach.workerMs.toFixed(1)}ms prepare=${attach.prepareMs.toFixed(1)}ms prime=${(attach.primeMs ?? 0).toFixed(1)}ms ring=${attach.primedRingFrames ?? 0} n=${attach.workers}`,
    });
    await runWarmup(t0, async (timeMs) => {
      const result = await renderFrame(doc, timeMs, W, H);
      backend.render(result.layers, result.frame);
      releaseRenderResult(result);
    });
    const fp0 = getFramePipelineStats();
    const run = await pacedSerialLoop(
      t0,
      FRAMES,
      async (timeMs) => {
        const result = await renderFrame(doc, timeMs, W, H);
        backend.render(result.layers, result.frame);
        let routed = 0;
        for (let l = 0; l < result.layers.length; l++) {
          if ((result.layers[l] as any).gpuFilter) routed++;
        }
        layerCounts.push(result.layers.length);
        gpuRoutedCounts.push(routed);
        if (result.activeEvents.length > activeEventsMax) activeEventsMax = result.activeEvents.length;
        releaseRenderResult(result);
      },
      heapSamples,
    );
    const fp1 = getFramePipelineStats();
    framePipelineWindows.push({
      dedupHits: fp1.dedupHits - fp0.dedupHits,
      dedupFrames: fp1.dedupFrames - fp0.dedupFrames,
      boundaryHits: fp1.boundaryHits - fp0.boundaryHits,
      boundaryAwaited: fp1.boundaryAwaited - fp0.boundaryAwaited,
      boundaryMisfires: fp1.boundaryMisfires - fp0.boundaryMisfires,
      boundaryStale: fp1.boundaryStale - fp0.boundaryStale,
      boundaryFiredEarly: fp1.boundaryFiredEarly - fp0.boundaryFiredEarly,
      ringHits: fp1.hits - fp0.hits,
      ringAwaited: fp1.ringAwaited - fp0.ringAwaited,
      scatterFrames: fp1.scatterFrames - fp0.scatterFrames,
      scatterSingle: fp1.scatterSingle - fp0.scatterSingle,
      misses: fp1.misses - fp0.misses,
      frameProduced: fp1.frameProduced - fp0.frameProduced,
      frameErrors: fp1.frameErrors - fp0.frameErrors,
      staleDrops: fp1.staleDrops - fp0.staleDrops,
    });
    // pacedSerialLoop already recorded the end-to-end draw duration in run.frameMs.
    for (let i = 0; i < run.frameMs.length; i++) allTimes[allTimes.length] = run.frameMs[i]!;
    wallMs += run.wallMs;
    await sleep(500);
  }
  const heap = heapSummary(heapSamples);
  return {
    caseId: c.id,
    renderer: "subframe",
    frames: allTimes.length,
    windows: c.timestampsMs.length,
    achievedFps: allTimes.length / (wallMs / 1000),
    frameMs: allTimes,
    heapSamples,
    peakHeapBytes: heap.peak,
    steadyHeapBytes: heap.steady,
    diagnostics: {
      activeEventsMax,
      layerCounts,
      gpuRoutedCounts,
      framePipelineWindows,
    },
  };
}

async function makeJassub(c: ManifestCase): Promise<{ inst: JASSUB; canvas: HTMLCanvasElement }> {
  const canvas = makeCanvas();
  const ass = await fetchTextAsset(c.ass);
  const fontSet = new Set<string>(c.fonts ?? []);
  fontSet.add("test/fixtures/jassub-benchmark/fonts/arial.ttf");
  const fonts = [...fontSet].map(assetUrl);
  const inst = new JASSUB({
    canvas,
    subContent: ass,
    workerUrl: "/jassub-worker.js",
    wasmUrl: "/jassub-worker.wasm",
    modernWasmUrl: "/jassub-worker-modern.wasm",
    fonts,
    defaultFont: "Arial",
    queryFonts: false,
  });
  await inst.ready;
  await inst.resize(true, W, H);
  return { inst, canvas };
}

async function runJassubCase(c: ManifestCase): Promise<RendererResult> {
  await post("/log", { msg: `jassub ${c.id}` });
  const allTimes: number[] = [];
  const heapSamples: HeapSample[] = [];
  let wallMs = 0;
  for (let w = 0; w < c.timestampsMs.length; w++) {
    const { inst, canvas } = await makeJassub(c);
    const t0 = c.timestampsMs[w]!;
    await runWarmup(t0, async (timeMs) => {
      await inst.manualRender({
        expectedDisplayTime: performance.now(),
        width: W,
        height: H,
        mediaTime: timeMs / 1000,
      });
    });
    const run = await pacedSerialLoop(
      t0,
      FRAMES,
      async (timeMs) => {
        await inst.manualRender({
          expectedDisplayTime: performance.now(),
          width: W,
          height: H,
          mediaTime: timeMs / 1000,
        });
      },
      heapSamples,
    );
    for (let i = 0; i < run.frameMs.length; i++) allTimes[allTimes.length] = run.frameMs[i]!;
    wallMs += run.wallMs;
    await inst.destroy();
    canvas.remove();
    await sleep(500);
  }
  const heap = heapSummary(heapSamples);
  return {
    caseId: c.id,
    renderer: "jassub",
    frames: allTimes.length,
    windows: c.timestampsMs.length,
    achievedFps: allTimes.length / (wallMs / 1000),
    frameMs: allTimes,
    heapSamples,
    peakHeapBytes: heap.peak,
    steadyHeapBytes: heap.steady,
    notes: ["manualRender paced serial; browser video-mode coalescing is not separately simulated"],
  };
}

async function main(): Promise<void> {
  setWorkerSource("/worker-entry.js");
  setFontResolver(async (name: string) => {
    const res = await fetch(`/font?name=${encodeURIComponent(name)}`);
    if (!res.ok) return null;
    const buf = await res.arrayBuffer();
    registerFontSource(name, buf);
    return buf;
  });

  const manifest = (await (await fetch("/manifest.json")).json()) as Manifest;
  const cases = ONLY.length > 0
    ? manifest.cases.filter((c) => ONLY.includes(c.id) || ONLY.includes(c.upstreamId ?? ""))
    : manifest.cases;
  const backend = await createWebGPUBackend({ canvas: makeCanvas() });

  const runs: RendererResult[] = [];
  for (let i = 0; i < cases.length; i++) {
    const c = cases[i]!;
    runs.push(await runSubframeCase(c, backend));
    await sleep(1000);
    runs.push(await runJassubCase(c));
    await sleep(1500);
  }
  await post("/result", {
    ok: true,
    env: {
      userAgent: navigator.userAgent,
      webgpu: "gpu" in navigator,
      crossOriginIsolated,
      sharedArrayBuffer: typeof SharedArrayBuffer !== "undefined",
      hardwareConcurrency: navigator.hardwareConcurrency,
    },
    frames: FRAMES,
    warmup: WARMUP,
    runs,
  });
}

main().catch(async (err) => {
  await post("/result", {
    ok: false,
    error: String(err),
    stack: (err as Error)?.stack,
  });
});
