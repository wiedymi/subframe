import type { SubtitleDocument, SubtitleEvent } from "subforge/core";
import type { GlyphBuffer } from "text-shaper";
import type { FrameContext, BitmapLayer } from "../data/types";
import type { TraceContext, TraceEvent } from "../trace";
import { startTraceEvent } from "../trace";
import type { ShapeContext } from "../shape/shaper";
import { buildEventLayout, type EventLayoutResult } from "../layout/event";
import { renderEventLines, type CacheLayerTemplate } from "../raster/event";
import type { ColorRGBA } from "../data/types";
import { applyAnimateColors } from "../animate/apply";
import { applyFade, fadeFactorComplex, fadeFactorSimple } from "../animate/fade";
import { addLayoutMs, addRasterMs, isProfiling, profileNow } from "../profile";

type CachedEntry =
  | {
      mode: "static";
      key: string;
      text: string;
      layers: BitmapLayer[];
      bytes: number;
      layerCount: number;
      hit: boolean;
    }
  | {
      mode: "tint";
      key: string;
      text: string;
      templates: CacheLayerTemplate[];
      bytes: number;
      layerCount: number;
      hit: boolean;
    };

// Dense typeset scripts keep >10k short-lived events alive within a few
// seconds (e.g. Beastars); a small entry cap causes eviction churn long
// before the byte budget is reached, so let bytes be the limiting factor.
// Frame-level dedup and boundary parking now carry the real-time path, while
// event-layer cache usage stays in the low MBs on measured fixtures. Keep the
// default main-realm ceiling modest; limits are ceilings, not preallocations.
// Entry cap sized so bytes stay the limiting factor even at the adaptive
// ceiling (dense scripts average ~60KB/entry; 64MB / 60KB ≈ 1k entries).
let EVENT_LAYER_CACHE_LIMIT = 32768;
let EVENT_LAYER_CACHE_BYTES_BASE = 64 * 1024 * 1024;
// Ceiling equals the base so the shipped main-thread cache cannot grow past
// the measured memory budget without an explicit caller override.
let EVENT_LAYER_CACHE_BYTES_CEILING = 64 * 1024 * 1024;
let EVENT_LAYER_CACHE_BYTES_LIMIT = EVENT_LAYER_CACHE_BYTES_BASE;
// Grow once this many never-hit entries were evicted since the last growth
// (or since the limits were last configured).
const EVENT_LAYER_GROW_THRESHOLD = 16;
const EVENT_LAYER_GROW_STEP_BYTES = 64 * 1024 * 1024;
const EVENT_LAYER_CACHE = new Map<SubtitleEvent, CachedEntry>();

// Events whose cache entry was evicted while the event could still come back
// (its entry had been inserted and later dropped). A subsequent cache MISS on
// such an event is the direct signature of thrashing: the working set does
// not fit the current byte limit. Together with never-hit evictions (prewarm
// output dying before its first read) this drives adaptive growth.
const EVENT_LAYER_EVICTED_EVENTS = new WeakSet<SubtitleEvent>();
const EVENT_LAYER_THRASH_THRESHOLD = 8;
let eventLayerThrashMisses = 0;
let eventLayerThrashMissWindow = 0;

// Grow the effective byte limit toward the ceiling when eviction pressure
// says the working set does not fit: either entries die before their first
// read, or previously-evicted events miss again. Returns whether the limit
// grew (callers re-check their eviction condition).
function maybeGrowEventLayerBytesLimit(): boolean {
  if (EVENT_LAYER_CACHE_BYTES_LIMIT >= EVENT_LAYER_CACHE_BYTES_CEILING) return false;
  if (
    eventLayerNeverHitEvictionWindow < EVENT_LAYER_GROW_THRESHOLD &&
    eventLayerThrashMissWindow < EVENT_LAYER_THRASH_THRESHOLD
  ) {
    return false;
  }
  EVENT_LAYER_CACHE_BYTES_LIMIT = Math.min(
    EVENT_LAYER_CACHE_BYTES_CEILING,
    Math.max(
      EVENT_LAYER_CACHE_BYTES_LIMIT + EVENT_LAYER_GROW_STEP_BYTES,
      Math.round(EVENT_LAYER_CACHE_BYTES_LIMIT * 1.25),
    ),
  );
  eventLayerNeverHitEvictionWindow = 0;
  eventLayerThrashMissWindow = 0;
  return true;
}

// Unconditional growth step (still ceiling-bounded), used when eviction would
// otherwise destroy an entry whose event has not ended yet: with a live
// playhead that entry is either active or a prewarmed future event awaiting
// its first read, and evicting it converts finished worker output into a
// guaranteed deadline miss. Growing first is strictly better while headroom
// remains.
function growEventLayerBytesLimitForLiveEntry(): boolean {
  if (EVENT_LAYER_CACHE_BYTES_LIMIT >= EVENT_LAYER_CACHE_BYTES_CEILING) return false;
  EVENT_LAYER_CACHE_BYTES_LIMIT = Math.min(
    EVENT_LAYER_CACHE_BYTES_CEILING,
    Math.max(
      EVENT_LAYER_CACHE_BYTES_LIMIT + EVENT_LAYER_GROW_STEP_BYTES,
      Math.round(EVENT_LAYER_CACHE_BYTES_LIMIT * 1.25),
    ),
  );
  eventLayerNeverHitEvictionWindow = 0;
  eventLayerThrashMissWindow = 0;
  return true;
}

// Called on a cache miss: if this event's entry was evicted earlier, the miss
// is re-render churn caused by the byte limit, not first-time work.
function noteEventLayerMiss(ev: SubtitleEvent): void {
  if (!EVENT_LAYER_EVICTED_EVENTS.has(ev)) return;
  EVENT_LAYER_EVICTED_EVENTS.delete(ev);
  eventLayerThrashMisses++;
  eventLayerThrashMissWindow++;
  if (
    eventLayerThrashMissWindow >= EVENT_LAYER_THRASH_THRESHOLD &&
    eventLayerCacheBytes > EVENT_LAYER_CACHE_BYTES_LIMIT - EVENT_LAYER_GROW_STEP_BYTES
  ) {
    maybeGrowEventLayerBytesLimit();
  }
}

// Mutable ceilings so a memory budget (or the worker realm, which needs almost
// none of this) can resize the dominant cache. Limits/stats only -- no
// rendering-semantics change. `bytes` sets the adaptive BASE; `bytesCeiling`
// caps the adaptive growth and defaults to the base itself (no growth) so an
// explicit budget is honored unless the caller opts into headroom. Shrinking
// evicts down to the new ceiling immediately (oldest-first, matching
// cacheInsert).
export function setEventLayerCacheLimits(limits: {
  entries?: number;
  bytes?: number;
  bytesCeiling?: number;
}): void {
  if (limits.entries !== undefined) EVENT_LAYER_CACHE_LIMIT = Math.max(0, limits.entries);
  if (limits.bytes !== undefined) {
    EVENT_LAYER_CACHE_BYTES_BASE = Math.max(0, limits.bytes);
    EVENT_LAYER_CACHE_BYTES_CEILING = Math.max(
      EVENT_LAYER_CACHE_BYTES_BASE,
      limits.bytesCeiling !== undefined ? Math.max(0, limits.bytesCeiling) : EVENT_LAYER_CACHE_BYTES_BASE,
    );
    EVENT_LAYER_CACHE_BYTES_LIMIT = EVENT_LAYER_CACHE_BYTES_BASE;
    eventLayerNeverHitEvictionWindow = 0;
    eventLayerThrashMissWindow = 0;
  } else if (limits.bytesCeiling !== undefined) {
    EVENT_LAYER_CACHE_BYTES_CEILING = Math.max(EVENT_LAYER_CACHE_BYTES_BASE, Math.max(0, limits.bytesCeiling));
    if (EVENT_LAYER_CACHE_BYTES_LIMIT > EVENT_LAYER_CACHE_BYTES_CEILING) {
      EVENT_LAYER_CACHE_BYTES_LIMIT = EVENT_LAYER_CACHE_BYTES_CEILING;
    }
  }
  while (
    EVENT_LAYER_CACHE.size > 0 &&
    (EVENT_LAYER_CACHE.size > EVENT_LAYER_CACHE_LIMIT ||
      eventLayerCacheBytes > EVENT_LAYER_CACHE_BYTES_LIMIT)
  ) {
    const first = EVENT_LAYER_CACHE.keys().next();
    if (first.done) break;
    const removed = EVENT_LAYER_CACHE.get(first.value);
    if (removed) {
      eventLayerCacheBytes -= removed.bytes;
      eventLayerCacheLayers -= removed.layerCount;
      eventLayerCacheEvictions++;
    }
    EVENT_LAYER_CACHE.delete(first.value);
  }
}
let eventLayerCacheBytes = 0;
let eventLayerCacheLayers = 0;
let eventLayerCacheHits = 0;
let eventLayerCacheMisses = 0;
let eventLayerCacheEvictions = 0;
let eventLayerNeverHitEvictions = 0;
let eventLayerNeverHitEvictionWindow = 0;
const FULLY_STATIC_EVENT_VERDICT = new WeakMap<SubtitleEvent, boolean>();

export function recordEventFullyStaticVerdict(
  ev: SubtitleEvent,
  fullyStatic: boolean,
): void {
  FULLY_STATIC_EVENT_VERDICT.set(ev, fullyStatic && !ev.dirty);
}

export function recordEventOrdinalStaticVerdicts(
  activeEvents: readonly SubtitleEvent[],
  staticOrdinals?: Int32Array,
  nonStaticOrdinals?: Int32Array,
): void {
  if (staticOrdinals) {
    for (let i = 0; i < staticOrdinals.length; i++) {
      const ev = activeEvents[staticOrdinals[i]!];
      if (ev) recordEventFullyStaticVerdict(ev, true);
    }
  }
  if (nonStaticOrdinals) {
    for (let i = 0; i < nonStaticOrdinals.length; i++) {
      const ev = activeEvents[nonStaticOrdinals[i]!];
      if (ev) recordEventFullyStaticVerdict(ev, false);
    }
  }
}

export function isEventFullyStaticForFrameDedup(ev: SubtitleEvent): boolean {
  return !ev.dirty && FULLY_STATIC_EVENT_VERDICT.get(ev) === true;
}

function cacheEntryBytes(layers: Array<{ bitmap: Uint8Array }>): number {
  let total = 0;
  for (let i = 0; i < layers.length; i++) {
    const bitmap = layers[i]!.bitmap;
    total += bitmap.buffer.byteLength;
  }
  return total;
}

function cacheTouch(ev: SubtitleEvent, entry: CachedEntry): void {
  EVENT_LAYER_CACHE.delete(ev);
  EVENT_LAYER_CACHE.set(ev, entry);
}

// Temporal-aware eviction choice: prefer the oldest entry whose event already
// ENDED (ev.end <= playhead) — it can only be needed again on a seek — over
// the plain LRU head, which under prewarm pressure can be a FUTURE event whose
// first read has not happened yet (evicting it guarantees a deadline miss and
// throws away worker output). Ended events stop being touched and migrate to
// the LRU head within their own lifetime, so a short bounded scan finds one
// whenever one exists; with no playhead information (liveMediaMs < 0, e.g.
// batch tools) this degrades to plain LRU.
const EVICTION_SCAN_LIMIT = 64;

function pickEvictionKey(): SubtitleEvent | null {
  const iter = EVENT_LAYER_CACHE.keys();
  const first = iter.next();
  if (first.done) return null;
  if (liveMediaMs >= 0) {
    let key = first.value;
    let scanned = 1;
    for (;;) {
      if (key.end <= liveMediaMs) return key;
      if (scanned >= EVICTION_SCAN_LIMIT) break;
      const n = iter.next();
      if (n.done) break;
      key = n.value;
      scanned++;
    }
  }
  return first.value;
}

function cacheInsert(ev: SubtitleEvent, entry: CachedEntry): void {
  const existing = EVENT_LAYER_CACHE.get(ev);
  if (existing) {
    eventLayerCacheBytes -= existing.bytes;
    eventLayerCacheLayers -= existing.layerCount;
    EVENT_LAYER_CACHE.delete(ev);
  }
  EVENT_LAYER_CACHE.set(ev, entry);
  eventLayerCacheBytes += entry.bytes;
  eventLayerCacheLayers += entry.layerCount;
  while (
    EVENT_LAYER_CACHE.size > EVENT_LAYER_CACHE_LIMIT ||
    eventLayerCacheBytes > EVENT_LAYER_CACHE_BYTES_LIMIT
  ) {
    // Byte-bound with growth headroom left: raise the limit instead of
    // throwing away entries that were never read (prewarm output dying
    // before its deadline).
    if (
      eventLayerCacheBytes > EVENT_LAYER_CACHE_BYTES_LIMIT &&
      EVENT_LAYER_CACHE.size <= EVENT_LAYER_CACHE_LIMIT &&
      maybeGrowEventLayerBytesLimit()
    ) {
      continue;
    }
    const key = pickEvictionKey();
    if (key === null) break;
    // No ended entry to reclaim and byte-bound: grow toward the ceiling
    // rather than evicting an entry that is still active or awaiting its
    // first read (see growEventLayerBytesLimitForLiveEntry).
    if (
      liveMediaMs >= 0 &&
      key.end > liveMediaMs &&
      eventLayerCacheBytes > EVENT_LAYER_CACHE_BYTES_LIMIT &&
      EVENT_LAYER_CACHE.size <= EVENT_LAYER_CACHE_LIMIT &&
      growEventLayerBytesLimitForLiveEntry()
    ) {
      continue;
    }
    const removed = EVENT_LAYER_CACHE.get(key);
    if (removed) {
      eventLayerCacheBytes -= removed.bytes;
      eventLayerCacheLayers -= removed.layerCount;
      EVENT_LAYER_CACHE.delete(key);
      eventLayerCacheEvictions++;
      EVENT_LAYER_EVICTED_EVENTS.add(key);
      if (!removed.hit) {
        eventLayerNeverHitEvictions++;
        eventLayerNeverHitEvictionWindow++;
      }
      if (FUNNEL_ENABLED) funnelNoteEvicted(key, removed.hit);
    } else {
      EVENT_LAYER_CACHE.delete(key);
    }
  }
}

export function getEventLayerCacheStats(): {
  entries: number;
  layers: number;
  bytes: number;
  hits: number;
  misses: number;
  evictions: number;
  neverHitEvictions: number;
  thrashMisses: number;
  limitEntries: number;
  limitBytes: number;
  limitBytesBase: number;
  limitBytesCeiling: number;
} {
  return {
    entries: EVENT_LAYER_CACHE.size,
    layers: eventLayerCacheLayers,
    bytes: eventLayerCacheBytes,
    hits: eventLayerCacheHits,
    misses: eventLayerCacheMisses,
    evictions: eventLayerCacheEvictions,
    neverHitEvictions: eventLayerNeverHitEvictions,
    thrashMisses: eventLayerThrashMisses,
    limitEntries: EVENT_LAYER_CACHE_LIMIT,
    limitBytes: EVENT_LAYER_CACHE_BYTES_LIMIT,
    limitBytesBase: EVENT_LAYER_CACHE_BYTES_BASE,
    limitBytesCeiling: EVENT_LAYER_CACHE_BYTES_CEILING,
  };
}

// ---------------------------------------------------------------------------
// Prewarm funnel instrumentation (opt-in: SUBFRAME_FUNNEL=1).
//
// Traces every prewarm candidate through
//   candidate -> dispatched -> completed -> inserted -> first deadline read
// so scheduling losses are attributable to a precise stage. Entirely additive:
// with the env flag unset every hook is a single boolean check and no record
// is ever allocated. Never enabled on the render hot path in production.
const FUNNEL_ENABLED =
  ((globalThis as any)?.process?.env?.SUBFRAME_FUNNEL ?? "") === "1";

export type FunnelOutcome =
  | "HIT_IN_TIME"
  | "INSERTED_LATE"
  | "EVICTED_BEFORE_USE"
  | "NEVER_DISPATCHED"
  | "IN_FLIGHT_AT_DEADLINE"
  | "COMPLETED_NOT_INSERTED"
  | "NOT_CACHEABLE"
  | "NEVER_CANDIDATE"
  | "NEVER_READ";

type FunnelRec = {
  start: number;
  end: number;
  candWall: number; // -1: first seen on the deadline path, never a candidate
  candMedia: number;
  dispWall: number;
  dispMedia: number;
  gateSkips: number;
  doneWall: number; // main-thread arrival of the worker result
  insWall: number; // insertion into the event-layer cache (prewarm path only)
  insMedia: number;
  bytes: number;
  notCacheable: boolean;
  firstRead: 0 | 1 | 2; // deadline path: 0 unread, 1 hit, 2 miss
  firstReadWall: number;
  missRenderMs: number; // cold render cost paid on the miss frame (post-layout)
  ncRenderMs: number; // cumulative live render cost of a not-cacheable event
  ncFrames: number;
  evictedNeverHitWall: number;
  evictions: number;
};

const funnelRecs = new Map<SubtitleEvent, FunnelRec>();
let funnelMedia = -1;

function newFunnelRec(ev: SubtitleEvent, candidate: boolean): FunnelRec {
  const rec: FunnelRec = {
    start: ev.start,
    end: ev.end,
    candWall: candidate ? performance.now() : -1,
    candMedia: candidate ? funnelMedia : -1,
    dispWall: -1,
    dispMedia: -1,
    gateSkips: 0,
    doneWall: -1,
    insWall: -1,
    insMedia: -1,
    bytes: 0,
    notCacheable: false,
    firstRead: 0,
    firstReadWall: -1,
    missRenderMs: 0,
    ncRenderMs: 0,
    ncFrames: 0,
    evictedNeverHitWall: -1,
    evictions: 0,
  };
  funnelRecs.set(ev, rec);
  return rec;
}

function funnelRecFor(ev: SubtitleEvent, candidate: boolean): FunnelRec {
  const rec = funnelRecs.get(ev);
  if (rec) {
    if (candidate && rec.candWall < 0) {
      rec.candWall = performance.now();
      rec.candMedia = funnelMedia;
    }
    return rec;
  }
  return newFunnelRec(ev, candidate);
}

// Called by renderFrame with the live playhead. Drives temporal-aware cache
// eviction (prefer evicting events that already ENDED over future prewarmed
// entries) and, when enabled, stamps funnel records with media time.
let liveMediaMs = -1;

export function noteFrameMediaTime(timeMs: number): void {
  liveMediaMs = timeMs;
  if (FUNNEL_ENABLED) funnelMedia = timeMs;
}

// The consumer's clock: the media time of the most recent renderFrame call.
// Boundary-prewarm scheduling must judge slot staleness against THIS, never
// against another slot's own (future) boundary time.
export function lastFrameMediaTimeMs(): number {
  return liveMediaMs;
}

export function funnelNoteCandidates(events: SubtitleEvent[]): void {
  if (!FUNNEL_ENABLED) return;
  for (let i = 0; i < events.length; i++) funnelRecFor(events[i]!, true);
}

export function funnelNoteGateSkip(ev: SubtitleEvent): void {
  if (!FUNNEL_ENABLED) return;
  funnelRecFor(ev, true).gateSkips++;
}

export function funnelNoteDispatched(ev: SubtitleEvent): void {
  if (!FUNNEL_ENABLED) return;
  const rec = funnelRecFor(ev, true);
  if (rec.dispWall < 0) {
    rec.dispWall = performance.now();
    rec.dispMedia = funnelMedia;
  }
}

export function funnelNoteCompleted(ev: SubtitleEvent, ok: boolean, reason?: string): void {
  if (!FUNNEL_ENABLED) return;
  const rec = funnelRecFor(ev, true);
  if (rec.doneWall < 0) rec.doneWall = performance.now();
  if (!ok && reason === "not-cacheable") rec.notCacheable = true;
}

function funnelNoteInserted(ev: SubtitleEvent, bytes: number): void {
  const rec = funnelRecs.get(ev);
  if (!rec) return;
  if (rec.insWall < 0) {
    rec.insWall = performance.now();
    rec.insMedia = funnelMedia;
  }
  rec.bytes = bytes;
}

function funnelNoteEvicted(ev: SubtitleEvent, wasHit: boolean): void {
  const rec = funnelRecs.get(ev);
  if (!rec) return;
  rec.evictions++;
  if (!wasHit && rec.firstRead === 0 && rec.evictedNeverHitWall < 0) {
    rec.evictedNeverHitWall = performance.now();
  }
}

function funnelOutcome(rec: FunnelRec): FunnelOutcome {
  if (rec.notCacheable) return "NOT_CACHEABLE";
  if (rec.firstRead === 1) return "HIT_IN_TIME";
  if (rec.firstRead === 2) {
    if (rec.candWall < 0) return "NEVER_CANDIDATE";
    if (rec.evictedNeverHitWall >= 0 && rec.evictedNeverHitWall <= rec.firstReadWall) {
      return "EVICTED_BEFORE_USE";
    }
    if (rec.dispWall < 0) return "NEVER_DISPATCHED";
    if (rec.doneWall < 0) return "IN_FLIGHT_AT_DEADLINE";
    if (rec.insWall < 0) return "COMPLETED_NOT_INSERTED";
    return "INSERTED_LATE";
  }
  return "NEVER_READ";
}

export function getPrewarmFunnelStats(): {
  enabled: boolean;
  total: number;
  outcomes: Record<string, number>;
  gateSkipEvents: number;
  missRenderMsTotal: number;
  ncRenderMsTotal: number;
} {
  const outcomes: Record<string, number> = {};
  let gateSkipEvents = 0;
  let missRenderMsTotal = 0;
  let ncRenderMsTotal = 0;
  for (const rec of funnelRecs.values()) {
    const o = funnelOutcome(rec);
    outcomes[o] = (outcomes[o] ?? 0) + 1;
    if (rec.gateSkips > 0) gateSkipEvents++;
    missRenderMsTotal += rec.missRenderMs;
    ncRenderMsTotal += rec.ncRenderMs;
  }
  return {
    enabled: FUNNEL_ENABLED,
    total: funnelRecs.size,
    outcomes,
    gateSkipEvents,
    missRenderMsTotal,
    ncRenderMsTotal,
  };
}

// Full per-event dump for offline analysis (working-set measurement, lead-time
// histograms). Plain objects only.
export function getPrewarmFunnelDump(): Array<
  {
    outcome: FunnelOutcome;
  } & Omit<FunnelRec, never>
> {
  const out: Array<{ outcome: FunnelOutcome } & FunnelRec> = [];
  for (const rec of funnelRecs.values()) {
    out.push({ outcome: funnelOutcome(rec), ...rec });
  }
  return out;
}

export function clearPrewarmFunnel(): void {
  funnelRecs.clear();
  funnelMedia = -1;
}

export function clearEventLayerCache(): void {
  EVENT_LAYER_CACHE.clear();
  eventLayerCacheBytes = 0;
  eventLayerCacheLayers = 0;
  eventLayerCacheHits = 0;
  eventLayerCacheMisses = 0;
  eventLayerCacheEvictions = 0;
  eventLayerNeverHitEvictions = 0;
  eventLayerNeverHitEvictionWindow = 0;
  eventLayerThrashMisses = 0;
  eventLayerThrashMissWindow = 0;
  EVENT_LAYER_CACHE_BYTES_LIMIT = EVENT_LAYER_CACHE_BYTES_BASE;
}

function pushCachedLayers(target: BitmapLayer[], cached: BitmapLayer[]): void {
  for (let i = 0; i < cached.length; i++) {
    const layer = cached[i]!;
    target[target.length] = {
      bitmap: layer.bitmap,
      width: layer.width,
      height: layer.height,
      stride: layer.stride,
      originX: layer.originX,
      originY: layer.originY,
      color: layer.color,
      z: layer.z,
      clip: layer.clip,
    };
  }
}

type ResolvedColors = {
  fillSolid: ColorRGBA;
  fillPrimary: ColorRGBA;
  fillSecondary: ColorRGBA;
  outline: ColorRGBA;
  shadow: ColorRGBA;
};

function resolveItemColors(
  ev: SubtitleEvent,
  item: {
    primaryColor: ColorRGBA;
    secondaryColor: ColorRGBA;
    outlineColor: ColorRGBA;
    shadowColor: ColorRGBA;
    animates: Array<any>;
    fadeFactor: number;
    fadeSimple?: { in: number; out: number } | null;
    fadeComplex?: {
      alphas: [number, number, number];
      times: [number, number, number, number];
    } | null;
  },
  timeMs: number,
): ResolvedColors {
  let primary = item.primaryColor;
  let secondary = item.secondaryColor;
  let outline = item.outlineColor;
  let shadow = item.shadowColor;
  if (item.animates.length > 0) {
    const colorState = {
      primary: [primary[0], primary[1], primary[2], primary[3]] as ColorRGBA,
      secondary: [secondary[0], secondary[1], secondary[2], secondary[3]] as ColorRGBA,
      outline: [outline[0], outline[1], outline[2], outline[3]] as ColorRGBA,
      shadow: [shadow[0], shadow[1], shadow[2], shadow[3]] as ColorRGBA,
    };
    applyAnimateColors(colorState, item.animates, timeMs, ev);
    primary = colorState.primary;
    secondary = colorState.secondary;
    outline = colorState.outline;
    shadow = colorState.shadow;
  }
  const fade = item.fadeComplex
    ? fadeFactorComplex(timeMs, ev, item.fadeComplex)
    : item.fadeSimple
      ? fadeFactorSimple(timeMs, ev, item.fadeSimple.in, item.fadeSimple.out)
      : item.fadeFactor ?? 1;
  return {
    fillSolid: applyFade(primary, fade),
    fillPrimary: applyFade(primary, fade),
    fillSecondary: applyFade(secondary, fade),
    outline: applyFade(outline, fade),
    shadow: applyFade(shadow, fade),
  };
}

function colorForRole(colors: ResolvedColors, role: CacheLayerTemplate["role"]): ColorRGBA {
  switch (role) {
    case "fillPrimary":
      return colors.fillPrimary;
    case "fillSecondary":
      return colors.fillSecondary;
    case "outline":
      return colors.outline;
    case "shadow":
      return colors.shadow;
    case "box":
      return colors.outline;
    default:
      return colors.fillSolid;
  }
}

function pushTintCachedLayers(
  target: BitmapLayer[],
  templates: CacheLayerTemplate[],
  lines: Array<{ items: any[] }>,
  ev: SubtitleEvent,
  timeMs: number,
): void {
  const colorCache: Array<Array<ResolvedColors | null>> = [];
  for (let i = 0; i < templates.length; i++) {
    const t = templates[i]!;
    const line = lines[t.lineIndex];
    if (!line) continue;
    const items = line.items;
    const item = items[t.itemIndex];
    if (!item) continue;
    let perLine = colorCache[t.lineIndex];
    if (!perLine) {
      perLine = [];
      colorCache[t.lineIndex] = perLine;
    }
    let colors = perLine[t.itemIndex];
    if (!colors) {
      colors = resolveItemColors(ev, item, timeMs);
      perLine[t.itemIndex] = colors;
    }
    const color = colorForRole(colors, t.role);
    target[target.length] = {
      bitmap: t.bitmap,
      width: t.width,
      height: t.height,
      stride: t.stride,
      originX: t.originX,
      originY: t.originY,
      color,
      z: t.z,
    };
  }
}

// Maps a resolved layout onto renderEventLines. Shared by the live frame path
// and the worker prewarm path so both produce byte-identical layers/templates.
function pushEventLayers(
  ev: SubtitleEvent,
  frame: FrameContext,
  timeMs: number,
  layout: EventLayoutResult,
  parScaleX: number,
  layers: BitmapLayer[],
  traceEvent: TraceEvent | null,
  cacheTemplates: CacheLayerTemplate[] | undefined,
  suppressGpuDefer: boolean,
): void {
  renderEventLines({
    ev,
    frame,
    timeMs,
    lines: layout.lines,
    align: layout.align,
    posX: layout.posX,
    posY: layout.posY,
    marginL: layout.marginL,
    marginR: layout.marginR,
    blockAnchorX: layout.blockAnchorX,
    blockAnchorY: layout.blockAnchorY,
    topY: layout.topY,
    clip: layout.clip,
    parScaleX,
    safeScreenScaleXPar: layout.safeScreenScaleXPar,
    safeScreenScaleY: layout.safeScreenScaleY,
    safeBlurScaleX: layout.safeBlurScaleX,
    safeBlurScaleY: layout.safeBlurScaleY,
    layers,
    traceEvent,
    cacheTemplates,
    suppressGpuDefer,
  });
}

function buildCachedEntry(
  ev: SubtitleEvent,
  cacheKey: string,
  cacheMode: "static" | "tint",
  layers: BitmapLayer[],
  cacheStart: number,
  cacheTemplates: CacheLayerTemplate[] | undefined,
): CachedEntry | null {
  // Never cache an event that produced GPU-deferred layers: those carry the
  // UNFILTERED source mask with phantom dims plus a per-frame groupId, so reusing
  // them across frames would composite unfiltered pixels and desync group ids.
  // Such events re-render each frame (they are the animated/blur cases anyway).
  for (let i = cacheStart; i < layers.length; i++) {
    if (layers[i]!.gpuFilter) return null;
  }
  if (cacheMode === "static") {
    const cachedLayers = layers.slice(cacheStart);
    return {
      mode: "static",
      key: cacheKey,
      text: ev.text,
      layers: cachedLayers,
      bytes: cacheEntryBytes(cachedLayers),
      layerCount: cachedLayers.length,
      hit: false,
    };
  }
  if (cacheTemplates) {
    return {
      mode: "tint",
      key: cacheKey,
      text: ev.text,
      templates: cacheTemplates,
      bytes: cacheEntryBytes(cacheTemplates),
      layerCount: cacheTemplates.length,
      hit: false,
    };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Cross-frame reuse gate.
//
// The event-layer cache and the render-ahead / worker prewarm only pay off when
// a cached entry is READ on a frame LATER than the one that produced it. Two
// classes of event can never earn that second read:
//   1. Time-variant events (\move, \t animating layout, karaoke): their output
//      changes every frame. Already excluded — buildEventLayout gives them
//      layerCacheMode "none" (hasTimeVariantEffects/hasKaraoke), so the cache
//      block below never runs for them.
//   2. Sub-frame events: static in content but on screen for ~one frame. Dense
//      typeset scripts (Beastars: ~99% of events last a single 40ms frame; the
//      benchmark sign sections likewise) emit thousands of these. They are
//      cacheable by content yet single-use in time — inserted, read at most
//      once, then pure retention. Under prewarm the lookahead horizon pulls in
//      the whole dense tail and fills the 512MB cache with entries that never
//      get a second read; multiplied across worker realms, that is the OOM.
//
// This gate excludes class 2 from both cache-insert and prewarm. Skipped events
// re-render live on their single active frame — output is byte-identical either
// way (caching is a pure perf optimisation, never a semantics change), so the
// gate is invisible to parity/golden. STATIC multi-frame events (normal
// subtitle dialogue, benchmark @901000's 5s sign strips, aot3p2 dialogue) stay
// fully cached: that is where the cross-frame hit win lives, and it is
// unchanged. A cached entry needs the event to span more than one frame; below
// ~one frame at typical playback cadence (24fps ≈ 42ms) reuse is impossible, so
// the default floor is 60ms. Configurable/disable-able for A/B and for content
// that plays back fast enough to reuse short events.
const CACHE_REUSE_MIN_MS_DEFAULT = 60;

let cacheReuseGateEnabled =
  ((globalThis as any)?.process?.env?.SUBFRAME_CACHE_REUSE_GATE ?? "") !== "0";
let cacheReuseMinMs = (() => {
  const v = Number((globalThis as any)?.process?.env?.SUBFRAME_CACHE_REUSE_MIN_MS);
  return Number.isFinite(v) && v > 0 ? v : CACHE_REUSE_MIN_MS_DEFAULT;
})();

// True when this event can plausibly be read from the cache on a frame other
// than the one that rendered it. Sub-frame events never can, so they are
// neither cached nor prewarmed. Non-positive durations are non-reusable.
export function isEventCacheReusable(ev: SubtitleEvent): boolean {
  if (!cacheReuseGateEnabled) return true;
  return ev.end - ev.start >= cacheReuseMinMs;
}

export function setEventCacheReuseGate(opts: {
  enabled?: boolean;
  minReuseMs?: number;
}): void {
  if (opts.enabled !== undefined) cacheReuseGateEnabled = opts.enabled;
  if (
    opts.minReuseMs !== undefined &&
    Number.isFinite(opts.minReuseMs) &&
    opts.minReuseMs >= 0
  ) {
    cacheReuseMinMs = opts.minReuseMs;
  }
}

export function getEventCacheReuseGate(): { enabled: boolean; minReuseMs: number } {
  return { enabled: cacheReuseGateEnabled, minReuseMs: cacheReuseMinMs };
}

export type RenderEventContext = {
  doc: SubtitleDocument;
  frame: FrameContext;
  timeMs: number;
  scaleBorderAndShadow: boolean | undefined;
  playResX: number;
  playResY: number;
  parScaleX: number;
  baseContentWidth: number;
  baseContentHeight: number;
  fitWidth: number;
  fitHeight: number;
  layers: BitmapLayer[];
  shapeCtx: ShapeContext;
  usedGlyphBuffers: GlyphBuffer[];
  traceCtx?: TraceContext;
  // Inline render-ahead marks itself so funnel instrumentation only counts
  // live deadline-path reads. No effect on rendering.
  prewarm?: boolean;
};

export async function renderEvent(ctx: RenderEventContext, ev: SubtitleEvent): Promise<void> {
  const {
    doc,
    frame,
    timeMs,
    scaleBorderAndShadow,
    playResX,
    playResY,
    parScaleX,
    baseContentWidth,
    baseContentHeight,
    fitWidth,
    fitHeight,
    layers,
    shapeCtx,
    usedGlyphBuffers,
    traceCtx,
  } = ctx;

  const layoutStart = isProfiling() ? profileNow() : 0;
  const layout = await buildEventLayout({
    doc,
    ev,
    frame,
    timeMs,
    scaleBorderAndShadow,
    playResX,
    playResY,
    parScaleX,
    baseContentWidth,
    baseContentHeight,
    fitWidth,
    fitHeight,
    shapeCtx,
    usedGlyphBuffers,
  });
  if (isProfiling()) addLayoutMs(profileNow() - layoutStart);
  if (!layout) return;

  // Funnel instrumentation stamps: live deadline-path reads only (not trace
  // renders, not inline prewarm). Zero-cost when SUBFRAME_FUNNEL is unset.
  const funnelLive = FUNNEL_ENABLED && !traceCtx && !ctx.prewarm;
  const funnelT0 = funnelLive ? performance.now() : 0;

  const cacheMode = !traceCtx ? layout.layerCacheMode : "none";
  if (!traceCtx) recordEventFullyStaticVerdict(ev, cacheMode === "static");
  // Cache only events that can be read on a later frame: cacheable by content
  // (layerCacheMode) AND on screen long enough to span more than one frame.
  // Sub-frame events are single-use in time — caching them is pure retention
  // (see isEventCacheReusable). Rendering is identical whether or not the entry
  // is stored, so a skipped event just re-renders live on its active frame.
  const cacheable =
    cacheMode !== "none" && !!layout.cacheKey && isEventCacheReusable(ev);
  if (cacheable) {
    const cached = EVENT_LAYER_CACHE.get(ev);
    if (
      cached &&
      cached.key === layout.cacheKey &&
      cached.text === ev.text &&
      cached.mode === cacheMode
    ) {
      eventLayerCacheHits++;
      cached.hit = true;
      cacheTouch(ev, cached);
      if (cached.mode === "static") {
        pushCachedLayers(layers, cached.layers);
      } else {
        pushTintCachedLayers(layers, cached.templates, layout.lines, ev, timeMs);
      }
      if (funnelLive) {
        const rec = funnelRecFor(ev, false);
        if (rec.firstRead === 0) {
          rec.firstRead = 1;
          rec.firstReadWall = funnelT0;
        }
      }
      return;
    }
    eventLayerCacheMisses++;
    noteEventLayerMiss(ev);
  } else if (funnelLive) {
    const rec = funnelRecFor(ev, false);
    rec.notCacheable = true;
    rec.ncFrames++;
  }

  let traceEvent: TraceEvent | null = null;
  if (traceCtx) {
    const movePos: [number, number] | null =
      layout.move && layout.posX !== null && layout.posY !== null
        ? [layout.posX, layout.posY]
        : null;
    traceEvent = startTraceEvent(
      traceCtx,
      ev,
      layout.align,
      [layout.posX, layout.posY],
      movePos,
      layout.clip ? layout.clip.type : null,
      layout.clip ? layout.clip.inverse : false,
      { l: layout.marginL, r: layout.marginR, v: layout.marginV },
      layout.wrapStyle,
      layout.availableWidth,
      { x: layout.blockAnchorX, y: layout.blockAnchorY },
    );
  }

  const rasterStart = isProfiling() ? profileNow() : 0;
  const cacheStart = layers.length;
  const cacheTemplates: CacheLayerTemplate[] | undefined =
    cacheable && cacheMode === "tint" ? [] : undefined;
  // Suppress GPU deferral for cacheable events (they cache their CPU blur and
  // reuse it) but never for trace renders (they must exercise the GPU path).
  pushEventLayers(ev, frame, timeMs, layout, parScaleX, layers, traceEvent, cacheTemplates, cacheable && !traceCtx);
  if (isProfiling()) addRasterMs(profileNow() - rasterStart);

  if (cacheable) {
    const entry = buildCachedEntry(
      ev,
      layout.cacheKey,
      cacheMode,
      layers,
      cacheStart,
      cacheTemplates,
    );
    if (entry) cacheInsert(ev, entry);
  }

  if (funnelLive) {
    const rec = funnelRecFor(ev, false);
    const dur = performance.now() - funnelT0;
    if (rec.notCacheable) {
      rec.ncRenderMs += dur;
    } else if (rec.firstRead === 0) {
      rec.firstRead = 2;
      rec.firstReadWall = funnelT0;
      rec.missRenderMs = dur;
    }
    if (rec.bytes === 0) {
      const now = EVENT_LAYER_CACHE.get(ev);
      if (now) rec.bytes = now.bytes;
    }
  }
}

// Serializable form of a cache entry as produced by a worker and handed back to
// insertPrewarmedLayers. Structurally identical to CachedEntry; the bitmaps
// arrive as transferred/cloned Uint8Arrays.
export type PrewarmedEntry = CachedEntry;

// Render one event for prewarming, off the live frame path. Returns the cache
// entry (static layers or tint templates) that the sync path would have
// produced for this event at this resolution, or null when the event is not
// layer-cacheable (karaoke / time-variant effects) or has no visible output.
// The bitmaps are byte-identical to the live path because both funnel through
// pushEventLayers/buildCachedEntry; timeMs does not affect a cacheable event's
// bitmaps (only per-frame color tinting, applied later on cache hit).
export async function renderEventForPrewarm(
  ctx: RenderEventContext,
  ev: SubtitleEvent,
): Promise<CachedEntry | null> {
  // A prewarmed entry only pays off if it is read on a later frame; sub-frame
  // events can never be (see isEventCacheReusable), so skip the whole render.
  if (!isEventCacheReusable(ev)) return null;
  const layout = await buildEventLayout({
    doc: ctx.doc,
    ev,
    frame: ctx.frame,
    timeMs: ctx.timeMs,
    scaleBorderAndShadow: ctx.scaleBorderAndShadow,
    playResX: ctx.playResX,
    playResY: ctx.playResY,
    parScaleX: ctx.parScaleX,
    baseContentWidth: ctx.baseContentWidth,
    baseContentHeight: ctx.baseContentHeight,
    fitWidth: ctx.fitWidth,
    fitHeight: ctx.fitHeight,
    shapeCtx: ctx.shapeCtx,
    usedGlyphBuffers: ctx.usedGlyphBuffers,
  });
  if (!layout) return null;
  const cacheMode = layout.layerCacheMode;
  if (cacheMode === "none" || !layout.cacheKey) return null;
  const layers: BitmapLayer[] = [];
  const cacheTemplates: CacheLayerTemplate[] | undefined =
    cacheMode === "tint" ? [] : undefined;
  // Prewarm output is always inserted into the cache, so never defer to the GPU
  // (workers have no GPU provider anyway; this keeps the entry cacheable).
  pushEventLayers(ev, ctx.frame, ctx.timeMs, layout, ctx.parScaleX, layers, null, cacheTemplates, true);
  return buildCachedEntry(ev, layout.cacheKey, cacheMode, layers, 0, cacheTemplates);
}

// Insert a worker-produced entry into the event-layer cache. Validated exactly
// like the live cacheInsert path: the entry's text must still match the event
// (index stability across the worker's cloned document), and an already-present
// matching entry is left untouched. Byte counts are recomputed from the
// received bitmaps rather than trusted across the thread boundary. Returns
// whether the entry was inserted.
export function insertPrewarmedLayers(
  ev: SubtitleEvent,
  entry: PrewarmedEntry | null,
): boolean {
  if (!entry) return false;
  if (entry.mode !== "static" && entry.mode !== "tint") return false;
  // Never retain a worker-produced entry for a non-reusable event (a stale
  // dispatch racing a gate change): it would be single-use dead weight.
  if (!isEventCacheReusable(ev)) return false;
  if (entry.text !== ev.text) return false;
  const existing = EVENT_LAYER_CACHE.get(ev);
  if (
    existing &&
    existing.mode === entry.mode &&
    existing.key === entry.key &&
    existing.text === ev.text
  ) {
    return false;
  }
  if (entry.mode === "static") {
    entry.bytes = cacheEntryBytes(entry.layers);
    entry.layerCount = entry.layers.length;
  } else {
    entry.bytes = cacheEntryBytes(entry.templates);
    entry.layerCount = entry.templates.length;
  }
  // Never trust hit-tracking across the thread boundary; a prewarmed entry
  // has not been read by the deadline path yet.
  entry.hit = false;
  cacheInsert(ev, entry);
  if (FUNNEL_ENABLED) funnelNoteInserted(ev, entry.bytes);
  return true;
}
