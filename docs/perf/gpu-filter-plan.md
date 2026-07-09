# GPU filter+composite chain — integration plan

Stage 1 (done) delivers the hard, correctness-critical piece: a **bit-exact**
WGSL integer port of the libass gaussian blur, plus in-browser proof tooling.
Stage 2 (done) delivers atlas-batched compute passes + a GPU-resident,
content-keyed filtered-bitmap cache. Both are default OFF and not referenced by
the render path.

Stage 1:
- Shaders: `src/backend/webgpu/blur-shaders.ts` (`BLUR_SHADER_SOURCE`)
- Engine: `src/backend/webgpu/blur.ts` (`GpuBlurEngine`, uses a readback — offline only)

Stage 2:
- Batched shaders: `src/backend/webgpu/blur-batch-shaders.ts` (`BLUR_BATCH_SHADER_SOURCE`) —
  one dispatch per pass type over N bitmaps; flat thread id maps to (job, x, y)
  via a per-pass pixel prefix-sum + binary search; per-bitmap A/B slots in one
  `work` buffer keep bitmaps with different level counts from desyncing.
- Batched engine + cache: `src/backend/webgpu/blur-batch.ts`
  (`BatchedGpuBlurEngine`, `GpuFilteredCache`). The cache places filtered
  results into `AtlasAllocator` slots backed by per-page storage buffers and
  skips re-filtering content it has already seen (content-hash key). Pack writes
  straight into atlas page buffers — no readback in the cache path.
- Self-test: `playground/app.ts` (`runGpuBlurSelfTest`) + `playground/index.html`
  (`#gpu-selftest-section`): stage-1 correctness, stage-2 batched correctness
  (byte-identical to stage-1 AND CPU), cache hit/readback check, and a
  Beastars-like throughput benchmark (CPU loop vs batched GPU, with GPU-side
  timing via `timestamp-query` when available).

Stage 1 uses one dispatch per pass and a `mapAsync` readback per blur; stage 2
removes the per-bitmap dispatch and the cache-path readback. The remaining
readback (linear `blurBatch`) exists only so the self-test can byte-compare —
the frame path (stage 3/4) uses the cache's atlas-resident results directly.

## The long-term target

A fully GPU-resident filter+composite chain: rasterized alpha masks are uploaded
once, all post-raster filters (blur, be-blur, outline fix, shadow, tint) run as
compute passes over atlas-resident bitmaps, and the filtered results feed the
existing composite draw **without any CPU readback**. The CPU keeps only the
cheap, exact decisions (blur method/level/radius/coeff via `findBestMethod`,
subpixel split, color/alpha resolution) and hands them to the GPU as uniforms.

## Where the CPU path lives today (integration points)

- `src/core/filters/blur.ts:194` `applyLibassGaussianBlur` — the CPU blur entry;
  wraps `libassGaussianBlur` (`src/core/libass_blur.ts:405`). `GpuBlurEngine`
  already mirrors this function's dims/shift math exactly.
- `src/core/filters/blur.ts:36/90` `beBlurOnce` / `applyBeBlur` — box (be) blur,
  a separable 1-2-1 pass; trivial second compute kernel.
- `src/core/raster/bitmap.ts:185` `fixOutlineBitmap` — subpixel-shifted
  `max`/`sub` combine of glyph+outline; `addBitmapClamped`/`maxBitmapClamped`/
  `subBitmapClamped` (`bitmap.ts:50/83/116`) are the per-pixel ops to port.
- Blur/outline call sites in the raster pipeline:
  `src/core/raster/event.ts:1314` (box), `:1645` (foreground), `:1656` (outline
  glyph); be-blur at `:1321/1648/1658`.
- Layer cache: `src/core/pipeline/event.ts:37` `EVENT_LAYER_CACHE`
  (`Map<SubtitleEvent, CachedEntry>`), built by `buildCachedEntry` (`:284`),
  emitted by `pushEventLayers` (`:249`) / `pushCachedLayers` (`:118`), tint-only
  reuse via `pushTintCachedLayers` (`:208`). Keyed on the event; color/alpha are
  applied per frame on cache hit, so the *shape* bitmaps are already reuse-stable.
- Composite: `src/backend/webgpu/index.ts:271` `render`, mask upload at `:251`
  `uploadMask`, atlas placement via `AtlasAllocator` (`src/backend/atlas-allocator.ts`).
  Draws are batched per atlas page (`:349-368`).

## Stage 2 — atlas-batched compute passes + GPU-resident cache (DONE)

Implemented in `blur-batch-shaders.ts` + `blur-batch.ts`:

1. All masks pack into one `work` storage buffer (two disjoint A/B slots each)
   plus per-bitmap `Job` records (src/dst base, dims, dstStride, radius,
   coeffBase) in a storage array.
2. One dispatch per *pass type* covers all bitmaps. A thread maps its flat id to
   (job, x, y) via a per-pass pixel prefix-sum + binary search. Kernels are the
   stage-1 kernels with indexing changed to job offsets.
3. Variable level counts are handled by round-gating (round k of shrink/expand
   only includes bitmaps whose level > k) and per-bitmap absolute src/dst offsets
   — so bitmaps never desync onto the wrong ping-pong buffer.
4. `findBestMethod` stays on the CPU (`blur.ts`, now exported and shared).
5. `GpuFilteredCache` keys by content hash, allocates `AtlasAllocator` slots
   (LRU/`gen` eviction), and pack writes straight into per-page storage buffers —
   repeated masks skip filtering entirely.

Verified headlessly (Bun emulators): batched output byte-identical to CPU across
the case matrix incl. mixed-size/mixed-r2 batches and asymmetric r2x≠r2y
(134/134); flat-thread→job mapping exact across 2000 random configs. The
in-browser self-test additionally checks batched == stage-1 == CPU and the cache
readback/hit behavior.

## Stage 3 — core defer-filter hook + wiring the cache to events (NEXT)

Now that stage 1+2 exist, wire the GPU cache to the render path:

- Key GPU filtered results the same way the CPU cache keys shapes
  (`src/core/pipeline/event.ts:284` `buildCachedEntry`): per event, shape-only,
  color/alpha excluded. On a CPU cache hit, the filtered bitmap is already atlas
  resident — skip re-upload and re-filter.
- Add a core "defer filtering to backend" hook so blur/be-blur/outline/shadow
  can be emitted as GPU passes instead of CPU calls
  (`src/core/raster/event.ts:1314/1645/1656`, `src/core/filters/blur.ts:194`).
  This is the first stage that edits `src/core`, and only after the user has
  validated stage 1+2 on real hardware via the self-test.
- Reuse the compositor's LRU/`gen` eviction (`src/backend/webgpu/index.ts:310-328`)
  so the filtered atlas stays coherent with the draw cache.

## Stage 4 — filters as passes + no-readback composite

- Port `fixOutlineBitmap` and the clamped combine ops
  (`src/core/raster/bitmap.ts:50/83/116/185`) to compute kernels operating on
  atlas slots; shadow becomes an offset+blur pass reusing the blur kernel; tint
  stays where it is (already per-frame, applied in the composite shader via the
  `Draw.color` path, `src/backend/webgpu/shaders.ts`).
- The composite (`src/backend/webgpu/index.ts:271`) samples the filtered atlas
  slot directly. Because filtering wrote into a GPU texture/atlas the fragment
  shader can sample, there is **no `mapAsync` and no CPU roundtrip** — the whole
  raster→filter→composite tail runs on the GPU timeline in one submit.
- Fallback: when `navigator.gpu` is absent or a device is lost, the existing CPU
  filter path (`applyLibassGaussianBlur` etc.) stays the default and unchanged.

## Risks / watch items

- Bit-exactness must survive batching. The i32 semantics that make stage 1 exact
  (arithmetic `>>`, `mod 2^32` wrap, Int16 store truncation) are unchanged by
  batching, but the offset/indexing math is new surface — cover it in the
  self-test before wiring into the frame loop.
- Atlas pressure: filtered bitmaps are larger than source masks (blur grows by
  `shiftX/shiftY`). Size the storage atlas from the same dim math
  (`offset`/`end` in `libassGaussianBlur`) and evict via the existing LRU.
- Keep everything behind a flag until the batched path is proven byte-identical
  across the full self-test matrix on Chrome and Firefox.
```
