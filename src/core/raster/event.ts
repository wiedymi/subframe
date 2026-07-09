import type { SubtitleEvent } from "subforge/core";
import type { FrameContext, BitmapLayer, ColorRGBA } from "../data/types";
import type { TraceEvent, TraceLayer, TraceLine } from "../trace";
import { pushTraceGlyph, pushTraceLine } from "../trace";
import {
  BitmapBuilder,
  FillRule,
  PathBuilder,
  PixelMode,
  createBitmap,
  computeControlBox,
  getFillRuleFromFlags,
  rasterizePath,
} from "text-shaper";
import type { RasterizedGlyph } from "text-shaper";
import { quantSubpixel, SUBPIXEL_SCALE } from "../math/fixed";
import type { ClipShape } from "../tags/types";
import type { Line, LineItem } from "../layout/line";
import {
  acquireBitmapBuffer,
  addBitmapClamped,
  fixOutlineBitmap,
  markFrameLocalBitmapBuffer,
  maxBitmapClamped,
  normalizeLayerOrigin,
  recordAllocCensus,
  releaseBitmapBuffer,
  shiftBitmapSubpixel,
  splitSubpixel,
  subBitmapClamped,
} from "../raster/bitmap";
import {
  applyBeBlur,
  applyLibassGaussianBlur,
  bePadding,
  quantizeBlur,
  quantizeShadowOffset,
  quantizeTransformPos,
} from "../filters/blur";
import { getGpuFilterProvider, isGpuFilterDeferEnabled } from "../filters/gpu-provider";
import type { GpuFilterSource, GpuFilterDesc } from "../data/types";
import { applyClip } from "../clip/apply";
import {
  clearClipMaskCache,
  getClipMaskCacheStats,
  setClipMaskCacheLimit,
} from "../clip/parser";
import { applyAnimateColors } from "../animate/apply";
import { applyFade, fadeFactorComplex, fadeFactorSimple } from "../animate/fade";
import { itemRotateOrShear } from "../transform/affine";
import {
  buildTransformMatrix,
  flipYMatrix3,
  quantizeTransform,
  restoreTransform,
  translateProjective,
} from "../transform/matrix";
import type { PathCbox } from "../transform/matrix";

export type CacheLayerRole =
  | "fillSolid"
  | "fillPrimary"
  | "fillSecondary"
  | "outline"
  | "shadow"
  | "box";

export type CacheLayerTemplate = {
  lineIndex: number;
  itemIndex: number;
  role: CacheLayerRole;
  bitmap: Uint8Array;
  width: number;
  height: number;
  stride: number;
  originX: number;
  originY: number;
  z: number;
};

const KARAOKE_CLIP_INF = 1_000_000_000;
const SYNTHETIC_ITALIC_SHEAR = 0.2;
const LIBASS_BBOX_EXPAND_MIN = 1;
// Off-frame margin (px) kept when clipping a 3D-transformed glyph bitmap to
// the frame: covers blur radius + shadow offset spread so nothing visible is
// cut, while bounding the allocation for near-90deg perspective projections.
const TRANSFORM_BITMAP_MARGIN = 512;
const LIBASS_BBOX_EXPAND_MAX = 127;
// FT_Outline_EmboldenXY halves the input strength internally (see ftoutln.c),
// but text-shaper emboldenPath expands by the full offset. Match libass by
// halving the effective strength.
const LIBASS_BOLD_STRENGTH_SCALE = 0.5;
const OUTLINE_BIAS = 0.0;

// Per-font entry cap. Kept modest because subpixel-phase keying stores up to
// 64 positional variants of the same glyph: at 4096/font across a dozen fonts
// (fill + outline) the cache alone pinned ~100K bitmaps / >1GB on dense
// cursive scripts. 768 bounds it to ~150MB while still covering a frame's hot
// glyph set.
let GLYPH_RASTER_CACHE_LIMIT = 768;
const GLYPH_RASTER_KEY_SCALE = 1e4;
let glyphFillCache = new WeakMap<LineItem["font"], Map<string, RasterizedGlyph>>();
let glyphOutlineCache = new WeakMap<LineItem["font"], Map<string, RasterizedGlyph>>();
let COMBINED_RASTER_CACHE_LIMIT = 256;
let combinedRasterCache = new WeakMap<
  LineItem["font"],
  Map<
    string,
    {
      fg: RasterizedGlyph;
      og: RasterizedGlyph | null;
      sg: ReturnType<typeof cloneRasterGlyph> | null;
      offsetX: number;
      offsetY: number;
      pad: number;
    }
  >
>();

// Registry of fonts that currently hold entries in the per-font raster/path
// caches (glyphFill/glyphOutline/combined/fillPath/strokePath). Those maps are
// WeakMap-keyed by font and cannot be enumerated, so trimRasterCaches keeps this
// side Set to reach each font's map for an incremental (oldest-first) trim.
// Strong refs are safe: fonts live in the process font cache for the document's
// lifetime, the Set is bounded by the distinct-font count, and clearRasterCaches
// drops it. Populated once per font (on first map creation), never on the hot
// per-glyph path.
const rasterCacheFonts = new Set<LineItem["font"]>();

function quantKey(value: number, scale: number = GLYPH_RASTER_KEY_SCALE): number {
  return Math.round(value * scale);
}

// Glyph fill/stroke PATH cache keys use the EXACT scale/border/bold values,
// not quantized ones. Quantizing (round(value*1e4)) bucketed distinct scales
// together: two transformed events wanting scaleX 0.03387 vs 0.033885 both map
// to key 339, so whichever event rendered first seeded the bucket with its
// scale and the other reused that wrong-scale path. That made a glyph's output
// depend on render order / cache warmth (the order-dependence / warm!=cold
// bug) and blocked bit-exact event-parallel scatter. Exact keys make same-key
// imply same-path: each event builds its path at its own scale (matching a
// cold, alone render), and genuinely-identical scales (same event's glyphs,
// static text across frames) still share the entry. Number->string is an exact
// round-trip, so bit-identical floats collapse to one key and distinct floats
// never collide. The transform raster cache (transformRasterCacheKey) already
// keys on exact scale, so this only aligns the upstream path cache with it.
function fillCacheKey(
  glyphId: number,
  scaleX: number,
  scaleY: number,
  italic: boolean,
  boldStrength: number,
): string {
  return `${glyphId}|${scaleX}|${scaleY}|${italic ? 1 : 0}|${boldStrength}`;
}

function outlineCacheKey(
  glyphId: number,
  scaleX: number,
  scaleY: number,
  italic: boolean,
  boldStrength: number,
  borderX: number,
  borderY: number,
): string {
  return `${glyphId}|${scaleX}|${scaleY}|${italic ? 1 : 0}|${boldStrength}|${borderX}|${borderY}`;
}

function getRasterCache(
  store: WeakMap<LineItem["font"], Map<string, RasterizedGlyph>>,
  font: LineItem["font"],
  key: string,
): RasterizedGlyph | null {
  const map = store.get(font);
  if (!map) return null;
  const value = map.get(key) ?? null;
  if (value) {
    map.delete(key);
    map.set(key, value);
  }
  return value;
}

function setRasterCache(
  store: WeakMap<LineItem["font"], Map<string, RasterizedGlyph>>,
  font: LineItem["font"],
  key: string,
  value: RasterizedGlyph,
): void {
  let map = store.get(font);
  if (!map) {
    map = new Map();
    store.set(font, map);
    rasterCacheFonts.add(font);
  }
  map.set(key, value);
  if (map.size > GLYPH_RASTER_CACHE_LIMIT) {
    const first = map.keys().next();
    if (!first.done) map.delete(first.value);
  }
}

function combinedCacheKey(
  item: LineItem,
  scaleX: number,
  scaleY: number,
  boldStrength: number,
  penSubX: number,
  penSubY: number,
  fillOpaque: boolean,
  fillInShadow: boolean,
): string {
  return [
    item.text,
    quantKey(scaleX),
    quantKey(scaleY),
    quantKey(item.spacing, 1e3),
    quantKey(item.borderX),
    quantKey(item.borderY),
    item.borderStyle,
    quantKey(item.blurSigmaX, 1e3),
    quantKey(item.blurSigmaY, 1e3),
    quantKey(item.edgeBlur, 1e3),
    item.syntheticItalic ? 1 : 0,
    quantKey(boldStrength, 1e3),
    penSubX,
    penSubY,
    fillOpaque ? 1 : 0,
    fillInShadow ? 1 : 0,
  ].join("|");
}

function getCombinedCache(
  font: LineItem["font"],
  key: string,
): { fg: RasterizedGlyph; og: RasterizedGlyph | null; sg: ReturnType<typeof cloneRasterGlyph> | null; offsetX: number; offsetY: number; pad: number } | null {
  const map = combinedRasterCache.get(font);
  if (!map) return null;
  const value = map.get(key) ?? null;
  if (value) {
    map.delete(key);
    map.set(key, value);
  }
  return value;
}

function setCombinedCache(
  font: LineItem["font"],
  key: string,
  value: { fg: RasterizedGlyph; og: RasterizedGlyph | null; sg: ReturnType<typeof cloneRasterGlyph> | null; offsetX: number; offsetY: number; pad: number },
): void {
  let map = combinedRasterCache.get(font);
  if (!map) {
    map = new Map();
    combinedRasterCache.set(font, map);
    rasterCacheFonts.add(font);
  }
  map.set(key, value);
  if (map.size > COMBINED_RASTER_CACHE_LIMIT) {
    const first = map.keys().next();
    if (!first.done) map.delete(first.value);
  }
}


// Filtered drawing bitmaps keyed by content (path text, scale, border, blur,
// fill-in flags). Position-independent: bearings are stored, offsets are
// applied at layer push. Scripts that stamp one drawing many times with
// different \clip/\c (gradient-by-strips) collapse to a single raster+blur.
type DrawingRasterEntry = {
  fg: ReturnType<typeof cloneRasterGlyph>;
  og: ReturnType<typeof cloneRasterGlyph> | null;
  sg: ReturnType<typeof cloneRasterGlyph> | null;
  pad: number;
  bytes: number;
};
let DRAWING_RASTER_CACHE_LIMIT = 256;
let DRAWING_RASTER_CACHE_BYTES_LIMIT = 32 * 1024 * 1024;
const DRAWING_RASTER_CACHE = new Map<string, DrawingRasterEntry>();
let drawingRasterCacheBytes = 0;

// Transformed-glyph raster cache. The per-glyph transform path (rotation/
// shear) re-runs perspective + scanline rasterization + blur every frame,
// which dominates animation-heavy scripts using complex CFF outlines (e.g.
// Mincho fonts). Two levels share one byte-bounded LRU map:
//   "r|" (pre-filter): the raw fill/outline rasters right after perspective +
//        scan conversion, keyed WITHOUT blur. Karaoke-effector scripts stamp
//        the same char as stacked events that differ only in \blur/\shad, so
//        this level shares the expensive scan conversion within a frame even
//        while every transform animates. Entries are handed out un-cloned:
//        the only consumer (BitmapBuilder.fromRasterizedGlyph) copies.
//   "f|" (post-filter): the finished fg/og (post pad/blur/edge-blur, pre
//        outline-punch), keyed WITH blur. Hits skip everything; entries are
//        cloned on every use because downstream mutates rasters in place
//        (fixOutlineBitmap, subpixel bakes in pushLayer).
// Keys use every byte-affecting input at EXACT precision — including the full
// 3x3 transform matrix, which folds in the glyph's absolute position — so a
// hit is byte-identical to a fresh re-raster. Position-animated glyphs (\move)
// simply miss every frame (same work as before, plus one insert).
type TransformGlyphEntry = {
  fg: ReturnType<typeof cloneRasterGlyph>;
  og: ReturnType<typeof cloneRasterGlyph> | null;
  bytes: number;
};
// Default OFF since frame-level dedup (pipeline.ts) took over the cross-frame
// reads that made this cache pay: under dedup, duplicate output frames never
// re-render, so the cache's remaining hits no longer cover its insert cost
// (two bitmap clones per cold glyph). Measured on beastars default: OFF wins
// mean 17.30 -> 14.91ms and p95 52.73 -> 36.31ms; FGOBD (animated, dedup-miss)
// is within noise (+0.7ms mean). SUBFRAME_TRANSFORM_CACHE=1 re-enables for A/B.
const TRANSFORM_GLYPH_CACHE_ENV_ENABLED =
  (globalThis as any)?.process?.env?.SUBFRAME_TRANSFORM_CACHE === "1";
let TRANSFORM_GLYPH_CACHE_LIMIT = TRANSFORM_GLYPH_CACHE_ENV_ENABLED ? 16384 : 0;
let TRANSFORM_GLYPH_CACHE_BYTES_LIMIT = TRANSFORM_GLYPH_CACHE_ENV_ENABLED
  ? 16 * 1024 * 1024
  : 0;
const TRANSFORM_GLYPH_CACHE = new Map<string, TransformGlyphEntry>();
let transformGlyphCacheBytes = 0;
let transformGlyphCacheHits = 0;
let transformGlyphCacheMisses = 0;
const transformCacheFontIds = new WeakMap<LineItem["font"], number>();
let nextTransformCacheFontId = 1;

// Adaptive engagement. A hit saves a full perspective+scan-convert+blur
// (~100µs+ for complex CFF glyphs); a miss costs key building, two lookups
// and an insert (~10µs). Break-even sits near a 1-in-16 hit rate. Scripts
// whose transforms animate EVERY frame (per-glyph \t ramps) never repeat a
// key, so after a probe window with a sub-break-even hit rate the cache goes
// to sleep — no keys, no lookups, no inserts — and re-probes later in case
// the content changed. Counter-based (not wall clock) so behavior stays
// deterministic for identical inputs.
const TRANSFORM_GLYPH_PROBE_WINDOW = 4096;
const TRANSFORM_GLYPH_SLEEP_WINDOW = 65536;
let transformGlyphWindowLookups = 0;
let transformGlyphWindowHits = 0;
let transformGlyphSleepRemaining = 0;

function transformGlyphCacheEngaged(): boolean {
  if (TRANSFORM_GLYPH_CACHE_LIMIT <= 0 || TRANSFORM_GLYPH_CACHE_BYTES_LIMIT <= 0) return false;
  if (transformGlyphSleepRemaining > 0) {
    transformGlyphSleepRemaining--;
    return false;
  }
  return true;
}

function transformGlyphCacheRecordLookup(hit: boolean): void {
  transformGlyphWindowLookups++;
  if (hit) transformGlyphWindowHits++;
  if (transformGlyphWindowLookups >= TRANSFORM_GLYPH_PROBE_WINDOW) {
    if (transformGlyphWindowHits * 16 < transformGlyphWindowLookups) {
      transformGlyphSleepRemaining = TRANSFORM_GLYPH_SLEEP_WINDOW;
    }
    transformGlyphWindowLookups = 0;
    transformGlyphWindowHits = 0;
  }
}

function transformCacheFontId(font: LineItem["font"]): number {
  let id = transformCacheFontIds.get(font);
  if (id === undefined) {
    id = nextTransformCacheFontId++;
    transformCacheFontIds.set(font, id);
  }
  return id;
}

// Pre-filter ("r|") key: everything that determines the raw fill/outline
// rasters. The post-filter ("f|") key appends the blur parameters.
function transformRasterCacheKey(
  font: LineItem["font"],
  glyphId: number,
  scaleX: number,
  scaleY: number,
  italic: boolean,
  boldStrength: number,
  borderX: number,
  borderY: number,
  borderStyle: number,
  matrix: number[][] | null,
): string {
  const m = matrix
    ? `${matrix[0]![0]},${matrix[0]![1]},${matrix[0]![2]},${matrix[1]![0]},${matrix[1]![1]},${matrix[1]![2]},${matrix[2]![0]},${matrix[2]![1]},${matrix[2]![2]}`
    : "I";
  return `${transformCacheFontId(font)}|${glyphId}|${scaleX}|${scaleY}|${italic ? 1 : 0}|${boldStrength}|${borderX}|${borderY}|${borderStyle}|${m}`;
}

function getTransformGlyphCache(key: string): TransformGlyphEntry | null {
  const value = TRANSFORM_GLYPH_CACHE.get(key) ?? null;
  if (value) {
    transformGlyphCacheHits++;
    TRANSFORM_GLYPH_CACHE.delete(key);
    TRANSFORM_GLYPH_CACHE.set(key, value);
  } else {
    transformGlyphCacheMisses++;
  }
  return value;
}

function setTransformGlyphCache(
  key: string,
  fg: ReturnType<typeof cloneRasterGlyph>,
  og: ReturnType<typeof cloneRasterGlyph> | null,
): void {
  if (TRANSFORM_GLYPH_CACHE_LIMIT <= 0 || TRANSFORM_GLYPH_CACHE_BYTES_LIMIT <= 0) return;
  const existing = TRANSFORM_GLYPH_CACHE.get(key);
  if (existing) {
    transformGlyphCacheBytes -= existing.bytes;
    TRANSFORM_GLYPH_CACHE.delete(key);
  }
  const bytes =
    fg.bitmap.buffer.byteLength + (og ? og.bitmap.buffer.byteLength : 0);
  TRANSFORM_GLYPH_CACHE.set(key, { fg, og, bytes });
  transformGlyphCacheBytes += bytes;
  while (
    TRANSFORM_GLYPH_CACHE.size > TRANSFORM_GLYPH_CACHE_LIMIT ||
    transformGlyphCacheBytes > TRANSFORM_GLYPH_CACHE_BYTES_LIMIT
  ) {
    const first = TRANSFORM_GLYPH_CACHE.keys().next();
    if (first.done) break;
    const removed = TRANSFORM_GLYPH_CACHE.get(first.value);
    if (removed) transformGlyphCacheBytes -= removed.bytes;
    TRANSFORM_GLYPH_CACHE.delete(first.value);
  }
}

// Mutable cache ceilings so a memory budget (or the worker realm) can shrink the
// raster caches. Limits/stats only -- no rendering-semantics change. Passing
// undefined leaves a ceiling untouched. Shrinking a byte ceiling trims the
// drawing cache immediately.
export function setRasterCacheLimits(limits: {
  glyph?: number;
  combined?: number;
  drawing?: number;
  drawingBytes?: number;
  path?: number;
  transform?: number;
  transformBytes?: number;
  postFilterBytes?: number;
  clipMaskBytes?: number;
}): void {
  if (limits.clipMaskBytes !== undefined)
    setClipMaskCacheLimit(limits.clipMaskBytes);
  if (limits.postFilterBytes !== undefined) {
    SHIFT_CACHE_BYTES_LIMIT = Math.max(0, limits.postFilterBytes);
    while (
      SHIFT_CACHE.size > 0 &&
      shiftCacheBytes > SHIFT_CACHE_BYTES_LIMIT
    ) {
      const first = SHIFT_CACHE.keys().next();
      if (first.done) break;
      const removed = SHIFT_CACHE.get(first.value);
      if (removed) shiftCacheBytes -= removed.bytes;
      SHIFT_CACHE.delete(first.value);
    }
  }
  if (limits.glyph !== undefined) GLYPH_RASTER_CACHE_LIMIT = Math.max(0, limits.glyph);
  if (limits.combined !== undefined) COMBINED_RASTER_CACHE_LIMIT = Math.max(0, limits.combined);
  if (limits.drawing !== undefined) DRAWING_RASTER_CACHE_LIMIT = Math.max(0, limits.drawing);
  if (limits.path !== undefined) GLYPH_PATH_CACHE_LIMIT = Math.max(0, limits.path);
  if (limits.transform !== undefined)
    TRANSFORM_GLYPH_CACHE_LIMIT = TRANSFORM_GLYPH_CACHE_ENV_ENABLED
      ? Math.max(0, limits.transform)
      : 0;
  if (limits.transformBytes !== undefined)
    TRANSFORM_GLYPH_CACHE_BYTES_LIMIT = TRANSFORM_GLYPH_CACHE_ENV_ENABLED
      ? Math.max(0, limits.transformBytes)
      : 0;
  if (limits.transform !== undefined || limits.transformBytes !== undefined) {
    while (
      TRANSFORM_GLYPH_CACHE.size > 0 &&
      (TRANSFORM_GLYPH_CACHE.size > TRANSFORM_GLYPH_CACHE_LIMIT ||
        transformGlyphCacheBytes > TRANSFORM_GLYPH_CACHE_BYTES_LIMIT)
    ) {
      const first = TRANSFORM_GLYPH_CACHE.keys().next();
      if (first.done) break;
      const removed = TRANSFORM_GLYPH_CACHE.get(first.value);
      if (removed) transformGlyphCacheBytes -= removed.bytes;
      TRANSFORM_GLYPH_CACHE.delete(first.value);
    }
  }
  if (limits.drawingBytes !== undefined) {
    DRAWING_RASTER_CACHE_BYTES_LIMIT = Math.max(0, limits.drawingBytes);
    while (
      DRAWING_RASTER_CACHE.size > 0 &&
      (DRAWING_RASTER_CACHE.size > DRAWING_RASTER_CACHE_LIMIT ||
        drawingRasterCacheBytes > DRAWING_RASTER_CACHE_BYTES_LIMIT)
    ) {
      const first = DRAWING_RASTER_CACHE.keys().next();
      if (first.done) break;
      const removed = DRAWING_RASTER_CACHE.get(first.value);
      if (removed) drawingRasterCacheBytes -= removed.bytes;
      DRAWING_RASTER_CACHE.delete(first.value);
    }
  }
}

// Drop the blurred-result raster caches (combined glyph runs + transformed
// glyphs + drawings). The unblurred glyph/path caches are left intact since
// their contents are identical regardless of GPU vs CPU filtering. Used by the
// playground OFF==ON test to force a real re-render when toggling the GPU
// filter provider between passes.
export function clearRasterCaches(): void {
  combinedRasterCache = new WeakMap();
  // Font-keyed glyph raster and path caches accumulate a bitmap/path per unique
  // (glyph, scale, subpixel phase) across playback and never evict on their own
  // (WeakMap by font, fonts persist). Reset them too so this is a real,
  // full memory reclaim — a prewarm worker calls this to shed accumulated
  // glyph bitmaps between bursts.
  glyphFillCache = new WeakMap();
  glyphOutlineCache = new WeakMap();
  glyphFillPathCache = new WeakMap();
  glyphStrokePathCache = new WeakMap();
  drawingRasterCacheBytes = 0;
  DRAWING_RASTER_CACHE.clear();
  TRANSFORM_GLYPH_CACHE.clear();
  transformGlyphCacheBytes = 0;
  transformGlyphWindowLookups = 0;
  transformGlyphWindowHits = 0;
  transformGlyphSleepRemaining = 0;
  SHIFT_CACHE.clear();
  shiftCacheBytes = 0;
  clearClipMaskCache();
  rasterCacheFonts.clear();
}

// Evict the oldest `drop` entries from an insertion-ordered (LRU) Map. Deleting a
// just-yielded key mid-iteration is well-defined (the entry was already visited),
// so this walks the oldest end and stops once `drop` are gone.
function evictOldestEntries(map: Map<unknown, unknown>, drop: number): void {
  if (drop <= 0) return;
  let n = 0;
  for (const k of map.keys()) {
    map.delete(k);
    if (++n >= drop) break;
  }
}

// Incremental, graceful cache trim: drop the OLDEST `fraction` (0..1) of every
// raster/path cache, keeping the hot working set warm. This is the STAGGERED
// per-worker memory backstop that replaces the synchronized full clearRasterCaches
// on the frame/subset paths — a full clear on every worker on the same frame
// cold-cliffed the whole pool at once (~1000ms+ scatter/ring makespan spike when
// every worker re-rastered its subset/whole frame cold). Dropping only the coldest
// slice sheds accumulated memory without evicting the events a worker re-renders
// each frame, so the makespan barely moves. Parity-safe: every cache is
// exact-keyed, so any dropped entry re-rasters byte-identically (a warm hit equals
// a cold re-raster). fraction<=0 is a no-op; fraction>=1 is a full clear.
export function trimRasterCaches(fraction: number): void {
  const f = fraction <= 0 ? 0 : fraction >= 1 ? 1 : fraction;
  if (f <= 0) return;
  if (f >= 1) {
    clearRasterCaches();
    return;
  }
  // Byte-bounded LRU pools: evict oldest fraction and recompute bytes from the
  // survivors so the counters stay exact (cheaper than per-entry decrement math
  // and immune to any drift).
  {
    const drop = Math.floor(TRANSFORM_GLYPH_CACHE.size * f);
    evictOldestEntries(TRANSFORM_GLYPH_CACHE as Map<unknown, unknown>, drop);
    let bytes = 0;
    for (const e of TRANSFORM_GLYPH_CACHE.values()) bytes += e.bytes;
    transformGlyphCacheBytes = bytes;
  }
  {
    const drop = Math.floor(DRAWING_RASTER_CACHE.size * f);
    evictOldestEntries(DRAWING_RASTER_CACHE as Map<unknown, unknown>, drop);
    let bytes = 0;
    for (const e of DRAWING_RASTER_CACHE.values()) bytes += e.bytes;
    drawingRasterCacheBytes = bytes;
  }
  {
    const drop = Math.floor(SHIFT_CACHE.size * f);
    evictOldestEntries(SHIFT_CACHE as Map<unknown, unknown>, drop);
    let bytes = 0;
    for (const e of SHIFT_CACHE.values()) bytes += e.bytes;
    shiftCacheBytes = bytes;
  }
  // Per-font entry-bounded pools (WeakMap-keyed; reached via the font registry).
  for (const font of rasterCacheFonts) {
    trimFontMap(glyphFillCache.get(font), f);
    trimFontMap(glyphOutlineCache.get(font), f);
    trimFontMap(combinedRasterCache.get(font) as Map<unknown, unknown> | undefined, f);
    trimFontMap(glyphFillPathCache.get(font), f);
    trimFontMap(glyphStrokePathCache.get(font), f);
  }
}

function trimFontMap(map: Map<unknown, unknown> | undefined, f: number): void {
  if (!map || map.size === 0) return;
  evictOldestEntries(map, Math.floor(map.size * f));
}

export function getRasterCacheStats(): {
  drawingBytes: number;
  drawingEntries: number;
  transformBytes: number;
  transformEntries: number;
  transformHits: number;
  transformMisses: number;
  postFilterBytes: number;
  postFilterEntries: number;
  postFilterHits: number;
  postFilterMisses: number;
  clipMaskBytes: number;
  clipMaskEntries: number;
  limits: {
    glyph: number;
    combined: number;
    drawing: number;
    drawingBytes: number;
    path: number;
    transform: number;
    transformBytes: number;
    postFilterBytes: number;
    clipMaskBytes: number;
  };
} {
  const clipMask = getClipMaskCacheStats();
  return {
    drawingBytes: drawingRasterCacheBytes,
    drawingEntries: DRAWING_RASTER_CACHE.size,
    transformBytes: transformGlyphCacheBytes,
    transformEntries: TRANSFORM_GLYPH_CACHE.size,
    transformHits: transformGlyphCacheHits,
    transformMisses: transformGlyphCacheMisses,
    postFilterBytes: shiftCacheBytes,
    postFilterEntries: SHIFT_CACHE.size,
    postFilterHits: shiftCacheHits,
    postFilterMisses: shiftCacheMisses,
    clipMaskBytes: clipMask.bytes,
    clipMaskEntries: clipMask.entries,
    limits: {
      glyph: GLYPH_RASTER_CACHE_LIMIT,
      combined: COMBINED_RASTER_CACHE_LIMIT,
      drawing: DRAWING_RASTER_CACHE_LIMIT,
      drawingBytes: DRAWING_RASTER_CACHE_BYTES_LIMIT,
      path: GLYPH_PATH_CACHE_LIMIT,
      transform: TRANSFORM_GLYPH_CACHE_LIMIT,
      transformBytes: TRANSFORM_GLYPH_CACHE_BYTES_LIMIT,
      postFilterBytes: SHIFT_CACHE_BYTES_LIMIT,
      clipMaskBytes: clipMask.limitBytes,
    },
  };
}

function drawingRasterEntryBytes(entry: {
  fg: ReturnType<typeof cloneRasterGlyph>;
  og: ReturnType<typeof cloneRasterGlyph> | null;
  sg: ReturnType<typeof cloneRasterGlyph> | null;
}): number {
  let total = entry.fg.bitmap.buffer.byteLength;
  if (entry.og && entry.og !== entry.fg) total += entry.og.bitmap.buffer.byteLength;
  if (entry.sg && entry.sg !== entry.og && entry.sg !== entry.fg)
    total += entry.sg.bitmap.buffer.byteLength;
  return total;
}

function getDrawingRasterCache(key: string): DrawingRasterEntry | null {
  const value = DRAWING_RASTER_CACHE.get(key) ?? null;
  if (value) {
    DRAWING_RASTER_CACHE.delete(key);
    DRAWING_RASTER_CACHE.set(key, value);
  }
  return value;
}

function setDrawingRasterCache(key: string, entry: DrawingRasterEntry): void {
  const existing = DRAWING_RASTER_CACHE.get(key);
  if (existing) {
    drawingRasterCacheBytes -= existing.bytes;
    DRAWING_RASTER_CACHE.delete(key);
  }
  DRAWING_RASTER_CACHE.set(key, entry);
  drawingRasterCacheBytes += entry.bytes;
  while (
    DRAWING_RASTER_CACHE.size > DRAWING_RASTER_CACHE_LIMIT ||
    drawingRasterCacheBytes > DRAWING_RASTER_CACHE_BYTES_LIMIT
  ) {
    const first = DRAWING_RASTER_CACHE.keys().next();
    if (first.done) break;
    const removed = DRAWING_RASTER_CACHE.get(first.value);
    if (removed) drawingRasterCacheBytes -= removed.bytes;
    DRAWING_RASTER_CACHE.delete(first.value);
  }
}

// Post-filter subpixel-shift cache (composite cache).
//
// The drawing stamp path rasterizes a drawing once (content-keyed
// DRAWING_RASTER_CACHE, position-independent) then, per stamp, clones the shared
// bitmap and runs ass_shift_bitmap's 2-tap subpixel shift to place it at its
// fractional device position. Baking that fractional offset into the scan
// conversion instead is NOT bit-exact to the 2-tap shift (a true subpixel
// raster and the linear 2-tap filter diverge by tens of levels on hard edges),
// so the shift stays a post-pass. But the shift output depends only on
// (source buffer bytes, phaseX, phaseY) — it is translation-invariant, so the
// integer origin never affects the pixels — which means every stamp of the same
// drawing at the same 1/8-px phase (repeated stamps within a frame, and every
// stamp of static/slow content across frames) produces byte-identical pixels.
// Cache them: on a hit the per-stamp clone + shift + (for shared cached fills,
// the whole ~mid-megapixel copy) collapse to a single map lookup.
//
// Keyed by a stable per-source-buffer id (assigned lazily via a WeakMap, so it
// tracks buffer identity and never collides across distinct cache entries) plus
// the source dims and the exact 1/64-px phase. A fresh (per-frame) source
// buffer simply never repeats its id, so it misses every frame — same work as
// before, plus one bounded insert. Byte-bounded LRU so it cannot grow without
// limit.
const shiftCacheBufIds = new WeakMap<Uint8Array, number>();
let nextShiftCacheBufId = 1;
type ShiftCacheEntry = { buf: Uint8Array; bytes: number };
let SHIFT_CACHE_BYTES_LIMIT = 8 * 1024 * 1024;
const SHIFT_CACHE = new Map<number, ShiftCacheEntry>();
let shiftCacheBytes = 0;
let shiftCacheHits = 0;
let shiftCacheMisses = 0;

function shiftCacheBufId(buf: Uint8Array): number {
  let id = shiftCacheBufIds.get(buf);
  if (id === undefined) {
    id = nextShiftCacheBufId++;
    shiftCacheBufIds.set(buf, id);
  }
  return id;
}

function getShiftCache(key: number): Uint8Array | null {
  const v = SHIFT_CACHE.get(key);
  if (v === undefined) {
    shiftCacheMisses++;
    return null;
  }
  shiftCacheHits++;
  // FIFO (insertion-order) eviction, not LRU: the per-hit Map.delete + Map.set
  // that LRU reordering needs costs more than re-deriving an evicted entry (a
  // single 2-tap shift), and the hot path here takes hundreds of hits per frame
  // (one drawing stamped many times), so a plain read keeps hits cheap.
  return v.buf;
}

function setShiftCache(key: number, buf: Uint8Array): void {
  if (SHIFT_CACHE_BYTES_LIMIT <= 0) return;
  const bytes = buf.byteLength;
  SHIFT_CACHE.set(key, { buf, bytes });
  shiftCacheBytes += bytes;
  while (shiftCacheBytes > SHIFT_CACHE_BYTES_LIMIT) {
    const first = SHIFT_CACHE.keys().next();
    if (first.done) break;
    const removed = SHIFT_CACHE.get(first.value);
    if (removed) shiftCacheBytes -= removed.bytes;
    SHIFT_CACHE.delete(first.value);
  }
}

// Debug escape hatch; read once — per-item env reads showed up in profiles.
const COMBINE_GLYPHS_ENABLED =
  (globalThis as any)?.process?.env?.SUBFRAME_COMBINE_GLYPHS !== "0";

function shouldBlurFill(borderStyle: number, borderMax: number): boolean {
  return borderStyle === 3 || borderMax <= 0;
}

// Monotonic id for GPU filter groups. Globally unique so the backend can dedup a
// frame's layers by group across events; only used when a provider is registered.
let gpuGroupCounter = 0;

// libass FILTER_FILL_IN_SHADOW (ass_render.c): the fill is kept inside the
// shadow when the fill is not fully transparent or during \kf/\ko karaoke.
function itemFillInShadow(item: LineItem, fillAlpha: number): boolean {
  return (
    item.karaokeMode === "fade" ||
    item.karaokeMode === "outline" ||
    fillAlpha !== 0
  );
}

function mulFix(value: number, scaleFix: number): number {
  if (value === 0 || scaleFix === 0) return 0;
  let sign = 1;
  let a = value;
  let b = scaleFix;
  if (a < 0) {
    a = -a;
    sign = -sign;
  }
  if (b < 0) {
    b = -b;
    sign = -sign;
  }
  const result = Math.floor((a * b + 0x8000) / 0x10000);
  return sign < 0 ? -result : result;
}

// phaseX/phaseY are the baked subpixel offsets in 1/64 px units (0..63,
// libass 1/8 px phases => multiples of 8). Folded into the 26.6 control-box
// mins/maxes before the floor so the bitmap bbox reflects the phase-shifted
// outline exactly like libass (device-space +phase in both axes). scale26Fix
// makes minX26 = round(xMin_px * 64), so adding the integer phase is exact.
function getPathBoundsLibass(
  path: { commands: Array<any> },
  flipY: boolean,
  phaseX: number = 0,
  phaseY: number = 0,
): { minX: number; minY: number; maxX: number; maxY: number } | null {
  const scale26Fix = Math.round(1 * 64 * 0x10000);
  let minX26 = Infinity;
  let minY26 = Infinity;
  let maxX26 = -Infinity;
  let maxY26 = -Infinity;

  const box = computeControlBox(path as any);
  if (box) {
    minX26 = mulFix(box.xMin, scale26Fix);
    minY26 = mulFix(box.yMin, scale26Fix);
    maxX26 = mulFix(box.xMax, scale26Fix);
    maxY26 = mulFix(box.yMax, scale26Fix);
  } else {
    const update = (x: number, y: number): void => {
      const rx = mulFix(x, scale26Fix);
      const ry = mulFix(y, scale26Fix);
      if (rx < minX26) minX26 = rx;
      if (rx > maxX26) maxX26 = rx;
      if (ry < minY26) minY26 = ry;
      if (ry > maxY26) maxY26 = ry;
    };

    for (const cmd of path.commands) {
      switch (cmd.type) {
        case "M":
        case "L":
          update(cmd.x, cmd.y);
          break;
        case "Q":
          update(cmd.x1, cmd.y1);
          update(cmd.x, cmd.y);
          break;
        case "C":
          update(cmd.x1, cmd.y1);
          update(cmd.x2, cmd.y2);
          update(cmd.x, cmd.y);
          break;
        default:
          break;
      }
    }
  }

  if (!Number.isFinite(minX26) || !Number.isFinite(minY26)) return null;

  // Device-space +phase in x and y (y already flipped below).
  minX26 += phaseX;
  maxX26 += phaseX;

  if (flipY) {
    const flippedMinY = -maxY26 + phaseY;
    const flippedMaxY = -minY26 + phaseY;
    return {
      minX: Math.floor((minX26 - LIBASS_BBOX_EXPAND_MIN) / 64),
      minY: Math.floor((flippedMinY - LIBASS_BBOX_EXPAND_MIN) / 64),
      maxX: Math.floor((maxX26 + LIBASS_BBOX_EXPAND_MAX) / 64),
      maxY: Math.floor((flippedMaxY + LIBASS_BBOX_EXPAND_MAX) / 64),
    };
  }
  return {
    minX: Math.floor((minX26 - LIBASS_BBOX_EXPAND_MIN) / 64),
    minY: Math.floor((minY26 + phaseY - LIBASS_BBOX_EXPAND_MIN) / 64),
    maxX: Math.floor((maxX26 + LIBASS_BBOX_EXPAND_MAX) / 64),
    maxY: Math.floor((maxY26 + phaseY + LIBASS_BBOX_EXPAND_MAX) / 64),
  };
}

// Control boxes of cached base paths, memoized per PathBuilder identity so
// per-frame quantization does not re-materialize lazy transforms.
const pathCboxCache = new WeakMap<object, PathCbox | null>();

function getPathCboxDown(builder: PathBuilder): PathCbox | null {
  const cached = pathCboxCache.get(builder as unknown as object);
  if (cached !== undefined) return cached;
  const cb = builder.controlBox();
  let out: PathCbox | null = null;
  if (
    cb &&
    Number.isFinite(cb.xMin) &&
    Number.isFinite(cb.yMin) &&
    cb.xMin <= cb.xMax &&
    cb.yMin <= cb.yMax
  ) {
    // Base paths are y-up; the libass-convention matrix consumes y-down.
    out = { minX: cb.xMin, minY: -cb.yMax, maxX: cb.xMax, maxY: -cb.yMin };
  }
  pathCboxCache.set(builder as unknown as object, out);
  return out;
}

// Quantize a transformed glyph's placement exactly like libass: quantize the
// final matrix and the transformed bbox-center position on a 1/8 px grid
// (quantize_transform, ass_render.c:676-828), reconstruct the coarse matrix
// (restore_transform, ass_render.c:829-866), then re-apply the integer pixel
// position so the path is rasterized directly in device space on the same
// grid libass renders on. Returns null for degenerate transforms
// (behind-camera / overflow guards), matching libass skipping the glyph.
function quantizeDeviceMatrix(
  matrix: number[][],
  cbox: PathCbox,
  padX: number,
  padY: number,
  runDelta: { x: number; y: number } | null,
): { m: number[][]; residualX: number; residualY: number } | null {
  const res = quantizeTransform(matrix, cbox, runDelta, padX, padY);
  if (!res) return null;
  const restored = restoreTransform(res.q, cbox, padX, padY);
  return {
    m: translateProjective(restored, res.q.posX, res.q.posY),
    residualX: res.residualX,
    residualY: res.residualY,
  };
}

function applySyntheticPathEffects(
  builder: PathBuilder,
  italic: boolean,
  boldStrength: number,
): PathBuilder {
  let out = builder;
  if (italic) out = out.shear(SYNTHETIC_ITALIC_SHEAR, 0);
  if (boldStrength > 0) {
    // FT_Outline_Embolden (libass ass_glyph_embolden, ass_font.c:595-605)
    // grows the glyph up/right by the full strength without recentering, so
    // libass bold ink sits str/2 right and str/2 above the unbolded glyph.
    // text-shaper's embolden offsets contours symmetrically; translating by
    // the per-side strength reproduces libass placement (y-up path space).
    out = out.embolden(boldStrength).translate(boldStrength, boldStrength);
  }
  return out;
}

function quantizePathInPlace(path: { commands: Array<any>; bounds?: any }): void {
  const cmds = path.commands;
  // SUBPIXEL_SCALE is a power of two, so multiplying by the exact reciprocal
  // is bit-identical to dividing (only the exponent changes). Constants are
  // hoisted and the switch iterates without a per-call closure; this runs for
  // every transformed glyph every frame.
  const s = SUBPIXEL_SCALE;
  const inv = 1 / SUBPIXEL_SCALE;
  for (let i = 0; i < cmds.length; i++) {
    const cmd = cmds[i]!;
    switch (cmd.type) {
      case "M":
      case "L":
        cmd.x = Math.round(cmd.x * s) * inv;
        cmd.y = Math.round(cmd.y * s) * inv;
        break;
      case "Q":
        cmd.x1 = Math.round(cmd.x1 * s) * inv;
        cmd.y1 = Math.round(cmd.y1 * s) * inv;
        cmd.x = Math.round(cmd.x * s) * inv;
        cmd.y = Math.round(cmd.y * s) * inv;
        break;
      case "C":
        cmd.x1 = Math.round(cmd.x1 * s) * inv;
        cmd.y1 = Math.round(cmd.y1 * s) * inv;
        cmd.x2 = Math.round(cmd.x2 * s) * inv;
        cmd.y2 = Math.round(cmd.y2 * s) * inv;
        cmd.x = Math.round(cmd.x * s) * inv;
        cmd.y = Math.round(cmd.y * s) * inv;
        break;
      default:
        break;
    }
  }
  if ("bounds" in path) path.bounds = null;
}

function buildGlyphPath(
  font: LineItem["font"],
  glyphId: number,
  scaleX: number,
  scaleY: number,
  italic: boolean,
  boldStrength: number,
): PathBuilder | null {
  let builder = PathBuilder.fromGlyph(font, glyphId);
  if (!builder) return null;
  builder = builder.scale(scaleX, scaleY);
  builder = applySyntheticPathEffects(builder, italic, boldStrength);
  return builder;
}

// Pre-transform glyph paths for animated/rotated items: the base fill path
// and its stroked border are transform-independent (libass caches the border
// outline and applies transform_3d afterwards, ass_render.c), so only the
// perspective + rasterization runs per frame.
let GLYPH_PATH_CACHE_LIMIT = 2048;
let glyphFillPathCache = new WeakMap<LineItem["font"], Map<string, PathBuilder | null>>();
let glyphStrokePathCache = new WeakMap<LineItem["font"], Map<string, PathBuilder | null>>();

function getPathCache<T>(
  store: WeakMap<LineItem["font"], Map<string, T | null>>,
  font: LineItem["font"],
  key: string,
): T | null | undefined {
  const map = store.get(font);
  if (!map) return undefined;
  if (!map.has(key)) return undefined;
  const value = map.get(key) ?? null;
  map.delete(key);
  map.set(key, value);
  return value;
}

function setPathCache<T>(
  store: WeakMap<LineItem["font"], Map<string, T | null>>,
  font: LineItem["font"],
  key: string,
  value: T | null,
): void {
  let map = store.get(font);
  if (!map) {
    map = new Map();
    store.set(font, map);
    rasterCacheFonts.add(font);
  }
  map.set(key, value);
  if (map.size > GLYPH_PATH_CACHE_LIMIT) {
    const first = map.keys().next();
    if (!first.done) map.delete(first.value);
  }
}

function getCachedGlyphFillPath(
  font: LineItem["font"],
  glyphId: number,
  scaleX: number,
  scaleY: number,
  italic: boolean,
  boldStrength: number,
): PathBuilder | null {
  const key = fillCacheKey(glyphId, scaleX, scaleY, italic, boldStrength);
  const cached = getPathCache(glyphFillPathCache, font, key);
  if (cached !== undefined) return cached;
  const built = buildGlyphPath(font, glyphId, scaleX, scaleY, italic, boldStrength);
  setPathCache(glyphFillPathCache, font, key, built);
  return built;
}

function contourSignedArea(commands: Array<any>): number {
  // Shoelace over on-path and control points; only the sign matters.
  let area = 0;
  let sx = 0;
  let sy = 0;
  let px = 0;
  let py = 0;
  let started = false;
  const acc = (x: number, y: number) => {
    if (!started) {
      sx = x;
      sy = y;
      started = true;
    } else {
      area += px * y - x * py;
    }
    px = x;
    py = y;
  };
  for (let i = 0; i < commands.length; i++) {
    const cmd = commands[i]!;
    switch (cmd.type) {
      case "M":
      case "L":
        acc(cmd.x, cmd.y);
        break;
      case "Q":
        acc(cmd.x1, cmd.y1);
        acc(cmd.x, cmd.y);
        break;
      case "C":
        acc(cmd.x1, cmd.y1);
        acc(cmd.x2, cmd.y2);
        acc(cmd.x, cmd.y);
        break;
      case "Z":
        if (started) area += px * sy - sx * py;
        break;
      default:
        break;
    }
  }
  return area;
}

// text-shaper's stroker emits raw offset contours; where the border is wider
// than a glyph feature the inner (eroded) offset self-intersects, and its
// opposite winding punches zero-coverage pockets out of the border under
// NonZero rasterization (libass's stroker skips such segments instead,
// ass_outline.c). Normalize every stroke contour plus the source outline to
// ONE winding direction: same-sign overlaps only add winding, so a single
// NonZero pass yields the solid dilated shape. The border bitmap therefore
// covers the glyph interior, matching libass's bm_o (fix_outline removes the
// fill region later when the fill is translucent; shadows copy the solid
// bitmap, which is what libass shadows show).
function strokeOutlinePath(
  builder: PathBuilder,
  borderX: number,
  borderY: number,
): PathBuilder | null {
  const biasedBorderX = borderX + OUTLINE_BIAS;
  const biasedBorderY = borderY + OUTLINE_BIAS;
  if (!(biasedBorderX > 0 || biasedBorderY > 0)) return null;
  const LIBASS_STROKER_EPS = 0.25;
  const stroked =
    Math.abs(biasedBorderX - biasedBorderY) <= 1e-6
      ? builder.clone().stroke({
          width: biasedBorderX * 2,
          lineJoin: "round",
        })
      : builder.clone().strokeAsymmetricCombined({
          xBorder: biasedBorderX,
          yBorder: biasedBorderY,
          eps: LIBASS_STROKER_EPS,
          lineJoin: "round",
        });
  if (!stroked) return null;
  const strokedPath = stroked.toPath();
  const basePath = builder.toPath();
  // The border bitmap is the DILATION of the glyph (libass bm_o: solid,
  // interior included — fix_outline punches the fill out later; counters
  // shrink by the border but survive when wide enough). The stroker emits an
  // annulus per source contour: the offset moving AWAY from the glyph
  // (expanded boundary / shrunk counter) belongs to the dilation and keeps
  // its winding; the offset moving INTO the glyph (eroded side) does not —
  // and for features thinner than the border it degenerates into
  // self-intersecting garbage that punches zero-winding holes. Classify each
  // stroke contour by whether its points lie inside the source glyph
  // (majority vote of sampled vertices) and drop the inside ones.
  const baseContours = splitPathContours(basePath);
  const basePolys = flattenPathToPolylines(basePath);
  // Outer boundary only (dominant orientation): used to tell counters from
  // the outside world.
  let solidSign = 0;
  let maxAbs = -1;
  const baseSigns: number[] = new Array(baseContours.length);
  for (let i = 0; i < baseContours.length; i++) {
    const area = contourSignedArea(baseContours[i]!.commands);
    baseSigns[i] = Math.sign(area);
    if (Math.abs(area) > maxAbs) {
      maxAbs = Math.abs(area);
      solidSign = Math.sign(area) || 1;
    }
  }
  const outerCmds: Array<any> = [];
  for (let i = 0; i < baseContours.length; i++) {
    if (baseSigns[i] !== solidSign) continue;
    const cmds = baseContours[i]!.commands;
    for (let c = 0; c < cmds.length; c++) outerCmds[outerCmds.length] = cmds[c];
  }
  const outerPolys = flattenPathToPolylines({ commands: outerCmds });

  const outCmds: Array<any> = [];
  const contours = splitPathContours(strokedPath);
  for (let i = 0; i < contours.length; i++) {
    const cmds = contours[i]!.commands;
    const cls = classifyStrokeContour(cmds, basePolys, outerPolys, solidSign);
    if (cls === 0) continue; // inside glyph or outer-band garbage: drop
    for (let c = 0; c < cmds.length; c++) outCmds[outCmds.length] = cmds[c];
  }
  if (outCmds.length === 0) return stroked;
  return PathBuilder.fromPath({
    commands: outCmds,
    bounds: null,
    flags: strokedPath.flags,
  } as any);
}

// Classify a stroke-output contour for the dilation raster:
//   keep (1): expansion of a boundary (outside the glyph AND outside its
//             outer boundary is only valid when solid-oriented), or a
//             counter-side offset (in a counter region) — genuine hole or
//             counter-filling degenerate, both correct to keep.
//   drop (0): eroded side (inside the glyph fill) or hole-oriented garbage
//             in the outer expansion band (would cancel winding).
function classifyStrokeContour(
  cmds: Array<any>,
  basePolys: Array<Array<number>>,
  outerPolys: Array<Array<number>>,
  solidSign: number,
): number {
  let insideGlyph = 0;
  let insideOuter = 0;
  let total = 0;
  const step = Math.max(1, Math.floor(cmds.length / 8));
  for (let i = 0; i < cmds.length && total < 9; i += step) {
    const cmd = cmds[i]!;
    if (cmd.type !== "M" && cmd.type !== "L" && cmd.type !== "Q" && cmd.type !== "C") continue;
    total++;
    if (windingAt(basePolys, cmd.x, cmd.y) !== 0) insideGlyph++;
    else if (windingAt(outerPolys, cmd.x, cmd.y) !== 0) insideOuter++;
  }
  if (total === 0) return 0;
  if (insideGlyph * 2 > total) return 0;
  if (insideOuter * 2 > total) return 1;
  // Outer expansion band: keep only contours that ADD solid coverage
  // (orientation matching the source outline's dominant direction);
  // hole-oriented fragments here are eroded-side garbage that would cancel
  // winding and punch holes in the border.
  return Math.sign(contourSignedArea(cmds)) === solidSign ? 1 : 0;
}

// Flatten a path to polylines using on-path and control points (winding
// tests only need topology, and every sample point sits a full border width
// away from the base boundary, so control-polygon accuracy is sufficient).
function flattenPathToPolylines(path: {
  commands: Array<any>;
}): Array<Array<number>> {
  const polys: Array<Array<number>> = [];
  let current: Array<number> = [];
  for (let i = 0; i < path.commands.length; i++) {
    const cmd = path.commands[i]!;
    switch (cmd.type) {
      case "M":
        if (current.length >= 6) polys[polys.length] = current;
        current = [cmd.x, cmd.y];
        break;
      case "L":
        current[current.length] = cmd.x;
        current[current.length] = cmd.y;
        break;
      case "Q":
        current[current.length] = cmd.x1;
        current[current.length] = cmd.y1;
        current[current.length] = cmd.x;
        current[current.length] = cmd.y;
        break;
      case "C":
        current[current.length] = cmd.x1;
        current[current.length] = cmd.y1;
        current[current.length] = cmd.x2;
        current[current.length] = cmd.y2;
        current[current.length] = cmd.x;
        current[current.length] = cmd.y;
        break;
      default:
        break;
    }
  }
  if (current.length >= 6) polys[polys.length] = current;
  return polys;
}

function windingAt(polys: Array<Array<number>>, px: number, py: number): number {
  let winding = 0;
  for (let p = 0; p < polys.length; p++) {
    const poly = polys[p]!;
    const n = poly.length;
    let x0 = poly[n - 2]!;
    let y0 = poly[n - 1]!;
    for (let i = 0; i < n; i += 2) {
      const x1 = poly[i]!;
      const y1 = poly[i + 1]!;
      if (y0 <= py) {
        if (y1 > py && (x1 - x0) * (py - y0) - (px - x0) * (y1 - y0) > 0) {
          winding++;
        }
      } else if (y1 <= py && (x1 - x0) * (py - y0) - (px - x0) * (y1 - y0) < 0) {
        winding--;
      }
      x0 = x1;
      y0 = y1;
    }
  }
  return winding;
}


function getCachedGlyphStrokePath(
  font: LineItem["font"],
  glyphId: number,
  scaleX: number,
  scaleY: number,
  italic: boolean,
  boldStrength: number,
  borderX: number,
  borderY: number,
): PathBuilder | null {
  const key = outlineCacheKey(
    glyphId,
    scaleX,
    scaleY,
    italic,
    boldStrength,
    borderX,
    borderY,
  );
  const cached = getPathCache(glyphStrokePathCache, font, key);
  if (cached !== undefined) return cached;
  const base = getCachedGlyphFillPath(
    font,
    glyphId,
    scaleX,
    scaleY,
    italic,
    boldStrength,
  );
  const stroked = base ? strokeOutlinePath(base, borderX, borderY) : null;
  setPathCache(glyphStrokePathCache, font, key, stroked);
  return stroked;
}

// phaseX/phaseY (1/64 px units, libass 1/8 px phases => multiples of 8) bake
// the glyph's subpixel placement offset directly into the scan conversion,
// matching libass's rasterize-at-subpixel behavior (ass_render.c restore_
// transform folds offset.x/y into the outline). The rasterizer's fractional
// offset (decomposePath adds offsetX*ONE_PIXEL, ONE_PIXEL=256, and phase/64*256
// = phase*4 is integer) so the phase enters cleanly with no extra rounding.
// The returned bearings pre-subtract the phase so the caller's existing
// `origin = pen +/- bearing` yields an integer origin with zero residual shift
// (no shiftBitmapSubpixel second pass).
function rasterizeFillFromPath(
  builder: PathBuilder,
  flipY: boolean,
  fillRuleOverride?: FillRule,
  phaseX: number = 0,
  phaseY: number = 0,
  clip?: { minX: number; minY: number; maxX: number; maxY: number },
  poolOut: boolean = false,
): RasterizedGlyph | null {
  const path = builder.toPath();
  if (fillRuleOverride === FillRule.EvenOdd) path.flags = 1;
  quantizePathInPlace(path);
  const bounds = getPathBoundsLibass(path, flipY, phaseX, phaseY);
  if (!bounds) {
    return {
      bitmap: createBitmap(1, 1, PixelMode.Gray),
      bearingX: 0,
      bearingY: 0,
    };
  }
  // A 3D-rotated glyph near 90deg projects to near-infinite screen coords
  // (the perspective denominator is clamped to 0.01, so a far corner lands
  // ~100x out), which would size the fill bitmap to gigabytes. libass clips
  // the transformed glyph to the frame; do the same by intersecting the
  // path bounds with the caller's clip rect. A no-op for in-frame content
  // (its bounds already sit inside the rect), so parity is unchanged.
  let minX = bounds.minX;
  let minY = bounds.minY;
  let maxX = bounds.maxX;
  let maxY = bounds.maxY;
  if (clip) {
    if (minX < clip.minX) minX = clip.minX;
    if (minY < clip.minY) minY = clip.minY;
    if (maxX > clip.maxX) maxX = clip.maxX;
    if (maxY > clip.maxY) maxY = clip.maxY;
  }
  const width = maxX - minX;
  const height = maxY - minY;
  if (width <= 0 || height <= 0) {
    return {
      bitmap: createBitmap(1, 1, PixelMode.Gray),
      bearingX: 0,
      bearingY: 0,
    };
  }
  const phaseFx = phaseX / 64;
  const phaseFy = phaseY / 64;
  const offsetX = -minX + phaseFx;
  const offsetY = -minY + phaseFy;
  const fillRule = fillRuleOverride ?? getFillRuleFromFlags(path);
  // Gray pitch === width, so the buffer is exactly width*height bytes. Pool it
  // only when the caller proved the raster is transient (blurred then dropped);
  // acquireBitmapBuffer hands back a zeroed buffer as the rasterizer requires.
  const out = poolOut
    ? acquireBitmapBuffer(width * height, "raster.fill")
    : undefined;
  const bitmap = rasterizePath(path, {
    width,
    height,
    scale: 1,
    offsetX,
    offsetY,
    pixelMode: PixelMode.Gray,
    fillRule,
    flipY,
    out,
  });
  if (!poolOut && (globalThis as any).__SUBFRAME_ALLOC_CENSUS__)
    recordAllocCensus("raster.fill.alloc", bitmap.buffer.length);
  return {
    bitmap,
    bearingX: bounds.minX - phaseFx,
    bearingY: -bounds.minY + phaseFy,
  };
}

function splitPathContours(path: { commands: Array<any>; flags?: number }): Array<{ commands: Array<any>; flags?: number }> {
  const contours: Array<{ commands: Array<any>; flags?: number }> = [];
  let current: Array<any> = [];
  for (let i = 0; i < path.commands.length; i++) {
    const cmd = path.commands[i]!;
    if (cmd.type === "M") {
      if (current.length > 0) {
        const last = current[current.length - 1];
        if (!last || last.type !== "Z") current.push({ type: "Z" });
        contours.push({ commands: current, flags: path.flags });
      }
      current = [cmd];
      continue;
    }
    current[current.length] = cmd;
    if (cmd.type === "Z") {
      contours.push({ commands: current, flags: path.flags });
      current = [];
    }
  }
  if (current.length > 0) {
    const last = current[current.length - 1];
    if (!last || last.type !== "Z") current.push({ type: "Z" });
    contours.push({ commands: current, flags: path.flags });
  }
  return contours;
}

function rasterizeFillUnionFromPath(
  builder: PathBuilder,
  flipY: boolean,
): RasterizedGlyph | null {
  const path = builder.toPath();
  const contours = splitPathContours(path);
  if (contours.length <= 1) {
    return rasterizeFillFromPath(builder, flipY, FillRule.NonZero);
  }

  const rasters: RasterizedGlyph[] = [];
  let minX = 0;
  let minY = 0;
  let maxX = 0;
  let maxY = 0;
  let haveBounds = false;
  for (let i = 0; i < contours.length; i++) {
    const contour = contours[i]!;
    const contourBuilder = PathBuilder.fromPath(contour as any);
    const raster = contourBuilder
      ? rasterizeFillFromPath(contourBuilder, flipY, FillRule.NonZero)
      : null;
    if (!raster) continue;
    const left = raster.bearingX;
    const top = -raster.bearingY;
    const right = left + raster.bitmap.width;
    const bottom = top + raster.bitmap.rows;
    if (!haveBounds) {
      minX = left;
      minY = top;
      maxX = right;
      maxY = bottom;
      haveBounds = true;
    } else {
      if (left < minX) minX = left;
      if (top < minY) minY = top;
      if (right > maxX) maxX = right;
      if (bottom > maxY) maxY = bottom;
    }
    rasters[rasters.length] = raster;
  }
  if (!haveBounds || rasters.length === 0) return null;

  const width = Math.max(1, maxX - minX);
  const height = Math.max(1, maxY - minY);
  const bitmap = createBitmap(width, height, PixelMode.Gray);
  if ((globalThis as any).__SUBFRAME_ALLOC_CENSUS__)
    recordAllocCensus("raster.contourUnion.alloc", bitmap.buffer.length);
  for (let i = 0; i < rasters.length; i++) {
    const raster = rasters[i]!;
    maxBitmapClamped(
      bitmap.buffer,
      width,
      height,
      bitmap.pitch,
      raster.bitmap.buffer,
      raster.bitmap.width,
      raster.bitmap.rows,
      raster.bitmap.pitch,
      raster.bearingX - minX,
      -raster.bearingY - minY,
    );
  }
  return {
    bitmap,
    bearingX: minX,
    bearingY: -minY,
  };
}

function rasterizeOutlineFromPath(
  builder: PathBuilder,
  borderX: number,
  borderY: number,
  flipY: boolean,
  phaseX: number = 0,
  phaseY: number = 0,
): RasterizedGlyph | null {
  const stroked = strokeOutlinePath(builder, borderX, borderY);
  if (!stroked) return null;
  return rasterizeFillFromPath(stroked, flipY, FillRule.NonZero, phaseX, phaseY);
}

function cloneRasterGlyph(
  glyph: {
    bitmap: {
      buffer: Uint8Array;
      width: number;
      rows: number;
      pitch: number;
      pixelMode?: PixelMode;
      numGrays?: number;
    };
    bearingX: number;
    bearingY: number;
  },
): {
  bitmap: {
    buffer: Uint8Array;
    width: number;
    rows: number;
    pitch: number;
    pixelMode?: PixelMode;
    numGrays?: number;
  };
  bearingX: number;
  bearingY: number;
} {
  const bm = glyph.bitmap;
  if ((globalThis as any).__SUBFRAME_ALLOC_CENSUS__)
    recordAllocCensus("cloneRasterGlyph.slice", bm.buffer.length);
  return {
    bitmap: {
      buffer: bm.buffer.slice(),
      width: bm.width,
      rows: bm.rows,
      pitch: bm.pitch,
      pixelMode: bm.pixelMode,
      numGrays: bm.numGrays,
    },
    bearingX: glyph.bearingX,
    bearingY: glyph.bearingY,
  };
}

function itemFadeFactor(item: LineItem, timeMs: number, ev: SubtitleEvent): number {
  if (item.fadeComplex) return fadeFactorComplex(timeMs, ev, item.fadeComplex);
  if (item.fadeSimple) return fadeFactorSimple(timeMs, ev, item.fadeSimple.in, item.fadeSimple.out);
  return item.fadeFactor ?? 1;
}

const glyphBoundsCache = new WeakMap<
  LineItem["font"],
  Map<number, { xMin: number; yMin: number; xMax: number; yMax: number }>
>();

function getGlyphBoundsCached(
  font: LineItem["font"],
  glyphId: number,
): { xMin: number; yMin: number; xMax: number; yMax: number } | null {
  let cache = glyphBoundsCache.get(font);
  if (!cache) {
    cache = new Map();
    glyphBoundsCache.set(font, cache);
  }
  const cached = cache.get(glyphId);
  if (cached) return cached;
  const bounds = font.getGlyphBounds(glyphId);
  if (!bounds) return null;
  cache.set(glyphId, bounds);
  return bounds;
}

export type RenderLinesInput = {
  ev: SubtitleEvent;
  frame: FrameContext;
  timeMs: number;
  lines: Line[];
  align: number;
  posX: number | null;
  posY: number | null;
  marginL: number;
  marginR: number;
  blockAnchorX: number;
  blockAnchorY: number;
  topY: number;
  clip: ClipShape | null;
  parScaleX: number;
  safeScreenScaleXPar: number;
  safeScreenScaleY: number;
  safeBlurScaleX: number;
  safeBlurScaleY: number;
  layers: BitmapLayer[];
  traceEvent: TraceEvent | null;
  cacheTemplates?: CacheLayerTemplate[];
  // CHANGE 1: suppress GPU filter deferral for this event. Set when the event
  // will be stored in the event-layer cache (cacheable): a cacheable event's
  // blur runs once on the CPU and is then reused for free on every later frame,
  // which strictly beats re-deferring the same blur to the GPU on every frame
  // (deferral poisons buildCachedEntry -> the event is never cached -> it
  // re-rasters + re-dispatches GPU blur each frame). Non-cacheable events
  // (sub-frame / animated) keep deferring — that is where the GPU win lives.
  suppressGpuDefer?: boolean;
  // Frame-arena workers copy GPU/filter source masks into a transfer arena,
  // after which those source buffers are dead. Mark only those private source
  // masks so the worker can pool them after packFrameArena; shared/cache buffers
  // stay unmarked.
  poolFrameLocalBitmaps?: boolean;
};

export function renderEventLines(input: RenderLinesInput): void {
  const {
    ev,
    frame,
    timeMs,
    lines,
    align,
    posX,
    posY,
    marginL,
    marginR,
    blockAnchorX,
    blockAnchorY,
    topY,
    clip,
    parScaleX,
    safeScreenScaleXPar,
    safeScreenScaleY,
    safeBlurScaleX,
    safeBlurScaleY,
    layers,
    traceEvent,
    cacheTemplates,
    suppressGpuDefer,
    poolFrameLocalBitmaps,
  } = input;
  const hAlign = align % 3;

  let penY = topY;
  let cacheLineIndex = -1;
  let cacheItemIndex = -1;

  // libass chains position-rounding residuals across the glyphs of a combined
  // run (ass_render.c:2749: first = !current_info->bitmap_count feeding the
  // offset in/out param of quantize_transform, ass_render.c:716-723, 788-791):
  // the first glyph's residual is subtracted from every later glyph's center
  // before rounding so relative spacing within the run survives quantization.
  // Runs split on style changes (split_style_runs), which maps to subframe
  // segment boundaries.
  let qtRunSegment = -1;
  let qtRunDelta: { x: number; y: number } | null = null;

  // GPU filter deferral (default OFF: gpuProvider is null unless the WebGPU
  // backend registered one). When an item qualifies, its blur/outline/shadow
  // pixel work is deferred to the GPU: fg/og become "phantom" glyphs (unfiltered
  // mask bytes but blurred out-dims + shifted bearings), CPU blur/punch/beBlur
  // are skipped, and each pushed layer is tagged with a gpuFilter descriptor. All
  // downstream origin math is unchanged because the phantom dims/bearings equal
  // what applyLibassGaussianBlur would have produced.
  // CHANGE 1: deferral is disabled for this event when it is cacheable
  // (suppressGpuDefer: its CPU blur is cached and reused, which beats
  // re-deferring every frame) or when the global defer switch is off. When
  // deferral is off, treat the provider as ABSENT for the whole event: no layer
  // routes to the GPU, AND the raster buffers are provably private (deferItem can
  // never be true), so the existing copy-elimination adopt guard
  // (`rasterKey === null && !gpuProvider`) legitimately adopts instead of copying
  // — exactly its documented precondition. This restores copy-elimination for
  // cacheable events that a registered provider would otherwise force onto the
  // slow copy path (~one full glyph-buffer copy per fresh raster).
  const gpuDeferEnabled = !suppressGpuDefer && isGpuFilterDeferEnabled();
  const gpuProvider = gpuDeferEnabled ? getGpuFilterProvider() : null;
  type GpuDeferShared = Omit<GpuFilterDesc, "source" | "sx" | "sy">;
  let gpuDeferShared: GpuDeferShared | null = null;
  let gpuDeferVariant: "none" | "shadow" | "both" | "fillonly" | null = null;
  let gpuDeferBlurFill = false;

  type PhantomBase = {
    bitmap: {
      buffer: Uint8Array;
      width: number;
      rows: number;
      pitch: number;
      pixelMode: PixelMode;
      numGrays?: number;
    };
    bearingX: number;
    bearingY: number;
  };
  const gpuPhantomGlyph = (
    base: PhantomBase,
    sigmaX: number,
    sigmaY: number,
  ): PhantomBase => {
    const d = gpuProvider!.computeBlurDims(
      base.bitmap.width,
      base.bitmap.rows,
      sigmaX * sigmaX,
      sigmaY * sigmaY,
    );
    return {
      bitmap: {
        buffer: base.bitmap.buffer,
        width: d.outW,
        rows: d.outH,
        pitch: base.bitmap.pitch,
        pixelMode: base.bitmap.pixelMode,
        numGrays: base.bitmap.numGrays,
      },
      bearingX: base.bearingX - d.shiftX,
      bearingY: base.bearingY + d.shiftY,
    };
  };

  // Map a layer's cache role to the GPU-produced source for the active variant.
  // Proven vs the CPU FILL_IN_SHADOW ordering (exec_full_emul): fill layers use
  // the blurred fill; outline/shadow select raw vs punched per variant.
  const gpuSourceForRole = (
    role: CacheLayerRole | undefined,
  ): GpuFilterSource | null => {
    if (!gpuDeferVariant) return null;
    if (role === "shadow") {
      if (gpuDeferVariant === "fillonly") return "fill";
      if (gpuDeferVariant === "shadow" || gpuDeferVariant === "both")
        return "outlineRaw";
      return "outlinePunched"; // none
    }
    if (role === "outline") {
      if (gpuDeferVariant === "both") return "outlineRaw";
      if (gpuDeferVariant === "none" || gpuDeferVariant === "shadow")
        return "outlinePunched";
      return null;
    }
    if (role === "fillSolid" || role === "fillPrimary" || role === "fillSecondary") {
      return gpuDeferBlurFill ? "fill" : null;
    }
    return null;
  };

  const gpuDeferCanCarryClip = (c: ClipShape | null | undefined): boolean =>
    !c ||
    (c.type === "rect" && !c.inverse) ||
    (c.type === "mask" && gpuProvider?.supportsMaskClip === true);

  const gpuRectClipIntersectsLayer = (layer: BitmapLayer): boolean => {
    const c = layer.clip;
    if (!c || c.type !== "rect" || c.inverse) return true;
    const x0 = Math.round(layer.originX);
    const y0 = Math.round(layer.originY);
    const x1 = x0 + layer.width;
    const y1 = y0 + layer.height;
    return Math.min(c.x1, x1) > Math.max(c.x0, x0) &&
      Math.min(c.y1, y1) > Math.max(c.y0, y0);
  };

  // Per-item QUALIFY predicate. Deferral is all-or-nothing for an item: once fg/og
  // become phantoms there are no CPU-blurred pixels to fall back to, so anything
  // that would need a per-layer CPU op (non-rect/inverse clip, straddling
  // karaoke fill split, combined border+shadow variant, box, be-blur)
  // disqualifies the whole item.
  const qualifyGpuDefer = (
    item: LineItem,
    useBox: boolean,
    fillInBorder: boolean,
    fillInShadow: boolean,
    blurFill: boolean,
    fgBase: PhantomBase,
    originX: number,
    karaokeSplitX: number | null,
  ): boolean => {
    if (!gpuProvider) return false;
    if (!(item.blurSigmaX > 0 || item.blurSigmaY > 0)) return false;
    if (item.edgeBlur !== 0) return false;
    if (!gpuDeferCanCarryClip(clip)) return false;
    if (useBox) return false;
    // Bordered glyphs ARE eligible. libass blurs the fill only when there is no
    // border (shouldBlurFill); with a border the fill stays sharp and the outline
    // punch (ass_fix_outline) subtracts that sharp fill. The GPU executor mirrors
    // this: filterGroups() preloads the UNBLURRED fill mask into a work slot so
    // bPunch subtracts the raw fill, keeping the outlinePunched source bit-exact
    // (proven end-to-end in exec_full_emul + punchfill_check), so there is no
    // blurFill gate here.
    // A blurred fill under a mid-glyph karaoke split needs a per-layer rect clip
    // on filtered pixels; leave those on the CPU.
    if (blurFill && karaokeSplitX !== null) {
      const deferDims = gpuProvider.computeBlurDims(
        fgBase.bitmap.width,
        fgBase.bitmap.rows,
        item.blurSigmaX * item.blurSigmaX,
        item.blurSigmaY * item.blurSigmaY,
      );
      const left = Math.round(originX + (fgBase.bearingX - deferDims.shiftX));
      const right = left + deferDims.outW;
      if (karaokeSplitX > left && karaokeSplitX < right) return false;
    }
    return true;
  };

  const pushLayer = (
    layer: BitmapLayer,
    kind: TraceLayer["kind"],
    item: LineItem,
    padding: number,
    extraClip?: ClipShape,
    glyphMeta?: { glyphIndex?: number; glyphId?: number },
    cacheRole?: CacheLayerRole,
    sharedBitmap?: boolean,
  ) => {
    // Rect (non-inverse) clips crop via subarray views and never write to
    // the bitmap; only inverse/mask clips mutate pixels and need a clone.
    // Layers referencing cache-shared bitmaps must also clone before
    // normalizeLayerOrigin bakes a subpixel shift into the pixels.
    const clipMutates = (c: ClipShape | undefined): boolean =>
      !!c && (c.type !== "rect" || c.inverse);
    // GPU-deferred layers carry the UNFILTERED source mask with phantom (blurred)
    // dims; the backend produces the filtered pixels. Tag by cache role/variant,
    // then integer-ize the origin and record the subpixel shift for the GPU to
    // bake (via bShiftH/bShiftV) instead of running normalizeLayerOrigin's CPU
    // shift. Rect non-inverse clips are carried to composite. Mask clips are
    // eligible only when the provider advertises a batched final-pixel multiply.
    // All other clips remain CPU-only.
    if (gpuDeferShared && !extraClip && gpuDeferCanCarryClip(layer.clip)) {
      const src = gpuSourceForRole(cacheRole);
      if (src) layer.gpuFilter = { ...gpuDeferShared, source: src, sx: 0, sy: 0 };
    }
    if (layer.gpuFilter) {
      const sp = splitSubpixel(layer.originX);
      const spy = splitSubpixel(layer.originY);
      layer.gpuFilter.sx = sp.s;
      layer.gpuFilter.sy = spy.s;
      layer.originX = sp.i;
      layer.originY = spy.i;
      if (layer.width <= 0 || layer.height <= 0) return;
      if (!gpuRectClipIntersectsLayer(layer)) return;
    } else {
      // Subpixel shift with a post-filter (composite) cache. The 2-tap shift's
      // output depends only on (source buffer bytes, phaseX, phaseY): it is
      // translation-invariant, so neither the integer origin nor any clip
      // affects the shifted pixels (clips are applied afterwards). For a shared
      // (cache-stable) source buffer that needs a real shift, memoize the shifted
      // buffer keyed by (source id, phase), so identical (drawing, phase) stamps
      // — repeated stamps within a frame and every stamp of static/slow content
      // across frames — reuse one shifted buffer instead of re-running a
      // per-stamp clone + shift. Clips are then applied per layer on the shared
      // buffer (rect crops are subarray views; mutating clips clone first so they
      // never write into the cached buffer). Non-shared / no-shift layers keep
      // the original clone-then-normalizeLayerOrigin path unchanged.
      const sp = splitSubpixel(layer.originX);
      const spy = splitSubpixel(layer.originY);
      const needShift = sp.s !== 0 || spy.s !== 0;
      const mutatingClip = clipMutates(extraClip) || clipMutates(layer.clip);
      if (sharedBitmap && needShift) {
        // Numeric key: a stable per-source-buffer id (which alone determines the
        // buffer's bytes and dims) times 4096, plus the 12-bit (phaseX, phaseY)
        // pair. Avoids a per-stamp string allocation on the hot hit path.
        const key = shiftCacheBufId(layer.bitmap) * 4096 + sp.s * 64 + spy.s;
        let shifted = getShiftCache(key);
        if (shifted === null) {
          shifted = layer.bitmap.slice();
          if ((globalThis as any).__SUBFRAME_ALLOC_CENSUS__)
            recordAllocCensus("shiftCache.slice", shifted.length);
          shiftBitmapSubpixel(
            shifted,
            layer.width,
            layer.height,
            layer.stride,
            sp.s,
            spy.s,
          );
          setShiftCache(key, shifted);
        }
        // A mutating clip writes into the bitmap, so it must own a private copy;
        // otherwise the shared cached buffer is used read-only.
        if (mutatingClip) {
          layer.bitmap = shifted.slice();
          if ((globalThis as any).__SUBFRAME_ALLOC_CENSUS__)
            recordAllocCensus("mutatingClip.slice", layer.bitmap.length);
        } else {
          layer.bitmap = shifted;
        }
        layer.originX = sp.i;
        layer.originY = spy.i;
      } else {
        // Reached only when the source is not shared or needs no shift, so the
        // only in-place mutation to guard against is a mutating clip; a private
        // (non-shared) buffer that needs a shift is shifted in place safely by
        // normalizeLayerOrigin, which also integer-izes the origin.
        if (mutatingClip) {
          layer.bitmap = layer.bitmap.slice();
          if ((globalThis as any).__SUBFRAME_ALLOC_CENSUS__)
            recordAllocCensus("mutatingClip.slice", layer.bitmap.length);
        }
        normalizeLayerOrigin(layer);
      }
      if (extraClip) applyClip(layer, extraClip);
      if (layer.clip) {
        applyClip(layer, layer.clip);
        // CPU-filtered layers have the clip baked into layer.bitmap at this
        // point. Keeping the ClipMask object would retain large vector-clip
        // bitmaps through dedup/boundary results even though no compositor reads
        // it. GPU-deferred layers skip this branch and keep composited clips.
        layer.clip = undefined;
      }
      if (layer.width <= 0 || layer.height <= 0) return;
    }
    if (traceEvent) {
      traceEvent.layerCount++;
      const traceLayer: TraceLayer = {
        index: layers.length,
        z: layer.z,
        width: layer.width,
        height: layer.height,
        originX: layer.originX,
        originY: layer.originY,
        color: layer.color,
        clip: layer.clip ? layer.clip.type : null,
        kind,
        segmentIndex: item.segmentIndex,
        text: item.text,
        padding,
        outline: item.border,
        outlineX: item.borderX,
        outlineY: item.borderY,
        borderStyle: item.borderStyle,
        shadow: item.shadow,
        shadowX: item.shadowXExplicit
          ? item.shadowX
          : item.shadow * item.shadowScaleX,
        shadowY: item.shadowYExplicit
          ? item.shadowY
          : item.shadow * item.shadowScaleY,
        blur: item.blur,
        edgeBlur: item.edgeBlur,
        fontSize: item.fontSize,
        scaleXFactor: item.scaleXFactor,
        scaleYFactor: item.scaleYFactor,
        syntheticBold: item.syntheticBold,
        syntheticItalic: item.syntheticItalic,
        fontHintingSupported: item.fontHintingSupported,
        underline: item.underline,
        strikeout: item.strikeout,
        isDrawing: !!item.drawingPath,
      };
      if (glyphMeta) {
        if (glyphMeta.glyphIndex !== undefined)
          traceLayer.glyphIndex = glyphMeta.glyphIndex;
        if (glyphMeta.glyphId !== undefined)
          traceLayer.glyphId = glyphMeta.glyphId;
      }
      traceEvent.layers[traceEvent.layers.length] = traceLayer;
    }
    if (
      cacheTemplates &&
      cacheRole &&
      !layer.gpuFilter &&
      cacheLineIndex >= 0 &&
      cacheItemIndex >= 0
    ) {
      cacheTemplates[cacheTemplates.length] = {
        lineIndex: cacheLineIndex,
        itemIndex: cacheItemIndex,
        role: cacheRole,
        bitmap: layer.bitmap,
        width: layer.width,
        height: layer.height,
        stride: layer.stride,
        originX: layer.originX,
        originY: layer.originY,
        z: layer.z,
      };
    }
    layers[layers.length] = layer;
  };
  for (let li = 0; li < lines.length; li++) {
    const line = lines[li]!;
    cacheLineIndex = li;
    const lineWidth = line.width;

    let segStartX: number[];
    let segWidth: number[];
    const hasCachedMetrics =
      !!line.cacheable && !!line.segStartX && !!line.segWidth;
    if (hasCachedMetrics) {
      segStartX = line.segStartX!;
      segWidth = line.segWidth!;
    } else {
      segStartX = [];
      segWidth = [];
      let segCursor = 0;
      for (let ii = 0; ii < line.items.length; ii++) {
        const item = line.items[ii]!;
        const segAdvance = item.width + item.spacingAfter;
        if (segStartX[item.segmentIndex] === undefined)
          segStartX[item.segmentIndex] = segCursor;
        const prev = segWidth[item.segmentIndex] ?? 0;
        segWidth[item.segmentIndex] = prev + segAdvance;
        segCursor = quantSubpixel(segCursor + segAdvance);
      }
      if (line.cacheable) {
        line.segStartX = segStartX;
        line.segWidth = segWidth;
      }
    }

    // \pos horizontal alignment uses the ADVANCE box [0, lineWidth], not ink
    // extents: libass compute_string_bbox (ass_render.c:1064) spans pen.x to
    // pen.x + cluster_advance and get_base_point picks min/mid/max of that
    // box. Drawings keep raw outline coords, so ink with negative xMin
    // correctly spills left of pos.x.
    let xStart = marginL;
    if (posX === null) {
      if (hAlign === 2) {
        xStart = marginL + (frame.width - marginL - marginR - lineWidth) / 2;
      } else if (hAlign === 0) {
        xStart = frame.width - marginR - lineWidth;
      }
    } else {
      if (hAlign === 2) {
        xStart = posX - lineWidth / 2;
      } else if (hAlign === 0) {
        xStart = posX - lineWidth;
      } else {
        xStart = posX;
      }
    }

    xStart = quantSubpixel(xStart);
    const baselineY = quantSubpixel(penY + line.ascent);
    let penX = xStart;
    let traceLine: TraceLine | null = null;
    if (traceEvent) {
      traceLine = {
        x: xStart,
        y: baselineY,
        width: line.width,
        height: line.height,
        ascent: line.ascent,
        descent: line.descent,
        items: [],
      };
      pushTraceLine(traceEvent, traceLine);
    }

    let boxItem: LineItem | null = null;
    let boxItemIndex = -1;
    let boxPadX = 0;
    let boxPadY = 0;
    let boxShadow = 0;
    let boxShadowX = 0;
    let boxShadowY = 0;
    let boxShadowXExplicit = false;
    let boxShadowYExplicit = false;
    let boxBlur = 0;
    let boxEdgeBlur = 0;
    for (let ii = 0; ii < line.items.length; ii++) {
      const item = line.items[ii]!;
      if (item.borderStyle !== 3) continue;
      if (!boxItem) {
        boxItem = item;
        boxItemIndex = ii;
      }
      boxPadX = Math.max(boxPadX, item.borderX);
      boxPadY = Math.max(boxPadY, item.borderY);
      boxShadow = Math.max(boxShadow, item.shadow);
      if (item.shadowXExplicit) {
        boxShadowX = item.shadowX;
        boxShadowXExplicit = true;
      }
      if (item.shadowYExplicit) {
        boxShadowY = item.shadowY;
        boxShadowYExplicit = true;
      }
      boxBlur = Math.max(boxBlur, item.blur);
      boxEdgeBlur = Math.max(boxEdgeBlur, item.edgeBlur);
    }

    if (boxItem && lineWidth > 0 && line.height > 0) {
      const padX = Math.max(1, boxPadX);
      const padY = Math.max(1, boxPadY);
      const boxWidth = Math.max(1, Math.ceil(lineWidth + padX * 2));
      const boxHeight = Math.max(1, Math.ceil(line.height + padY * 2));
      const buffer = new Uint8Array(boxWidth * boxHeight);
      if ((globalThis as any).__SUBFRAME_ALLOC_CENSUS__)
        recordAllocCensus("solid.box.alloc", buffer.length);
      buffer.fill(255);
      const bitmap = {
        buffer,
        width: boxWidth,
        rows: boxHeight,
        pitch: boxWidth,
        pixelMode: PixelMode.Gray,
        numGrays: 256,
      };
      const extraPad = Math.ceil(Math.max(boxShadow, boxEdgeBlur));
      let baseBuilder = BitmapBuilder.fromBitmap(bitmap);
      if (extraPad > 0) baseBuilder = baseBuilder.pad(extraPad);

      const baseX = xStart - padX;
      const baseY = baselineY - line.ascent - padY;
      let boxOutline = boxItem.outlineColor;
      let boxShadowBase = boxItem.shadowColor;
      if (boxItem.animates.length > 0) {
        const colorState = {
          primary: [0, 0, 0, 0] as ColorRGBA,
          secondary: [0, 0, 0, 0] as ColorRGBA,
          outline: [
            boxOutline[0],
            boxOutline[1],
            boxOutline[2],
            boxOutline[3],
          ] as ColorRGBA,
          shadow: [
            boxShadowBase[0],
            boxShadowBase[1],
            boxShadowBase[2],
            boxShadowBase[3],
          ] as ColorRGBA,
        };
        applyAnimateColors(colorState, boxItem.animates, timeMs, ev);
        boxOutline = colorState.outline;
        boxShadowBase = colorState.shadow;
      }
      const boxFade = itemFadeFactor(boxItem, timeMs, ev);
      const boxColor = applyFade(boxOutline, boxFade);
      const boxShadowColor = applyFade(boxShadowBase, boxFade);
      const shadowXRaw = boxShadowXExplicit
        ? boxShadowX
        : boxShadow * boxItem.shadowScaleX;
      const shadowYRaw = boxShadowYExplicit
        ? boxShadowY
        : boxShadow * boxItem.shadowScaleY;
      const shadowX = quantizeShadowOffset(shadowXRaw, boxItem.shadowMaskX);
      const shadowY = quantizeShadowOffset(shadowYRaw, boxItem.shadowMaskY);
      const boxBlurQuantX = quantizeBlur(boxBlur, safeBlurScaleX);
      const boxBlurQuantY = quantizeBlur(boxBlur, safeBlurScaleY);
      const boxBlurSigmaX = boxBlurQuantX.sigma;
      const boxBlurSigmaY = boxBlurQuantY.sigma;

      let baseGlyph = baseBuilder.toRasterizedGlyph();
      if (boxBlurSigmaX > 0 || boxBlurSigmaY > 0) {
        baseGlyph = applyLibassGaussianBlur(
          baseGlyph,
          boxBlurSigmaX,
          boxBlurSigmaY,
        );
      }
      if (boxEdgeBlur > 0) {
        applyBeBlur(baseGlyph.bitmap, boxEdgeBlur);
      }

      if (shadowXRaw !== 0 || shadowYRaw !== 0) {
        const shadowBuilder = BitmapBuilder.fromRasterizedGlyph(
          baseGlyph,
        ).shift(shadowX, shadowY);
        const sg = shadowBuilder.toRasterizedGlyph();
        const shadowLayer = {
          bitmap: sg.bitmap.buffer,
          width: sg.bitmap.width,
          height: sg.bitmap.rows,
          stride: sg.bitmap.pitch,
          originX: baseX + sg.bearingX,
          originY: baseY - sg.bearingY,
          color: boxShadowColor,
          z: ev.layer,
          clip: clip ?? undefined,
        } as BitmapLayer;
        cacheItemIndex = boxItemIndex;
        pushLayer(
          shadowLayer,
          "shadow",
          boxItem,
          Math.max(padX, padY, extraPad),
          undefined,
          undefined,
          "shadow",
        );
      }

      const bg = baseGlyph;
      const boxLayer = {
        bitmap: bg.bitmap.buffer,
        width: bg.bitmap.width,
        height: bg.bitmap.rows,
        stride: bg.bitmap.pitch,
        originX: baseX + bg.bearingX,
        originY: baseY - bg.bearingY,
        color: boxColor,
        z: ev.layer,
        clip: clip ?? undefined,
      } as BitmapLayer;
      cacheItemIndex = boxItemIndex;
      pushLayer(
        boxLayer,
        "outline",
        boxItem,
        Math.max(padX, padY, extraPad),
        undefined,
        undefined,
        "box",
      );
    }

    for (let ii = 0; ii < line.items.length; ii++) {
      const item = line.items[ii]!;
      cacheItemIndex = ii;
      // Defensive: no GPU-defer context leaks across items (each deferring site
      // sets it right before its pushes and clears it right after).
      gpuDeferShared = null;
      gpuDeferVariant = null;
      const scaleX = item.scaleX;
      const scaleY = item.scaleY;
      const combineEnabled = COMBINE_GLYPHS_ENABLED;
      const shearXAdj =
        item.shearX !== 0 && scaleX !== 0 && scaleY !== 0
          ? item.shearX * (scaleX / scaleY)
          : item.shearX;
      const shearYAdj =
        item.shearY !== 0 && scaleX !== 0 && scaleY !== 0
          ? item.shearY * (scaleY / scaleX)
          : item.shearY;
      const fade = itemFadeFactor(item, timeMs, ev);
      const originX = item.originOverride
        ? quantSubpixel(item.originOverride.x)
        : blockAnchorX;
      const originY = item.originOverride
        ? quantSubpixel(item.originOverride.y)
        : blockAnchorY;
      let outlineBase = item.outlineColor;
      let shadowBase = item.shadowColor;
      let primaryBase = item.primaryColor;
      let secondaryBase = item.secondaryColor;
      if (item.animates.length > 0) {
        const colorState = {
          primary: [primaryBase[0], primaryBase[1], primaryBase[2], primaryBase[3]] as ColorRGBA,
          secondary: [secondaryBase[0], secondaryBase[1], secondaryBase[2], secondaryBase[3]] as ColorRGBA,
          outline: [outlineBase[0], outlineBase[1], outlineBase[2], outlineBase[3]] as ColorRGBA,
          shadow: [shadowBase[0], shadowBase[1], shadowBase[2], shadowBase[3]] as ColorRGBA,
        };
        applyAnimateColors(colorState, item.animates, timeMs, ev);
        primaryBase = colorState.primary;
        secondaryBase = colorState.secondary;
        outlineBase = colorState.outline;
        shadowBase = colorState.shadow;
      }
      const segStart = segStartX[item.segmentIndex] ?? 0;
      const segW = segWidth[item.segmentIndex] ?? item.width;
      // libass emboldens the glyph outline before ASS \fscx/\fscy scaling
      // (ass_font.c:595-605; ass_render.c:2335-2365). text-shaper's path
      // embolden is scalar and runs after path scale, so fold the equivalent
      // isotropic ASS scale into the strength. 100% scale remains unchanged.
      const boldStrength = item.syntheticBold
        ? (item.fontSize / 64) *
          LIBASS_BOLD_STRENGTH_SCALE *
          Math.sqrt(Math.max(0, item.scaleXFactor * item.scaleYFactor))
        : 0;
      let karaokeSplitX: number | null = null;
      let karaokeFillColor = primaryBase;
      let karaokeFillPrimary = primaryBase;
      let karaokeFillSecondary = secondaryBase;
      let karaokeOutlineEnabled = true;
      if (
        item.karaokeStart !== null &&
        item.karaokeEnd !== null &&
        item.karaokeMode
      ) {
        const start = item.karaokeStart;
        const end = item.karaokeEnd;
        if (item.karaokeMode === "fade") {
          if (timeMs <= start) {
            karaokeSplitX = -KARAOKE_CLIP_INF;
          } else if (timeMs >= end || end <= start || segW <= 0) {
            karaokeSplitX = KARAOKE_CLIP_INF;
          } else {
            let t = (timeMs - start) / (end - start);
            if (t < 0) t = 0;
            if (t > 1) t = 1;
            let primary = primaryBase;
            let secondary = secondaryBase;
            let frz = item.rotateZ % 360;
            if (frz < 0) frz += 360;
            if (frz > 90 && frz < 270) {
              t = 1 - t;
              const tmp = primary;
              primary = secondary;
              secondary = tmp;
            }
            karaokeFillPrimary = primary;
            karaokeFillSecondary = secondary;
            karaokeSplitX = Math.round(xStart + segStart + segW * t);
          }
        } else {
          const active = timeMs >= start;
          karaokeFillColor = active ? primaryBase : secondaryBase;
          if (item.karaokeMode === "outline") karaokeOutlineEnabled = active;
        }
      }
      const fillSolidFinal = applyFade(karaokeFillColor, fade);
      const fillPrimaryFinal = applyFade(karaokeFillPrimary, fade);
      const fillSecondaryFinal = applyFade(karaokeFillSecondary, fade);
      const outlineColor = applyFade(outlineBase, fade);
      const shadowColor = applyFade(shadowBase, fade);
      const fillOpaque =
        fillPrimaryFinal[3] === 255 && fillSecondaryFinal[3] === 255;
      const borderMax = Math.max(item.borderX, item.borderY);

      const allTransparent =
        fillSolidFinal[3] === 0 &&
        fillPrimaryFinal[3] === 0 &&
        fillSecondaryFinal[3] === 0 &&
        outlineColor[3] === 0 &&
        shadowColor[3] === 0;
      if (allTransparent) {
        penX = quantSubpixel(penX + item.width + item.spacingAfter);
        continue;
      }
      if (item.isWhitespace && item.borderStyle !== 3) {
        const shadowAny = item.shadow !== 0 || item.shadowX !== 0 || item.shadowY !== 0;
        if (borderMax <= 0 && !shadowAny) {
          penX = quantSubpixel(penX + item.width + item.spacingAfter);
          continue;
        }
      }

      const combineAllowed = combineEnabled;

      if (traceLine) {
        pushTraceGlyph(traceLine, {
          text: item.text,
          isDrawing: !!item.drawingPath,
          isWhitespace: item.isWhitespace,
          x: penX,
          y: baselineY,
          width: item.width,
          ascent: item.ascent,
          descent: item.descent,
          fontSize: item.fontSize,
          spacing: item.spacing,
          spacingAfter: item.spacingAfter,
          rotateZ: item.rotateZ,
          rotateX: item.rotateX,
          rotateY: item.rotateY,
          shearX: item.shearX,
          shearY: item.shearY,
          originX,
          originY,
          scaleX: item.scaleXFactor,
          scaleY: item.scaleYFactor,
          scaleXFactor: item.scaleXFactor,
          scaleYFactor: item.scaleYFactor,
          border: item.border,
          borderX: item.borderX,
          borderY: item.borderY,
          borderStyle: item.borderStyle,
          shadow: item.shadow,
          shadowX: item.shadowXExplicit
            ? item.shadowX
            : item.shadow * item.shadowScaleX,
          shadowY: item.shadowYExplicit
            ? item.shadowY
            : item.shadow * item.shadowScaleY,
          blur: item.blur,
          edgeBlur: item.edgeBlur,
          underline: item.underline,
          strikeout: item.strikeout,
          syntheticBold: item.syntheticBold,
          syntheticItalic: item.syntheticItalic,
          karaokeStart: item.karaokeStart,
          karaokeEnd: item.karaokeEnd,
          segmentIndex: item.segmentIndex,
        });
      }

      if (item.drawingPath) {
        const useTransform = itemRotateOrShear(
          item.rotateZ,
          item.rotateX,
          item.rotateY,
          item.shearX,
          item.shearY,
        );
        const gx = useTransform ? penX : quantizeTransformPos(penX);
        const gy = useTransform ? baselineY : quantizeTransformPos(baselineY);
        let px = gx;
        let py = gy;
        const phaseX = useTransform ? 0 : splitSubpixel(gx).s;
        const phaseY = useTransform ? 0 : splitSubpixel(gy).s;

        const drawScaleX = item.scaleXFactor * safeScreenScaleXPar;
        const drawScaleY = item.scaleYFactor * safeScreenScaleY;
        if (useTransform) {
          px = 0;
          py = 0;
        }

        const borderMax = Math.max(item.borderX, item.borderY);
        const useBox = item.borderStyle === 3;
        const pad = bePadding(item.edgeBlur);
        const fillOpaque =
          fillPrimaryFinal[3] === 255 && fillSecondaryFinal[3] === 255;
        const fillInBorder = borderMax > 0 && fillOpaque;
        const fillInShadow = itemFillInShadow(item, fillPrimaryFinal[3]);

        // EXACT values, not quantized buckets: every float here affects the
        // rasterized bytes, and bucketing (round(v*1e3)) would let two events
        // with nearly-equal scales collide and reuse each other's raster —
        // output would then depend on render order / cache warmth, the same
        // warm!=cold class fillCacheKey was rewritten to eliminate. Exact
        // number->string round-trips make same-key imply same-bytes.
        const drawingKey = !useTransform
          ? [
              item.text,
              drawScaleX,
              drawScaleY,
              item.drawingBaseline,
              item.borderX,
              item.borderY,
              item.borderStyle,
              item.blurSigmaX,
              item.blurSigmaY,
              item.edgeBlur,
              fillInBorder ? 1 : 0,
              fillInShadow ? 1 : 0,
              phaseX,
              phaseY,
            ].join("|")
          : null;
        let entry = drawingKey ? getDrawingRasterCache(drawingKey) : null;

        if (!entry) {
          let builder = PathBuilder.fromPath(item.drawingPath);
          builder = builder.scale(drawScaleX, drawScaleY);
          // PathBuilder composes transforms in local space (right-multiply):
          // translate after scale takes pre-scale units, so pass the raw
          // drawing-local baseline offset.
          if (item.drawingBaseline !== 0)
            builder = builder.translate(0, -item.drawingBaseline);
          if (useTransform) {
            let matrix = buildTransformMatrix(
              gx,
              gy,
              originX,
              originY,
              item.rotateZ,
              item.rotateX,
              item.rotateY,
              shearXAdj,
              shearYAdj,
              item.ascent,
              parScaleX,
              safeBlurScaleY,
            );
            // Drawings render in y-down device space already (flipY: false
            // below), so the cbox needs no flip. Quantize the final transform
            // like libass does for drawing outlines too (drawings are glyphs
            // in the combined run, ass_render.c:1562-1596).
            if (item.segmentIndex !== qtRunSegment) {
              qtRunSegment = item.segmentIndex;
              qtRunDelta = null;
            }
            const cb = builder.controlBox();
            if (
              cb &&
              Number.isFinite(cb.xMin) &&
              Number.isFinite(cb.yMin) &&
              cb.xMin <= cb.xMax &&
              cb.yMin <= cb.yMax
            ) {
              const qDraw = quantizeDeviceMatrix(
                matrix,
                { minX: cb.xMin, minY: cb.yMin, maxX: cb.xMax, maxY: cb.yMax },
                drawScaleX,
                drawScaleY,
                qtRunDelta,
              );
              if (qDraw) {
                if (!qtRunDelta)
                  qtRunDelta = { x: qDraw.residualX, y: qDraw.residualY };
                matrix = qDraw.m;
              }
            }
            builder = builder.perspective(matrix);
          }
          // libass stores ASS drawings as OUTLINE_DRAWING and then feeds them
          // through the same glyph bitmap path as text (ass_render.c
          // get_outline_glyph -> get_bitmap_glyph). Bake the same 1/64px
          // subpixel phase into drawing scan conversion that glyphs use;
          // fractional \pos on thin frame-form rules otherwise over-covers.
          const raster = rasterizeFillFromPath(
            builder,
            false,
            FillRule.NonZero,
            phaseX,
            phaseY,
          );
          if (raster) {
            const baseBuilder = BitmapBuilder.adoptRasterizedGlyph(raster);
            const padded = pad > 0 ? baseBuilder.pad(pad) : baseBuilder;
            const outlineRaster =
              !useBox && borderMax > 0
                ? rasterizeOutlineFromPath(
                  builder,
                  item.borderX,
                  item.borderY,
                  false,
                  phaseX,
                  phaseY,
                )
              : null;
            const outlineBase = outlineRaster
              ? pad > 0
                ? BitmapBuilder.adoptRasterizedGlyph(outlineRaster).pad(pad)
                : BitmapBuilder.adoptRasterizedGlyph(outlineRaster)
              : null;

            const blurSigmaX = item.blurSigmaX;
            const blurSigmaY = item.blurSigmaY;
            const blurFill = shouldBlurFill(item.borderStyle, borderMax);
            const fgBase = padded.intoRasterizedGlyph();
            const fg =
              (blurSigmaX > 0 || blurSigmaY > 0) && blurFill
                ? applyLibassGaussianBlur(fgBase, blurSigmaX, blurSigmaY)
                : fgBase;
            if (blurFill && item.edgeBlur > 0)
              applyBeBlur(fg.bitmap, item.edgeBlur);

            let og: ReturnType<BitmapBuilder["toRasterizedGlyph"]> | null =
              null;
            if (outlineBase) {
              const ogBase = outlineBase.intoRasterizedGlyph();
              og =
                blurSigmaX > 0 || blurSigmaY > 0
                  ? applyLibassGaussianBlur(ogBase, blurSigmaX, blurSigmaY)
                  : ogBase;
              if (og && item.edgeBlur > 0) applyBeBlur(og.bitmap, item.edgeBlur);
            }
            if (og && fg && !useBox && !fillInBorder && !fillInShadow) {
              fixOutlineBitmap(
                og,
                px + og.bearingX,
                py - og.bearingY,
                fg,
                px + fg.bearingX,
                py - fg.bearingY,
              );
            }
            let sg: ReturnType<typeof cloneRasterGlyph> | null = null;
            if (og) {
              if (fg && !useBox && fillInShadow && !fillInBorder) {
                sg = cloneRasterGlyph(og);
              } else if (fg && fillInBorder && !fillInShadow) {
                sg = cloneRasterGlyph(og);
                fixOutlineBitmap(
                  sg,
                  px + sg.bearingX,
                  py - sg.bearingY,
                  fg,
                  px + fg.bearingX,
                  py - fg.bearingY,
                );
              } else {
                sg = og;
              }
            } else {
              sg = fillInShadow ? fg : null;
            }
            if (og && fg && !useBox && !fillInBorder && fillInShadow) {
              fixOutlineBitmap(
                og,
                px + og.bearingX,
                py - og.bearingY,
                fg,
                px + fg.bearingX,
                py - fg.bearingY,
              );
            }
            entry = { fg, og, sg, pad, bytes: 0 };
            entry.bytes = drawingRasterEntryBytes(entry);
            if (drawingKey) setDrawingRasterCache(drawingKey, entry);
          }
        }

        if (entry) {
          const fg = entry.fg;
          const og = entry.og;

          const sxRaw = item.shadowXExplicit
            ? item.shadowX
            : item.shadow * item.shadowScaleX;
          const syRaw = item.shadowYExplicit
            ? item.shadowY
            : item.shadow * item.shadowScaleY;
          const sx = quantizeShadowOffset(sxRaw, item.shadowMaskX);
          const sy = quantizeShadowOffset(syRaw, item.shadowMaskY);

          if (!useBox && (sxRaw !== 0 || syRaw !== 0) && entry.sg) {
            const shadowGlyph = entry.sg;
            const layer = {
              bitmap: shadowGlyph.bitmap.buffer,
              width: shadowGlyph.bitmap.width,
              height: shadowGlyph.bitmap.rows,
              stride: shadowGlyph.bitmap.pitch,
              originX: px + shadowGlyph.bearingX + sx,
              originY: py - shadowGlyph.bearingY + sy,
              color: shadowColor,
              z: ev.layer,
              clip: clip ?? undefined,
            } as BitmapLayer;
            pushLayer(layer, "shadow", item, pad, undefined, undefined, "shadow", true);
          }

          if (og && karaokeOutlineEnabled) {
            const layer = {
              bitmap: og.bitmap.buffer,
              width: og.bitmap.width,
              height: og.bitmap.rows,
              stride: og.bitmap.pitch,
              originX: px + og.bearingX,
              originY: py - og.bearingY,
              color: outlineColor,
              z: ev.layer,
              clip: clip ?? undefined,
            } as BitmapLayer;
            pushLayer(layer, "outline", item, pad, undefined, undefined, "outline", true);
          }

          const fgOriginX = px + fg.bearingX;
          const fgOriginY = py - fg.bearingY;
          if (karaokeSplitX !== null) {
            const left = Math.round(fgOriginX);
            const right = left + fg.bitmap.width;
            if (karaokeSplitX <= left) {
              const layer = {
                bitmap: fg.bitmap.buffer,
                width: fg.bitmap.width,
                height: fg.bitmap.rows,
                stride: fg.bitmap.pitch,
                originX: fgOriginX,
                originY: fgOriginY,
                color: fillSecondaryFinal,
                z: ev.layer,
                clip: clip ?? undefined,
              } as BitmapLayer;
              pushLayer(layer, "fill", item, pad, undefined, undefined, "fillSecondary", true);
            } else if (karaokeSplitX >= right) {
              const layer = {
                bitmap: fg.bitmap.buffer,
                width: fg.bitmap.width,
                height: fg.bitmap.rows,
                stride: fg.bitmap.pitch,
                originX: fgOriginX,
                originY: fgOriginY,
                color: fillPrimaryFinal,
                z: ev.layer,
                clip: clip ?? undefined,
              } as BitmapLayer;
              pushLayer(layer, "fill", item, pad, undefined, undefined, "fillPrimary", true);
            } else {
              const leftLayer = {
                bitmap: fg.bitmap.buffer,
                width: fg.bitmap.width,
                height: fg.bitmap.rows,
                stride: fg.bitmap.pitch,
                originX: fgOriginX,
                originY: fgOriginY,
                color: fillPrimaryFinal,
                z: ev.layer,
                clip: clip ?? undefined,
              } as BitmapLayer;
              pushLayer(leftLayer, "fill", item, pad, {
                type: "rect",
                x0: -KARAOKE_CLIP_INF,
                y0: -KARAOKE_CLIP_INF,
                x1: karaokeSplitX,
                y1: KARAOKE_CLIP_INF,
                inverse: false,
              }, undefined, "fillPrimary", true);
              const rightLayer = {
                bitmap: fg.bitmap.buffer,
                width: fg.bitmap.width,
                height: fg.bitmap.rows,
                stride: fg.bitmap.pitch,
                originX: fgOriginX,
                originY: fgOriginY,
                color: fillSecondaryFinal,
                z: ev.layer,
                clip: clip ?? undefined,
              } as BitmapLayer;
              pushLayer(rightLayer, "fill", item, pad, {
                type: "rect",
                x0: karaokeSplitX,
                y0: -KARAOKE_CLIP_INF,
                x1: KARAOKE_CLIP_INF,
                y1: KARAOKE_CLIP_INF,
                inverse: false,
              }, undefined, "fillSecondary", true);
            }
          } else {
            const layer = {
              bitmap: fg.bitmap.buffer,
              width: fg.bitmap.width,
              height: fg.bitmap.rows,
              stride: fg.bitmap.pitch,
              originX: fgOriginX,
              originY: fgOriginY,
              color: fillSolidFinal,
              z: ev.layer,
              clip: clip ?? undefined,
            } as BitmapLayer;
            pushLayer(layer, "fill", item, pad, undefined, undefined, "fillSolid", true);
          }
        }

        penX = quantSubpixel(penX + item.width + item.spacingAfter);
        continue;
      }

      const shaped = item.shaped;
      if (!shaped) {
        penX = quantSubpixel(penX + item.width + item.spacingAfter);
        continue;
      }
      const infos = shaped.infos;
      const positions = shaped.positions;
      let baselineShear = 0;
      const itemHasTransform =
        item.rotateZ !== 0 ||
        item.shearX !== 0 ||
        item.shearY !== 0 ||
        item.rotateX !== 0 ||
        item.rotateY !== 0;
      // Transformed items stay per-glyph: combining their rasters would blur
      // the rotated line's whole AABB (large, sparse), which measures much
      // slower than per-glyph blur on animation-heavy scripts.
      if (!itemHasTransform && combineAllowed) {
        const penSub = splitSubpixel(penX).s;
        const baseSub = splitSubpixel(baselineY).s;
        const fillOpaque =
          fillPrimaryFinal[3] === 255 && fillSecondaryFinal[3] === 255;
        const fillInShadowKey = itemFillInShadow(item, fillPrimaryFinal[3]);
        const combinedKey = combinedCacheKey(
          item,
          scaleX,
          scaleY,
          boldStrength,
          penSub,
          baseSub,
          fillOpaque,
          fillInShadowKey,
        );
        const cachedCombined = getCombinedCache(item.font, combinedKey);
        if (cachedCombined) {
          const baseOriginX = penX + cachedCombined.offsetX;
          const baseOriginY = baselineY + cachedCombined.offsetY;
          const pad = cachedCombined.pad;
          const fg = cachedCombined.fg;
          const og = cachedCombined.og;

          if (item.borderStyle !== 3) {
            const sxRaw = item.shadowXExplicit
              ? item.shadowX
              : item.shadow * item.shadowScaleX;
            const syRaw = item.shadowYExplicit
              ? item.shadowY
              : item.shadow * item.shadowScaleY;
            const sx = quantizeShadowOffset(sxRaw, item.shadowMaskX);
            const sy = quantizeShadowOffset(syRaw, item.shadowMaskY);
            const sg = cachedCombined.sg;
            if ((sxRaw !== 0 || syRaw !== 0) && sg) {
              const shadowGlyph = cloneRasterGlyph(sg);
              const layer = {
                bitmap: shadowGlyph.bitmap.buffer,
                width: shadowGlyph.bitmap.width,
                height: shadowGlyph.bitmap.rows,
                stride: shadowGlyph.bitmap.pitch,
                originX: baseOriginX + shadowGlyph.bearingX + sx,
                originY: baseOriginY - shadowGlyph.bearingY + sy,
                color: shadowColor,
                z: ev.layer,
                clip: clip ?? undefined,
              } as BitmapLayer;
              pushLayer(layer, "shadow", item, pad, undefined, undefined, "shadow", true);
            }
          }

          if (og && karaokeOutlineEnabled) {
            const layer = {
              bitmap: og.bitmap.buffer,
              width: og.bitmap.width,
              height: og.bitmap.rows,
              stride: og.bitmap.pitch,
              originX: baseOriginX + og.bearingX,
              originY: baseOriginY - og.bearingY,
              color: outlineColor,
              z: ev.layer,
              clip: clip ?? undefined,
            } as BitmapLayer;
            pushLayer(layer, "outline", item, pad, undefined, undefined, "outline", true);
          }

          const fgOriginX = baseOriginX + fg.bearingX;
          const fgOriginY = baseOriginY - fg.bearingY;
          if (karaokeSplitX !== null) {
            const left = Math.round(fgOriginX);
            const right = left + fg.bitmap.width;
            if (karaokeSplitX <= left) {
              const layer = {
                bitmap: fg.bitmap.buffer,
                width: fg.bitmap.width,
                height: fg.bitmap.rows,
                stride: fg.bitmap.pitch,
                originX: fgOriginX,
                originY: fgOriginY,
                color: fillSecondaryFinal,
                z: ev.layer,
                clip: clip ?? undefined,
              } as BitmapLayer;
              pushLayer(layer, "fill", item, pad, undefined, undefined, "fillSecondary", true);
            } else if (karaokeSplitX >= right) {
              const layer = {
                bitmap: fg.bitmap.buffer,
                width: fg.bitmap.width,
                height: fg.bitmap.rows,
                stride: fg.bitmap.pitch,
                originX: fgOriginX,
                originY: fgOriginY,
                color: fillPrimaryFinal,
                z: ev.layer,
                clip: clip ?? undefined,
              } as BitmapLayer;
              pushLayer(layer, "fill", item, pad, undefined, undefined, "fillPrimary", true);
            } else {
              const leftLayer = {
                bitmap: fg.bitmap.buffer,
                width: fg.bitmap.width,
                height: fg.bitmap.rows,
                stride: fg.bitmap.pitch,
                originX: fgOriginX,
                originY: fgOriginY,
                color: fillPrimaryFinal,
                z: ev.layer,
                clip: clip ?? undefined,
              } as BitmapLayer;
              pushLayer(leftLayer, "fill", item, pad, {
                type: "rect",
                x0: -KARAOKE_CLIP_INF,
                y0: -KARAOKE_CLIP_INF,
                x1: karaokeSplitX,
                y1: KARAOKE_CLIP_INF,
                inverse: false,
              }, undefined, "fillPrimary", true);
              const rightLayer = {
                bitmap: fg.bitmap.buffer,
                width: fg.bitmap.width,
                height: fg.bitmap.rows,
                stride: fg.bitmap.pitch,
                originX: fgOriginX,
                originY: fgOriginY,
                color: fillSecondaryFinal,
                z: ev.layer,
                clip: clip ?? undefined,
              } as BitmapLayer;
              pushLayer(rightLayer, "fill", item, pad, {
                type: "rect",
                x0: karaokeSplitX,
                y0: -KARAOKE_CLIP_INF,
                x1: KARAOKE_CLIP_INF,
                y1: KARAOKE_CLIP_INF,
                inverse: false,
              }, undefined, "fillSecondary", true);
            }
          } else {
            const layer = {
              bitmap: fg.bitmap.buffer,
              width: fg.bitmap.width,
              height: fg.bitmap.rows,
              stride: fg.bitmap.pitch,
              originX: fgOriginX,
              originY: fgOriginY,
              color: fillSolidFinal,
              z: ev.layer,
              clip: clip ?? undefined,
            } as BitmapLayer;
            pushLayer(layer, "fill", item, pad, undefined, undefined, "fillSolid", true);
          }

          penX = quantSubpixel(penX + item.width + item.spacingAfter);
          continue;
        }
        const fillGlyphs: Array<{
          bitmap: {
            buffer: Uint8Array;
            width: number;
            rows: number;
            pitch: number;
          };
          x: number;
          y: number;
        }> = [];
        const outlineGlyphs: Array<{
          bitmap: {
            buffer: Uint8Array;
            width: number;
            rows: number;
            pitch: number;
          };
          x: number;
          y: number;
        }> = [];
        let minX = 0;
        let minY = 0;
        let maxX = 0;
        let maxY = 0;
        let haveBounds = false;
        let glyphPenX = penX;

        for (let gi = 0; gi < infos.length; gi++) {
          const glyphId = infos[gi]!.glyphId;
          const pos = positions[gi]!;
          const xOffset = quantSubpixel(pos.xOffset * scaleX);
          const yOffset = quantSubpixel(pos.yOffset * scaleY);
          const xAdvance = quantSubpixel(pos.xAdvance * scaleX);
          const advance = xAdvance + item.spacing;

          const gxAligned = quantSubpixel(glyphPenX + xOffset);
          const gyAligned = quantSubpixel(baselineY - yOffset);
          let gx = gxAligned;
          let gy = gyAligned;
          if (shearYAdj !== 0) {
            gy = quantSubpixel(gy + baselineShear + shearYAdj * xOffset);
            baselineShear = quantSubpixel(
              baselineShear + shearYAdj * xAdvance,
            );
          }
          gx = quantizeTransformPos(gx);
          gy = quantizeTransformPos(gy);

          const useBox = item.borderStyle === 3;
          const borderMax = Math.max(item.borderX, item.borderY);
          // libass rasterizes the outline AT the 1/8 px subpixel phase
          // (SUBPIXEL_ORDER=3, 8 phases/axis). gx/gy are quantized to 1/8 px,
          // so their fractional part is the phase to bake into the raster. The
          // phase is part of the RASTER cache key (up to 8x8 = 64 variants per
          // glyph) but NOT the path cache key (paths are phase-independent).
          const phaseX = splitSubpixel(gx).s;
          const phaseY = splitSubpixel(gy).s;
          const phaseSuffix = `|${phaseX}|${phaseY}`;
          const fillKey =
            fillCacheKey(
              glyphId,
              scaleX,
              scaleY,
              item.syntheticItalic,
              boldStrength,
            ) + phaseSuffix;
          const outlineKey =
            !useBox && borderMax > 0
              ? outlineCacheKey(
                  glyphId,
                  scaleX,
                  scaleY,
                  item.syntheticItalic,
                  boldStrength,
                  item.borderX,
                  item.borderY,
                ) + phaseSuffix
              : null;
          let fillRaster = getRasterCache(glyphFillCache, item.font, fillKey);
          let outlineRaster =
            outlineKey && !useBox && borderMax > 0
              ? getRasterCache(glyphOutlineCache, item.font, outlineKey)
              : null;

          let glyphPath: PathBuilder | null = null;
          if (!fillRaster || (!outlineRaster && outlineKey)) {
            glyphPath = buildGlyphPath(
              item.font,
              glyphId,
              scaleX,
              scaleY,
              item.syntheticItalic,
              boldStrength,
            );
            if (!glyphPath) {
              glyphPenX = quantSubpixel(glyphPenX + advance);
              continue;
            }
          }

          if (!fillRaster) {
            fillRaster = glyphPath
              ? rasterizeFillFromPath(glyphPath, true, undefined, phaseX, phaseY)
              : null;
            if (fillRaster) {
              setRasterCache(glyphFillCache, item.font, fillKey, fillRaster);
            }
          }
          if (fillRaster) {
            // Phase baked into the raster => origin is integer, no second-pass
            // shift, and the cached bitmap is consumed read-only (addBitmap
            // only reads src) so no per-glyph copy either.
            const originX = gx + fillRaster.bearingX;
            const originY = gy - fillRaster.bearingY;
            const sx = splitSubpixel(originX);
            const sy = splitSubpixel(originY);
            const fillBitmap = fillRaster.bitmap;
            const ix = sx.i;
            const iy = sy.i;
            const right = ix + fillBitmap.width;
            const bottom = iy + fillBitmap.rows;
            if (!haveBounds) {
              minX = ix;
              minY = iy;
              maxX = right;
              maxY = bottom;
              haveBounds = true;
            } else {
              if (ix < minX) minX = ix;
              if (iy < minY) minY = iy;
              if (right > maxX) maxX = right;
              if (bottom > maxY) maxY = bottom;
            }
            fillGlyphs[fillGlyphs.length] = {
              bitmap: fillBitmap,
              x: ix,
              y: iy,
            };
          }

          if (!useBox && borderMax > 0) {
            if (!outlineRaster) {
              outlineRaster = glyphPath
                ? rasterizeOutlineFromPath(
                    glyphPath,
                    item.borderX,
                    item.borderY,
                    true,
                    phaseX,
                    phaseY,
                  )
                : null;
              if (outlineRaster && outlineKey) {
                setRasterCache(
                  glyphOutlineCache,
                  item.font,
                  outlineKey,
                  outlineRaster,
                );
              }
            }
            if (outlineRaster) {
              const originX = gx + outlineRaster.bearingX;
              const originY = gy - outlineRaster.bearingY;
              const sx = splitSubpixel(originX);
              const sy = splitSubpixel(originY);
              const outlineBitmap = outlineRaster.bitmap;
              const ix = sx.i;
              const iy = sy.i;
              const right = ix + outlineBitmap.width;
              const bottom = iy + outlineBitmap.rows;
              if (!haveBounds) {
                minX = ix;
                minY = iy;
                maxX = right;
                maxY = bottom;
                haveBounds = true;
              } else {
                if (ix < minX) minX = ix;
                if (iy < minY) minY = iy;
                if (right > maxX) maxX = right;
                if (bottom > maxY) maxY = bottom;
              }
              outlineGlyphs[outlineGlyphs.length] = {
                bitmap: outlineBitmap,
                x: ix,
                y: iy,
              };
            }
          }

          glyphPenX = quantSubpixel(glyphPenX + advance);
        }

        if (fillGlyphs.length > 0 && haveBounds) {
          const combinedWidth = Math.max(1, maxX - minX);
          const combinedHeight = Math.max(1, maxY - minY);
          const fillBitmap = createBitmap(
            combinedWidth,
            combinedHeight,
            PixelMode.Gray,
          );
          if ((globalThis as any).__SUBFRAME_ALLOC_CENSUS__)
            recordAllocCensus("combined.fillBitmap.alloc", fillBitmap.buffer.length);
          for (let gi = 0; gi < fillGlyphs.length; gi++) {
            const g = fillGlyphs[gi]!;
            addBitmapClamped(
              fillBitmap.buffer,
              combinedWidth,
              combinedHeight,
              fillBitmap.pitch,
              g.bitmap.buffer,
              g.bitmap.width,
              g.bitmap.rows,
              g.bitmap.pitch,
              g.x - minX,
              g.y - minY,
            );
          }
          const outlineBitmap =
            outlineGlyphs.length > 0
              ? createBitmap(combinedWidth, combinedHeight, PixelMode.Gray)
              : null;
          if (outlineBitmap)
            if ((globalThis as any).__SUBFRAME_ALLOC_CENSUS__)
              recordAllocCensus("combined.outlineBitmap.alloc", outlineBitmap.buffer.length);
          if (outlineBitmap) {
            for (let gi = 0; gi < outlineGlyphs.length; gi++) {
              const g = outlineGlyphs[gi]!;
              addBitmapClamped(
                outlineBitmap.buffer,
                combinedWidth,
                combinedHeight,
                outlineBitmap.pitch,
                g.bitmap.buffer,
                g.bitmap.width,
                g.bitmap.rows,
                g.bitmap.pitch,
                g.x - minX,
                g.y - minY,
              );
            }
          }

          const baseOriginX = minX;
          const baseOriginY = minY;
          const combinedFill = {
            bitmap: fillBitmap,
            bearingX: 0,
            bearingY: 0,
          };
          const useBox = item.borderStyle === 3;
          const borderMax = Math.max(item.borderX, item.borderY);
          const pad = bePadding(item.edgeBlur);
          const fillBase =
            pad > 0
              ? BitmapBuilder.adoptRasterizedGlyph(combinedFill).pad(pad)
              : BitmapBuilder.adoptRasterizedGlyph(combinedFill);
          const combinedOutline = outlineBitmap
            ? { bitmap: outlineBitmap, bearingX: 0, bearingY: 0 }
            : null;
          const outlineBase =
            !useBox && combinedOutline
              ? pad > 0
                ? BitmapBuilder.adoptRasterizedGlyph(combinedOutline).pad(pad)
                : BitmapBuilder.adoptRasterizedGlyph(combinedOutline)
              : null;

          const blurSigmaX = item.blurSigmaX;
          const blurSigmaY = item.blurSigmaY;
          const blurFill = shouldBlurFill(item.borderStyle, borderMax);
          const fillOpaque =
            fillPrimaryFinal[3] === 255 && fillSecondaryFinal[3] === 255;
          const fillInBorder = borderMax > 0 && fillOpaque;
          const fillInShadow = itemFillInShadow(item, fillPrimaryFinal[3]);
          const fgBase = fillBase.intoRasterizedGlyph();
          const deferItem = qualifyGpuDefer(
            item,
            useBox,
            fillInBorder,
            fillInShadow,
            blurFill,
            fgBase,
            baseOriginX,
            karaokeSplitX,
          );
          const fg =
            deferItem && blurFill
              ? gpuPhantomGlyph(fgBase, blurSigmaX, blurSigmaY)
              : (blurSigmaX > 0 || blurSigmaY > 0) && blurFill
                ? applyLibassGaussianBlur(fgBase, blurSigmaX, blurSigmaY)
                : fgBase;
          if (!deferItem && blurFill && item.edgeBlur > 0)
            applyBeBlur(fg.bitmap, item.edgeBlur);

          let og: ReturnType<BitmapBuilder["toRasterizedGlyph"]> | null =
            null;
          let ogBaseForDesc: PhantomBase | null = null;
          if (outlineBase) {
            const ogBase = outlineBase.intoRasterizedGlyph();
            ogBaseForDesc = ogBase;
            og = deferItem
              ? gpuPhantomGlyph(ogBase, blurSigmaX, blurSigmaY)
              : blurSigmaX > 0 || blurSigmaY > 0
                ? applyLibassGaussianBlur(ogBase, blurSigmaX, blurSigmaY)
                : ogBase;
            if (!deferItem && og && item.edgeBlur > 0) applyBeBlur(og.bitmap, item.edgeBlur);
          }
          if (!deferItem && og && fg && item.borderStyle !== 3 && !fillInBorder && !fillInShadow) {
            fixOutlineBitmap(
              og,
              baseOriginX + og.bearingX,
              baseOriginY - og.bearingY,
              fg,
              baseOriginX + fg.bearingX,
              baseOriginY - fg.bearingY,
            );
          }
          if (deferItem) {
            gpuDeferVariant = og
              ? fillInBorder && fillInShadow
                ? "both"
                : fillInShadow
                  ? "shadow"
                  : "none"
              : "fillonly";
            gpuDeferBlurFill = blurFill;
            gpuDeferShared = {
              groupId: gpuGroupCounter++,
              r2x: blurSigmaX * blurSigmaX,
              r2y: blurSigmaY * blurSigmaY,
              fillMask: fgBase.bitmap.buffer,
              fillW: fgBase.bitmap.width,
              fillH: fgBase.bitmap.rows,
              fillStride: fgBase.bitmap.pitch,
              outlineMask: ogBaseForDesc?.bitmap.buffer,
              outlineW: ogBaseForDesc?.bitmap.width,
              outlineH: ogBaseForDesc?.bitmap.rows,
              outlineStride: ogBaseForDesc?.bitmap.pitch,
              punchOX: og ? splitSubpixel(baseOriginX + og.bearingX).i : undefined,
              punchOY: og ? splitSubpixel(baseOriginY - og.bearingY).i : undefined,
              punchFX: og ? splitSubpixel(baseOriginX + fg.bearingX).i : undefined,
              punchFY: og ? splitSubpixel(baseOriginY - fg.bearingY).i : undefined,
            };
          } else {
            gpuDeferShared = null;
            gpuDeferVariant = null;
          }

          // Shadow source must be captured before the outline gets the fill
          // punched out (libass copies bm_s from bm_o pre-fix under
          // FILL_IN_SHADOW). Kept in the combined cache alongside fg/og.
          let shadowSource: ReturnType<typeof cloneRasterGlyph> | null = null;
          if (og) {
            if (fg && item.borderStyle !== 3 && fillInShadow && !fillInBorder) {
              shadowSource = cloneRasterGlyph(og);
            } else if (fg && fillInBorder && !fillInShadow) {
              shadowSource = cloneRasterGlyph(og);
              if (!deferItem)
                fixOutlineBitmap(
                  shadowSource,
                  baseOriginX + shadowSource.bearingX,
                  baseOriginY - shadowSource.bearingY,
                  fg,
                  baseOriginX + fg.bearingX,
                  baseOriginY - fg.bearingY,
                );
            } else {
              shadowSource = og;
            }
          } else {
            shadowSource = fillInShadow ? fg : null;
          }

          if (!useBox) {
            const sxRaw = item.shadowXExplicit
              ? item.shadowX
              : item.shadow * item.shadowScaleX;
            const syRaw = item.shadowYExplicit
              ? item.shadowY
              : item.shadow * item.shadowScaleY;
            const sx = quantizeShadowOffset(sxRaw, item.shadowMaskX);
            const sy = quantizeShadowOffset(syRaw, item.shadowMaskY);
            if ((sxRaw !== 0 || syRaw !== 0) && shadowSource) {
              const shadowGlyph = cloneRasterGlyph(shadowSource);
              const layer = {
                bitmap: shadowGlyph.bitmap.buffer,
                width: shadowGlyph.bitmap.width,
                height: shadowGlyph.bitmap.rows,
                stride: shadowGlyph.bitmap.pitch,
                originX: baseOriginX + shadowGlyph.bearingX + sx,
                originY: baseOriginY - shadowGlyph.bearingY + sy,
                color: shadowColor,
                z: ev.layer,
                clip: clip ?? undefined,
              } as BitmapLayer;
              pushLayer(layer, "shadow", item, pad, undefined, undefined, "shadow", true);
            }
          }

          if (!deferItem && og && fg && item.borderStyle !== 3 && !fillInBorder && fillInShadow) {
            fixOutlineBitmap(
              og,
              baseOriginX + og.bearingX,
              baseOriginY - og.bearingY,
              fg,
              baseOriginX + fg.bearingX,
              baseOriginY - fg.bearingY,
            );
          }

          if (og && karaokeOutlineEnabled) {
            const layer = {
              bitmap: og.bitmap.buffer,
              width: og.bitmap.width,
              height: og.bitmap.rows,
              stride: og.bitmap.pitch,
              originX: baseOriginX + og.bearingX,
              originY: baseOriginY - og.bearingY,
              color: outlineColor,
              z: ev.layer,
              clip: clip ?? undefined,
            } as BitmapLayer;
            pushLayer(layer, "outline", item, pad, undefined, undefined, "outline", true);
          }

          const fgOriginX = baseOriginX + fg.bearingX;
          const fgOriginY = baseOriginY - fg.bearingY;
          if (karaokeSplitX !== null) {
            const left = Math.round(fgOriginX);
            const right = left + fg.bitmap.width;
            if (karaokeSplitX <= left) {
              const layer = {
                bitmap: fg.bitmap.buffer,
                width: fg.bitmap.width,
                height: fg.bitmap.rows,
                stride: fg.bitmap.pitch,
                originX: fgOriginX,
                originY: fgOriginY,
                color: fillSecondaryFinal,
                z: ev.layer,
                clip: clip ?? undefined,
              } as BitmapLayer;
              pushLayer(layer, "fill", item, pad, undefined, undefined, "fillSecondary", true);
            } else if (karaokeSplitX >= right) {
              const layer = {
                bitmap: fg.bitmap.buffer,
                width: fg.bitmap.width,
                height: fg.bitmap.rows,
                stride: fg.bitmap.pitch,
                originX: fgOriginX,
                originY: fgOriginY,
                color: fillPrimaryFinal,
                z: ev.layer,
                clip: clip ?? undefined,
              } as BitmapLayer;
              pushLayer(layer, "fill", item, pad, undefined, undefined, "fillPrimary", true);
            } else {
              const leftLayer = {
                bitmap: fg.bitmap.buffer,
                width: fg.bitmap.width,
                height: fg.bitmap.rows,
                stride: fg.bitmap.pitch,
                originX: fgOriginX,
                originY: fgOriginY,
                color: fillPrimaryFinal,
                z: ev.layer,
                clip: clip ?? undefined,
              } as BitmapLayer;
              pushLayer(leftLayer, "fill", item, pad, {
                type: "rect",
                x0: -KARAOKE_CLIP_INF,
                y0: -KARAOKE_CLIP_INF,
                x1: karaokeSplitX,
                y1: KARAOKE_CLIP_INF,
                inverse: false,
              }, undefined, "fillPrimary", true);
              const rightLayer = {
                bitmap: fg.bitmap.buffer,
                width: fg.bitmap.width,
                height: fg.bitmap.rows,
                stride: fg.bitmap.pitch,
                originX: fgOriginX,
                originY: fgOriginY,
                color: fillSecondaryFinal,
                z: ev.layer,
                clip: clip ?? undefined,
              } as BitmapLayer;
              pushLayer(rightLayer, "fill", item, pad, {
                type: "rect",
                x0: karaokeSplitX,
                y0: -KARAOKE_CLIP_INF,
                x1: KARAOKE_CLIP_INF,
                y1: KARAOKE_CLIP_INF,
                inverse: false,
              }, undefined, "fillSecondary", true);
            }
          } else {
            const layer = {
              bitmap: fg.bitmap.buffer,
              width: fg.bitmap.width,
              height: fg.bitmap.rows,
              stride: fg.bitmap.pitch,
              originX: fgOriginX,
              originY: fgOriginY,
              color: fillSolidFinal,
              z: ev.layer,
              clip: clip ?? undefined,
            } as BitmapLayer;
            pushLayer(layer, "fill", item, pad, undefined, undefined, "fillSolid", true);
          }

          if (!deferItem && combinedKey) {
            setCombinedCache(item.font, combinedKey, {
              fg,
              og,
              sg: shadowSource,
              offsetX: baseOriginX - penX,
              offsetY: baseOriginY - baselineY,
              pad,
            });
          }
          gpuDeferShared = null;
          gpuDeferVariant = null;
        }

        penX = quantSubpixel(penX + item.width + item.spacingAfter);
        continue;
      }

      for (let gi = 0; gi < infos.length; gi++) {
        const glyphId = infos[gi]!.glyphId;
        const glyphMeta = { glyphIndex: gi, glyphId };
        const pos = positions[gi]!;
        const xOffset = quantSubpixel(pos.xOffset * scaleX);
        const yOffset = quantSubpixel(pos.yOffset * scaleY);
        const xAdvance = quantSubpixel(pos.xAdvance * scaleX);
        const advance = xAdvance + item.spacing;

        const useTransform = itemHasTransform;
        const gxAligned = quantSubpixel(penX + xOffset);
        const gyAligned = quantSubpixel(baselineY - yOffset);
        let gx = gxAligned;
        let gy = gyAligned;
        if (shearYAdj !== 0) {
          gy = quantSubpixel(gy + baselineShear + shearYAdj * xOffset);
          baselineShear = quantSubpixel(baselineShear + shearYAdj * xAdvance);
        }
        if (!useTransform) {
          gx = quantizeTransformPos(gx);
          gy = quantizeTransformPos(gy);
        }

        let px = gx;
        let py = gy;
        // Non-transform per-glyph path (only reached when glyph-combining is
        // disabled): bake the 1/8 px subpixel phase like the combined path.
        // Transformed glyphs bake their phase into the quantized device matrix,
        // so the phase stays 0 for them (no double-shift).
        const phaseX = useTransform ? 0 : splitSubpixel(gx).s;
        const phaseY = useTransform ? 0 : splitSubpixel(gy).s;
        const useBox = item.borderStyle === 3;
        const borderMax = Math.max(item.borderX, item.borderY);
        let transformMatrix: ReturnType<typeof buildTransformMatrix> | null =
          null;
        let fillDevMatrix: number[][] | null = null;
        let strokeDevMatrix: number[][] | null = null;
        let basePathQ: ReturnType<typeof getCachedGlyphFillPath> = null;
        let strokePathQ: ReturnType<typeof getCachedGlyphStrokePath> = null;
        if (useTransform) {
          // libass feeds unquantized 26.6 positions into calc_transform_matrix
          // (ass_render.c:1504-1551) and only quantizes the FINAL transform
          // (quantize_transform, ass_render.c:676-828); gx/gy/origin are
          // already rounded to 1/64 px above, matching info->pos/info->shift.
          transformMatrix = buildTransformMatrix(
            gx,
            gy,
            originX,
            originY,
            item.rotateZ,
            item.rotateX,
            item.rotateY,
            shearXAdj,
            shearYAdj,
            item.ascent,
            parScaleX,
            safeBlurScaleY,
          );
          if (item.segmentIndex !== qtRunSegment) {
            qtRunSegment = item.segmentIndex;
            qtRunDelta = null;
          }
          basePathQ = getCachedGlyphFillPath(
            item.font,
            glyphId,
            scaleX,
            scaleY,
            item.syntheticItalic,
            boldStrength,
          );
          if (!basePathQ) {
            penX = quantSubpixel(penX + advance);
            continue;
          }
          // 64 outline units (the libass cbox pad) in pixels: outlines are
          // hinting-free masters at ft_size = 256 (fix_glyph_scaling,
          // ass_render.c:2185-2206), so one outline pixel spans
          // fontSize * scale / 256 device pixels.
          const padX = (item.fontSize * item.scaleXFactor) / 256;
          const padY = (item.fontSize * item.scaleYFactor) / 256;
          const fillCbox = getPathCboxDown(basePathQ);
          if (fillCbox) {
            const qFill = quantizeDeviceMatrix(
              transformMatrix,
              fillCbox,
              padX,
              padY,
              qtRunDelta,
            );
            if (qFill) {
              if (!qtRunDelta)
                qtRunDelta = { x: qFill.residualX, y: qFill.residualY };
              fillDevMatrix = qFill.m;
            }
          }
          if (!useBox && borderMax > 0) {
            strokePathQ = getCachedGlyphStrokePath(
              item.font,
              glyphId,
              scaleX,
              scaleY,
              item.syntheticItalic,
              boldStrength,
              item.borderX,
              item.borderY,
            );
            const strokeCbox = strokePathQ
              ? getPathCboxDown(strokePathQ)
              : null;
            if (strokeCbox) {
              const qStroke = quantizeDeviceMatrix(
                transformMatrix,
                strokeCbox,
                padX,
                padY,
                qtRunDelta,
              );
              if (qStroke) strokeDevMatrix = qStroke.m;
            }
          }
          px = 0;
          py = 0;
        }
        const fillMatrixFinal =
          useTransform && transformMatrix
            ? (fillDevMatrix ?? transformMatrix)
            : null;
        const strokeMatrixFinal =
          useTransform && transformMatrix
            ? (strokeDevMatrix ?? fillMatrixFinal)
            : null;
        // Transformed-glyph raster cache (see the cache's comment block).
        // Skipped when a GPU filter provider is registered: deferral needs the
        // unfiltered mask and a fresh per-frame group id.
        let rasterKey: string | null = null;
        let filteredKey: string | null = null;
        let cachedFiltered: TransformGlyphEntry | null = null;
        let cachedRaster: TransformGlyphEntry | null = null;
        if (!gpuProvider && transformGlyphCacheEngaged()) {
          rasterKey = transformRasterCacheKey(
            item.font,
            glyphId,
            scaleX,
            scaleY,
            item.syntheticItalic,
            boldStrength,
            item.borderX,
            item.borderY,
            item.borderStyle,
            fillMatrixFinal,
          );
          if (strokeMatrixFinal && strokeMatrixFinal !== fillMatrixFinal) {
            const s = strokeMatrixFinal;
            rasterKey += `|S${s[0]![0]},${s[0]![1]},${s[0]![2]},${s[1]![0]},${s[1]![1]},${s[1]![2]},${s[2]![0]},${s[2]![1]},${s[2]![2]}`;
          }
          // Phase only differs for the non-transform branch (0 otherwise); a
          // constant suffix for transformed glyphs, a discriminator otherwise.
          rasterKey += `|P${phaseX},${phaseY}`;
          filteredKey = `f|${rasterKey}|${item.blurSigmaX}|${item.blurSigmaY}|${item.edgeBlur}`;
          cachedFiltered = getTransformGlyphCache(filteredKey);
          if (!cachedFiltered) cachedRaster = getTransformGlyphCache(`r|${rasterKey}`);
          transformGlyphCacheRecordLookup(cachedFiltered !== null || cachedRaster !== null);
        }

        let fillRaster: RasterizedGlyph | null = null;
        let outlineRaster: RasterizedGlyph | null = null;
        // Set true when the corresponding raster below is drawn into a pooled
        // buffer (transient blur input only) so it can be released after the
        // blur produces its distinct output. Always false unless the raster is
        // provably private (adopt case) AND consumed by a blur.
        let poolFillRaster = false;
        let poolOutlineRaster = false;
        if (!cachedFiltered) {
          if (cachedRaster) {
            // Un-cloned on purpose: consumed only by fromRasterizedGlyph,
            // which copies.
            fillRaster = cachedRaster.fg;
            outlineRaster = cachedRaster.og;
          } else {
            // Base fill and stroked border paths are transform-independent and
            // cached; only perspective + rasterization runs per frame. Stroking
            // happens BEFORE the 3D transform (libass ass_render.c order).
            const basePath =
              basePathQ ??
              getCachedGlyphFillPath(
                item.font,
                glyphId,
                scaleX,
                scaleY,
                item.syntheticItalic,
                boldStrength,
              );
            if (!basePath) {
              penX = quantSubpixel(penX + advance);
              continue;
            }
            // Clip 3D-transformed glyph bitmaps to the frame plus a margin
            // for blur/shadow spread; without this a near-90deg projection
            // sizes the bitmap to gigabytes. Only applied on the transformed
            // branch (untransformed glyphs already sit in-frame).
            const transformClip = fillMatrixFinal
              ? {
                  minX: -TRANSFORM_BITMAP_MARGIN,
                  minY: -TRANSFORM_BITMAP_MARGIN,
                  maxX: frame.width + TRANSFORM_BITMAP_MARGIN,
                  maxY: frame.height + TRANSFORM_BITMAP_MARGIN,
                }
              : undefined;
            const glyphPath = fillMatrixFinal
              ? basePath.perspective(flipYMatrix3(fillMatrixFinal))
              : basePath;
            // Pool a raster only when it is provably private (rasterKey===null),
            // has no be-blur padding (pad===0, so the raster IS the direct
            // Gaussian/GPU-source input), and WILL be filtered. On the CPU path
            // the blur allocates a distinct output and the input is released
            // immediately. On the worker GPU-defer path, packFrameArena copies
            // the unfiltered source mask into the transfer arena and the worker
            // releases it after that copy. Cache/shared rasters are excluded.
            const rasterPoolable =
              rasterKey === null &&
              (!gpuProvider || poolFrameLocalBitmaps) &&
              bePadding(item.edgeBlur) === 0 &&
              (item.blurSigmaX > 0 || item.blurSigmaY > 0);
            poolFillRaster =
              rasterPoolable &&
              shouldBlurFill(item.borderStyle, borderMax);
            fillRaster = rasterizeFillFromPath(
              glyphPath,
              true,
              undefined,
              phaseX,
              phaseY,
              transformClip,
              poolFillRaster,
            );

            if (!useBox && borderMax > 0) {
              const strokePath =
                strokePathQ ??
                getCachedGlyphStrokePath(
                  item.font,
                  glyphId,
                  scaleX,
                  scaleY,
                  item.syntheticItalic,
                  boldStrength,
                  item.borderX,
                  item.borderY,
                );
              if (strokePath) {
                poolOutlineRaster = rasterPoolable;
                outlineRaster = rasterizeFillFromPath(
                  strokeMatrixFinal
                    ? strokePath.perspective(flipYMatrix3(strokeMatrixFinal))
                    : strokePath,
                  true,
                  FillRule.NonZero,
                  phaseX,
                  phaseY,
                  strokeMatrixFinal ? transformClip : undefined,
                  poolOutlineRaster,
                );
              }
            }
            if (rasterKey && fillRaster) {
              setTransformGlyphCache(`r|${rasterKey}`, fillRaster, outlineRaster);
            }
          }
        }

        if (fillRaster || cachedFiltered) {
          const pad = bePadding(item.edgeBlur);

          // Fill
          const blurSigmaX = item.blurSigmaX;
          const blurSigmaY = item.blurSigmaY;
          const blurFill = shouldBlurFill(item.borderStyle, borderMax);
          const fillOpaque =
            fillPrimaryFinal[3] === 255 && fillSecondaryFinal[3] === 255;
          const fillInBorder = borderMax > 0 && fillOpaque;
          const fillInShadow = itemFillInShadow(item, fillPrimaryFinal[3]);
          let deferItem = false;
          let fg: ReturnType<typeof cloneRasterGlyph>;
          let og: ReturnType<typeof cloneRasterGlyph> | null = null;
          if (cachedFiltered) {
            fg = cloneRasterGlyph(cachedFiltered.fg);
            og = cachedFiltered.og
              ? cloneRasterGlyph(cachedFiltered.og)
              : null;
            gpuDeferShared = null;
            gpuDeferVariant = null;
          } else {
            const baseFill = fillRaster!;
            // When the transform-glyph cache is asleep and no GPU provider is
            // active, fillRaster/outlineRaster were freshly rasterized this
            // frame, were NOT inserted into the "r|" cache (rasterKey===null =>
            // setTransformGlyphCache skipped above), and never become a
            // GPU-deferred mask (deferItem is always false without a provider,
            // qualifyGpuDefer returns false at its first line). They are
            // provably private, so the builder takes ownership instead of
            // copying. Byte-identical: pad/blur read the same bytes and the
            // eliminated copy fed only those consumers.
            const adoptRaster = rasterKey === null && !gpuProvider;
            const fillBase = adoptRaster
              ? pad > 0
                ? BitmapBuilder.adoptRasterizedGlyph(baseFill).pad(pad)
                : BitmapBuilder.adoptRasterizedGlyph(baseFill)
              : pad > 0
                ? BitmapBuilder.fromRasterizedGlyph(baseFill).pad(pad)
                : BitmapBuilder.fromRasterizedGlyph(baseFill);
            const outlineBase =
              outlineRaster && !useBox
                ? adoptRaster
                  ? pad > 0
                    ? BitmapBuilder.adoptRasterizedGlyph(outlineRaster).pad(pad)
                    : BitmapBuilder.adoptRasterizedGlyph(outlineRaster)
                  : pad > 0
                    ? BitmapBuilder.fromRasterizedGlyph(outlineRaster).pad(pad)
                    : BitmapBuilder.fromRasterizedGlyph(outlineRaster)
                : null;
            const fgBase = fillBase.intoRasterizedGlyph();
            deferItem = qualifyGpuDefer(
              item,
              useBox,
              fillInBorder,
              fillInShadow,
              blurFill,
              fgBase,
              px,
              karaokeSplitX,
            );
            fg =
              deferItem && blurFill
                ? gpuPhantomGlyph(fgBase, blurSigmaX, blurSigmaY)
                : (blurSigmaX > 0 || blurSigmaY > 0) && blurFill
                  ? applyLibassGaussianBlur(fgBase, blurSigmaX, blurSigmaY)
                  : fgBase;
            if (!deferItem && blurFill && item.edgeBlur > 0)
              applyBeBlur(fg.bitmap, item.edgeBlur);
            // The pooled fill raster fed only the blur, which allocated a
            // distinct output; the input buffer is now dead. The pointer guard
            // keeps it un-released if the blur ever returned its input.
            if (poolFillRaster && fg.bitmap.buffer !== fgBase.bitmap.buffer) {
              releaseBitmapBuffer(fgBase.bitmap.buffer);
            }

            // Outline
            let ogBaseForDesc: PhantomBase | null = null;
            if (outlineBase) {
              const ogBase = outlineBase.intoRasterizedGlyph();
              ogBaseForDesc = ogBase;
              og = deferItem
                ? gpuPhantomGlyph(ogBase, blurSigmaX, blurSigmaY)
                : blurSigmaX > 0 || blurSigmaY > 0
                  ? applyLibassGaussianBlur(ogBase, blurSigmaX, blurSigmaY)
                  : ogBase;
              if (!deferItem && og && item.edgeBlur > 0) applyBeBlur(og.bitmap, item.edgeBlur);
              // Same lifetime argument as the fill: the pooled outline raster is
              // dead once the blur produced its own output.
              if (
                poolOutlineRaster &&
                og &&
                og.bitmap.buffer !== ogBase.bitmap.buffer
              ) {
                releaseBitmapBuffer(ogBase.bitmap.buffer);
              }
            }
            // Snapshot BEFORE the per-frame outline punch: fixOutlineBitmap
            // depends on fade-varying alphas, so cached bytes stay pristine.
            if (filteredKey && !deferItem) {
              setTransformGlyphCache(
                filteredKey,
                cloneRasterGlyph(fg),
                og ? cloneRasterGlyph(og) : null,
              );
            }
            if (deferItem) {
              gpuDeferVariant = og
                ? fillInBorder && fillInShadow
                  ? "both"
                  : fillInShadow
                    ? "shadow"
                    : "none"
                : "fillonly";
              gpuDeferBlurFill = blurFill;
              gpuDeferShared = {
                groupId: gpuGroupCounter++,
                r2x: blurSigmaX * blurSigmaX,
                r2y: blurSigmaY * blurSigmaY,
                fillMask: fgBase.bitmap.buffer,
                fillW: fgBase.bitmap.width,
                fillH: fgBase.bitmap.rows,
                fillStride: fgBase.bitmap.pitch,
                outlineMask: ogBaseForDesc?.bitmap.buffer,
                outlineW: ogBaseForDesc?.bitmap.width,
                outlineH: ogBaseForDesc?.bitmap.rows,
                outlineStride: ogBaseForDesc?.bitmap.pitch,
                punchOX: og ? splitSubpixel(px + og.bearingX).i : undefined,
                punchOY: og ? splitSubpixel(py - og.bearingY).i : undefined,
                punchFX: og ? splitSubpixel(px + fg.bearingX).i : undefined,
                punchFY: og ? splitSubpixel(py - fg.bearingY).i : undefined,
              };
              if (poolFrameLocalBitmaps) {
                markFrameLocalBitmapBuffer(fgBase.bitmap.buffer);
                if (ogBaseForDesc) markFrameLocalBitmapBuffer(ogBaseForDesc.bitmap.buffer);
              }
            } else {
              gpuDeferShared = null;
              gpuDeferVariant = null;
            }
          }
          if (!deferItem && og && fg && item.borderStyle !== 3 && !fillInBorder && !fillInShadow) {
            fixOutlineBitmap(
              og,
              px + og.bearingX,
              py - og.bearingY,
              fg,
              px + fg.bearingX,
              py - fg.bearingY,
            );
          }

          if (!useBox) {
            const sxRaw = item.shadowXExplicit
              ? item.shadowX
              : item.shadow * item.shadowScaleX;
            const syRaw = item.shadowYExplicit
              ? item.shadowY
              : item.shadow * item.shadowScaleY;
            const sx = quantizeShadowOffset(sxRaw, item.shadowMaskX);
            const sy = quantizeShadowOffset(syRaw, item.shadowMaskY);
            if (sxRaw !== 0 || syRaw !== 0) {
              const sg = og ?? (fillInShadow ? fg : null);
              if (sg) {
                const shadowGlyph = cloneRasterGlyph(sg);
                if (!deferItem && og && fg && fillInBorder && !fillInShadow) {
                  fixOutlineBitmap(
                    shadowGlyph,
                    px + shadowGlyph.bearingX,
                    py - shadowGlyph.bearingY,
                    fg,
                    px + fg.bearingX,
                    py - fg.bearingY,
                  );
                }
                const layer = {
                  bitmap: shadowGlyph.bitmap.buffer,
                  width: shadowGlyph.bitmap.width,
                  height: shadowGlyph.bitmap.rows,
                  stride: shadowGlyph.bitmap.pitch,
                  originX: px + shadowGlyph.bearingX + sx,
                  originY: py - shadowGlyph.bearingY + sy,
                  color: shadowColor,
                  z: ev.layer,
                  clip: clip ?? undefined,
                } as BitmapLayer;
                pushLayer(layer, "shadow", item, pad, undefined, glyphMeta, "shadow");
              }
            }
          }

          if (!deferItem && og && fg && item.borderStyle !== 3 && !fillInBorder && fillInShadow) {
            fixOutlineBitmap(
              og,
              px + og.bearingX,
              py - og.bearingY,
              fg,
              px + fg.bearingX,
              py - fg.bearingY,
            );
          }

          if (og && karaokeOutlineEnabled) {
            const layer = {
              bitmap: og.bitmap.buffer,
              width: og.bitmap.width,
              height: og.bitmap.rows,
              stride: og.bitmap.pitch,
              originX: px + og.bearingX,
              originY: py - og.bearingY,
              color: outlineColor,
              z: ev.layer,
              clip: clip ?? undefined,
            } as BitmapLayer;
            pushLayer(layer, "outline", item, pad, undefined, glyphMeta, "outline");
          }

          const fgOriginX = px + fg.bearingX;
          const fgOriginY = py - fg.bearingY;
          if (karaokeSplitX !== null) {
            const left = Math.round(fgOriginX);
            const right = left + fg.bitmap.width;
            if (karaokeSplitX <= left) {
              const layer = {
                bitmap: fg.bitmap.buffer,
                width: fg.bitmap.width,
                height: fg.bitmap.rows,
                stride: fg.bitmap.pitch,
                originX: fgOriginX,
                originY: fgOriginY,
                color: fillSecondaryFinal,
                z: ev.layer,
                clip: clip ?? undefined,
              } as BitmapLayer;
              pushLayer(layer, "fill", item, pad, undefined, glyphMeta, "fillSecondary");
            } else if (karaokeSplitX >= right) {
              const layer = {
                bitmap: fg.bitmap.buffer,
                width: fg.bitmap.width,
                height: fg.bitmap.rows,
                stride: fg.bitmap.pitch,
                originX: fgOriginX,
                originY: fgOriginY,
                color: fillPrimaryFinal,
                z: ev.layer,
                clip: clip ?? undefined,
              } as BitmapLayer;
              pushLayer(layer, "fill", item, pad, undefined, glyphMeta, "fillPrimary");
            } else {
              const leftLayer = {
                bitmap: fg.bitmap.buffer,
                width: fg.bitmap.width,
                height: fg.bitmap.rows,
                stride: fg.bitmap.pitch,
                originX: fgOriginX,
                originY: fgOriginY,
                color: fillPrimaryFinal,
                z: ev.layer,
                clip: clip ?? undefined,
              } as BitmapLayer;
              pushLayer(
                leftLayer,
                "fill",
                item,
                pad,
                {
                  type: "rect",
                  x0: -KARAOKE_CLIP_INF,
                  y0: -KARAOKE_CLIP_INF,
                  x1: karaokeSplitX,
                  y1: KARAOKE_CLIP_INF,
                  inverse: false,
                },
                glyphMeta,
                "fillPrimary",
              );
              const rightLayer = {
                bitmap: fg.bitmap.buffer,
                width: fg.bitmap.width,
                height: fg.bitmap.rows,
                stride: fg.bitmap.pitch,
                originX: fgOriginX,
                originY: fgOriginY,
                color: fillSecondaryFinal,
                z: ev.layer,
                clip: clip ?? undefined,
              } as BitmapLayer;
              pushLayer(
                rightLayer,
                "fill",
                item,
                pad,
                {
                  type: "rect",
                  x0: karaokeSplitX,
                  y0: -KARAOKE_CLIP_INF,
                  x1: KARAOKE_CLIP_INF,
                  y1: KARAOKE_CLIP_INF,
                  inverse: false,
                },
                glyphMeta,
                "fillSecondary",
              );
            }
          } else {
            const layer = {
              bitmap: fg.bitmap.buffer,
              width: fg.bitmap.width,
              height: fg.bitmap.rows,
              stride: fg.bitmap.pitch,
              originX: fgOriginX,
              originY: fgOriginY,
              color: fillSolidFinal,
              z: ev.layer,
              clip: clip ?? undefined,
            } as BitmapLayer;
            pushLayer(layer, "fill", item, pad, undefined, glyphMeta, "fillSolid");
          }
        }

        gpuDeferShared = null;
        gpuDeferVariant = null;
        penX = quantSubpixel(penX + advance);
      }
    }

    // Underline / strikeout lines (per line, after glyph rendering)
    if (lineWidth > 0) {
      let maxUnderlineThickness = 0;
      let maxStrikeoutThickness = 0;
      let underlinePos: number | null = null;
      let strikeoutPos: number | null = null;
      let underlineColor: ColorRGBA | null = null;
      let strikeoutColor: ColorRGBA | null = null;
      let underlineItemIndex = -1;
      let strikeoutItemIndex = -1;

      for (let ii = 0; ii < line.items.length; ii++) {
        const item = line.items[ii]!;
        if (item.underline) {
          maxUnderlineThickness = Math.max(
            maxUnderlineThickness,
            item.underlineThickness * item.scaleY,
          );
          const pos = item.underlinePos * item.scaleY;
          underlinePos =
            underlinePos === null ? pos : Math.min(underlinePos, pos);
          underlineColor = item.primaryColor;
          underlineItemIndex = ii;
        }
        if (item.strikeout) {
          maxStrikeoutThickness = Math.max(
            maxStrikeoutThickness,
            item.strikeoutThickness * item.scaleY,
          );
          const pos = item.strikeoutPos * item.scaleY;
          strikeoutPos =
            strikeoutPos === null ? pos : Math.min(strikeoutPos, pos);
          strikeoutColor = item.primaryColor;
          strikeoutItemIndex = ii;
        }
      }

      const drawLine = (
        yPos: number,
        thickness: number,
        color: ColorRGBA | null,
        itemIndex: number,
      ) => {
        if (!color || thickness <= 0) return;
        if (itemIndex < 0) return;
        const anchorItem = line.items[itemIndex];
        if (!anchorItem) return;
        const height = Math.max(1, Math.round(Math.abs(thickness)));
        const width = Math.max(1, Math.ceil(lineWidth));
        const buffer = new Uint8Array(width * height);
        if ((globalThis as any).__SUBFRAME_ALLOC_CENSUS__)
          recordAllocCensus("solid.line.alloc", buffer.length);
        buffer.fill(255);
        const bitmap = {
          buffer,
          width,
          rows: height,
          pitch: width,
          pixelMode: PixelMode.Gray,
          numGrays: 256,
        };
        const builder = BitmapBuilder.fromBitmap(bitmap);
        const glyph = builder.toRasterizedGlyph();
        const layer = {
          bitmap: glyph.bitmap.buffer,
          width: glyph.bitmap.width,
          height: glyph.bitmap.rows,
          stride: glyph.bitmap.pitch,
          originX: xStart + glyph.bearingX,
          originY: yPos - glyph.bearingY,
          color,
          z: ev.layer,
          clip: clip ?? undefined,
        } as BitmapLayer;
        cacheItemIndex = itemIndex;
        pushLayer(layer, "fill", anchorItem, 0, undefined, undefined, "fillSolid");
      };

      if (maxUnderlineThickness > 0 && underlinePos !== null) {
        const yPos = baselineY - underlinePos;
        drawLine(yPos, maxUnderlineThickness, underlineColor, underlineItemIndex);
      }
      if (maxStrikeoutThickness > 0 && strikeoutPos !== null) {
        const yPos = baselineY - strikeoutPos;
        drawLine(yPos, maxStrikeoutThickness, strikeoutColor, strikeoutItemIndex);
      }
    }

    penY = quantSubpixel(penY + line.height);
  }


}
