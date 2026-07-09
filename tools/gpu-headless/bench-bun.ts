// Bun-side twin of bench-entry.ts: identical fixtures, timestamps, resolution,
// pacing, and configs (minus GPU compositing, which Bun lacks). Establishes the
// Bun-vs-Chrome delta for the same workload.
//
// Usage: bun run tools/gpu-headless/bench-bun.ts [--fixture id] [--config id] [--out result.json]
import { readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parseASS } from "subforge/ass";
import type { SubtitleDocument } from "subforge/core";
import {
  renderFrame,
  releaseRenderResult,
  prepareDocument,
  clearEventLayerCache,
  clearRasterCaches,
  getEventLayerCacheStats,
  getFramePipelineStats,
  setFramePipeline,
} from "../../src/core/pipeline";
import { setFontSearchPaths } from "../../src/io/fonts/resolve";
import { getWorkerPoolStats, setWorkerPool, isWorkerPoolUsable } from "../../src/core/worker-pool";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "../..");
const FIXTURES = join(ROOT, "test/fixtures/jassub-benchmark");

const W = 1920;
const H = 1080;
const FRAMES = 300;
const FRAME_MS = 1000 / 60;

const argv = process.argv.slice(2);
function argVal(flag: string): string | null {
  const i = argv.indexOf(flag);
  return i !== -1 ? (argv[i + 1] ?? null) : null;
}
const outPath = argVal("--out");
const fixtureFilter = argVal("--fixture");
const configFilter = argVal("--config");

setFontSearchPaths([join(FIXTURES, "fonts")]);

type Fixture = { id: string; file: string; t0: number };
type Config = { id: string; workers: boolean; profile: boolean };

const FIXTURE_LIST: Fixture[] = [
  { id: "beastars", file: "beastars.ass", t0: 246350 },
  { id: "FGOBD", file: "FGOBD.ass", t0: 39000 },
  { id: "kusriya", file: "kusriya-s2-op1v3.ass", t0: 35000 },
];

const CONFIGS: Config[] = [
  { id: "default", workers: true, profile: false },
  { id: "workers-off", workers: false, profile: false },
  { id: "profiled", workers: true, profile: true },
  { id: "workers-off-profiled", workers: false, profile: true },
];

const selectedFixtures = fixtureFilter
  ? FIXTURE_LIST.filter((fixture) => fixture.id === fixtureFilter)
  : FIXTURE_LIST;
const selectedConfigs = configFilter ? CONFIGS.filter((config) => config.id === configFilter) : CONFIGS;

if (selectedFixtures.length === 0) {
  throw new Error(`unknown --fixture ${fixtureFilter}; expected one of ${FIXTURE_LIST.map((f) => f.id).join(", ")}`);
}
if (selectedConfigs.length === 0) {
  throw new Error(`unknown --config ${configFilter}; expected one of ${CONFIGS.map((c) => c.id).join(", ")}`);
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

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

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

async function runOne(fixture: Fixture, config: Config): Promise<Record<string, unknown>> {
  const text = readFileSync(join(FIXTURES, "subtitles", fixture.file), "utf8");
  const parsed = parseASS(text, { onError: "collect", strict: false, preserveOrder: true });
  const doc: SubtitleDocument = parsed.document;

  clearEventLayerCache();
  clearRasterCaches();
  setWorkerPool(config.workers);
  setFramePipeline(config.workers);

  let stages: StageTotals | null = null;
  const origLog = console.log.bind(console);
  if (config.profile) {
    process.env.SUBFRAME_PROFILE = "1";
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

  const prepared = await prepareDocument(doc, W, H, { timeMs: fixture.t0, boundaryWarmupMs: 500 });
  releaseRenderResult(prepared);

  const cache0 = getEventLayerCacheStats();
  const pool0 = getWorkerPoolStats();
  const framePipe0 = getFramePipelineStats();

  const renderMs = new Array<number>(FRAMES);
  const layerCounts = new Array<number>(FRAMES);
  let activeEventsMax = 0;

  const wallStart = performance.now();
  for (let i = 0; i < FRAMES; i++) {
    const target = wallStart + i * FRAME_MS;
    const now = performance.now();
    if (now < target) await sleep(target - now);
    const t = fixture.t0 + i * FRAME_MS;
    const a = performance.now();
    const result = await renderFrame(doc, t, W, H);
    const b = performance.now();
    renderMs[i] = b - a;
    layerCounts[i] = result.layers.length;
    if (result.activeEvents.length > activeEventsMax) activeEventsMax = result.activeEvents.length;
    releaseRenderResult(result);
  }
  const wallTotalMs = performance.now() - wallStart;

  const cache1 = getEventLayerCacheStats();
  const pool1 = getWorkerPoolStats();
  const framePipe1 = getFramePipelineStats();

  if (config.profile) {
    console.log = origLog;
    delete process.env.SUBFRAME_PROFILE;
  }

  return {
    fixture: fixture.id,
    config: config.id,
    frames: FRAMES,
    wallTotalMs,
    achievedFps: (FRAMES / wallTotalMs) * 1000,
    renderMs,
    layerCounts,
    activeEventsMax,
    workerPoolBefore: pool0,
    workerPoolAfter: pool1,
    workerPoolUsableAfter: isWorkerPoolUsable(),
    framePipelineDelta: {
      dedupHits: framePipe1.dedupHits - framePipe0.dedupHits,
      dedupFrames: framePipe1.dedupFrames - framePipe0.dedupFrames,
      boundaryHits: framePipe1.boundaryHits - framePipe0.boundaryHits,
      boundaryAwaited: framePipe1.boundaryAwaited - framePipe0.boundaryAwaited,
      boundaryMisfires: framePipe1.boundaryMisfires - framePipe0.boundaryMisfires,
      boundaryFiredEarly: framePipe1.boundaryFiredEarly - framePipe0.boundaryFiredEarly,
      boundaryStale: framePipe1.boundaryStale - framePipe0.boundaryStale,
      boundaryPrewarmSuppressed:
        framePipe1.boundaryPrewarmSuppressed - framePipe0.boundaryPrewarmSuppressed,
    },
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
  const runs: Array<Record<string, unknown>> = [];
  for (const fixture of selectedFixtures) {
    for (const config of selectedConfigs) {
      console.log(`[bun-bench] start ${fixture.id}/${config.id}`);
      runs.push(await runOne(fixture, config));
      if (outPath) writeFileSync(outPath, JSON.stringify({ runs }, null, 2));
    }
  }

  console.log("\n=== Bun bench result ===");
  for (const run of runs as any[]) {
    const r = summarize(run.renderMs);
    console.log(`\n--- ${run.fixture} / ${run.config} ---`);
    console.log(
      `render: p50 ${r.p50.toFixed(2)}  p95 ${r.p95.toFixed(2)}  max ${r.max.toFixed(2)}  mean ${r.mean.toFixed(2)} ms`,
    );
    console.log(
      `wall ${run.wallTotalMs.toFixed(0)}ms achievedFps ${run.achievedFps.toFixed(1)} layersMax ${Math.max(...run.layerCounts)} activeEventsMax ${run.activeEventsMax}`,
    );
    console.log(
      `workerPool after: ${JSON.stringify(run.workerPoolAfter)} usable=${run.workerPoolUsableAfter}`,
    );
    if (run.workerPoolAfter) {
      const wp = run.workerPoolAfter;
      console.log(
        `arenaFreelist: returned=${wp.arenaReturned ?? 0} reused=${wp.arenaReused ?? 0} dropped=${wp.arenaDropped ?? 0}`,
      );
    }
    if (run.framePipelineDelta) {
      const d = run.framePipelineDelta;
      const pct = d.dedupFrames > 0 ? (100 * d.dedupHits) / d.dedupFrames : 0;
      const parkedPct =
        d.boundaryHits > 0
          ? (100 * (d.boundaryHits - d.boundaryAwaited)) / d.boundaryHits
          : 0;
      console.log(`frameDedup: ${d.dedupHits}/${d.dedupFrames} (${pct.toFixed(1)}%)`);
      console.log(
        `boundary: hits=${d.boundaryHits} awaited=${d.boundaryAwaited} misfires=${d.boundaryMisfires} stale=${d.boundaryStale} firedEarly=${d.boundaryFiredEarly} suppressed=${d.boundaryPrewarmSuppressed ?? 0} parkedInTime=${parkedPct.toFixed(1)}%`,
      );
    }
    console.log(`cacheDelta: ${JSON.stringify(run.cacheDelta)}`);
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
