# Goals for subframe

## Vision
Build a subtitle renderer that consumes Subforge `SubtitleDocument` and works toward 1:1 visual parity with libass for the tested ASS/SSA surface on web and Bun. Other formats are rendered through Subforge without a libass-parity claim.

## v0 scope (must-have)
- [x] Format-agnostic rendering API that accepts Subforge `SubtitleDocument`.
- [ ] Prove 1:1 parity vs libass for every advertised ASS/SSA feature and fixture.
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
- [x] No false claims in docs; only document implemented and measured behavior.

## Success criteria
- [ ] Pixel-diff parity against libass for a representative test suite. (2026-07-10 smoke: 0/3; mean error 1.051-1.104, pixels over tolerance 2.237%-2.484%)
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

2026-07-10, Apple Silicon, headless Chrome 150, 1920x1080, JASSUB Beastars stress window, 300 frames:

- Low-level frame path: p50 0.475ms, p95 17.900ms, p99 29.445ms, max 167.055ms; 23/300 frames exceeded 16.67ms.
- `Subframe.frame()` path: p50 0.475ms, p95 17.315ms, p99 39.040ms, max 221.490ms; 18/300 frames exceeded 16.67ms.
- Playback smoothness comparison: p95 18.7ms before vs 26.6ms after, standard deviation 6.24ms vs 6.73ms, max 68.4ms vs 30.9ms. This is mixed rather than a demonstrated overall win.

These are local snapshots, not cross-machine guarantees. The 60fps and tail-latency checkboxes remain open because the measured tails exceed the targets.

Verification rerun after the lifecycle/API fixes (same date/environment, `Subframe.frame()`, 300 Beastars frames): achieved cadence 60.2fps, total p50 0.48ms, p95 30.11ms, max 352.46ms, with 12/300 pipeline renders above 16.67ms. The variance versus the earlier snapshot reinforces that this is not yet a stable tail-latency pass.

The corresponding 8-second smoothness rerun measured display-interval standard deviation 6.72ms reactive vs 6.65ms render-ahead, p95 18.40ms vs 26.40ms, and max 77.60ms vs 31.10ms. Render-ahead materially caps the worst stall and holds about 59.9fps, but does not yet improve p95 cadence.
