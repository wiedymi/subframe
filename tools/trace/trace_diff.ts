import { readFileSync } from "node:fs";

type Diff = { path: string; a: unknown; b: unknown };

function getArg(args: string[], name: string, fallback?: string): string | undefined {
  const idx = args.indexOf(name);
  if (idx === -1) return fallback;
  return args[idx + 1] ?? fallback;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function diffValue(a: unknown, b: unknown, path: string, diffs: Diff[], max: number): void {
  if (diffs.length >= max) return;
  if (a === b) return;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) {
      diffs[diffs.length] = { path: `${path}.length`, a: a.length, b: b.length };
      return;
    }
    for (let i = 0; i < a.length; i++) {
      diffValue(a[i], b[i], `${path}[${i}]`, diffs, max);
      if (diffs.length >= max) return;
    }
    return;
  }
  if (isObject(a) && isObject(b)) {
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    for (const key of keys) {
      diffValue(a[key], b[key], `${path}.${key}`, diffs, max);
      if (diffs.length >= max) return;
    }
    return;
  }
  diffs[diffs.length] = { path, a, b };
}

function summarizeDiff(d: Diff): string {
  const a = JSON.stringify(d.a);
  const b = JSON.stringify(d.b);
  return `${d.path}\n  A: ${a}\n  B: ${b}`;
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const aPath = getArg(args, "--a");
  const bPath = getArg(args, "--b");
  const max = Number(getArg(args, "--max", "1"));

  if (!aPath || !bPath) {
    console.error("Usage: bun run tools/trace/trace_diff.ts --a <trace.json> --b <trace.json> [--max N]");
    process.exit(1);
  }

  const aRaw = JSON.parse(readFileSync(aPath, "utf8")) as { trace?: unknown };
  const bRaw = JSON.parse(readFileSync(bPath, "utf8")) as { trace?: unknown };
  const aTrace = (aRaw.trace ?? aRaw) as unknown;
  const bTrace = (bRaw.trace ?? bRaw) as unknown;

  const diffs: Diff[] = [];
  diffValue(aTrace, bTrace, "trace", diffs, Number.isFinite(max) && max > 0 ? max : 1);

  if (diffs.length === 0) {
    console.log("No differences found.");
    process.exit(0);
  }

  for (let i = 0; i < diffs.length; i++) {
    console.log(summarizeDiff(diffs[i]!));
  }
  process.exit(1);
}
