// Long Bun memory sampler for the jassub benchmark fixtures. Uses the same
// fixture roots, fonts, resolution, 60fps pacing, and warmup as bench-bun.ts,
// but keeps the worker pool enabled and records raw process/cache growth.
//
// Usage: bun run tools/gpu-headless/mem-bench.ts [--fixture beastars] [--frames 1800] [--workers 1]
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseASS } from "subforge/ass";
import type { SubtitleDocument } from "subforge/core";
import {
  renderFrame,
  clearEventLayerCache,
  clearRasterCaches,
  getEventLayerCacheStats,
} from "../../src/core/pipeline";
import { setFontSearchPaths } from "../../src/io/fonts/resolve";
import { setWorkerPool } from "../../src/core/worker-pool";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "../..");
const FIXTURES = join(ROOT, "test/fixtures/jassub-benchmark");

const W = 1920;
const H = 1080;
const FRAME_MS = 1000 / 60;
const SAMPLE_EVERY = 60;

const FIXTURE_LIST: Record<string, { file: string; t0: number }> = {
  beastars: { file: "beastars.ass", t0: 246350 },
  FGOBD: { file: "FGOBD.ass", t0: 39000 },
};

const argv = process.argv.slice(2);

function argVal(flag: string): string | null {
  const i = argv.indexOf(flag);
  return i !== -1 ? (argv[i + 1] ?? null) : null;
}

const fixtureId = argVal("--fixture") ?? "beastars";
const FRAMES = Number(argVal("--frames") ?? "1800");
const workersArg = argVal("--workers") ?? "1";
const workersOn = workersArg !== "0";

setFontSearchPaths([join(FIXTURES, "fonts")]);

type Sample = {
  frame: number;
  timeMs: number;
  rssMB: number;
  heapMB: number;
  cacheMB: number;
  cacheEntries: number;
  limitMB: number;
  ceilingMB: number;
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const toMB = (bytes: number) => bytes / (1024 * 1024);

function sample(frame: number, timeMs: number): Sample {
  const mem = process.memoryUsage();
  const cache = getEventLayerCacheStats();
  return {
    frame,
    timeMs,
    rssMB: toMB(mem.rss),
    heapMB: toMB(mem.heapUsed),
    cacheMB: toMB(cache.bytes),
    cacheEntries: cache.entries,
    limitMB: toMB(cache.limitBytes),
    ceilingMB: toMB(cache.limitBytesCeiling),
  };
}

function printSample(s: Sample) {
  console.log(
    [
      s.frame,
      s.timeMs.toFixed(1),
      s.rssMB.toFixed(1),
      s.heapMB.toFixed(1),
      s.cacheMB.toFixed(1),
      s.cacheEntries,
      s.limitMB.toFixed(1),
      s.ceilingMB.toFixed(1),
    ].join(","),
  );
}

function slopeMBPerMin(samples: Sample[], key: "rssMB" | "heapMB"): number {
  if (samples.length < 2) return 0;
  let sumX = 0;
  let sumY = 0;
  let sumXX = 0;
  let sumXY = 0;
  for (let i = 0; i < samples.length; i++) {
    const s = samples[i]!;
    const x = s.timeMs / 60_000;
    const y = s[key];
    sumX += x;
    sumY += y;
    sumXX += x * x;
    sumXY += x * y;
  }
  const n = samples.length;
  const denom = n * sumXX - sumX * sumX;
  return denom === 0 ? 0 : (n * sumXY - sumX * sumY) / denom;
}

async function main() {
  const fx = FIXTURE_LIST[fixtureId];
  if (!fx) throw new Error(`unknown --fixture ${fixtureId}; expected one of ${Object.keys(FIXTURE_LIST).join(", ")}`);
  if (!Number.isFinite(FRAMES) || FRAMES <= 0) throw new Error(`invalid --frames ${FRAMES}`);
  if (workersArg !== "0" && workersArg !== "1") throw new Error(`invalid --workers ${workersArg}; expected 0 or 1`);

  const text = readFileSync(join(FIXTURES, "subtitles", fx.file), "utf8");
  const parsed = parseASS(text, { onError: "collect", strict: false, preserveOrder: true });
  const doc: SubtitleDocument = parsed.document;

  clearEventLayerCache();
  clearRasterCaches();
  setWorkerPool(workersOn);

  await renderFrame(doc, fx.t0 - 100, W, H);
  await renderFrame(doc, fx.t0 - 50, W, H);

  const samples: Sample[] = [];
  console.log(`=== mem bench ${fixtureId} frames=${FRAMES} paced 60fps workers=${workersOn ? "on" : "off"} ===`);
  console.log("frame,timeMs,rssMB,heapMB,cacheMB,cacheEntries,limitMB,ceilingMB");
  const initial = sample(0, fx.t0);
  samples.push(initial);
  printSample(initial);

  let activeEventsMax = 0;
  let layersMax = 0;
  const wallStart = performance.now();
  for (let i = 0; i < FRAMES; i++) {
    const target = wallStart + i * FRAME_MS;
    const now = performance.now();
    if (now < target) await sleep(target - now);
    const t = fx.t0 + i * FRAME_MS;
    const result = await renderFrame(doc, t, W, H);
    if (result.activeEvents.length > activeEventsMax) activeEventsMax = result.activeEvents.length;
    if (result.layers.length > layersMax) layersMax = result.layers.length;

    const rendered = i + 1;
    if (rendered % SAMPLE_EVERY === 0 || rendered === FRAMES) {
      const s = sample(rendered, fx.t0 + rendered * FRAME_MS);
      samples.push(s);
      printSample(s);
    }
  }

  const wallTotalMs = performance.now() - wallStart;
  const lastThirdStart = Math.floor(FRAMES * (2 / 3));
  const lastThird = samples.filter((s) => s.frame >= lastThirdStart);
  const rssSlope = slopeMBPerMin(lastThird, "rssMB");
  const heapSlope = slopeMBPerMin(lastThird, "heapMB");
  const threshold = 5;
  const verdict = rssSlope > threshold || heapSlope > threshold ? "still-growing" : "plateau";

  console.log(
    `summary: wallMs=${wallTotalMs.toFixed(0)} achievedFps=${((FRAMES / wallTotalMs) * 1000).toFixed(1)} layersMax=${layersMax} activeEventsMax=${activeEventsMax}`,
  );
  console.log(
    `verdict: ${verdict} lastThirdMediaSlope rssMBPerMin=${rssSlope.toFixed(1)} heapMBPerMin=${heapSlope.toFixed(1)} thresholdMBPerMin=${threshold.toFixed(1)}`,
  );
  process.exit(0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
