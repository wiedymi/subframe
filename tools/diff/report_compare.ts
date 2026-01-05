import { readFileSync } from "node:fs";

type Report = {
  cases: Array<{
    id: string;
    timestamps: Array<{ t: number; ok: boolean; stats: { maxError: number; meanError: number; pctOver: number } }>;
  }>;
};

function getArg(args: string[], name: string, fallback?: string) {
  const idx = args.indexOf(name);
  if (idx === -1) return fallback;
  return args[idx + 1];
}

function loadReport(path: string): Report {
  return JSON.parse(readFileSync(path, "utf8")) as Report;
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const basePath = getArg(args, "--base");
  const curPath = getArg(args, "--current");
  const enforce = args.includes("--enforce");

  if (!basePath || !curPath) {
    console.error("Usage: bun run tools/diff/report_compare.ts --base <report.json> --current <report.json> [--enforce]");
    process.exit(1);
  }

  const base = loadReport(basePath);
  const cur = loadReport(curPath);
  const baseMap = new Map<string, Map<number, boolean>>();
  for (const c of base.cases ?? []) {
    const ts = new Map<number, boolean>();
    for (const t of c.timestamps ?? []) ts.set(t.t, t.ok);
    baseMap.set(c.id, ts);
  }

  let regressions = 0;
  let improvements = 0;
  for (const c of cur.cases ?? []) {
    const baseTs = baseMap.get(c.id);
    if (!baseTs) continue;
    for (const t of c.timestamps ?? []) {
      const prev = baseTs.get(t.t);
      if (prev === undefined) continue;
      if (prev && !t.ok) {
        regressions++;
        console.log(`regress ${c.id} @ ${t.t}ms`);
      } else if (!prev && t.ok) {
        improvements++;
        console.log(`improve ${c.id} @ ${t.t}ms`);
      }
    }
  }

  console.log(`summary: regressions=${regressions} improvements=${improvements}`);
  if (enforce && regressions > 0) process.exit(1);
}
