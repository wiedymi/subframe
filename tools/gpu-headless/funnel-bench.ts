// Prewarm-funnel analysis run: replicates bench-bun.ts's paced 60fps protocol
// for a single fixture/config, with SUBFRAME_FUNNEL instrumentation and
// dropped-frame accounting (a frame is DROPPED when it finishes after the end
// of its 16.7ms slot). Writes the raw per-event funnel dump to --dump for
// offline analysis (loss histograms, working-set measurement).
//
// Usage: SUBFRAME_FUNNEL=1 bun run tools/gpu-headless/funnel-bench.ts \
//          [--fixture beastars] [--dump funnel.json] [--frames 300]
import { readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parseASS } from "subforge/ass";
import type { SubtitleDocument } from "subforge/core";
import {
  renderFrame,
  clearEventLayerCache,
  clearRasterCaches,
  getEventLayerCacheStats,
} from "../../src/core/pipeline";
import { getPrewarmFunnelDump, getPrewarmFunnelStats } from "../../src/core/pipeline/event";
import { setFontSearchPaths } from "../../src/io/fonts/resolve";
import { getWorkerPoolStats, setWorkerPool } from "../../src/core/worker-pool";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "../..");
const FIXTURES = join(ROOT, "test/fixtures/jassub-benchmark");

const W = 1920;
const H = 1080;
const FRAME_MS = 1000 / 60;

const argv = process.argv.slice(2);
function argOf(name: string, dflt: string): string {
  const i = argv.indexOf(name);
  return i !== -1 ? argv[i + 1]! : dflt;
}
const fixtureId = argOf("--fixture", "beastars");
const dumpPath = argOf("--dump", "");
const FRAMES = Number(argOf("--frames", "300"));
// --warm: use bench-entry.ts's warmup protocol (playback approaching the
// window for 1s at 50ms steps) instead of bench-bun.ts's two frames.
const warm = argv.includes("--warm");

const T0: Record<string, { file: string; t0: number }> = {
  beastars: { file: "beastars.ass", t0: 246350 },
  FGOBD: { file: "FGOBD.ass", t0: 39000 },
  fate: { file: "fate.ass", t0: 0 },
  kusriya: { file: "Kusriya S2 OP1v3.ass", t0: 35000 },
};

setFontSearchPaths([join(FIXTURES, "fonts")]);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function percentile(sortedAsc: number[], p: number): number {
  if (sortedAsc.length === 0) return 0;
  const idx = Math.min(
    sortedAsc.length - 1,
    Math.max(0, Math.round((p / 100) * (sortedAsc.length - 1))),
  );
  return sortedAsc[idx]!;
}

async function main() {
  const fx = T0[fixtureId];
  if (!fx) throw new Error(`unknown fixture ${fixtureId}`);
  const text = readFileSync(join(FIXTURES, "subtitles", fx.file), "utf8");
  const parsed = parseASS(text, { onError: "collect", strict: false, preserveOrder: true });
  const doc: SubtitleDocument = parsed.document;

  clearEventLayerCache();
  clearRasterCaches();
  setWorkerPool(true);

  if (warm) {
    // bench-entry.ts protocol: playback approaches the window for 1s.
    for (let t = fx.t0 - 1000; t < fx.t0; t += 50) {
      await renderFrame(doc, t, W, H);
    }
  } else {
    // Same warmup as bench-bun.ts.
    await renderFrame(doc, fx.t0 - 100, W, H);
    await renderFrame(doc, fx.t0 - 50, W, H);
  }

  const cache0 = getEventLayerCacheStats();

  const renderMs = new Array<number>(FRAMES);
  const finishRel = new Array<number>(FRAMES);
  const layerCounts = new Array<number>(FRAMES);

  const wallStart = performance.now();
  for (let i = 0; i < FRAMES; i++) {
    const target = wallStart + i * FRAME_MS;
    const now = performance.now();
    if (now < target) await sleep(target - now);
    const t = fx.t0 + i * FRAME_MS;
    const a = performance.now();
    const result = await renderFrame(doc, t, W, H);
    const b = performance.now();
    renderMs[i] = b - a;
    finishRel[i] = b - wallStart;
    layerCounts[i] = result.layers.length;
  }
  const wallTotalMs = performance.now() - wallStart;

  const cache1 = getEventLayerCacheStats();
  const pool = getWorkerPoolStats();
  const funnel = getPrewarmFunnelStats();

  // A frame is DROPPED when its render exceeds its 1/60s slot. Cumulative
  // lateness (finishRel) is reported separately as catch-up debt.
  let dropped = 0;
  const droppedIdx: number[] = [];
  for (let i = 0; i < FRAMES; i++) {
    if (renderMs[i]! > FRAME_MS) {
      dropped++;
      if (droppedIdx.length < 60) droppedIdx.push(i);
    }
  }
  const lateAtEndMs = Math.max(0, finishRel[FRAMES - 1]! - FRAMES * FRAME_MS);
  const sorted = [...renderMs].sort((x, y) => x - y);
  const mean = renderMs.reduce((x, y) => x + y, 0) / FRAMES;

  console.log(`=== funnel bench ${fixtureId} frames=${FRAMES} paced 60fps ===`);
  console.log(
    `render: p50 ${percentile(sorted, 50).toFixed(2)} p95 ${percentile(sorted, 95).toFixed(2)} p99 ${percentile(sorted, 99).toFixed(2)} max ${sorted[FRAMES - 1]!.toFixed(2)} mean ${mean.toFixed(2)} ms`,
  );
  console.log(
    `dropped: ${dropped}/${FRAMES} (${((dropped / FRAMES) * 100).toFixed(1)}%) idx=${JSON.stringify(droppedIdx)}`,
  );
  console.log(
    `wall ${wallTotalMs.toFixed(0)}ms achievedFps ${((FRAMES / wallTotalMs) * 1000).toFixed(1)} lateAtEnd ${lateAtEndMs.toFixed(0)}ms`,
  );
  console.log(`pool: ${JSON.stringify({ ...pool, funnel: undefined })}`);
  console.log(`funnel: ${JSON.stringify(funnel)}`);
  console.log(
    `cacheDelta: ${JSON.stringify({
      hits: cache1.hits - cache0.hits,
      misses: cache1.misses - cache0.misses,
      evictions: cache1.evictions - cache0.evictions,
      neverHitEvictions: cache1.neverHitEvictions - cache0.neverHitEvictions,
      entriesEnd: cache1.entries,
      bytesEnd: cache1.bytes,
      limitBytes: cache1.limitBytes,
    })}`,
  );

  if (dumpPath) {
    writeFileSync(
      dumpPath,
      JSON.stringify({
        fixture: fixtureId,
        t0: fx.t0,
        frames: FRAMES,
        frameMs: FRAME_MS,
        renderMs,
        finishRel,
        layerCounts,
        funnelDump: getPrewarmFunnelDump(),
      }),
    );
    console.log(`dump written to ${dumpPath}`);
  }
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
