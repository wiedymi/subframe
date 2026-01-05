# Performance guidelines

This file is the entry point for performance guidance. Numeric performance targets live in `docs/GOALS.md`.

## What to follow
- General TS/JS guidance: `docs/perf/TS_JS_PERF_GUIDELINES_GENERAL.md`
- Bun/Chrome/Safari specifics: `docs/perf/TS_JS_PERF_GUIDELINES_BUN_CHROME_SAFARI.md`

## Measuring consistently
- Warm up the JIT before timing.
- Use realistic inputs and representative workloads.
- Keep outputs alive to avoid dead-code elimination.
- Report median and tail latency (p95/p99).
- Record the environment (engine, OS, viewport, active events).

## Bench tooling
- `bun run bench:basic -- --fonts /path/to/fonts` for shaping/raster microbench.
- `bun run bench:fixtures -- --manifest test/manifest.json --fps 60` for end-to-end timing.
- `bun run bench:reference -- --fps 60` for the reference complex event workload.
- Add `--enforce` to fail when p95 exceeds the frame budget (and p95/p99 tail targets for 60/120fps).
- Fixture benchmarks report per-event budgets (dt / activeEvents) and can enforce per-event tail targets.
- Add `--out <file.json>` to record a baseline report for later comparison.
- Compare baselines with `bun run bench:compare -- --baseline <file.json> --current <file.json> --tol-pct 10 --enforce`.
- Update `docs/GOALS.md` from baselines with `bun run bench:update-goals -- --reference <ref.json> --fixtures <fixtures.json>`.

## Reference complex event
Definition (single Dialogue line):
- Animation: `\t(0,1000,\fscx120\fscy120\frz15\blur1)`
- Karaoke: `\k` segments across multiple words
- Drawing: inline `\p1` rectangle path, then `\p0`
- Typical styling: `\bord4\shad3\blur2\be1` plus `\frx/\fry/\frz` and `\fax/\fay`

Implemented in `tools/bench/bench_reference.ts` as the default workload.

## Hot path rules of thumb
- Prefer stable object shapes and dense arrays.
- Avoid per-iteration allocations, closures, and destructuring in hot loops.
- Keep CPU-GPU sync points out of the frame loop.
