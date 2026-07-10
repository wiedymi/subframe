# Testing and verification

## Required layers

- `bun test ./test` runs the repository-owned unit, integration, lifecycle, and deterministic render tests. The explicit path prevents Bun from discovering tests inside reference submodules.
- `bun run typecheck` checks production source with the shipped TypeScript version.
- `bun run build` produces the browser/Bun bundle, standalone worker, and declarations without modifying source.
- `npm pack --dry-run` proves the publish allowlist and runs the production build through `prepack`.
- Golden and parity tools compare fixed ASS inputs and locked fonts against native libass.
- Browser hardware tools verify worker bootstrapping and WebGPU filter byte equality; performance tools report p50/p95/p99/max rather than only averages.

## Regression workflow

1. Add a deterministic failing test or parity fixture.
2. Capture the expected libass pixels or trace when pixel semantics change.
3. Make the smallest behavioral fix.
4. Run the focused test, then `bun test ./test`, typecheck, build, package dry-run, and any relevant hardware/parity gate.
5. Update measured documentation only from a saved report; never infer parity or performance from a successful build.

## Commands

```sh
bun test ./test
bun run typecheck
bun run build
npm pack --dry-run
bun run test:golden:preflight
bun run test:golden
bun run test:golden:smoke
bun run tools/parity/sweep.ts
bun run tools/gpu-headless/run-headless.ts
bun run tools/gpu-headless/run-worker-check.ts
bun run tools/gpu-headless/run-bench.ts
```

Focused diff, trace, baseline, and report commands are listed by `package.json` scripts and `docs/DEBUG_TOOLS.md`.

## Fixtures and fonts

- Small tag regressions live as test cases; larger ASS inputs live in `test/fixtures/ass`.
- `test/manifest.json` pins viewport, timestamps, renderer commands, and diff thresholds.
- Strict comparisons must use the same font bytes. Machine-local fallback is useful for interactive rendering but is not a reproducible golden-test input.
- Third-party benchmark assets are repository test data and are excluded from the npm package. Their provenance and known license status are recorded next to the fixture bundle.

## Output policy

- Pixel changes require a focused regression and, where applicable, an updated libass comparison.
- Returned `RenderResult`/`SubframeFrame` buffers remain live until explicitly released; lifetime tests must cover any scheduler change.
- Performance gates use warmed runs and retain outputs so dead-code elimination cannot invalidate measurements.
