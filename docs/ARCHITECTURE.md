# Architecture overview

## Pipeline (libass-aligned)
1) Parse input into Subforge `SubtitleDocument` (any supported format)
2) Render **directly from Subforge events/segments** (no extra abstraction layer)
3) Shape runs with text-shaper (glyphs, metrics)
4) Layout: positioning, wrapping, margins, alignment
5) Karaoke timing and segment splitting
6) Reorder and align (RTL, \q)
7) Bounding boxes and transform prep
8) Apply transforms and timing-sensitive ops (pre-raster)
9) Rasterize glyph paths to alpha bitmaps
10) Post-raster filters: outline, blur, shadow
11) Composite bitmaps into frame (WebGL / Canvas2D)

## Core modules (current)
- `core/pipeline.ts`: thin frame-level orchestrator
- `core/pipeline/event.ts`: per-event orchestration
- `core/layout/*`: shaping + layout + positioning
- `core/raster/*`: glyph raster + filters + layer output
- `core/render.ts`: public API for `SubtitleDocument` rendering
- `core/trace.ts`: trace schema + helpers for debug visibility
- `core/data/types.ts`: shared data types
- `core/math/fixed.ts`: fixed-point helpers (1/64 px)
- `io/fonts/*`: font discovery + caching (Bun + browser-compatible)

## Folder structure (current)
```
src/
  core/
    pipeline.ts         # frame orchestrator
    pipeline/           # per-event pipeline
    render.ts           # top-level render API
    trace.ts            # trace schema + builders
    animate/            # fade/move/transform logic
    clip/               # clip parsing + application
    filters/            # blur helpers
    layout/             # line building + layout
    raster/             # glyph raster + bitmap utils
    shape/              # shaping helpers
    style/              # color + font style resolution
    tags/               # tag parsing + effect helpers
    transform/          # matrix + affine helpers
    math/               # fixed-point utilities
    data/               # core data types (FrameContext, BitmapLayer, etc.)
  io/
    fonts/       # font discovery/loading glue (browser + Bun)
test/
  fixtures/    # ASS samples + expected outputs (parity focus)
  harness/     # libass comparison harness
tools/
  trace/       # trace emitters
  diff/        # image diff helpers (dev only)
  bench/       # micro + fixture benchmarks
  ref/         # libass + subframe reference renderers
docs/
  GOALS.md
  ARCHITECTURE.md
  DEBUG_TOOLS.md
  perf/
```

Notes:
- Rendering operates on Subforge `SubtitleDocument` directly; avoid creating intermediate run/segment layers.
- `tools/*` are dev-only and excluded from production bundles.

## Data model (initial)
- `Fixed26_6`: signed 26.6 fixed point (1/64 px) for all geometry
- `FrameContext`: time, viewport, margins, styles, fonts
- `SubtitleDocument`: Subforge document (format-agnostic input)
- `SubtitleEvent`: Subforge event (timing + segments + style refs)
- `GlyphRun`: glyph ids, advances, offsets, font face, features
- `LayoutLine`: positioned glyphs, line metrics, alignment
- `BitmapLayer`: alpha bitmap + origin + size + color + z
- `RenderItem`: final composited quad (texture + transform + color)

## Backend boundary
- Core already produces `BitmapLayer[]` per frame.
- WebGL/WebGPU backends handle atlas placement and compositing only.
- No layout or filter logic in backend code.

## Determinism rules
- All math uses fixed-point in core; floats only in GPU shaders.
- Stable ordering of glyphs and layers across runs.
- All randomness disabled; explicit seeds if ever needed.

## Notes on parity
- Full ASS spec rendering is the parity target.
- Other formats are rendered through Subforge conversion; parity is not guaranteed outside ASS/SSA.
- Apply 3D transforms before rasterization to match libass.
- Outline/blur/shadow are bitmap filters post-raster.
- Subpixel rounding must match libass at each stage.

## Browser runtime notes
- Font loading in browser requires a URL (http/https/data/blob). The renderer does not auto-resolve system fonts outside Bun.

## Implementation preference
- Before implementing new bitmap/text shaping (or related) operations, check `refs/text-shaper` for a ready-to-use solution.
- Before introducing new interfaces or abstraction layers, check `refs/subforge` and reuse existing Subforge data types/systems where possible.
