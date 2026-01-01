# Architecture overview

## Pipeline (libass-aligned)
1) Parse ASS events (Subforge)
2) Resolve styles and tags into style runs
3) Shape runs with text-shaper (glyphs, metrics)
4) Layout: positioning, wrapping, margins, alignment
5) Karaoke timing and segment splitting
6) Reorder and align (RTL, \q)
7) Bounding boxes and transform prep
8) Apply transforms and timing-sensitive ops (pre-raster)
9) Rasterize glyph paths to alpha bitmaps
10) Post-raster filters: outline, blur, shadow
11) Composite bitmaps into frame (WebGL / Canvas2D)

## Core modules
- `core/ass`: glue to Subforge parsing and event normalization
- `core/tags`: tag parser and per-event tag state machine
- `core/style`: style resolution (ASS style + tags -> computed style)
- `core/shape`: wrapper over text-shaper; returns glyph runs
- `core/layout`: line breaking, wrapping, alignment, margins, karaoke
- `core/transform`: 2D/3D transforms, timing, fixed-point math
- `core/raster`: glyph outline to bitmap (text-shaper or libass port)
- `core/filters`: outline/blur/shadow filters on alpha bitmaps
- `core/composite`: backend-agnostic compositor API
- `backend/webgl`: texture atlas + quad compositor
- `backend/canvas`: debug backend for inspection

## Folder structure (proposed)
```
src/
  core/
    ass/         # Subforge integration, event normalization, time slicing
    tags/        # tag parser, tag state machine, tag interpolation (\t, \fad)
    style/       # style resolution, defaults, computed style structs
    shape/       # text-shaper adapter, glyph run assembly, metrics
    layout/      # line breaking, wrapping, margins, alignment, karaoke
    transform/   # 2D/3D transforms, fixed-point math, bbox transforms
    raster/      # outline -> bitmap rasterizer (text-shaper or libass port)
    filters/     # outline/blur/shadow filters on alpha bitmaps
    composite/   # backend-agnostic compositor API + render item assembly
    math/        # fixed-point types, matrices, rounding utilities
    data/        # core data types (FrameContext, GlyphRun, BitmapLayer, etc.)
  backend/
    webgl/       # atlas, batching, quad renderer (WebGL2 if available)
    canvas/      # debug renderer, quick visual checks
  io/
    fonts/       # font discovery/loading glue (browser + Bun)
    assets/      # texture/glyph cache IO helpers
  tools/
    trace/       # trace schema + emitters
    diff/        # image diff helpers (dev only)
  test/
    fixtures/    # ASS samples, fonts, expected outputs
    harness/     # libass comparison harness
docs/
  GOALS.md
  ARCHITECTURE.md
  DEBUG_TOOLS.md
  perf/
```

Notes:
- `core/data` holds pure data types with no side effects.
- `core/math` contains fixed-point math utilities used across modules.
- `tools/*` are dev-only and excluded from production bundles.

## Data model (initial)
- `Fixed26_6`: signed 26.6 fixed point (1/64 px) for all geometry
- `FrameContext`: time, viewport, margins, styles, fonts
- `EventContext`: parsed event, resolved style state, timing
- `GlyphRun`: glyph ids, advances, offsets, font face, features
- `LayoutLine`: positioned glyphs, line metrics, alignment
- `BitmapLayer`: alpha bitmap + origin + size + color + z
- `RenderItem`: final composited quad (texture + transform + color)

## Backend boundary
- Core produces `BitmapLayer[]` per frame.
- Backends handle atlas placement and compositing only.
- No layout or filter logic in backend code.

## Determinism rules
- All math uses fixed-point in core; floats only in GPU shaders.
- Stable ordering of glyphs and layers across runs.
- All randomness disabled; explicit seeds if ever needed.

## Notes on parity
- Apply 3D transforms before rasterization to match libass.
- Outline/blur/shadow are bitmap filters post-raster.
- Subpixel rounding must match libass at each stage.
