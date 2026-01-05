import { readFileSync } from "node:fs";
import { parseASS } from "subforge/ass";
import { renderFrame } from "../../src/core/pipeline";
import { resetFontCache } from "../../src/io/fonts/cache";
import { setFontSearchPaths } from "../../src/io/fonts/resolve";

type Manifest = {
  viewport: { width: number; height: number };
  cases: Array<{ id: string; ass: string; timestampsMs: number[] }>;
};

function getArg(args: string[], name: string, fallback?: string) {
  const idx = args.indexOf(name);
  if (idx === -1) return fallback;
  return args[idx + 1];
}

function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.floor(p * (sorted.length - 1)));
  return sorted[idx]!;
}

type Sample = { dt: number; activeEvents: number; ts: number };

async function benchCase(
  assPath: string,
  timestamps: number[],
  width: number,
  height: number,
  warmup: number,
  iterations: number
): Promise<{ samples: Sample[]; samplesByTs: Map<number, Sample[]> }> {
  const text = readFileSync(assPath, "utf8");
  const parsed = parseASS(text, { onError: "collect", strict: false, preserveOrder: true });
  if (!parsed.ok) {
    console.warn(`parse errors for ${assPath}: ${parsed.errors.length}`);
  }

  const samples: Sample[] = [];
  const samplesByTs = new Map<number, Sample[]>();
  for (let w = 0; w < warmup; w++) {
    for (const t of timestamps) {
      await renderFrame(parsed.document, t, width, height);
    }
  }

  for (let i = 0; i < iterations; i++) {
    for (const t of timestamps) {
      const start = performance.now();
      const result = await renderFrame(parsed.document, t, width, height);
      const end = performance.now();
      const dt = end - start;
      const sample = { dt, activeEvents: result.activeEvents.length, ts: t };
      samples[samples.length] = sample;
      const arr = samplesByTs.get(t);
      if (arr) arr[arr.length] = sample;
      else samplesByTs.set(t, [sample]);
    }
  }

  return { samples, samplesByTs };
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const manifestPath = getArg(args, "--manifest", "test/manifest.json")!;
  const warmup = Number(getArg(args, "--warmup", "1"));
  const iterations = Number(getArg(args, "--iters", "3"));
  const fonts = getArg(args, "--fonts");
  const fpsArg = getArg(args, "--fps");
  const budgetArg = getArg(args, "--budget-ms");
  const outPath = getArg(args, "--out");
  const enforce = args.includes("--enforce");

  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as Manifest;
  const { width, height } = manifest.viewport;
  const fps = fpsArg ? Number(fpsArg) : 0;
  const frameBudgetMs = budgetArg ? Number(budgetArg) : fps > 0 ? 1000 / fps : 0;
  const tailTargets =
    fps === 60 ? { p95: 20, p99: 24 } : fps === 120 ? { p95: 12, p99: 16 } : null;

  if (fonts) {
    setFontSearchPaths(fonts.split(","));
    resetFontCache();
  }

  if (enforce && !Number.isFinite(frameBudgetMs)) {
    console.error("Invalid --budget-ms or --fps");
    process.exit(1);
  }
  if (enforce && frameBudgetMs <= 0) {
    console.error("Set --fps or --budget-ms when using --enforce");
    process.exit(1);
  }

  (async () => {
    let failures = 0;
    const report: {
      viewport: { width: number; height: number };
      fps: number | null;
      frameBudgetMs: number | null;
      warmup: number;
      iterations: number;
      cases: Array<{
        id: string;
        samples: number;
        mean: number;
        p50: number;
        p95: number;
        p99: number;
        activeMean: number;
        perEventMean: number;
        perEventP50: number;
        perEventP95: number;
        perEventP99: number;
        timestamps: Array<{
          ts: number;
          mean: number;
          p95: number;
          p99: number;
          activeMean: number;
          perEventMean: number;
          perEventP95: number;
          perEventP99: number;
        }>;
      }>;
      env: { platform: string; arch: string; node: string; bun: string | null };
      generatedAt: string;
    } = {
      viewport: { width, height },
      fps: fps || null,
      frameBudgetMs: frameBudgetMs || null,
      warmup,
      iterations,
      cases: [],
      env: {
        platform: process.platform,
        arch: process.arch,
        node: process.version,
        bun: typeof Bun !== "undefined" ? Bun.version : null,
      },
      generatedAt: new Date().toISOString(),
    };
    for (const c of manifest.cases) {
      const { samples, samplesByTs } = await benchCase(c.ass, c.timestampsMs, width, height, warmup, iterations);
      const dts = samples.map((s) => s.dt);
      const perEventSamples = samples.map((s) => s.dt / Math.max(1, s.activeEvents));
      const p50 = percentile(dts, 0.5);
      const p95 = percentile(dts, 0.95);
      const p99 = percentile(dts, 0.99);
      const perEventP50 = percentile(perEventSamples, 0.5);
      const perEventP95 = percentile(perEventSamples, 0.95);
      const perEventP99 = percentile(perEventSamples, 0.99);
      const mean = dts.reduce((a, b) => a + b, 0) / Math.max(1, dts.length);
      const activeMean =
        samples.reduce((acc, s) => acc + s.activeEvents, 0) / Math.max(1, samples.length);
      const perEventMean =
        samples.reduce((acc, s) => acc + s.dt / Math.max(1, s.activeEvents), 0) / Math.max(1, samples.length);
      console.log(
        `${c.id}: samples=${samples.length} mean=${mean.toFixed(2)}ms p50=${p50.toFixed(2)}ms p95=${p95.toFixed(2)}ms p99=${p99.toFixed(2)}ms active~${activeMean.toFixed(1)} perEvent~${perEventMean.toFixed(2)}ms p95~${perEventP95.toFixed(2)}ms p99~${perEventP99.toFixed(2)}ms`
      );
      const timestampStats: Array<{
        ts: number;
        mean: number;
        p95: number;
        p99: number;
        activeMean: number;
        perEventMean: number;
        perEventP95: number;
        perEventP99: number;
      }> = [];
      for (const [ts, list] of samplesByTs.entries()) {
        const tsDts = list.map((s) => s.dt);
        const tsPerEventSamples = list.map((s) => s.dt / Math.max(1, s.activeEvents));
        const tsMean = tsDts.reduce((a, b) => a + b, 0) / Math.max(1, tsDts.length);
        const tsP95 = percentile(tsDts, 0.95);
        const tsP99 = percentile(tsDts, 0.99);
        const tsActive =
          list.reduce((acc, s) => acc + s.activeEvents, 0) / Math.max(1, list.length);
        const tsPerEvent =
          list.reduce((acc, s) => acc + s.dt / Math.max(1, s.activeEvents), 0) / Math.max(1, list.length);
        const tsPerEventP95 = percentile(tsPerEventSamples, 0.95);
        const tsPerEventP99 = percentile(tsPerEventSamples, 0.99);
        console.log(
          `  @${ts}ms: mean=${tsMean.toFixed(2)}ms p95=${tsP95.toFixed(2)}ms p99=${tsP99.toFixed(2)}ms active~${tsActive.toFixed(1)} perEvent~${tsPerEvent.toFixed(2)}ms p95~${tsPerEventP95.toFixed(2)}ms p99~${tsPerEventP99.toFixed(2)}ms`
        );
        timestampStats[timestampStats.length] = {
          ts,
          mean: tsMean,
          p95: tsP95,
          p99: tsP99,
          activeMean: tsActive,
          perEventMean: tsPerEvent,
          perEventP95: tsPerEventP95,
          perEventP99: tsPerEventP99,
        };
      }

      report.cases[report.cases.length] = {
        id: c.id,
        samples: samples.length,
        mean,
        p50,
        p95,
        p99,
        activeMean,
        perEventMean,
        perEventP50,
        perEventP95,
        perEventP99,
        timestamps: timestampStats,
      };

      if (enforce) {
        const budgetFail = p95 > frameBudgetMs;
        const perEventBudget = frameBudgetMs / Math.max(1, activeMean);
        const perEventBudgetFail = perEventP95 > perEventBudget;
        const tailFail = tailTargets ? p95 > tailTargets.p95 || p99 > tailTargets.p99 : false;
        const tailEventFail = tailTargets
          ? perEventP95 > tailTargets.p95 / Math.max(1, activeMean) || perEventP99 > tailTargets.p99 / Math.max(1, activeMean)
          : false;
        const messages: string[] = [];
        if (budgetFail || tailFail) {
          const budgetMsg = `frameBudget=${frameBudgetMs.toFixed(2)}ms`;
          const tailMsg = tailTargets ? `p95<=${tailTargets.p95}ms p99<=${tailTargets.p99}ms` : "tail targets off";
          messages[messages.length] = `${budgetMsg} ${tailMsg}`;
        }
        if (perEventBudgetFail || tailEventFail) {
          const perEventMsg = `perEventBudget~${perEventBudget.toFixed(2)}ms`;
          const tailMsg = tailTargets
            ? `perEvent p95<=${(tailTargets.p95 / Math.max(1, activeMean)).toFixed(2)}ms p99<=${(tailTargets.p99 / Math.max(1, activeMean)).toFixed(2)}ms`
            : "perEvent tail targets off";
          messages[messages.length] = `${perEventMsg} ${tailMsg}`;
        }
        if (messages.length > 0) {
          failures++;
          for (const msg of messages) console.error(`  FAIL ${c.id}: ${msg}`);
        }
      }
    }
    if (outPath) {
      await Bun.write(outPath, JSON.stringify(report, null, 2));
    }
    if (enforce && failures > 0) process.exit(1);
  })().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
