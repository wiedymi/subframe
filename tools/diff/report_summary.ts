import { readFileSync } from "node:fs";

type Report = {
  cases: Array<{
    id: string;
    timestamps: Array<{
      t: number;
      ok: boolean;
      stats: { maxError: number; meanError: number; pctOver: number };
      threshold: { max: number; mean: number; pct: number };
    }>;
  }>;
};

function getArg(args: string[], name: string, fallback?: string) {
  const idx = args.indexOf(name);
  if (idx === -1) return fallback;
  return args[idx + 1];
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const reportPath = getArg(args, "--report");
  const maxList = Number(getArg(args, "--max", "10"));
  if (!reportPath) {
    console.error("Usage: bun run tools/diff/report_summary.ts --report <report.json> [--max 10]");
    process.exit(1);
  }

  const report = JSON.parse(readFileSync(reportPath, "utf8")) as Report;
  let total = 0;
  let failures = 0;
  const failed: Array<{ id: string; t: number; stats: string }> = [];
  for (const c of report.cases ?? []) {
    for (const ts of c.timestamps ?? []) {
      total++;
      if (!ts.ok) {
        failures++;
        const stats = `max=${ts.stats.maxError} mean=${ts.stats.meanError.toFixed(3)} pct=${ts.stats.pctOver.toFixed(3)}%`;
        failed[failed.length] = { id: c.id, t: ts.t, stats };
      }
    }
  }

  const passed = total - failures;
  const passRate = total > 0 ? (passed / total) * 100 : 0;
  console.log(`summary: total=${total} passed=${passed} failed=${failures} passRate=${passRate.toFixed(2)}%`);

  if (failed.length > 0) {
    const limit = Number.isFinite(maxList) && maxList > 0 ? maxList : 10;
    console.log(`failures (showing ${Math.min(limit, failed.length)}):`);
    for (let i = 0; i < Math.min(limit, failed.length); i++) {
      const f = failed[i]!;
      console.log(`  ${f.id} @ ${f.t}ms ${f.stats}`);
    }
  }
}
