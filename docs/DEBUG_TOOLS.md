# Debug tools

## For the agent (CLI + automation)
- `tools/render_ref`: render a specific time/event with libass to PNG.
- `tools/render_subframe`: render the same input with subframe to PNG.
- `tools/diff`: pixel diff with heatmap + summary stats.
- `tools/trace`: dump JSON trace of pipeline stages for one event/time.
- `tools/repro`: bundle ASS + fonts + config + trace into a zip.
- `tools/bench`: micro-benchmarks for shaping, raster, filters.

### Trace content (v1)
- Inputs: ASS event, resolved style, tag timeline.
- Shaping: glyph ids, advances, offsets, font size.
- Layout: line breaks, alignment, margins, karaoke segments.
- Transform: matrices, origins, fixed-point rounding points.
- Raster: glyph paths or bitmap bounds.
- Filters: blur/outline/shadow params and output bounds.
- Composite: final quads and atlas coords.

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
