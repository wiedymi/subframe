function getArg(args: string[], name: string, fallback?: string): string | undefined {
  const idx = args.indexOf(name);
  if (idx === -1) return fallback;
  return args[idx + 1] ?? fallback;
}

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

async function run(cmd: string[], args: string[]): Promise<number> {
  const proc = Bun.spawn({ cmd: [...cmd, ...args], stdout: "inherit", stderr: "inherit" });
  return await proc.exited;
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const updateRef = args.includes("--update-ref");
  const trace = args.includes("--trace");
  const traceOnFail = args.includes("--trace-on-fail");
  const updateGoals = args.includes("--update-goals");
  const reportPath = getArg(args, "--report", "test/expected/diff/report_smoke.json")!;
  const timeArgs = collectArgs(args, "--time");
  const fontsOverride = getArg(args, "--fonts");

  const preflight = await run(["bun", "run", "tools/run-golden-preflight.ts"], []);
  if (preflight !== 0) process.exit(preflight);

  const goldenArgs = ["run", "tools/run-golden.ts", "--case", "parity_smoke", "--report", reportPath];
  if (fontsOverride) {
    goldenArgs[goldenArgs.length] = "--fonts";
    goldenArgs[goldenArgs.length] = fontsOverride;
  }
  if (updateRef) goldenArgs[goldenArgs.length] = "--update-ref";
  if (trace) goldenArgs[goldenArgs.length] = "--trace";
  if (traceOnFail) goldenArgs[goldenArgs.length] = "--trace-on-fail";
  for (const t of timeArgs) {
    goldenArgs[goldenArgs.length] = "--time";
    goldenArgs[goldenArgs.length] = t;
  }

  const golden = await run(["bun"], goldenArgs);
  if (golden !== 0) {
    console.error("golden run failed; summary still available.");
  }

  await run(["bun", "run", "tools/diff/report_summary.ts"], ["--report", reportPath]);
  if (updateGoals) {
    await run(["bun", "run", "tools/diff/update_goals_parity.ts"], ["--report", reportPath]);
  }
  process.exit(golden);
}
