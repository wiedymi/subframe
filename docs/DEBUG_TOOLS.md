# Debug tools

## For the agent (CLI + automation)
- `tools/render_ref`: render a specific time/event with libass to PNG.
- `tools/render_subframe`: render the same input with subframe to PNG.
- `tools/diff`: pixel diff with heatmap + summary stats.
- `tools/diff/bbox_compare.ts`: compare libass vs subframe bounding boxes and flag size mismatches.
- `tools/trace/render_trace.ts`: dump JSON trace of layout decisions for one frame.
- `tools/trace/trace_diff.ts`: compare two trace JSONs and show first mismatch.
- `tools/trace/move_rotate_diff.ts`: per-layer diff report for a targeted event (useful for Move/Rotate).
- `tools/repro`: bundle ASS + fonts + config + trace into a zip.
- `tools/bench/bench_basic.ts`: micro-benchmarks for shaping and raster.
- `tools/bench/bench_fixtures.ts`: end-to-end frame timing over fixtures.

### Trace content (v1)
- Inputs: ASS event, resolved style, tag timeline.
- Shaping: per-item font size, spacing, synthetic bold/italic.
- Layout: line breaks, alignment, margins, block anchor, karaoke segments.
- Transform: rotate/shear/origin values per item.
- Raster: bitmap layer bounds (origin + width/height).
- Filters: outline/blur/shadow params (including x/y overrides).
- Composite: final layer order with z, colors, and clip type.

## For the human (visual tools)
- Debug viewer (web) with frame scrubber and timeline.
- Side-by-side: libass vs subframe + diff heatmap.
- Overlay toggles: baselines, glyph origins, bounding boxes,
  margins, alignment anchor, clip regions.
- Glyph atlas inspector (including SDF/MSDF layers).
- Tag inspector: resolved per-event tag state at time T.
- Pipeline step viewer: parse -> shape -> layout -> transform ->
  raster -> filters -> composite.

## Minimum viable tooling (phase 1)
- CLI to render one frame and diff against libass.
- JSON trace for a single event at a given timestamp.
- Simple HTML viewer that loads traces and shows overlays.

## Debug UX goals
- One command to reproduce a mismatch.
- Every mismatch links to a concrete stage with numbers.
- Zero ambiguity about rounding and coordinate spaces.
