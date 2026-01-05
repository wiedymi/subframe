import { readFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { diffPng } from "./diff/pngdiff";

type Manifest = {
  viewport: { width: number; height: number };
  fontsDir: string;
  threshold?: { max: number; mean: number; pct: number };
  renderers: {
    libass: { cmd: string[] };
    subframe: { cmd: string[] };
  };
  cases: Array<{
    id: string;
    ass: string;
    timestampsMs: number[];
    threshold?: { max: number; mean: number; pct: number };
  }>;
};

function collectArgs(args: string[], name: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === name && args[i + 1]) {
      out[out.length] = args[i + 1]!;
      i++;
    }
  }
  return out;
}

function getArg(args: string[], name: string, fallback?: string): string | undefined {
  const idx = args.indexOf(name);
  if (idx === -1) return fallback;
  return args[idx + 1] ?? fallback;
}

function run(cmd: string[], args: string[]) {
  const proc = Bun.spawn({ cmd: [...cmd, ...args], stdout: "inherit", stderr: "inherit" });
  return proc.exited;
}

async function main() {
  const args = process.argv.slice(2);
  const updateRef = args.includes("--update-ref");
  const traceAlways = args.includes("--trace");
  const traceOnFail = args.includes("--trace-on-fail");
  const caseArgs = collectArgs(args, "--case");
  const timeArgs = collectArgs(args, "--time");
  const reportPath = getArg(args, "--report");
  const fontsOverride = getArg(args, "--fonts");
  const manifestPath = args[0] && !args[0].startsWith("--") ? args[0] : "test/manifest.json";

  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as Manifest;
  const { width, height } = manifest.viewport;
  const fontsDir = fontsOverride ?? manifest.fontsDir;
  const defaultThreshold = manifest.threshold || { max: 2, mean: 0.5, pct: 0.1 };
  const caseFilter = new Set(caseArgs.flatMap((v) => v.split(",").map((s) => s.trim()).filter(Boolean)));
  const timeFilter = new Set(
    timeArgs.flatMap((v) => v.split(",").map((s) => s.trim()).filter(Boolean).map((t) => Number(t)))
  );

  let failures = 0;
  const report: {
    manifest: string;
    viewport: { width: number; height: number };
    generatedAt: string;
    totals: { failures: number };
    cases: Array<{
      id: string;
      timestamps: Array<{
        t: number;
        ok: boolean;
        stats: { maxError: number; meanError: number; pctOver: number };
        threshold: { max: number; mean: number; pct: number };
      }>;
    }>;
  } = {
    manifest: manifestPath,
    viewport: { width, height },
    generatedAt: new Date().toISOString(),
    totals: { failures: 0 },
    cases: [],
  };

  const traceEnabled = traceAlways || traceOnFail;

  for (const c of manifest.cases) {
    if (caseFilter.size > 0 && !caseFilter.has(c.id)) continue;
    const threshold = c.threshold || defaultThreshold;
    const timestamps =
      timeFilter.size > 0 ? c.timestampsMs.filter((t) => timeFilter.has(t)) : c.timestampsMs;
    if (timestamps.length === 0) continue;
    const reportCase = { id: c.id, timestamps: [] as any[] };
    report.cases[report.cases.length] = reportCase;

    for (const t of timestamps) {
      const refOut = join("test/expected/libass", c.id, `${t}.png`);
      const outOut = join("test/expected/subframe", c.id, `${t}.png`);
      const diffOut = join("test/expected/diff", c.id, `${t}.png`);
      const statsOut = join("test/expected/diff", c.id, `${t}.json`);
      const traceOut = join("test/expected/trace", c.id, `${t}.json`);

      mkdirSync(dirname(refOut), { recursive: true });
      mkdirSync(dirname(outOut), { recursive: true });

      if (updateRef || !existsSync(refOut)) {
        const refArgs = [
          "--ass", c.ass,
          "--time", String(t),
          "--w", String(width),
          "--h", String(height),
          "--out", refOut,
        ];
        if (fontsDir) {
          refArgs.splice(refArgs.length - 1, 0, "--fonts", fontsDir);
        }
        const code = await run(manifest.renderers.libass.cmd, refArgs);
        if (code !== 0) {
          console.error(`libass render failed for ${c.id} @ ${t}ms`);
          failures++;
          continue;
        }
      }

      const outArgs = [
        "--ass", c.ass,
        "--time", String(t),
        "--w", String(width),
        "--h", String(height),
        "--out", outOut,
      ];
      if (fontsDir) {
        outArgs.splice(outArgs.length - 1, 0, "--fonts", fontsDir);
      }
      const code = await run(manifest.renderers.subframe.cmd, outArgs);
      if (code !== 0) {
        console.error(`subframe render failed for ${c.id} @ ${t}ms`);
        failures++;
        continue;
      }

      const stats = diffPng(refOut, outOut, diffOut, statsOut, 1);
      const bad =
        stats.maxError > threshold.max ||
        stats.meanError > threshold.mean ||
        stats.pctOver > threshold.pct;

      reportCase.timestamps[reportCase.timestamps.length] = {
        t,
        ok: !bad,
        stats: {
          maxError: stats.maxError,
          meanError: stats.meanError,
          pctOver: stats.pctOver,
        },
        threshold: {
          max: threshold.max,
          mean: threshold.mean,
          pct: threshold.pct,
        },
      };

      if (bad) {
        failures++;
        console.error(
          `diff failed ${c.id} @ ${t}ms: max=${stats.maxError} mean=${stats.meanError.toFixed(3)} pct=${stats.pctOver.toFixed(3)}%`
        );
        if (traceEnabled) {
          const traceArgs = [
            "run",
            "tools/trace/render_trace.ts",
            "--ass",
            c.ass,
            "--time",
            String(t),
            "--w",
            String(width),
            "--h",
            String(height),
            "--out",
            traceOut,
          ];
          if (fontsDir) {
            traceArgs.splice(traceArgs.length - 1, 0, "--fonts", fontsDir);
          }
          await run(["bun"], traceArgs);
        }
      } else {
        console.log(`ok ${c.id} @ ${t}ms`);
        if (traceAlways) {
          const traceArgs = [
            "run",
            "tools/trace/render_trace.ts",
            "--ass",
            c.ass,
            "--time",
            String(t),
            "--w",
            String(width),
            "--h",
            String(height),
            "--out",
            traceOut,
          ];
          if (fontsDir) {
            traceArgs.splice(traceArgs.length - 1, 0, "--fonts", fontsDir);
          }
          await run(["bun"], traceArgs);
        }
      }
    }
  }

  report.totals.failures = failures;
  if (reportPath) {
    await Bun.write(reportPath, JSON.stringify(report, null, 2));
  }

  if (failures > 0) {
    console.error(`Failures: ${failures}`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
