import { existsSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { createHash } from "node:crypto";
import { diffPng } from "../diff/pngdiff";

type FixtureSweep = {
  id: string;
  ass: string;
  start: number;
  end: number;
  step: number;
};

type DiffRow = {
  fixture: string;
  ass: string;
  timeMs: number;
  refPath: string;
  subPath: string;
  diffPath: string;
  maxError: number;
  meanError: number;
  pixelsOver: number;
  pctOver: number;
};

const DEFAULT_FONTS = "test/fixtures/jassub-benchmark/fonts";
const DEFAULT_SWEEPS: FixtureSweep[] = [
  {
    id: "FGOBD",
    ass: "test/fixtures/jassub-benchmark/subtitles/FGOBD.ass",
    start: 20000,
    end: 100000,
    step: 400,
  },
  {
    id: "beastars",
    ass: "test/fixtures/jassub-benchmark/subtitles/beastars.ass",
    start: 246350,
    end: 251350,
    step: 500,
  },
];

function getArg(args: string[], name: string, fallback?: string): string | undefined {
  const idx = args.indexOf(name);
  if (idx === -1) return fallback;
  return args[idx + 1];
}

function hasFlag(args: string[], name: string): boolean {
  return args.includes(name);
}

function stableKey(parts: string[]): string {
  const hash = createHash("sha1");
  for (let i = 0; i < parts.length; i++) {
    hash.update(parts[i]!);
    hash.update("\0");
  }
  return hash.digest("hex").slice(0, 16);
}

function timesFor(start: number, end: number, step: number): number[] {
  const out: number[] = [];
  for (let t = start; t < end; t += step) out[out.length] = t;
  return out;
}

function parseTimes(raw: string | undefined): number[] | null {
  if (!raw) return null;
  const out = raw
    .split(",")
    .map((part) => Number(part.trim()))
    .filter((value) => Number.isFinite(value));
  return out.length > 0 ? out : null;
}

function percentile(values: number[], pct: number): number {
  if (values.length === 0) return 0;
  const sorted = values.slice().sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.floor((pct / 100) * (sorted.length - 1)));
  return sorted[idx]!;
}

function summarize(rows: DiffRow[]) {
  const pct = rows.map((row) => row.pctOver);
  const mean = pct.length > 0 ? pct.reduce((sum, value) => sum + value, 0) / pct.length : 0;
  return {
    frames: rows.length,
    meanPctOver: mean,
    p50PctOver: percentile(pct, 50),
    p95PctOver: percentile(pct, 95),
    maxPctOver: pct.length > 0 ? Math.max(...pct) : 0,
  };
}

function runChecked(cmd: string[], env?: Record<string, string>): void {
  const result = Bun.spawnSync(cmd, {
    stdout: "pipe",
    stderr: "pipe",
    env: env ? { ...process.env, ...env } : process.env,
  });
  if (result.exitCode !== 0) {
    const stdout = new TextDecoder().decode(result.stdout);
    const stderr = new TextDecoder().decode(result.stderr);
    throw new Error(
      `Command failed (${result.exitCode}): ${cmd.join(" ")}\n${stdout}\n${stderr}`,
    );
  }
}

function buildSweeps(args: string[]): Array<{ fixture: FixtureSweep; times: number[] }> {
  const ass = getArg(args, "--ass");
  const fixtureArg = getArg(args, "--fixture");
  const explicitTimes = parseTimes(getArg(args, "--times"));
  const start = Number(getArg(args, "--start", "NaN"));
  const end = Number(getArg(args, "--end", "NaN"));
  const step = Number(getArg(args, "--step", "NaN"));

  if (ass) {
    const fixture: FixtureSweep = {
      id: fixtureArg ?? basename(ass).replace(/\.[^.]+$/, ""),
      ass,
      start: Number.isFinite(start) ? start : 0,
      end: Number.isFinite(end) ? end : 0,
      step: Number.isFinite(step) ? step : 1,
    };
    const times = explicitTimes ?? timesFor(fixture.start, fixture.end, fixture.step);
    return [{ fixture, times }];
  }

  const selected = fixtureArg
    ? DEFAULT_SWEEPS.filter((sweep) => sweep.id === fixtureArg)
    : DEFAULT_SWEEPS;
  if (selected.length === 0) throw new Error(`Unknown fixture: ${fixtureArg}`);
  return selected.map((fixture) => {
    const useStart = Number.isFinite(start) ? start : fixture.start;
    const useEnd = Number.isFinite(end) ? end : fixture.end;
    const useStep = Number.isFinite(step) ? step : fixture.step;
    return {
      fixture: { ...fixture, start: useStart, end: useEnd, step: useStep },
      times: explicitTimes ?? timesFor(useStart, useEnd, useStep),
    };
  });
}

function printTable(rows: DiffRow[], top: number): void {
  const worst = rows.slice().sort((a, b) => b.pctOver - a.pctOver).slice(0, top);
  console.log("rank fixture timeMs pctOver meanError maxError pixelsOver");
  for (let i = 0; i < worst.length; i++) {
    const row = worst[i]!;
    console.log(
      `${i + 1} ${row.fixture} ${row.timeMs} ${row.pctOver.toFixed(3)} ${row.meanError.toFixed(3)} ${row.maxError} ${row.pixelsOver}`,
    );
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const width = Number(getArg(args, "--w", "1920"));
  const height = Number(getArg(args, "--h", "1080"));
  const fonts = getArg(args, "--fonts", DEFAULT_FONTS)!;
  const top = Number(getArg(args, "--top", "15"));
  const tolerance = Number(getArg(args, "--tolerance", "1"));
  const outPath = getArg(args, "--out");
  const workDir = getArg(args, "--work-dir", "tools/parity/results/sweep-current")!;
  const cacheDir = getArg(args, "--cache-dir", "tools/parity/cache/libass")!;
  const noCache = hasFlag(args, "--no-cache");
  const sweeps = buildSweeps(args);

  mkdirSync(workDir, { recursive: true });
  mkdirSync(cacheDir, { recursive: true });

  const rows: DiffRow[] = [];
  for (let s = 0; s < sweeps.length; s++) {
    const { fixture, times } = sweeps[s]!;
    const assPath = resolve(fixture.ass);
    const assReal = realpathSync(assPath);
    for (let i = 0; i < times.length; i++) {
      const timeMs = times[i]!;
      const key = stableKey([assReal, String(timeMs), `${width}x${height}`]);
      const stem = `${fixture.id}-${timeMs}-${width}x${height}-${key}`;
      const refPath = `${cacheDir}/${stem}-ref.png`;
      const subPath = `${workDir}/${stem}-sub.png`;
      const diffPath = `${workDir}/${stem}-diff.png`;
      const statsPath = `${workDir}/${stem}-stats.json`;

      if (noCache || !existsSync(refPath)) {
        runChecked(
          [
            "./tools/ref/render_libass",
            "--ass",
            assPath,
            "--time",
            String(timeMs),
            "--w",
            String(width),
            "--h",
            String(height),
            "--fonts",
            fonts,
            "--out",
            refPath,
          ],
          { DYLD_LIBRARY_PATH: "refs/libass/libass/.libs" },
        );
      }

      runChecked(
        [
          "bun",
          "run",
          "tools/ref/render_subframe.ts",
          "--ass",
          assPath,
          "--time",
          String(timeMs),
          "--w",
          String(width),
          "--h",
          String(height),
          "--fonts",
          fonts,
          "--out",
          subPath,
        ],
        {
          SUBFRAME_WORKERS: "0",
          SUBFRAME_RENDER_AHEAD: "0",
          SUBFRAME_FRAME_DEDUP: "0",
        },
      );

      const stats = diffPng(refPath, subPath, diffPath, statsPath, tolerance);
      rows[rows.length] = {
        fixture: fixture.id,
        ass: assPath,
        timeMs,
        refPath,
        subPath,
        diffPath,
        maxError: stats.maxError,
        meanError: stats.meanError,
        pixelsOver: stats.pixelsOver,
        pctOver: stats.pctOver,
      };
      console.error(
        `[${rows.length}] ${fixture.id} ${timeMs}: pct=${stats.pctOver.toFixed(3)} mean=${stats.meanError.toFixed(3)}`,
      );
    }
  }

  const summary = summarize(rows);
  printTable(rows, Number.isFinite(top) ? top : 15);
  console.log(
    `summary frames=${summary.frames} meanPct=${summary.meanPctOver.toFixed(3)} p50Pct=${summary.p50PctOver.toFixed(3)} p95Pct=${summary.p95PctOver.toFixed(3)} maxPct=${summary.maxPctOver.toFixed(3)}`,
  );

  if (outPath) {
    mkdirSync(dirname(outPath), { recursive: true });
    writeFileSync(outPath, JSON.stringify({ summary, rows }, null, 2));
  }
}

if (import.meta.main) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
