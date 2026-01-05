# Agent guide for subframe

## Role
You are a coding agent working in this repo. Your job is to help design and implement a WebGL-first subtitle renderer that **directly renders Subforge `SubtitleDocument`** and targets libass visual parity for ASS/SSA on web and Bun.

## Primary goals
- 1:1 visual parity with libass for supported tags/features.
- Single build that runs in both browser and Bun (no separate targets).
- Minimal dependencies; avoid heavy optional deps or native addons.
- Deterministic output: same inputs => same pixels.

## Non-goals (initial)
- Full ASS feature coverage beyond the documented scope.
- Multiple build variants or per-platform bundles.
- Claims about parity/features that are not implemented.

## Core invariants
- Use 1/64 px fixed-point internally (SUBPIXEL_MASK = 63).
- Apply 3D transforms before rasterization (libass parity).
- Outline/blur/shadow are bitmap filters post-raster (vsfilter-style).
- Backend only composites bitmaps; core handles layout/raster/filter.
- Renderer consumes Subforge `SubtitleDocument` as the **single source of truth** for all formats.
- **Do not introduce extra abstraction layers** (no custom run/segment models). Render Subforge events/segments directly.
- Format support comes from Subforge; parity is targeted for ASS/SSA via libass behavior.

## References
- Subforge: `refs/subforge`
- text-shaper: `refs/text-shaper`
- libass: `refs/libass`
  - `refs/libass/libass/ass_render.c`
  - `refs/libass/libass/ass_bitmap_engine.c`
  - `refs/libass/libass/ass_rasterizer.c`
  - `refs/libass/libass/ass_font.c`

## Repo docs to follow
- docs/GOALS.md
- docs/ARCHITECTURE.md
- docs/DEBUG_TOOLS.md
- docs/perf.md
- docs/perf/TS_JS_PERF_GUIDELINES_BUN_CHROME_SAFARI.md
- docs/perf/TS_JS_PERF_GUIDELINES_GENERAL.md

## Working style
- Prefer clear, predictable code over clever micro-opts; measure before changing hot paths.
- Keep core math deterministic and fixed-point; avoid float drift.
- Avoid accidental allocations in hot loops.
- Make debugability a first-class feature; every stage should be inspectable.
- Before implementing new bitmap/text shaping (or related) operations, check `refs/text-shaper` for a ready-to-use solution.
- Before introducing new interfaces or abstraction layers, check `refs/subforge` and reuse existing Subforge data types/systems where possible.

## Performance checklist (follow docs/perf.md and docs/perf/*.md)
- Algorithmic wins first; avoid O(n^2) where possible.
- Keep shapes stable; avoid `delete`, avoid polymorphic options objects in hot paths.
- Keep arrays dense and monomorphic; prefer TypedArray for numeric kernels.
- Hot loops: prefer `for`/`while` over `for...of`, `map`, `forEach`, `reduce` when profiling shows heat.
- Avoid per-iteration closures, spreads, and destructuring in hot paths.
- Minimize allocations; reuse buffers/objects when safe.
- Avoid CPU↔GPU sync in render loops (no readbacks in hot path).

## Debug tooling expectations
Planned tools (build when asked):
- tools/render_ref: render a frame with libass to PNG.
- tools/render_subframe: render same frame with subframe.
- tools/diff: pixel diff with heatmap and stats.
- tools/trace: JSON trace for a single event/time.
- tools/repro: bundle ASS + fonts + trace for repros.

## Documentation rules
- Do not claim parity or feature support unless tests prove it.
- Keep docs aligned with actual implementation state.
- Prefer short, actionable notes over broad promises.

## If blocked
- State what is missing (data, file, access) and propose a next step.
- Avoid stalling; make minimal, safe progress when possible.
