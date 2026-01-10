# Goals for subframe

## Vision
Build a WebGL-first subtitle renderer that consumes Subforge `SubtitleDocument` and targets **full ASS spec rendering with 1:1 visual parity vs libass** on web and Bun, with a WebGPU compositor backend available.
Other subtitle formats are rendered via Subforge conversion; parity is only guaranteed for ASS/SSA.

## v0 scope (must-have)
- [x] Format-agnostic rendering API that accepts Subforge `SubtitleDocument`.
- [ ] Full ASS spec rendering, with 1:1 parity vs libass for supported tags.
- [x] Render directly from Subforge events/segments (no extra abstraction layer).
- [x] Core ASS layout + tag engine: \fs, \fscx, \fscy, \fsp, \bord, \shad, \blur, \be, \c, \alpha, \an, \pos, \move, \org, \q.
- [x] Text styling: \b, \i, \u, \s.
- [x] BorderStyle=3 opaque box rendering.
- [x] ScaledBorderAndShadow respects ScriptInfo scaling.
- [x] Wrapping, margins, alignment, and line breaking consistent with libass.
- [x] Karaoke: \k, \kf, \ko, \kt.
- [x] Clip: \clip / \iclip.
- [x] Animation: \t, \fade, \fad.
- [x] 3D transforms: \frx, \fry, \frz, \fax, \fay.

## Non-goals (initially)
- [ ] Full ASS feature coverage outside the scope list.
- [ ] Multiple build targets or separate browser/Bun builds.
- [ ] Heavy optional dependencies or native addons.

## Constraints
- [x] Single build that runs in browser and Bun (font URLs required in browser).
- [x] Minimal dependencies; keep subframe separate from subforge core (monorepo allowed).
- [ ] No false claims in docs; only document implemented features.

## Success criteria
- [ ] Pixel-diff parity against libass for a representative test suite. (latest 2026-01-01: passRate=0.00% (0/3))
- [x] Deterministic output given the same inputs (fonts, timestamps, config).
- [x] Clear instrumentation for debugging layout/rasterization differences.

## Quality targets
- [x] Internal geometry uses 1/64 px fixed point (SUBPIXEL_MASK = 63).
- [x] No unstable ordering; rendering is stable across runs.
- [x] Debug tooling makes mismatches actionable within minutes.

## Performance targets (initial)
- [x] Define a reference "complex event": animation + karaoke + drawing, plus typical ASS styling (border/blur/shadow/transform).
- [ ] 60fps target: end-to-end frame time <= 16.67ms at 1080p for the reference workload.
- [ ] 120fps target: end-to-end frame time <= 8.33ms at 1080p for the reference workload.
- [ ] Per-event budget: when multiple events are active, each event's budget is `frame_budget / active_events`.
- [ ] Single-event budget: a frame with one complex event must fit within the frame budget for the target fps.
- [ ] All fixtures under `test/fixtures/ass/` must meet the frame budget for their target fps.
- [ ] Tail latency goals: p95 <= 20ms and p99 <= 24ms at 60fps; p95 <= 12ms and p99 <= 16ms at 120fps.
- [x] See `docs/perf.md` for measurement guidance and performance rules.
 
## Baselines (recorded locally)
- [ ] `bench:reference` @ 1080p 60fps (record once, update on regressions).
- [ ] `bench:fixtures` @ 1080p 60fps (record once, update on regressions).
