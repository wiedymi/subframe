---
name: performance-guardrails
description: Apply TS/JS runtime performance guardrails and benchmark workflow for hot-path work in Bun, Chrome, and Safari. Use when implementing or reviewing renderer/layout/raster/compositing code, optimizing frame time or tail latency, investigating regressions, or validating performance tradeoffs with repeatable measurements.
---

# Performance Guardrails

Use this skill to make performance changes deterministic, measurable, and reviewable.

## Scope

- Treat shaping, layout, rasterization, filtering, compositing, and frame-loop code as hot-path sensitive by default.
- Treat one-off tooling and debug-only paths as non-hot unless profiling shows impact.

## Execution Workflow

1. Classify the path.
- Mark code as hot-path or non-hot-path.
- Default to hot-path for render pipeline work.

2. Apply hot-path guardrails before micro-optimization.
- Prioritize algorithmic and data-layout wins first.
- Keep object property insertion order stable.
- Keep call sites monomorphic and avoid megamorphic dispatch.
- Keep arrays dense and type-consistent.
- Prefer typed arrays for numeric and pixel-heavy kernels.
- Prefer `for` or `while` in tight loops when profiled hot.
- Avoid per-iteration allocations, closures, spreads, and destructuring.
- Avoid `delete` on hot objects.
- Avoid `try/catch` inside tight loops.
- Minimize per-frame allocation rate and reuse buffers where safe.

3. Apply graphics-specific guardrails for GPU paths.
- Batch draw calls and state changes.
- Reuse shaders, pipelines, and bind groups where possible.
- Group buffer uploads into larger writes.
- Avoid CPU<->GPU sync points in frame loops, especially readbacks or forced flushes.

4. Measure with production-like methodology.
- Warm up JIT before measuring.
- Use realistic workloads and keep outputs alive to avoid dead-code elimination.
- Run multiple samples and report median, p95, and p99.
- Record environment details: engine, OS, viewport, and active event count.

5. Enforce regression checks.
- Use enforcement mode when requested.
- Persist baselines and compare against current runs.
- State missing benchmark execution explicitly if tools or fixtures are unavailable.

## Benchmark Commands

- Microbench:
`bun run bench:basic -- --fonts /path/to/fonts`
- End-to-end fixture benchmark:
`bun run bench:fixtures -- --manifest test/manifest.json --fps 60`
- Reference complex-event benchmark:
`bun run bench:reference -- --fps 60`
- Enforce budget and tail constraints:
Append `--enforce`
- Save baseline report:
Append `--out <file.json>`
- Compare baseline to current:
`bun run bench:compare -- --baseline <file.json> --current <file.json> --tol-pct 10 --enforce`
- Update goals from baselines:
`bun run bench:update-goals -- --reference <ref.json> --fixtures <fixtures.json>`

## Reference Workload Definition

Use this default complex ASS event for stable comparisons:
- Transform animation:
`\t(0,1000,\fscx120\fscy120\frz15\blur1)`
- Karaoke:
Multiple `\k` segments
- Drawing:
Inline `\p1` rectangle path, then `\p0`
- Typical style stack:
`\bord4\shad3\blur2\be1` with `\frx`, `\fry`, `\frz`, `\fax`, `\fay`

## Reporting Contract

- Do not claim a performance win without measured macro impact.
- Include median, p95, p99, workload, and environment in summaries.
- Call out tradeoffs when lowering allocations, changing data layout, or batching behavior.
