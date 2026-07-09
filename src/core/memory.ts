// Aggregate memory accounting and budget control across the renderer's caches.
// Additive over the existing cache modules: it only reads their stats and moves
// their ceilings. No rendering path or output changes.
//
// The event-layer cache dominates (it holds whole composited events); the
// drawing-raster, transformed-glyph, and vector clip-mask caches are the other
// byte-tracked pools. Glyph/combined/path/shaped caches are entry-bounded pools
// of small per-font bitmaps; their limits are reported but their bytes are not
// separately tracked.
import {
  getEventLayerCacheStats,
  setEventLayerCacheLimits,
} from "./pipeline/event";
import { setBitmapPoolLimit } from "./raster/bitmap";
import { getRasterCacheStats, setRasterCacheLimits } from "./raster/event";
import { getLayoutCacheStats, setLayoutCacheLimits } from "./layout/event";

// Re-export the cross-frame reuse gate: the memory layer is the natural place to
// toggle it alongside byte budgets. Default-on; skips caching/prewarming
// sub-frame (single-use) events on dense typeset scripts. See pipeline/event.ts.
export {
  setEventCacheReuseGate,
  getEventCacheReuseGate,
  isEventCacheReusable,
} from "./pipeline/event";

// Default ceilings, captured so a budget scales relative to the shipped config.
// Measured fixtures use only a few MB of byte-tracked caches; the real-time path
// is frame-level dedup + boundary parking, so the main realm should not reserve
// hundreds of MB of cache headroom by default.
const DEFAULT_EVENT_LAYER_BYTES = 64 * 1024 * 1024;
const DEFAULT_EVENT_LAYER_BYTES_CEILING = 64 * 1024 * 1024;
const DEFAULT_DRAWING_BYTES = 32 * 1024 * 1024;
// Transform glyph cache is disabled by default (SUBFRAME_TRANSFORM_CACHE=1 is
// an A/B override), so its shipped default share is zero.
const DEFAULT_TRANSFORM_BYTES = 0;
const DEFAULT_POST_FILTER_BYTES = 8 * 1024 * 1024;
const DEFAULT_CLIP_MASK_BYTES = 16 * 1024 * 1024;
const DEFAULT_TOTAL_BYTES =
  DEFAULT_EVENT_LAYER_BYTES +
  DEFAULT_DRAWING_BYTES +
  DEFAULT_TRANSFORM_BYTES +
  DEFAULT_POST_FILTER_BYTES +
  DEFAULT_CLIP_MASK_BYTES;

export type MemoryStats = {
  // Byte-tracked pools.
  eventLayerBytes: number;
  drawingBytes: number;
  transformBytes: number;
  postFilterBytes: number;
  clipMaskBytes: number;
  totalBytes: number;
  // Entry counts.
  eventLayerEntries: number;
  eventLayerLayers: number;
  drawingEntries: number;
  transformEntries: number;
  postFilterEntries: number;
  clipMaskEntries: number;
  drawingPathEntries: number;
  // Current ceilings.
  limits: {
    eventLayerBytes: number;
    eventLayerBytesCeiling: number;
    eventLayerEntries: number;
    drawingBytes: number;
    drawingEntries: number;
    transformBytes: number;
    transformEntries: number;
    postFilterBytes: number;
    clipMaskBytes: number;
    glyph: number;
    combined: number;
    path: number;
    shapedRun: number;
    drawingPath: number;
  };
};

export function getMemoryStats(): MemoryStats {
  const ev = getEventLayerCacheStats();
  const rs = getRasterCacheStats();
  const ly = getLayoutCacheStats();
  return {
    eventLayerBytes: ev.bytes,
    drawingBytes: rs.drawingBytes,
    transformBytes: rs.transformBytes,
    postFilterBytes: rs.postFilterBytes,
    clipMaskBytes: rs.clipMaskBytes,
    totalBytes:
      ev.bytes + rs.drawingBytes + rs.transformBytes + rs.postFilterBytes + rs.clipMaskBytes,
    eventLayerEntries: ev.entries,
    eventLayerLayers: ev.layers,
    drawingEntries: rs.drawingEntries,
    transformEntries: rs.transformEntries,
    postFilterEntries: rs.postFilterEntries,
    clipMaskEntries: rs.clipMaskEntries,
    drawingPathEntries: ly.drawingPathEntries,
    limits: {
      eventLayerBytes: ev.limitBytes,
      eventLayerBytesCeiling: ev.limitBytesCeiling,
      eventLayerEntries: ev.limitEntries,
      drawingBytes: rs.limits.drawingBytes,
      drawingEntries: rs.limits.drawing,
      transformBytes: rs.limits.transformBytes,
      transformEntries: rs.limits.transform,
      postFilterBytes: rs.limits.postFilterBytes,
      clipMaskBytes: rs.limits.clipMaskBytes,
      glyph: rs.limits.glyph,
      combined: rs.limits.combined,
      path: rs.limits.path,
      shapedRun: ly.limits.shapedRun,
      drawingPath: ly.limits.drawingPath,
    },
  };
}

// Scale every byte ceiling proportionally to `bytes` relative to the default
// total (120MB). `bytes` is treated as the hard byte-tracked cache total: the
// event-layer share's adaptive ceiling is clamped so base + growth never exceeds
// the requested budget. Entry-bounded pools are left alone -- they are small and
// not the memory problem. Clamped to a sane floor so a tiny budget still renders
// (it just re-renders more).
export function setMemoryBudget(bytes: number): void {
  const budget = Math.max(16 * 1024 * 1024, bytes);
  const scale = budget / DEFAULT_TOTAL_BYTES;
  const eventLayerCeiling = Math.max(
    8 * 1024 * 1024,
    Math.round(DEFAULT_EVENT_LAYER_BYTES * scale),
  );
  // Start the adaptive limit at half the share; eviction pressure from
  // never-read entries grows it back up to the full share when needed.
  const eventLayerBytes = Math.max(8 * 1024 * 1024, Math.round(eventLayerCeiling / 2));
  const drawingBytes = Math.max(4 * 1024 * 1024, Math.round(DEFAULT_DRAWING_BYTES * scale));
  const transformBytes =
    DEFAULT_TRANSFORM_BYTES === 0
      ? 0
      : Math.max(2 * 1024 * 1024, Math.round(DEFAULT_TRANSFORM_BYTES * scale));
  const postFilterBytes = Math.max(2 * 1024 * 1024, Math.round(DEFAULT_POST_FILTER_BYTES * scale));
  const clipMaskBytes = Math.max(2 * 1024 * 1024, Math.round(DEFAULT_CLIP_MASK_BYTES * scale));
  setEventLayerCacheLimits({ bytes: eventLayerBytes, bytesCeiling: eventLayerCeiling });
  setRasterCacheLimits({ drawingBytes, transformBytes, postFilterBytes, clipMaskBytes });
}

// Trim the caches to a worker's needs. A prewarm worker renders one event at a
// time and posts the result out, so it never re-reads the event-layer cache —
// that cache is zeroed. Its WORKING caches (glyph/transform/drawing/shaped-run)
// are a different story: they are the pool's throughput engine. Dense typeset
// scripts reuse the same glyphs at the same sizes across thousands of events;
// with starved working caches a worker re-shapes and re-rasterizes every glyph
// on every task, and per-task cost balloons (~4ms/event vs ~1ms warm on
// Beastars — measured via the prewarm funnel; at ~4ms x 11.6k events the pool
// saturates and near-deadline events are never prewarmed). Keep working caches
// near main-thread sized; their limits are ceilings, not preallocations, and
// entry-bounded pools of small per-font bitmaps stay in the tens of MBs.
// Keep the small per-font glyph/path pools that drove the per-task throughput
// win, but keep the LARGE byte-bounded pools (drawing/transform bitmaps) small:
// those multiply across every worker, and 32MB+32MB on each of 6 workers,
// stacked with the main-thread caches, exhausted browser tab memory. Drawings
// live mostly on the main thread's cache; a prewarm worker rendering text
// events barely needs them.
export function applyWorkerCacheLimits(): void {
  setEventLayerCacheLimits({ entries: 0, bytes: 0, bytesCeiling: 0 });
  // Worker frame/scatter renders now return frame-local source masks to the
  // bitmap pool after packFrameArena copies them into the transfer arena. Keep
  // the retained pool modest: enough to absorb dense per-event churn, still
  // small compared with the worker's byte-bounded caches.
  setBitmapPoolLimit(16 * 1024 * 1024);
  setRasterCacheLimits({
    glyph: 2048,
    combined: 256,
    drawing: 24,
    drawingBytes: 8 * 1024 * 1024,
    path: 1024,
    transform: 2048,
    transformBytes: 8 * 1024 * 1024,
    clipMaskBytes: 4 * 1024 * 1024,
  });
  setLayoutCacheLimits({ shapedRun: 512, drawingPath: 32 });
}
