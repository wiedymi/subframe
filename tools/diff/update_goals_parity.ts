import { readFileSync, writeFileSync } from "node:fs";

type Report = {
  generatedAt?: string;
  cases?: Array<{
    timestamps?: Array<{ ok: boolean }>;
  }>;
};

function getArg(args: string[], name: string, fallback: string): string;
function getArg(args: string[], name: string): string | undefined;
function getArg(args: string[], name: string, fallback?: string): string | undefined {
  const idx = args.indexOf(name);
  if (idx === -1) return fallback;
  return args[idx + 1] ?? fallback;
}

function summarize(report: Report) {
  let total = 0;
  let failed = 0;
  for (const c of report.cases ?? []) {
    for (const t of c.timestamps ?? []) {
      total++;
      if (!t.ok) failed++;
    }
  }
  const passed = total - failed;
  const passRate = total > 0 ? (passed / total) * 100 : 0;
  return { total, passed, failed, passRate };
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const reportPath = getArg(args, "--report");
  const goalsPath = getArg(args, "--goals", "docs/GOALS.md");

  if (!reportPath) {
    console.error("Usage: bun run tools/diff/update_goals_parity.ts --report <report.json> [--goals docs/GOALS.md]");
    process.exit(1);
  }

  const report = JSON.parse(readFileSync(reportPath, "utf8")) as Report;
  const { total, passed, failed, passRate } = summarize(report);
  const date = report.generatedAt ? report.generatedAt.slice(0, 10) : "n/a";
  const checked = failed === 0 && total > 0 ? "x" : " ";
  const status = `latest ${date}: passRate=${passRate.toFixed(2)}% (${passed}/${total})`;

  const lines = readFileSync(goalsPath, "utf8").split("\n");
  const idx = lines.findIndex((line) => line.includes("Pixel-diff parity against libass"));
  if (idx === -1) {
    console.error("Parity goal line not found in GOALS.md");
    process.exit(1);
  }

  const baseText = "Pixel-diff parity against libass for a representative test suite.";
  lines[idx] = `- [${checked}] ${baseText} (${status})`;
  writeFileSync(goalsPath, lines.join("\n"));
}
