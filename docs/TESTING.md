# Testing and TDD

## Goals
- Prove pixel parity with libass for ASS/SSA rendering.
- Catch regressions early with deterministic tests.
- Make mismatches actionable with clear traces and diffs.

## TDD workflow (expected)
1) Write a failing test for a specific feature or bug.
2) Add or update a fixture (ASS + fonts + config).
3) Define the expected output (trace or pixel diff vs libass).
4) Implement the smallest change to pass the test.
5) Refactor, keeping tests green.

## Test layers
- Unit tests: fixed-point math, tag parsing, style resolution, layout decisions.
- Integration tests: pipeline stage snapshots (shape/layout/transform/raster).
- Golden image tests: render frame(s) with libass and compare to subframe.
- Performance checks (optional): microbench of hot paths.
  - Measurement guidance lives in `docs/perf.md`.

## Golden image policy
- Compare subframe output to libass at fixed timestamps.
- Use pixel diff with heatmap and summary stats.
- Track max/mean error and fail above thresholds.
- Lock fonts and renderer parameters for determinism.
  - We do not commit proprietary fonts; tests rely on system fonts by default.
  - For strict determinism, provide a local fonts dir at runtime.

## Fixtures
- Large/complex ASS files live under `test/fixtures/ass/` (parity target).
- The renderer accepts Subforge `SubtitleDocument` for any format, but ASS parity vs libass is the only guaranteed benchmark.
- Keep a small set of minimal test cases for each tag.
- Prefer small, focused fixtures for fast iteration.

## Dependencies
- libass (from `refs/libass` submodule) + freetype (+ fribidi/harfbuzz as needed by libass).
- Bun for test tooling and scripts.
- `pngjs` dev dependency for diffing and placeholder renders.
- Fonts are expected to be available on the system. Do not commit proprietary fonts.

## Fonts policy
- Tests may differ across machines if system fonts differ.
- If strict determinism is required, use a local fonts directory and pass `--fonts` to the renderers, but do not commit proprietary fonts.
- Subframe resolves `--fonts` by filename first (e.g., `Arial.ttf`), then falls back to system fontconfig if no match is found.

## Commands
- `bun test` for unit/integration tests.
- `bun run test:golden` for libass parity tests (uses `test/manifest.json`).
- `bun run test:golden:preflight` to verify libass renderer + submodules before running golden tests.
- `bun run test:golden:smoke` for the parity smoke case only.
- `bun run test:golden -- --case parity_smoke --time 1000` for a focused parity run.
- `bun run test:golden:smoke:update` to refresh the smoke baseline.
- `bun run test:golden:smoke:trace` to emit traces for all smoke timestamps.
- `bun run test:golden:smoke:report` to preflight, run smoke, and print a summary.
- `bun run test:golden:smoke:goals` to update parity status in `docs/GOALS.md` after the smoke run.
- `bun run test:golden -- --report test/expected/diff/report.json` to save a diff summary.
- `bun run test:golden -- --fonts /path/to/fonts` to override the manifest fonts dir for a run.
- `bun run test:diff:compare -- --base <report.json> --current <report.json> --enforce` to check regressions.
- `bun run test:diff:summary -- --report <report.json>` to print pass rate and failing cases.
- `bun run test:diff:update-goals -- --report <report.json>` to update parity status in `docs/GOALS.md`.
- `bun run test:golden -- --trace-on-fail` to emit subframe traces for failing cases.
- `bun run test:golden -- --trace` to emit subframe traces for all cases.
- `bun run test:diff` to generate diff images and stats.
- `bun run trace:diff -- --a traceA.json --b traceB.json` to pinpoint the first mismatch in trace output.

## Golden test layout
- `test/manifest.json`: cases, timestamps, viewport, thresholds.
- `test/expected/libass/`: reference PNGs.
- `test/expected/subframe/`: subframe PNGs.
- `test/expected/diff/`: heatmaps + stats JSON.

## Principles
- Tests are part of the API: do not change outputs without updating fixtures.
- Any change that affects pixels must add or update a golden test.
- Avoid flaky tests by pinning fonts, inputs, and rendering settings.
