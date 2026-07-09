// Perceived-smoothness bench page. Served by run-smoothness.ts through Bun's dev
// bundler (same pipeline as the playground). It plays the dense beastars window
// through the REAL WebGPU backend two ways and measures the DISPLAY interval —
// the wall-clock gap between successive on-screen frame presentations, which IS
// perceived stutter — for each:
//
//   BEFORE (reactive)     — the old playground loop: a rAF loop that advances
//     media time by REAL elapsed wall time and fire-and-forgets an awaited
//     renderFrame guarded by a pendingRender flag, presenting when the render
//     finishes. Cadence == render latency, so the 20-100ms per-frame variance on
//     dense typeset content shows up directly as jitter.
//
//   AFTER (render-ahead)  — the SHIPPED playground/render-ahead.ts RenderAheadPlayer:
//     a producer renders upcoming frames on a uniform media grid into a bounded
//     buffer (feeding the core ring/hybrid prefetch); a display loop presents the
//     ready frame at a steady vsync-multiple cadence.
//
// Both run with the worker pool ON (the ?workers=1 hybrid path). The only variable
// is the loop structure. POSTs JSON present-interval stats to /result.
import { parseASS } from "subforge/ass";
import type { SubtitleDocument } from "subforge/core";
import {
  renderFrame,
  createWebGPUBackend,
  setFontResolver,
  clearEventLayerCache,
  clearRasterCaches,
  setWorkerSource,
  registerFontSource,
  getFramePipelineStats,
  resetFramePipeline,
  type CompositorBackend,
  type RenderResult,
} from "../../src";
import { setWorkerCount } from "../../src/core/worker-pool";
import { RenderAheadPlayer } from "../../playground/render-ahead";

const W = 1920;
const H = 1080;
const QS = new URLSearchParams(location.search);
// Dense beastars sign window (matches the frame-pipeline bench's beastars t0).
const T0 = Number(QS.get("t0")) > 0 ? Number(QS.get("t0")) : 246350;
const MEASURE_MS = Number(QS.get("measureMs")) > 0 ? Number(QS.get("measureMs")) : 8000;
const FIXTURE = QS.get("fixture") ?? "beastars.ass";
const WORKERS = Number(QS.get("workers"));
const GRID_FPS = 60;
const GRID_STEP_MS = 1000 / GRID_FPS;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const raf = (cb: (ts: number) => void) => requestAnimationFrame(cb);

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

function percentile(sortedAsc: number[], p: number): number {
  const n = sortedAsc.length;
  if (n === 0) return 0;
  const idx = Math.min(n - 1, Math.max(0, Math.round((p / 100) * (n - 1))));
  return sortedAsc[idx]!;
}

function stats(intervals: number[]) {
  const sorted = [...intervals].sort((a, b) => a - b);
  let mean = 0;
  for (const v of intervals) mean += v;
  mean = intervals.length ? mean / intervals.length : 0;
  let varSum = 0;
  for (const v of intervals) varSum += (v - mean) * (v - mean);
  const stdev = intervals.length ? Math.sqrt(varSum / intervals.length) : 0;
  return {
    samples: intervals.length,
    p50: percentile(sorted, 50),
    p95: percentile(sorted, 95),
    p99: percentile(sorted, 99),
    max: sorted[sorted.length - 1] ?? 0,
    min: sorted[0] ?? 0,
    mean,
    stdev,
    // Achieved on-screen fps from the median display interval.
    achievedFps: percentile(sorted, 50) > 0 ? 1000 / percentile(sorted, 50) : 0,
  };
}

function pipelineDelta(before: ReturnType<typeof getFramePipelineStats>) {
  const a = getFramePipelineStats();
  const served =
    a.hits - before.hits + (a.scatterFrames - before.scatterFrames) + (a.scatterSingle - before.scatterSingle);
  return {
    served,
    ringHitPct: served > 0 ? (100 * (a.hits - before.hits)) / served : 0,
    ringHits: a.hits - before.hits,
    ringAwaited: a.ringAwaited - before.ringAwaited,
    scatter: a.scatterFrames - before.scatterFrames,
    single: a.scatterSingle - before.scatterSingle,
    conceded: a.ringConceded - before.ringConceded,
    frameCpuEmaMs: a.frameCpuEmaMs,
  };
}

function makeCanvas(): HTMLCanvasElement {
  const c = document.createElement("canvas");
  c.width = W;
  c.height = H;
  document.body.appendChild(c);
  return c;
}

// Warm the caches/JIT/fonts by playing the second leading up to the window, so
// each mode is measured in steady state (not paying one-time cold costs).
async function warmup(doc: SubtitleDocument): Promise<void> {
  for (let t = T0 - 1000; t < T0; t += 50) {
    await renderFrame(doc, t, W, H);
  }
}

// BEFORE: faithful reproduction of the old reactive playground loop. Media time
// advances by real elapsed wall time; a pendingRender flag serializes renders so
// a new frame reaches the screen only when its render finishes — cadence == latency.
async function runReactive(
  doc: SubtitleDocument,
  backend: CompositorBackend,
): Promise<{ display: number[]; renderMs: number[]; pipeline: ReturnType<typeof pipelineDelta> }> {
  clearEventLayerCache();
  clearRasterCaches();
  resetFramePipeline();
  await warmup(doc);
  const pipeBefore = getFramePipelineStats();

  const display: number[] = [];
  const renderMs: number[] = [];
  let lastPresentTs = -1;
  let pending = false;
  let done = false;
  const startWall = performance.now();

  await new Promise<void>((resolve) => {
    const tick = (): void => {
      if (done) return;
      raf(tick);
      if (pending) return;
      const elapsed = performance.now() - startWall;
      if (elapsed >= MEASURE_MS) {
        done = true;
        resolve();
        return;
      }
      const mediaMs = T0 + elapsed; // media follows real time (the old behavior)
      pending = true;
      const r0 = performance.now();
      void renderFrame(doc, mediaMs, W, H).then((result: RenderResult) => {
        renderMs.push(performance.now() - r0);
        backend.render(result.layers, result.frame);
        const ts = performance.now();
        if (lastPresentTs >= 0) display.push(ts - lastPresentTs);
        lastPresentTs = ts;
        pending = false;
      });
    };
    raf(tick);
  });

  return { display, renderMs, pipeline: pipelineDelta(pipeBefore) };
}

// AFTER: the shipped RenderAheadPlayer. Present timestamps are recorded in the
// present callback so the DISPLAY interval is computed identically to BEFORE.
async function runRenderAhead(
  doc: SubtitleDocument,
  backend: CompositorBackend,
): Promise<{
  display: number[];
  renderMs: number[];
  pipeline: ReturnType<typeof pipelineDelta>;
  finalStrideFps: number;
  strideTimeline: Array<{
    elapsedMs: number;
    stride: number;
    bufferDepth: number;
    holds: number;
  }>;
}> {
  clearEventLayerCache();
  clearRasterCaches();
  resetFramePipeline();
  await warmup(doc);
  const pipeBefore = getFramePipelineStats();

  const display: number[] = [];
  const renderMs: number[] = [];
  let lastPresentTs = -1;
  let lastStrideFps = 0;
  const strideTimeline: Array<{
    elapsedMs: number;
    stride: number;
    bufferDepth: number;
    holds: number;
  }> = [];
  let lastStride = -1;
  let timelineStart = performance.now();

  const player = new RenderAheadPlayer(
    {
      render: (d, t, w, h) => {
        const r0 = performance.now();
        return renderFrame(d, t, w, h).then((res) => {
          renderMs.push(performance.now() - r0);
          return res;
        });
      },
      present: (frame) => {
        backend.render(frame.result.layers, frame.result.frame);
        const ts = performance.now();
        if (lastPresentTs >= 0) display.push(ts - lastPresentTs);
        lastPresentTs = ts;
      },
      width: () => W,
      height: () => H,
      now: () => performance.now(),
      requestFrame: raf,
      onStats: (s) => {
        lastStrideFps = s.refreshMs > 0 ? 1000 / (s.stride * s.refreshMs) : 0;
        if (s.stride !== lastStride) {
          strideTimeline.push({
            elapsedMs: performance.now() - timelineStart,
            stride: s.stride,
            bufferDepth: s.bufferDepth,
            holds: s.holds,
          });
          lastStride = s.stride;
        }
      },
    },
    { fps: GRID_FPS },
  );

  timelineStart = performance.now();
  player.start(doc, T0);
  await sleep(MEASURE_MS);
  player.stop();
  // Let any in-flight present settle.
  await sleep(50);

  return {
    display,
    renderMs,
    pipeline: pipelineDelta(pipeBefore),
    finalStrideFps: lastStrideFps,
    strideTimeline,
  };
}

async function main() {
  const env = {
    userAgent: navigator.userAgent,
    hardwareConcurrency: navigator.hardwareConcurrency,
    webgpu: "gpu" in navigator,
    devicePixelRatio,
    gridFps: GRID_FPS,
    gridStepMs: GRID_STEP_MS,
    t0: T0,
    measureMs: MEASURE_MS,
    fixture: FIXTURE,
  };

  setWorkerSource("/worker-entry.js");
  if (Number.isFinite(WORKERS) && WORKERS > 0) setWorkerCount(WORKERS);

  setFontResolver(async (name: string) => {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const res = await fetch(`/font?name=${encodeURIComponent(name)}`);
        if (!res.ok) return null;
        const buf = await res.arrayBuffer();
        registerFontSource(name, buf);
        return buf;
      } catch {
        await sleep(100);
      }
    }
    return null;
  });

  const text = await (await fetch(`/ass/${FIXTURE}`)).text();
  const doc = parseASS(text, { onError: "collect", strict: false, preserveOrder: true }).document;

  const backend = await createWebGPUBackend({ canvas: makeCanvas(), enableGpuFilters: true });
  backend.resize(W, H);

  await post("/log", { msg: "reactive (before) starting" });
  const before = await runReactive(doc, backend);
  await post("/log", { msg: `reactive done: ${before.display.length} display samples` });

  await post("/log", { msg: "render-ahead (after) starting" });
  const after = await runRenderAhead(doc, backend);
  await post("/log", { msg: `render-ahead done: ${after.display.length} display samples` });

  await post("/result", {
    ok: true,
    env,
    reactive: {
      display: stats(before.display),
      render: stats(before.renderMs),
      pipeline: before.pipeline,
    },
    renderAhead: {
      display: stats(after.display),
      render: stats(after.renderMs),
      pipeline: after.pipeline,
      finalStrideFps: after.finalStrideFps,
      strideTimeline: after.strideTimeline,
    },
  });
}

main().catch(async (err) => {
  await post("/result", { ok: false, error: String(err), stack: (err as Error)?.stack });
});
