# Testing and TDD

## Goals
- Prove pixel parity with libass for supported features.
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

## Golden image policy
- Compare subframe output to libass at fixed timestamps.
- Use pixel diff with heatmap and summary stats.
- Track max/mean error and fail above thresholds.
- Lock fonts and renderer parameters for determinism.

## Fixtures
- Large/complex ASS files live under `test/fixtures/ass/`.
- Keep a small set of minimal test cases for each tag.
- Prefer small, focused fixtures for fast iteration.

## Planned commands (TODO)
- `bun test` for unit tests.
- `bun run test:golden` for libass parity tests.
- `bun run test:diff` to generate diff images and stats.

## Principles
- Tests are part of the API: do not change outputs without updating fixtures.
- Any change that affects pixels must add or update a golden test.
- Avoid flaky tests by pinning fonts, inputs, and rendering settings.
