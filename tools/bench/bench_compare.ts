import { readFileSync } from "node:fs";

type CompareResult = { id: string; metric: string; base: number; current: number; ratio: number };

function getArg(args: string[], name: string, fallback?: string) {
  const idx = args.indexOf(name);
  if (idx === -1) return fallback;
  return args[idx + 1];
}

function parseJson(path: string) {
  return JSON.parse(readFileSync(path, "utf8")) as any;
}

function ratio(a: number, b: number): number {
  if (!Number.isFinite(a) || !Number.isFinite(b) || b <= 0) return Number.POSITIVE_INFINITY;
  return a / b;
}

function compareReference(base: any, cur: any): CompareResult[] {
  const out: CompareResult[] = [];
  const baseStats = base?.stats;
  const curStats = cur?.stats;
  if (!baseStats || !curStats) return out;
  const metrics = ["mean", "p50", "p95", "p99"];
  for (const m of metrics) {
    if (Number.isFinite(baseStats[m]) && Number.isFinite(curStats[m])) {
      out[out.length] = { id: "reference", metric: m, base: baseStats[m], current: curStats[m], ratio: ratio(curStats[m], baseStats[m]) };
    }
  }
  return out;
}

function compareFixtures(base: any, cur: any): CompareResult[] {
  const out: CompareResult[] = [];
  const baseCases: Array<any> = base?.cases ?? [];
  const curCases: Array<any> = cur?.cases ?? [];
  const curById = new Map<string, any>();
  for (const c of curCases) curById.set(c.id, c);
  for (const bc of baseCases) {
    const cc = curById.get(bc.id);
    if (!cc) continue;
    const metrics = ["mean", "p50", "p95", "p99", "perEventMean", "perEventP95", "perEventP99"];
    for (const m of metrics) {
      if (Number.isFinite(bc[m]) && Number.isFinite(cc[m])) {
        out[out.length] = { id: bc.id, metric: m, base: bc[m], current: cc[m], ratio: ratio(cc[m], bc[m]) };
      }
    }
  }
  return out;
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const basePath = getArg(args, "--baseline");
  const curPath = getArg(args, "--current");
  const tolPct = Number(getArg(args, "--tol-pct", "10"));
  const enforce = args.includes("--enforce");

  if (!basePath || !curPath) {
    console.error("Usage: bun run tools/bench/bench_compare.ts --baseline <file.json> --current <file.json> [--tol-pct 10] [--enforce]");
    process.exit(1);
  }

  const base = parseJson(basePath);
  const cur = parseJson(curPath);
  const isFixtures = Array.isArray(base?.cases) || Array.isArray(cur?.cases);
  const rows = isFixtures ? compareFixtures(base, cur) : compareReference(base, cur);

  if (rows.length === 0) {
    console.log("No comparable metrics found.");
    process.exit(enforce ? 1 : 0);
  }

  const threshold = 1 + (Number.isFinite(tolPct) ? tolPct : 10) / 100;
  let failures = 0;
  for (const row of rows) {
    const ok = row.ratio <= threshold;
    const status = ok ? "ok" : "regress";
    if (!ok) failures++;
    console.log(
      `${status} ${row.id} ${row.metric}: base=${row.base.toFixed(2)}ms current=${row.current.toFixed(2)}ms ratio=${row.ratio.toFixed(2)}`
    );
  }

  if (enforce && failures > 0) process.exit(1);
}
