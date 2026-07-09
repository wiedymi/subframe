// Web Worker entry for the transparent prewarm pool (src/core/worker-pool.ts).
// Runs the real core pipeline for a single event and posts the resulting
// event-layer cache entry back to the main thread, which inserts it via
// insertPrewarmedLayers. Bootstrapped by createPoolWorker in worker-pool.ts:
// an explicit setWorkerSource wins, otherwise the sibling module next to the
// pool is used (the package build emits dist/worker-entry.js beside
// dist/index.js; Bun resolves the .ts source natively). If no source is
// reachable the pool fails closed and callers fall back to inline prewarm.
// Mark this realm as a worker so any transitively-loaded worker-pool code can
// never recursively spawn its own pool.
(globalThis as any).__SUBFRAME_WORKER__ = true;
import type { SubtitleDocument, SubtitleEvent } from "subforge/core";
import type { GlyphBuffer } from "text-shaper";
import type { BitmapLayer } from "./data/types";
import { renderEventForPrewarm, type PrewarmedEntry } from "./pipeline/event";
import { clearRasterCaches, trimRasterCaches } from "./raster/event";
import {
  getBitmapPoolStats,
  releaseFrameLocalBitmapBuffer,
  setAllocCensusEnabled,
  takeAllocCensusStats,
} from "./raster/bitmap";
import { frameContextFromDocument, frameEventParams } from "./frame";
import { renderFrameToLayers, renderSubsetToLayers, packFrameArena } from "./frame-arena";
import { createShapeContext, releaseGlyphBuffer } from "./shape/shaper";
import { registerFontSource, setFontResolver, type FontSource } from "../io/fonts/cache";
import { setFontSearchPaths } from "../io/fonts/resolve";
import { applyWorkerCacheLimits } from "./memory";
import {
  computeGpuBlurDims,
  setGpuFilterDeferEnabled,
  setGpuFilterProvider,
} from "./filters/gpu-provider";

// A prewarm worker renders one event at a time and posts the result out; it
// never re-reads the event-layer cache and needs only tiny working caches.
// Shrink them up front so N workers don't each grow a full main-thread-sized
// cache footprint.
applyWorkerCacheLimits();

type InitMessage = {
  type: "init";
  fontSearchPaths: string[];
  fontSources: Array<{ name: string; source: string | ArrayBuffer | Uint8Array }>;
  // Dedicated channel for result messages. When present (Bun/Node pools),
  // results are posted here so the main thread can drain them synchronously
  // without waiting for an event-loop turn; see worker-pool.ts
  // drainWorkerResults. Absent in browsers (results use self.postMessage).
  resultPort?: MessagePort;
  // Pool slot + size, used ONCE to phase-seed this worker's periodic cache
  // backstop so no two workers shed on the same displayed frame.
  workerIndex?: number;
  workerCount?: number;
  gpuFiltersEnabled?: boolean;
  allocCensusEnabled?: boolean;
  sabArenasEnabled?: boolean;
};
type GpuFilterProviderMessage = { type: "gpu-filter-provider"; enabled: boolean };
type DocMessage = { type: "doc"; docId: number; doc: SubtitleDocument };
type TaskMessage = {
  type: "task";
  taskId: number;
  docId: number;
  eventIndex: number;
  width: number;
  height: number;
};
type FontResponseMessage = {
  type: "font-response";
  name: string;
  source: string | ArrayBuffer | Uint8Array | null;
};
type ArenaReturnMessage = {
  type: "arena-return";
  buffer: ArrayBuffer;
};
type ArenaSlotReleaseMessage = {
  type: "arena-slot-release";
  slotIdx: number;
};
// Whole-frame render request (frame-pipeline ring, STAGE 1): render EVERY active
// layer of `timeMs` and post the packed arena back.
type RenderFrameMessage = {
  type: "renderFrame";
  docId: number;
  timeMs: number;
  width: number;
  height: number;
};
// Per-frame EVENT-SCATTER request (PRIMARY path, STAGE 4): render a SUBSET of
// `timeMs`'s active events (by ordinal into activeEventsAtTime) into one arena.
// N of these fan out across the pool per frame; the main thread fork-joins them.
type RenderSubsetMessage = {
  type: "renderSubset";
  docId: number;
  frameId: number;
  subsetIdx: number;
  timeMs: number;
  width: number;
  height: number;
  ordinals: Int32Array | number[];
};
type InMessage =
  | InitMessage
  | GpuFilterProviderMessage
  | DocMessage
  | TaskMessage
  | RenderFrameMessage
  | RenderSubsetMessage
  | ArenaReturnMessage
  | ArenaSlotReleaseMessage
  | FontResponseMessage;

const scope = self as unknown as {
  postMessage: (message: unknown, transfer?: Transferable[]) => void;
  onmessage: ((event: MessageEvent) => void) | null;
};

const docs = new Map<number, SubtitleDocument>();
const shapeCtx = createShapeContext();

// Where task results go: the dedicated result port when the pool provided
// one, else the worker's own message channel. Both share the postMessage
// (message, transfer) signature.
let resultTarget: {
  postMessage: (message: unknown, transfer?: Transferable[]) => void;
} = scope;

const ARENA_FREELIST_CAP = 2;
const ARENA_SIZE_CLASS = 1024 * 1024;
const ARENA_RECENT_NEED_SLOTS = 16;
const arenaFreeList: Array<{ buffer: ArrayBuffer; classBytes: number }> = [];
const arenaRecentNeeds = new Array<number>(ARENA_RECENT_NEED_SLOTS).fill(0);
let arenaRecentNeedPos = 0;
let arenaRecentHighWater = 0;
const SAB_ARENA_RING_SIZE = 4;
const sabArenaSlots: Array<{
  buffer: SharedArrayBuffer | null;
  classBytes: number;
  inUse: boolean;
}> = [];
let sabArenasEnabled = false;
let sabArenaPacked = 0;
let sabArenaFallbacks = 0;
let sabArenaGrows = 0;

for (let i = 0; i < SAB_ARENA_RING_SIZE; i++) {
  sabArenaSlots[i] = { buffer: null, classBytes: 0, inUse: false };
}

function arenaSizeClass(bytes: number): number {
  if (bytes <= 0) return 0;
  return Math.ceil(bytes / ARENA_SIZE_CLASS) * ARENA_SIZE_CLASS;
}

function recordArenaNeed(classBytes: number): void {
  arenaRecentNeeds[arenaRecentNeedPos] = classBytes;
  arenaRecentNeedPos = (arenaRecentNeedPos + 1) % ARENA_RECENT_NEED_SLOTS;
  let high = 0;
  for (let i = 0; i < arenaRecentNeeds.length; i++) {
    if (arenaRecentNeeds[i]! > high) high = arenaRecentNeeds[i]!;
  }
  arenaRecentHighWater = high;
}

function acquireArenaBuffer(minBytes: number): { buffer: ArrayBuffer; reused: boolean } | null {
  if (minBytes <= 0) return null;
  const classBytes = arenaSizeClass(minBytes);
  recordArenaNeed(classBytes);
  for (let i = 0; i < arenaFreeList.length; i++) {
    const entry = arenaFreeList[i]!;
    if (
      entry.classBytes < classBytes ||
      entry.classBytes > classBytes + ARENA_SIZE_CLASS
    ) {
      continue;
    }
    arenaFreeList.splice(i, 1);
    return { buffer: entry.buffer, reused: true };
  }
  return { buffer: new ArrayBuffer(classBytes), reused: false };
}

function acquireSabArenaBuffer(minBytes: number): {
  buffer: SharedArrayBuffer;
  reused: boolean;
  sabSlotIdx: number;
} | null {
  if (!sabArenasEnabled || typeof SharedArrayBuffer === "undefined") return null;
  if (minBytes <= 0) return null;
  const classBytes = arenaSizeClass(minBytes);
  for (let i = 0; i < sabArenaSlots.length; i++) {
    const slot = sabArenaSlots[i]!;
    if (slot.inUse) continue;
    if (!slot.buffer || slot.classBytes < classBytes) {
      slot.buffer = new SharedArrayBuffer(classBytes);
      slot.classBytes = classBytes;
      sabArenaGrows++;
    }
    slot.inUse = true;
    pendingSabSlotIdx = i;
    sabArenaPacked++;
    return { buffer: slot.buffer, reused: true, sabSlotIdx: i };
  }
  sabArenaFallbacks++;
  return null;
}

// The SAB slot acquired by the in-flight packFrameArena call. Cleared when the
// packed result posts (the main thread then owns the release via
// arena-slot-release). If pack THROWS after acquiring, the slot would otherwise
// stay inUse forever — after SAB_ARENA_RING_SIZE such throws the worker would
// silently fall back to transfer arenas. releasePendingSabSlot() in the pack
// catch paths returns it to the ring.
let pendingSabSlotIdx = -1;

function releasePendingSabSlot(): void {
  if (pendingSabSlotIdx < 0) return;
  const slot = sabArenaSlots[pendingSabSlotIdx];
  if (slot) slot.inUse = false;
  pendingSabSlotIdx = -1;
}

function acquireFrameArenaBuffer(minBytes: number) {
  return acquireSabArenaBuffer(minBytes) ?? acquireArenaBuffer(minBytes);
}

function returnArenaBuffer(buffer: ArrayBuffer): void {
  if (buffer.byteLength <= 0) return;
  const recent = arenaRecentHighWater;
  if (recent > 0 && buffer.byteLength > recent * 2) return;
  if (arenaFreeList.length >= ARENA_FREELIST_CAP) return;
  arenaFreeList[arenaFreeList.length] = {
    buffer,
    classBytes: arenaSizeClass(buffer.byteLength),
  };
}

function releaseSabArenaSlot(slotIdx: number): void {
  if (slotIdx < 0 || slotIdx >= sabArenaSlots.length) return;
  sabArenaSlots[slotIdx]!.inUse = false;
}

function readSabArenaStats(): {
  sabArenaBytes: number;
  sabArenaHeldSlots: number;
  sabArenaAllocatedSlots: number;
} {
  let sabArenaBytes = 0;
  let sabArenaHeldSlots = 0;
  let sabArenaAllocatedSlots = 0;
  for (let i = 0; i < sabArenaSlots.length; i++) {
    const slot = sabArenaSlots[i]!;
    if (slot.buffer) {
      sabArenaBytes += slot.classBytes;
      sabArenaAllocatedSlots++;
    }
    if (slot.inUse) sabArenaHeldSlots++;
  }
  return { sabArenaBytes, sabArenaHeldSlots, sabArenaAllocatedSlots };
}

function readWorkerHeapSample(): {
  workerHeapUsed?: number;
  workerHeapTotal?: number;
  workerHeapLimit?: number;
} {
  const memory = (performance as Performance & {
    memory?: {
      usedJSHeapSize?: number;
      totalJSHeapSize?: number;
      jsHeapSizeLimit?: number;
    };
  }).memory;
  if (!memory || typeof memory.usedJSHeapSize !== "number") return {};
  const sample: {
    workerHeapUsed?: number;
    workerHeapTotal?: number;
    workerHeapLimit?: number;
  } = { workerHeapUsed: memory.usedJSHeapSize };
  if (typeof memory.totalJSHeapSize === "number") sample.workerHeapTotal = memory.totalJSHeapSize;
  if (typeof memory.jsHeapSizeLimit === "number") sample.workerHeapLimit = memory.jsHeapSizeLimit;
  return sample;
}

function readWorkerDiagnosticSample(): {
  workerHeapUsed?: number;
  workerHeapTotal?: number;
  workerHeapLimit?: number;
  bitmapPoolBytes: number;
  bitmapPoolBuckets: number;
  bitmapPoolHits: number;
  bitmapPoolMisses: number;
  bitmapPoolReleased: number;
  bitmapPoolDropped: number;
  allocCensus?: Record<string, { bytes: number; count: number }>;
  sabArenasEnabled: boolean;
  sabArenaPacked: number;
  sabArenaFallbacks: number;
  sabArenaGrows: number;
  sabArenaBytes: number;
  sabArenaHeldSlots: number;
  sabArenaAllocatedSlots: number;
} {
  const pool = getBitmapPoolStats();
  const sample: ReturnType<typeof readWorkerDiagnosticSample> = {
    ...readWorkerHeapSample(),
    bitmapPoolBytes: pool.bytes,
    bitmapPoolBuckets: pool.buckets,
    bitmapPoolHits: pool.hits,
    bitmapPoolMisses: pool.misses,
    bitmapPoolReleased: pool.released,
    bitmapPoolDropped: pool.dropped,
    sabArenasEnabled,
    sabArenaPacked,
    sabArenaFallbacks,
    sabArenaGrows,
    ...readSabArenaStats(),
  };
  const census = takeAllocCensusStats();
  if (census) sample.allocCensus = census;
  return sample;
}

function releasePackedFrameLocalBitmaps(layers: BitmapLayer[]): void {
  // packFrameArena has already copied every source mask the main thread will
  // ever read. Only buffers explicitly marked by the frame-arena render path are
  // returned here; cached/shared clip/event-layer buffers are never marked.
  const released = new Set<ArrayBuffer>();
  const release = (buf: Uint8Array | undefined): void => {
    if (!buf || buf.length === 0 || released.has(buf.buffer)) return;
    if (releaseFrameLocalBitmapBuffer(buf)) released.add(buf.buffer);
  };
  for (let i = 0; i < layers.length; i++) {
    const layer = layers[i]!;
    release(layer.bitmap);
    const gpu = layer.gpuFilter;
    if (gpu) {
      release(gpu.fillMask);
      release(gpu.outlineMask);
    }
  }
}

// Browser-only font backfill: prewarm candidates run ahead of playback, so a
// task can need a font the pool's init snapshot did not contain (the main
// thread loads fonts lazily through its resolver). Instead of failing, ask the
// main thread for the font by name and wait; the pool drives the app resolver
// and answers with the registered source (or null). Bun workers skip this and
// resolve through the font search paths as before.
const FONT_REQUEST_TIMEOUT_MS = 10_000;
const pendingFontWaiters = new Map<string, Array<(src: FontSource | null) => void>>();

function configureGpuFilterProvider(enabled: boolean): void {
  if (enabled) {
    setGpuFilterProvider({ computeBlurDims: computeGpuBlurDims });
    setGpuFilterDeferEnabled(true);
  } else {
    setGpuFilterProvider(null);
    setGpuFilterDeferEnabled(false);
  }
}

if (typeof Bun === "undefined") {
  setFontResolver(
    (name: string) =>
      new Promise<FontSource | null>((resolve) => {
        let waiters = pendingFontWaiters.get(name);
        if (!waiters) {
          waiters = [];
          pendingFontWaiters.set(name, waiters);
          scope.postMessage({ type: "font-request", name });
          setTimeout(() => {
            const stale = pendingFontWaiters.get(name);
            if (!stale) return;
            pendingFontWaiters.delete(name);
            for (let i = 0; i < stale.length; i++) stale[i]!(null);
          }, FONT_REQUEST_TIMEOUT_MS);
        }
        waiters.push(resolve);
      }),
  );
}

function handleFontResponse(msg: FontResponseMessage): void {
  if (msg.source !== null) registerFontSource(msg.name, msg.source);
  const waiters = pendingFontWaiters.get(msg.name);
  if (!waiters) return;
  pendingFontWaiters.delete(msg.name);
  for (let i = 0; i < waiters.length; i++) waiters[i]!(msg.source);
}

// Replace every bitmap in the entry with a compact, standalone copy so the
// underlying buffers can be transferred without detaching the worker's raster
// caches (a pushed layer bitmap may alias a cached glyph buffer). slice() also
// collapses any subarray views onto exact-size buffers.
function compactAndCollectTransfers(entry: PrewarmedEntry): ArrayBuffer[] {
  const transfers: ArrayBuffer[] = [];
  const take = (bitmap: Uint8Array): Uint8Array => {
    const copy = bitmap.slice();
    transfers[transfers.length] = copy.buffer;
    return copy;
  };
  if (entry.mode === "static") {
    for (let i = 0; i < entry.layers.length; i++) {
      const layer = entry.layers[i]! as BitmapLayer;
      layer.bitmap = take(layer.bitmap);
      if (layer.clip && layer.clip.type === "mask") {
        layer.clip = {
          ...layer.clip,
          bitmap: take(layer.clip.bitmap),
        };
      }
    }
  } else {
    for (let i = 0; i < entry.templates.length; i++) {
      const t = entry.templates[i]!;
      t.bitmap = take(t.bitmap);
    }
  }
  return transfers;
}

// Periodic cache backstop. Every worker cache is already bounded — the
// byte-tracked drawing/transform/shift pools self-evict at their ceilings
// (applyWorkerCacheLimits) and the glyph/path/combined pools are entry-bounded
// per font — so warmth alone cannot grow the heap without limit. Retaining warm
// caches across frames is what unlocks the pool's parallel efficiency (a cold
// glyph raster costs ~4ms vs ~1ms warm) and, with exact-value cache keys
// (raster/event.ts), a warm hit is byte-identical to a cold re-raster, so it
// never changes output. The periodic shed below is therefore ONLY a graceful
// memory backstop against pathological font/glyph fan-out — not a correctness
// requirement.
//
// It is INCREMENTAL and STAGGERED so it never causes the synchronized cold-cliff
// the old per-interval FULL clearRasterCaches produced: with N workers each
// rendering one subset/whole-frame per displayed frame, the counters ran in
// lockstep and every worker cleared ALL caches on the SAME frame, so the next
// frame every worker re-rastered cold and the scatter fork-join makespan (or the
// ring's awaited whole-frame render) spiked hundreds of ms to >1s at once. The
// fix: (1) trimRasterCaches drops only the OLDEST fraction, keeping the hot
// working set warm (the events a worker re-renders every frame survive), and
// (2) each worker's counter is phase-seeded from its pool index so no two workers
// shed on the same displayed frame. A FULL clear (resetWorkerCaches) is kept only
// for the OOM catch paths, which are per-worker and rare.
const CACHE_RESET_INTERVAL = 400;
const SUBSET_CACHE_RESET_INTERVAL = 600;
// Fraction of each cache dropped per backstop tick. Small enough that a single
// staggered worker's trim is invisible in the fork-join makespan, large enough
// that repeated ticks bound accumulated memory.
const CACHE_TRIM_FRACTION = 0.25;
let tasksSinceReset = 0;
let subsetFramesSinceReset = 0;

// Per-worker phase so the periodic backstop of different workers never lands on
// the same displayed frame. Seeded once from the pool-assigned worker index on
// the first init; a random fallback covers a pool that sends no index.
let backstopPhaseSeeded = false;
function seedBackstopPhase(index: number, count: number): void {
  if (backstopPhaseSeeded) return;
  backstopPhaseSeeded = true;
  const n = count > 0 ? count : 1;
  const frac = index >= 0 ? (((index % n) + n) % n) / n : Math.random();
  subsetFramesSinceReset = Math.floor(frac * SUBSET_CACHE_RESET_INTERVAL) % SUBSET_CACHE_RESET_INTERVAL;
  tasksSinceReset = Math.floor(frac * CACHE_RESET_INTERVAL) % CACHE_RESET_INTERVAL;
}

// Full cache clear — the OOM backstop only. Fired when an allocation actually
// threw (compaction / arena / subset render), where shedding everything on THIS
// one worker is the right, rare response. Never fired on a fixed interval (that
// synchronized-clear was the periodic-stall bug).
function resetWorkerCaches(): void {
  clearRasterCaches();
  tasksSinceReset = 0;
  subsetFramesSinceReset = 0;
}

async function handleTask(msg: TaskMessage): Promise<void> {
  const doc = docs.get(msg.docId);
  // reason is diagnostic only: surfaced in getWorkerPoolStats().noEntryReasons
  // so browser deployments can tell "event not layer-cacheable" from real
  // worker-side failures (e.g. missing fonts).
  const fail = (reason: string): void => {
    resultTarget.postMessage({
      type: "result",
      taskId: msg.taskId,
      docId: msg.docId,
      eventIndex: msg.eventIndex,
      ok: false,
      reason,
    });
  };
  if (!doc) return fail("no-doc");
  const ev: SubtitleEvent | undefined = doc.events[msg.eventIndex];
  if (!ev) return fail("no-event");

  const t0 = performance.now();
  const frame = frameContextFromDocument(doc, ev.start, msg.width, msg.height);
  const params = frameEventParams(doc, frame);
  const usedGlyphBuffers: GlyphBuffer[] = [];
  let entry: PrewarmedEntry | null = null;
  let caught: string | null = null;
  try {
    entry = await renderEventForPrewarm(
      {
        doc,
        frame,
        timeMs: ev.start,
        ...params,
        layers: [],
        shapeCtx,
        usedGlyphBuffers,
        traceCtx: undefined,
      },
      ev,
    );
  } catch (err) {
    entry = null;
    caught = String(err);
  } finally {
    for (let i = 0; i < usedGlyphBuffers.length; i++) {
      releaseGlyphBuffer(usedGlyphBuffers[i]!);
    }
  }

  if (!entry) return fail(caught ?? "not-cacheable");
  const renderMs = performance.now() - t0;
  let transfers: ArrayBuffer[];
  try {
    transfers = compactAndCollectTransfers(entry);
  } catch (err) {
    // Under memory pressure the compaction copy can throw
    // "Array buffer allocation failed". Drop this prewarm task instead of
    // letting the rejection crash the worker, and shed the worker's caches
    // so the next task starts lean.
    resetWorkerCaches();
    return fail(String(err));
  }
  // Transfer only on the browser path (self.postMessage). The Bun/Node result
  // port is drained synchronously via receiveMessageOnPort while this worker
  // keeps posting; transfer-list handoff on that concurrent path segfaults Bun
  // intermittently (native race, cf. oven-sh/bun#8775). The entry's bitmaps
  // are already compacted to exact-size buffers, so structured-cloning them
  // instead costs one small memcpy per task.
  resultTarget.postMessage(
    {
      type: "result",
      taskId: msg.taskId,
      docId: msg.docId,
      eventIndex: msg.eventIndex,
      ok: true,
      text: ev.text,
      entry,
      // Worker-side render CPU for this task; drives the pool's throughput
      // accounting (getWorkerPoolStats.taskCpuEmaMs).
      ms: renderMs,
      ...readWorkerDiagnosticSample(),
    },
    resultTarget === scope ? transfers : undefined,
  );
  if (++tasksSinceReset >= CACHE_RESET_INTERVAL) {
    trimRasterCaches(CACHE_TRIM_FRACTION);
    tasksSinceReset = 0;
  }
}

// Whole-frame render: run the SAME event loop the main thread's renderFrame
// runs (activeEventsAtTime -> buildEventLayout -> renderEventLines), rendering
// every active layer of the animated body, bump-pack the masks into one arena
// and post it out. Caches are kept WARM across frames (periodic OOM backstop,
// shared with the scatter path) — NOT shed every frame. Two reasons the old
// per-frame reset was wrong: (1) in the HYBRID a worker handles both renderFrame
// (ring) and renderSubset (scatter) messages, so a per-frame clearRasterCaches
// nuked the scatter fallback's warm caches on the shared worker every ring frame;
// (2) the reset itself (clear + refont) is pure overhead. Animated glyphs are
// unique per frame so cross-frame reuse is ~nil, but the worker's pools are all
// byte/entry-bounded (applyWorkerCacheLimits), so warmth cannot grow the heap —
// only the bounded backstop reset is needed. renderMs is measured and posted so
// the main thread can track per-worker frame throughput (was the ring's blind
// spot: ~130ms warm vs the cold+slow the per-frame reset produced).
async function handleRenderFrame(msg: RenderFrameMessage): Promise<void> {
  const doc = docs.get(msg.docId);
  if (!doc) {
    resultTarget.postMessage({
      type: "frame",
      arena: new ArrayBuffer(0),
      meta: new Float64Array(0),
      count: 0,
      timeMs: msg.timeMs,
      error: "no-doc",
    });
    return;
  }
  const t0 = performance.now();
  let rendered: Awaited<ReturnType<typeof renderFrameToLayers>>;
  try {
    rendered = await renderFrameToLayers(doc, msg.timeMs, msg.width, msg.height, shapeCtx);
  } catch (err) {
    resultTarget.postMessage({
      type: "frame",
      arena: new ArrayBuffer(0),
      meta: new Float64Array(0),
      count: 0,
      timeMs: msg.timeMs,
      error: String(err),
    });
    resetWorkerCaches();
    return;
  }
  let packed: ReturnType<typeof packFrameArena>;
  try {
    packed = packFrameArena(rendered.layers, acquireFrameArenaBuffer);
    // Slot release responsibility now rides with the posted sabSlotIdx.
    pendingSabSlotIdx = -1;
  } catch (err) {
    // Under memory pressure the arena allocation/copy can throw; drop the frame
    // rather than crash the worker, and shed caches so the next frame is lean.
    releasePendingSabSlot();
    resetWorkerCaches();
    resultTarget.postMessage({
      type: "frame",
      arena: new ArrayBuffer(0),
      meta: new Float64Array(0),
      count: 0,
      timeMs: msg.timeMs,
      error: String(err),
    });
    return;
  }
  releasePackedFrameLocalBitmaps(rendered.layers);
  const renderMs = performance.now() - t0;
  // Transfer only on the browser path (self.postMessage). On the Bun/Node result
  // port a transfer-list handoff segfaults intermittently (same native race as
  // handleTask), so structured-clone the arena there instead.
  resultTarget.postMessage(
    {
      type: "frame",
      arena: packed.arena,
      meta: packed.meta,
      count: packed.count,
      timeMs: msg.timeMs,
      sabSlotIdx: packed.sabSlotIdx,
      staticOrdinals: rendered.staticOrdinals,
      nonStaticOrdinals: rendered.nonStaticOrdinals,
      arenaReused: packed.reused,
      ms: renderMs,
      ...readWorkerDiagnosticSample(),
    },
    resultTarget === scope
      ? packed.sabSlotIdx === undefined
        ? [
            packed.arena as ArrayBuffer,
            packed.meta.buffer,
            rendered.staticOrdinals.buffer,
            rendered.nonStaticOrdinals.buffer,
          ]
        : [
            packed.meta.buffer,
            rendered.staticOrdinals.buffer,
            rendered.nonStaticOrdinals.buffer,
          ]
      : undefined,
  );
  // Keep caches warm across frames; shed only periodically as a graceful,
  // staggered, INCREMENTAL memory backstop (shared counter with the scatter path
  // so the hybrid's mixed frame/subset traffic on one worker still bounds heap
  // growth). Never a synchronized full clear — that cold-cliffed every worker at
  // once (~1s ring/scatter spike).
  if (++subsetFramesSinceReset >= SUBSET_CACHE_RESET_INTERVAL) {
    trimRasterCaches(CACHE_TRIM_FRACTION);
    subsetFramesSinceReset = 0;
  }
}

// Per-frame event-scatter render: render this worker's SUBSET of the frame's
// active events and post the packed arena + per-layer ordinal tags. In browser
// WebGPU runs the main thread syncs a GPU-filter provider stub into workers, so
// qualifying layers can carry deferred-filter masks through this arena; CPU/Bun
// workers keep producing CPU-final layers. The main thread fork-joins all N
// subsets, merges by ordinal into single-thread order, z-sorts, and composites.
// Unlike the whole-frame ring, caches are kept WARM across frames here: the
// scatter subset is the same events frame-to-frame in a dense typeset window, so
// warm glyph rasters (cold ~4ms/glyph vs warm ~1ms) are the parallel-efficiency
// unlock, and the determinism fix makes a warm hit byte-identical to a cold
// re-raster. A bounded full reset fires only every SUBSET_CACHE_RESET_INTERVAL
// frames as an OOM backstop (see resetWorkerCaches).
async function handleRenderSubset(msg: RenderSubsetMessage): Promise<void> {
  const fail = (error: string): void => {
    resultTarget.postMessage({
      type: "subset",
      frameId: msg.frameId,
      subsetIdx: msg.subsetIdx,
      arena: new ArrayBuffer(0),
      meta: new Float64Array(0),
      ordinals: new Int32Array(0),
      count: 0,
      timeMs: msg.timeMs,
      staticOrdinals: new Int32Array(0),
      nonStaticOrdinals: new Int32Array(0),
      error,
      ms: 0,
    });
  };
  const doc = docs.get(msg.docId);
  if (!doc) return fail("no-doc");
  const t0 = performance.now();
  let sub: Awaited<ReturnType<typeof renderSubsetToLayers>>;
  try {
    sub = await renderSubsetToLayers(doc, msg.timeMs, msg.width, msg.height, msg.ordinals, shapeCtx);
  } catch (err) {
    resetWorkerCaches();
    return fail(String(err));
  }
  const renderMs = performance.now() - t0;
  let packed: ReturnType<typeof packFrameArena>;
  try {
    packed = packFrameArena(sub.layers, acquireFrameArenaBuffer);
    pendingSabSlotIdx = -1;
  } catch (err) {
    releasePendingSabSlot();
    resetWorkerCaches();
    return fail(String(err));
  }
  releasePackedFrameLocalBitmaps(sub.layers);
  // Transfer only on the browser path (self.postMessage); the Bun/Node result
  // port is drained synchronously while the worker keeps posting, and a
  // transfer-list handoff on that concurrent port segfaults Bun intermittently.
  resultTarget.postMessage(
    {
      type: "subset",
      frameId: msg.frameId,
      subsetIdx: msg.subsetIdx,
      arena: packed.arena,
      meta: packed.meta,
      ordinals: sub.ordinals,
      count: packed.count,
      timeMs: msg.timeMs,
      sabSlotIdx: packed.sabSlotIdx,
      staticOrdinals: sub.staticOrdinals,
      nonStaticOrdinals: sub.nonStaticOrdinals,
      arenaReused: packed.reused,
      ms: renderMs,
      costOrdinals: sub.costOrdinals,
      costMs: sub.costMs,
      ...readWorkerDiagnosticSample(),
    },
    resultTarget === scope
      ? packed.sabSlotIdx === undefined
        ? [
            packed.arena as ArrayBuffer,
            packed.meta.buffer,
            sub.ordinals.buffer,
            sub.staticOrdinals.buffer,
            sub.nonStaticOrdinals.buffer,
            sub.costOrdinals.buffer,
            sub.costMs.buffer,
          ]
        : [
            packed.meta.buffer,
            sub.ordinals.buffer,
            sub.staticOrdinals.buffer,
            sub.nonStaticOrdinals.buffer,
            sub.costOrdinals.buffer,
            sub.costMs.buffer,
          ]
      : undefined,
  );
  // Keep caches warm across frames; shed only periodically as a graceful,
  // staggered, INCREMENTAL memory backstop (see handleRenderFrame).
  if (++subsetFramesSinceReset >= SUBSET_CACHE_RESET_INTERVAL) {
    trimRasterCaches(CACHE_TRIM_FRACTION);
    subsetFramesSinceReset = 0;
  }
}

scope.onmessage = (event: MessageEvent): void => {
  const msg = event.data as InMessage;
  switch (msg.type) {
    case "init": {
      if (msg.fontSearchPaths.length > 0) setFontSearchPaths(msg.fontSearchPaths);
      for (let i = 0; i < msg.fontSources.length; i++) {
        const s = msg.fontSources[i]!;
        registerFontSource(s.name, s.source);
      }
      if (msg.resultPort) resultTarget = msg.resultPort;
      // Phase-seed the periodic cache backstop from this worker's pool slot so
      // the pool never sheds on every worker on the same frame (staggered).
      seedBackstopPhase(
        typeof msg.workerIndex === "number" ? msg.workerIndex : -1,
        typeof msg.workerCount === "number" ? msg.workerCount : 1,
      );
      configureGpuFilterProvider(msg.gpuFiltersEnabled === true);
      setAllocCensusEnabled(msg.allocCensusEnabled === true);
      sabArenasEnabled =
        msg.sabArenasEnabled === true && typeof SharedArrayBuffer !== "undefined";
      scope.postMessage({ type: "ready" });
      break;
    }
    case "gpu-filter-provider": {
      configureGpuFilterProvider(msg.enabled);
      break;
    }
    case "doc": {
      docs.set(msg.docId, msg.doc);
      break;
    }
    case "task": {
      void handleTask(msg);
      break;
    }
    case "renderFrame": {
      void handleRenderFrame(msg);
      break;
    }
    case "renderSubset": {
      void handleRenderSubset(msg);
      break;
    }
    case "arena-return": {
      returnArenaBuffer(msg.buffer);
      break;
    }
    case "arena-slot-release": {
      releaseSabArenaSlot(msg.slotIdx);
      break;
    }
    case "font-response": {
      handleFontResponse(msg);
      break;
    }
  }
};
