# Architecture overview

## Runtime pipeline

1. A caller parses any supported subtitle format with Subforge and passes its `SubtitleDocument` directly to Subframe.
2. `core/pipeline.ts` finds active Subforge events, coordinates warm caches, workers, frame deduplication, scatter/hybrid scheduling, and returned-buffer lifetime.
3. `core/pipeline/event.ts` resolves each event's Subforge segments and ASS effects without introducing a second run/segment document model.
4. `core/layout/*` resolves fonts, shapes with text-shaper, wraps lines, and places items.
5. `core/raster/*` constructs paths, applies 3D transforms before scan conversion, rasterizes masks, and emits `BitmapLayer` records.
6. Outline, blur, edge blur, and shadow remain post-raster bitmap operations. They run on the CPU unless a WebGPU backend accepts a byte-exact deferred filter descriptor.
7. Canvas2D, WebGL, or WebGPU composites the final ordered layers. WebGL is compositor-only; WebGPU additionally owns its optional integer-compute implementation of the same post-raster filters.

The WebGPU filter path is an explicit exception to the older “backend only composites” shorthand. It may execute filters, but it may not decide layout, shape text, rasterize paths, or change filter semantics. The hardware gate must show byte-identical masks before that path is enabled.

## Ownership boundaries

- `Subframe` is the lifecycle facade: backend selection, explicit fallback reporting, fonts, workers, document warmup, video-clock scheduling, presentation, and disposal.
- `core/pipeline.ts` is a substantial scheduler and cache owner, not a thin wrapper.
- `core/layout/*` and `core/raster/*` own deterministic subtitle semantics.
- `backend/*` owns device resources, atlas allocation, and compositing; WebGPU may also execute proven byte-exact deferred bitmap filters.
- `io/fonts/*` owns registration and resolution. Facade registrations are scoped and removed on document changes or disposal.
- `player/render-ahead.ts` owns buffering and pacing. An attached video supplies the authoritative media clock through `requestVideoFrameCallback` when available.

The core still contains module-global caches and a process-wide worker pool, so only one live `Subframe` facade is supported per JavaScript realm. Low-level callers share that same global state. This limitation is enforced instead of being hidden.

## Coordinate and determinism rules

- Geometry is quantized to 1/64 px at parity-sensitive core boundaries (`SUBPIXEL_MASK = 63`). Public `BitmapLayer.originX` and `originY` are pixel coordinates, not raw 26.6 integers.
- 3D transforms happen before rasterization.
- Outline, blur, edge blur, and shadow operate on raster bitmaps.
- Layer/event ordering is stable. Worker scatter reassembles by the original active-event ordinal before the global z-sort.
- Same document, font bytes, timestamp, viewport, and options must produce the same masks. Machine-local fonts are the last fallback so explicit and embedded bytes take priority.
- The render loop performs no GPU readback. Readback exists only in offline/hardware verification tools.

## Public and package boundary

- `src/index.ts` is an explicit allowlist; adding an internal export is an API decision.
- The package ships one browser-targeted ESM build that also executes under Bun, plus the same worker as a standalone CSP-friendly asset.
- Declaration files are generated into `dist`; raw `src` is not published. Because Subforge 0.1.3 exposes a broad source barrel as its type entry, the build also snapshots that pinned dependency's document schema and redirects generated type-only imports to the snapshot. Runtime inputs remain unmodified Subforge objects.
- The build injects inline-worker code virtually and does not rewrite `src/generated/worker-inline.ts`.

## Parity status

Libass parity is a target for the documented ASS/SSA surface, not a completed guarantee. Golden tests and frame sweeps are the evidence; unsupported or mismatching cases remain failures rather than documentation claims. Other formats rely on Subforge's document conversion and have no libass parity claim.
