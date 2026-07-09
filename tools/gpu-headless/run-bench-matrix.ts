import { spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, extname, join, resolve } from "node:path";

type MatrixEntry = { fixture: string; config: string };
type RunRecord = {
  fixture: string;
  config: string;
  renderMs: number[];
  framePipelineDelta?: {
    dedupHits: number;
    dedupFrames: number;
    boundaryHits: number;
    boundaryAwaited: number;
    boundaryMisfires: number;
    boundaryFiredEarly: number;
    boundaryStale: number;
    boundaryPrewarmSuppressed?: number;
  };
  stages?: {
    frames: number;
    frameMs: number[];
    layoutMs: number;
    rasterMs: number;
    blurMs: number;
    shapeMs: number;
    fontMs: number;
  } | null;
};
type FailureRecord = {
  fixture: string;
  config: string;
  command: string;
  outPath: string;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  error?: string;
};

const MATRIX: MatrixEntry[] = [
  { fixture: "beastars", config: "default" },
  { fixture: "beastars", config: "workers-off" },
  { fixture: "beastars", config: "profiled" },
  { fixture: "FGOBD", config: "default" },
];
const COOLDOWN_MS = 3_000;

const argv = process.argv.slice(2);

function argVal(flag: string): string | null {
  const i = argv.indexOf(flag);
  return i !== -1 ? (argv[i + 1] ?? null) : null;
}

const fixtureFilter = argVal("--fixture");
const configFilter = argVal("--config");
const matrix = MATRIX.filter((entry) => {
  if (fixtureFilter && entry.fixture !== fixtureFilter) return false;
  if (configFilter && entry.config !== configFilter) return false;
  return true;
});
if (fixtureFilter && configFilter && matrix.length === 0) {
  matrix.push({ fixture: fixtureFilter, config: configFilter });
}
if (matrix.length === 0) {
  throw new Error("matrix filters selected no runs");
}

function timestamp(): string {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function shellQuote(value: string): string {
  return /^[A-Za-z0-9_./:=+-]+$/.test(value) ? value : `'${value.replaceAll("'", "'\\''")}'`;
}

function commandString(command: string, args: string[]): string {
  return [command, ...args].map(shellQuote).join(" ");
}

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

function fmtMs(value: number | null): string {
  return value === null ? "-" : value.toFixed(2);
}

function fmtInt(value: number | null): string {
  return value === null ? "-" : value.toFixed(0);
}

function fmtPct(value: number | null): string {
  return value === null ? "-" : value.toFixed(1);
}

function printTable(runs: RunRecord[], failures: FailureRecord[]) {
  const rows = [
    [
      "fixture",
      "config",
      "status",
      "p50",
      "p95",
      "max",
      "mean",
      "dedup",
      "boundary",
      "parked%",
      "layout",
      "raster",
      "blur",
      "shape",
      "font",
      "blur%",
    ],
  ];

  for (const run of runs) {
    const r = summarize(run.renderMs);
    const stages = run.stages ?? null;
    const frameSum = stages ? stages.frameMs.reduce((a, b) => a + b, 0) : 0;
    rows.push([
      run.fixture,
      run.config,
      "ok",
      fmtMs(r.p50),
      fmtMs(r.p95),
      fmtMs(r.max),
      fmtMs(r.mean),
      run.framePipelineDelta
        ? `${run.framePipelineDelta.dedupHits}/${run.framePipelineDelta.dedupFrames}`
        : "-",
      run.framePipelineDelta
        ? `${run.framePipelineDelta.boundaryHits}/${run.framePipelineDelta.boundaryAwaited}/${run.framePipelineDelta.boundaryMisfires}/${run.framePipelineDelta.boundaryStale}/${run.framePipelineDelta.boundaryFiredEarly}/${run.framePipelineDelta.boundaryPrewarmSuppressed ?? 0}`
        : "-",
      run.framePipelineDelta && run.framePipelineDelta.boundaryHits > 0
        ? fmtPct(
            (100 *
              (run.framePipelineDelta.boundaryHits -
                run.framePipelineDelta.boundaryAwaited)) /
              run.framePipelineDelta.boundaryHits,
          )
        : "-",
      fmtInt(stages?.layoutMs ?? null),
      fmtInt(stages?.rasterMs ?? null),
      fmtInt(stages?.blurMs ?? null),
      fmtInt(stages?.shapeMs ?? null),
      fmtInt(stages?.fontMs ?? null),
      fmtPct(stages && frameSum > 0 ? (100 * stages.blurMs) / frameSum : null),
    ]);
  }

  for (const failure of failures) {
    rows.push([
      failure.fixture,
      failure.config,
      failure.signal ? `crashed:${failure.signal}` : `exit:${failure.exitCode}`,
      "-",
      "-",
      "-",
      "-",
      "-",
      "-",
      "-",
      "-",
      "-",
      "-",
      "-",
      "-",
    ]);
  }

  const widths = rows[0]!.map((_, col) =>
    Math.max(...rows.map((row) => String(row[col] ?? "").length)),
  );
  for (const row of rows) {
    console.log(row.map((cell, col) => String(cell).padEnd(widths[col]!)).join("  "));
  }
}

function printStageShareTables(runs: RunRecord[]) {
  const stageNames = ["layoutMs", "rasterMs", "blurMs", "shapeMs", "fontMs"] as const;
  for (const run of runs) {
    const stages = run.stages ?? null;
    if (!stages) continue;
    const frameTotal = stages.frameMs.reduce((a, b) => a + b, 0);
    const attributedTotal = stageNames.reduce((sum, name) => sum + stages[name], 0);
    const rows = [["stage", "totalMs", "avgMs/frame", "share%"]];
    for (const name of stageNames) {
      const total = stages[name];
      rows.push([
        name.slice(0, -2),
        total.toFixed(0),
        (total / stages.frames).toFixed(2),
        frameTotal > 0 ? ((100 * total) / frameTotal).toFixed(1) : "0.0",
      ]);
    }
    const other = frameTotal - attributedTotal;
    rows.push([
      "unattributed",
      other.toFixed(0),
      (other / stages.frames).toFixed(2),
      frameTotal > 0 ? ((100 * other) / frameTotal).toFixed(1) : "0.0",
    ]);

    const widths = rows[0]!.map((_, col) =>
      Math.max(...rows.map((row) => String(row[col] ?? "").length)),
    );
    console.log(`\n--- stage shares ${run.fixture} / ${run.config} (${stages.frames} profiled frames) ---`);
    for (const row of rows) {
      console.log(row.map((cell, col) => String(cell).padEnd(widths[col]!)).join("  "));
    }
  }
}

function runChild(command: string, args: string[]): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  return new Promise((resolveRun) => {
    const child = spawn(command, args, { stdio: "inherit" });
    child.on("error", (error) => {
      console.error(error);
      resolveRun({ code: 1, signal: null });
    });
    child.on("exit", (code, signal) => resolveRun({ code, signal }));
  });
}

const sleep = (ms: number) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms));

async function main() {
  const outPath = resolve(
    argVal("--out") ?? join("tools/gpu-headless/results", `bench-matrix-${timestamp()}.json`),
  );
  mkdirSync(dirname(outPath), { recursive: true });

  const ext = extname(outPath);
  const stem = basename(outPath, ext);
  const runOutDir = join(dirname(outPath), `${stem}-runs`);
  mkdirSync(runOutDir, { recursive: true });

  const runs: RunRecord[] = [];
  const failures: FailureRecord[] = [];
  const commands: string[] = [];

  console.log(`[bench-matrix] cooldown ${COOLDOWN_MS}ms between child processes`);
  for (let i = 0; i < matrix.length; i++) {
    const entry = matrix[i]!;
    const runOutPath = join(runOutDir, `${entry.fixture}-${entry.config}.json`);
    const args = [
      "run",
      "tools/gpu-headless/bench-bun.ts",
      "--fixture",
      entry.fixture,
      "--config",
      entry.config,
      "--out",
      runOutPath,
    ];
    const printable = commandString("bun", args);
    commands.push(printable);
    console.log(`\n[bench-matrix] ${printable}`);

    const { code, signal } = await runChild("bun", args);
    if (code === 0 && signal === null && existsSync(runOutPath)) {
      const parsed = JSON.parse(readFileSync(runOutPath, "utf8"));
      if (Array.isArray(parsed.runs)) runs.push(...(parsed.runs as RunRecord[]));
    } else {
      failures.push({
        fixture: entry.fixture,
        config: entry.config,
        command: printable,
        outPath: runOutPath,
        exitCode: code,
        signal,
      });
    }

    writeFileSync(
      outPath,
      JSON.stringify(
        {
          createdAt: new Date().toISOString(),
          bunVersion: Bun.version,
          cooldownMs: COOLDOWN_MS,
          matrix,
          commands,
          runs,
          failures,
          runResultDir: runOutDir,
        },
        null,
        2,
      ),
    );

    if (i < matrix.length - 1) await sleep(COOLDOWN_MS);
  }

  console.log("\n=== Bun bench matrix summary ===");
  printTable(runs, failures);
  printStageShareTables(runs);
  console.log(`\nsummary JSON: ${outPath}`);
  console.log(`per-run JSON dir: ${runOutDir}`);
  process.exit(failures.length === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
