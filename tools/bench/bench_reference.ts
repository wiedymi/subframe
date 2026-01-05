import { parseASS } from "subforge/ass";
import { renderFrame } from "../../src/core/pipeline";
import { resetFontCache } from "../../src/io/fonts/cache";
import { setFontSearchPaths } from "../../src/io/fonts/resolve";

const REFERENCE_ASS = String.raw`[Script Info]
Title: reference-complex-event
ScriptType: v4.00+
PlayResX: 1920
PlayResY: 1080
WrapStyle: 0
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,Arial,64,&H00FFFFFF,&H000000FF,&H00000000,&H80000000,-1,0,0,0,100,100,0,0,1,4,3,2,100,100,60,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
Dialogue: 0,0:00:00.00,0:00:02.00,Default,,0,0,0,,{\\bord4\\shad3\\blur2\\be1\\frx10\\fry-8\\frz5\\fax0.05\\fay-0.05\\t(0,1000,\\fscx120\\fscy120\\frz15\\blur1)}{\\k20}Com{\\k30}plex{\\k40} Event {\\k20}Test {\\p1\\pos(960,540)}m 0 0 l 120 0 120 60 0 60{\\p0}
`;

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

if (import.meta.main) {
  const args = process.argv.slice(2);
  const warmup = Number(getArg(args, "--warmup", "1"));
  const iterations = Number(getArg(args, "--iters", "5"));
  const fonts = getArg(args, "--fonts");
  const fpsArg = getArg(args, "--fps");
  const budgetArg = getArg(args, "--budget-ms");
  const outPath = getArg(args, "--out");
  const enforce = args.includes("--enforce");

  const fps = fpsArg ? Number(fpsArg) : 0;
  const frameBudgetMs = budgetArg ? Number(budgetArg) : fps > 0 ? 1000 / fps : 0;
  const tailTargets =
    fps === 60 ? { p95: 20, p99: 24 } : fps === 120 ? { p95: 12, p99: 16 } : null;

  if (fonts) {
    setFontSearchPaths(fonts.split(","));
    resetFontCache();
  }

  if (enforce && (!Number.isFinite(frameBudgetMs) || frameBudgetMs <= 0)) {
    console.error("Set --fps or --budget-ms when using --enforce");
    process.exit(1);
  }

  const parsed = parseASS(REFERENCE_ASS, { onError: "collect", strict: false, preserveOrder: true });
  if (!parsed.ok) {
    console.warn(`parse errors: ${parsed.errors.length}`);
  }

  const timestamps = [0, 500, 1000, 1500];
  (async () => {
    for (let w = 0; w < warmup; w++) {
      for (const t of timestamps) {
        await renderFrame(parsed.document, t, 1920, 1080);
      }
    }

    const samples: number[] = [];
    for (let i = 0; i < iterations; i++) {
      for (const t of timestamps) {
        const start = performance.now();
        await renderFrame(parsed.document, t, 1920, 1080);
        const end = performance.now();
        samples[samples.length] = end - start;
      }
    }

    const p50 = percentile(samples, 0.5);
    const p95 = percentile(samples, 0.95);
    const p99 = percentile(samples, 0.99);
    const mean = samples.reduce((a, b) => a + b, 0) / Math.max(1, samples.length);
    console.log(
      `reference: samples=${samples.length} mean=${mean.toFixed(2)}ms p50=${p50.toFixed(2)}ms p95=${p95.toFixed(2)}ms p99=${p99.toFixed(2)}ms`
    );

    if (outPath) {
      const report = {
        id: "reference",
        viewport: { width: 1920, height: 1080 },
        fps: fps || null,
        frameBudgetMs: frameBudgetMs || null,
        warmup,
        iterations,
        timestamps,
        stats: { mean, p50, p95, p99, samples: samples.length },
        env: {
          platform: process.platform,
          arch: process.arch,
          node: process.version,
          bun: typeof Bun !== "undefined" ? Bun.version : null,
        },
        generatedAt: new Date().toISOString(),
      };
      await Bun.write(outPath, JSON.stringify(report, null, 2));
    }

    if (enforce) {
      const budgetFail = p95 > frameBudgetMs;
      const tailFail = tailTargets ? p95 > tailTargets.p95 || p99 > tailTargets.p99 : false;
      if (budgetFail || tailFail) {
        const budgetMsg = `frameBudget=${frameBudgetMs.toFixed(2)}ms`;
        const tailMsg = tailTargets ? `p95<=${tailTargets.p95}ms p99<=${tailTargets.p99}ms` : "tail targets off";
        console.error(`FAIL reference: ${budgetMsg} ${tailMsg}`);
        process.exit(1);
      }
    }
  })().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
