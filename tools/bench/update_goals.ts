import { readFileSync, existsSync, writeFileSync } from "node:fs";

function getArg(args: string[], name: string) {
  const idx = args.indexOf(name);
  if (idx === -1) return undefined;
  return args[idx + 1];
}

function loadJson(path: string): any {
  return JSON.parse(readFileSync(path, "utf8"));
}

function summarizeReference(path: string) {
  const data = loadJson(path);
  const stats = data?.stats ?? {};
  return {
    recordedAt: data?.generatedAt ?? null,
    mean: stats.mean ?? null,
    p95: stats.p95 ?? null,
    p99: stats.p99 ?? null,
  };
}

function summarizeFixtures(path: string) {
  const data = loadJson(path);
  const cases = Array.isArray(data?.cases) ? data.cases : [];
  let worstP95 = 0;
  let worstP99 = 0;
  let worstPerEventP95 = 0;
  let worstPerEventP99 = 0;
  for (const c of cases) {
    if (Number.isFinite(c.p95)) worstP95 = Math.max(worstP95, c.p95);
    if (Number.isFinite(c.p99)) worstP99 = Math.max(worstP99, c.p99);
    if (Number.isFinite(c.perEventP95)) worstPerEventP95 = Math.max(worstPerEventP95, c.perEventP95);
    if (Number.isFinite(c.perEventP99)) worstPerEventP99 = Math.max(worstPerEventP99, c.perEventP99);
  }
  return {
    recordedAt: data?.generatedAt ?? null,
    worstP95: worstP95 || null,
    worstP99: worstP99 || null,
    worstPerEventP95: worstPerEventP95 || null,
    worstPerEventP99: worstPerEventP99 || null,
  };
}

function formatNum(value: number | null) {
  return value === null ? "n/a" : value.toFixed(2);
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const referencePath = getArg(args, "--reference");
  const fixturesPath = getArg(args, "--fixtures");
  const goalsPath = getArg(args, "--goals") ?? "docs/GOALS.md";

  if (!referencePath && !fixturesPath) {
    console.error(
      "Usage: bun run tools/bench/update_goals.ts --reference <baseline.json> --fixtures <baseline.json> [--goals docs/GOALS.md]"
    );
    process.exit(1);
  }

  const lines = readFileSync(goalsPath, "utf8").split("\n");
  const startIdx = lines.findIndex((line) => line.trim() === "## Baselines (recorded locally)");
  if (startIdx === -1) {
    console.error("Baselines section not found in GOALS.md");
    process.exit(1);
  }
  let endIdx = lines.length;
  for (let i = startIdx + 1; i < lines.length; i++) {
    if (lines[i]!.startsWith("## ")) {
      endIdx = i;
      break;
    }
  }

  const newLines: string[] = [];
  newLines[newLines.length] = "## Baselines (recorded locally)";

  if (referencePath && existsSync(referencePath)) {
    const summary = summarizeReference(referencePath);
    const date = summary.recordedAt ? summary.recordedAt.slice(0, 10) : "n/a";
    newLines[newLines.length] =
      `- [x] \`bench:reference\` @ 1080p 60fps (recorded ${date}; mean=${formatNum(summary.mean)}ms p95=${formatNum(summary.p95)}ms p99=${formatNum(summary.p99)}ms)`;
  } else {
    newLines[newLines.length] = "- [ ] `bench:reference` @ 1080p 60fps (record once, update on regressions).";
  }

  if (fixturesPath && existsSync(fixturesPath)) {
    const summary = summarizeFixtures(fixturesPath);
    const date = summary.recordedAt ? summary.recordedAt.slice(0, 10) : "n/a";
    newLines[newLines.length] =
      `- [x] \`bench:fixtures\` @ 1080p 60fps (recorded ${date}; worst p95=${formatNum(summary.worstP95)}ms p99=${formatNum(summary.worstP99)}ms per-event p95=${formatNum(summary.worstPerEventP95)}ms p99=${formatNum(summary.worstPerEventP99)}ms)`;
  } else {
    newLines[newLines.length] = "- [ ] `bench:fixtures` @ 1080p 60fps (record once, update on regressions).";
  }

  const out = [...lines.slice(0, startIdx), ...newLines, ...lines.slice(endIdx)].join("\n");
  writeFileSync(goalsPath, out);
}
