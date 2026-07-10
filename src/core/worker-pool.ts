// Transparent Web Worker pool that parallelizes render-ahead (prewarm) work.
//
// Workers do PREWARM ONLY. The synchronous deadline path in renderFrame is
// never touched: workers render upcoming layer-cacheable events in parallel and
// post the resulting cache entries back, which the main thread inserts into the
// event-layer cache via insertPrewarmedLayers. When playback reaches those
// events the (unchanged) sync path gets cache hits. Any failure disables the
// pool for the session and the caller falls back to inline prewarm.
//
// Zero-config: feature-detected on `typeof Worker`, spun up lazily on first
// dispatch. Disable with setWorkerPool(false) or env SUBFRAME_WORKERS=0; size
// with SUBFRAME_WORKERS=<n>. Worker script resolution is overridable via
// setWorkerSource (URL/string/factory) for bundlers that do not serve the
// sibling worker-entry module.
import type { SubtitleDocument, SubtitleEvent } from "subforge/core";
import type {
  ArenaBuffer,
  FrameArenaMessage,
  SubsetArenaMessage,
} from "./data/types";
import {
  insertPrewarmedLayers,
  funnelNoteGateSkip,
  funnelNoteDispatched,
  funnelNoteCompleted,
  getPrewarmFunnelStats,
  type PrewarmedEntry,
} from "./pipeline/event";
import {
  getFont,
  getFontRegistry,
  snapshotFontSources,
} from "../io/fonts/cache";
import { getFontSearchPaths } from "../io/fonts/resolve";
import {
  getGpuFilterProvider,
  isGpuFilterDeferEnabled,
} from "./filters/gpu-provider";
import {
  isAllocCensusEnabled,
  type AllocCensusSnapshot,
} from "./raster/bitmap";

// In-flight tasks per worker. Deep enough that a worker never drains its
// queue between refills (pumpWorkerPool refills at frame start and between
// events, and browsers refill per result arrival), but shallow enough that a
// soonest-deadline task dispatched behind the queue still completes quickly:
// queue latency ~= depth x per-task cost (~3-4ms on dense typesets) feeds the
// deadline gate's latency estimate, and a deep FIFO inflates it until
// near-deadline candidates are gated into guaranteed misses. 10 keeps queue
// latency ~30ms while covering inter-pump gaps. Tunable via
// SUBFRAME_WORKER_QUEUE.
const MAX_INFLIGHT_PER_WORKER = (() => {
  const env = Number((globalThis as any)?.process?.env?.SUBFRAME_WORKER_QUEUE);
  return Number.isFinite(env) && env > 0 ? env : 10;
})();
const MAX_POOL_SIZE = 8;

type PoolWorker = {
  worker: Worker;
  inFlight: number;
  // Whole-frame ("renderFrame") requests in flight on this worker, tracked
  // separately from prewarm `inFlight` so the frame-ring scheduler can place
  // by frame load without prewarm traffic skewing the count.
  frameInFlight: number;
  // Per-frame event-scatter ("renderSubset") requests in flight on this worker
  // (PRIMARY path). Tracked separately from prewarm/frame load.
  subsetInFlight: number;
  // docIds already delivered to this worker (documents are cloned once each).
  docsSent: Set<number>;
  // Dedicated result channel, drained SYNCHRONOUSLY on every dispatch where
  // the runtime supports it (Bun/Node receiveMessageOnPort). A tight render
  // loop that never yields to the macrotask queue would otherwise starve
  // worker.onmessage delivery: results pile up undelivered, pending stays at
  // capacity, and the pool silently stops dispatching after the first burst.
  // null in browsers, which yield every animation frame anyway.
  resultPort: MessagePort | null;
  gpuFiltersEnabled: boolean;
  arenaFreeListMirror: number;
  heapMeasured: boolean;
  heapLatestBytes: number;
  heapPeakBytes: number;
  heapTotalBytes: number;
  heapLimitBytes: number;
  bitmapPoolBytes: number;
  bitmapPoolBuckets: number;
  bitmapPoolHits: number;
  bitmapPoolMisses: number;
  bitmapPoolReleased: number;
  bitmapPoolDropped: number;
  sabArenasEnabled: boolean;
  sabArenaPacked: number;
  sabArenaFallbacks: number;
  sabArenaGrows: number;
  sabArenaBytes: number;
  sabArenaHeldSlots: number;
  sabArenaAllocatedSlots: number;
};

const ARENA_FREELIST_CAP = 2;
let statArenaReturned = 0;
let statArenaReused = 0;
let statArenaDropped = 0;
let statSabArenaSlotReleased = 0;
let statSabArenaSlotDropped = 0;

type WorkerHeapCarrier = {
  workerHeapUsed?: number;
  workerHeapTotal?: number;
  workerHeapLimit?: number;
  bitmapPoolBytes?: number;
  bitmapPoolBuckets?: number;
  bitmapPoolHits?: number;
  bitmapPoolMisses?: number;
  bitmapPoolReleased?: number;
  bitmapPoolDropped?: number;
  sabArenasEnabled?: boolean;
  sabArenaPacked?: number;
  sabArenaFallbacks?: number;
  sabArenaGrows?: number;
  sabArenaBytes?: number;
  sabArenaHeldSlots?: number;
  sabArenaAllocatedSlots?: number;
  allocCensus?: AllocCensusSnapshot;
};

const statAllocCensus = new Map<string, { bytes: number; count: number }>();

function noteAllocCensus(data: WorkerHeapCarrier): void {
  const census = data.allocCensus;
  if (!census) return;
  for (const site of Object.keys(census)) {
    const entry = census[site]!;
    const prev = statAllocCensus.get(site);
    if (prev) {
      prev.bytes += entry.bytes;
      prev.count += entry.count;
    } else {
      statAllocCensus.set(site, { bytes: entry.bytes, count: entry.count });
    }
  }
}

function noteWorkerHeapSample(
  workerIdx: number,
  data: WorkerHeapCarrier,
): void {
  noteAllocCensus(data);
  const pw = workers[workerIdx];
  if (pw) {
    if (typeof data.bitmapPoolBytes === "number")
      pw.bitmapPoolBytes = data.bitmapPoolBytes;
    if (typeof data.bitmapPoolBuckets === "number")
      pw.bitmapPoolBuckets = data.bitmapPoolBuckets;
    if (typeof data.bitmapPoolHits === "number")
      pw.bitmapPoolHits = data.bitmapPoolHits;
    if (typeof data.bitmapPoolMisses === "number")
      pw.bitmapPoolMisses = data.bitmapPoolMisses;
    if (typeof data.bitmapPoolReleased === "number")
      pw.bitmapPoolReleased = data.bitmapPoolReleased;
    if (typeof data.bitmapPoolDropped === "number")
      pw.bitmapPoolDropped = data.bitmapPoolDropped;
    if (typeof data.sabArenasEnabled === "boolean")
      pw.sabArenasEnabled = data.sabArenasEnabled;
    if (typeof data.sabArenaPacked === "number")
      pw.sabArenaPacked = data.sabArenaPacked;
    if (typeof data.sabArenaFallbacks === "number")
      pw.sabArenaFallbacks = data.sabArenaFallbacks;
    if (typeof data.sabArenaGrows === "number")
      pw.sabArenaGrows = data.sabArenaGrows;
    if (typeof data.sabArenaBytes === "number")
      pw.sabArenaBytes = data.sabArenaBytes;
    if (typeof data.sabArenaHeldSlots === "number")
      pw.sabArenaHeldSlots = data.sabArenaHeldSlots;
    if (typeof data.sabArenaAllocatedSlots === "number")
      pw.sabArenaAllocatedSlots = data.sabArenaAllocatedSlots;
  }
  const used = data.workerHeapUsed;
  if (typeof used !== "number" || !Number.isFinite(used) || used < 0) return;
  if (!pw) return;
  pw.heapMeasured = true;
  pw.heapLatestBytes = used;
  if (used > pw.heapPeakBytes) pw.heapPeakBytes = used;
  const total = data.workerHeapTotal;
  if (typeof total === "number" && Number.isFinite(total) && total >= 0) {
    pw.heapTotalBytes = total;
  }
  const limit = data.workerHeapLimit;
  if (typeof limit === "number" && Number.isFinite(limit) && limit >= 0) {
    pw.heapLimitBytes = limit;
  }
}

function workerGpuFiltersWanted(): boolean {
  // Only browser WebGPU compositing can consume deferred filters. Bun/Node keep
  // worker output CPU-final, which preserves the existing default fallback and
  // avoids enabling GPU metadata in CLI/test realms.
  if (typeof (globalThis as { Bun?: unknown }).Bun !== "undefined")
    return false;
  return getGpuFilterProvider() !== null && isGpuFilterDeferEnabled();
}

function sabArenasWanted(): boolean {
  const env = (globalThis as any)?.process?.env?.SUBFRAME_SAB_ARENAS;
  const globalFlag = (globalThis as any).__SUBFRAME_SAB_ARENAS__;
  if (env === "0") return false;
  if (globalFlag === "0") return false;
  if (typeof SharedArrayBuffer === "undefined") return false;
  // The measured SAB arena path does not yet clear the memory/perf gates, so it
  // is diagnostic opt-in only. The transfer/recycle path remains the product
  // default until a SAB mode shows a real heap win without hurting cadence.
  const explicitlyEnabled = env === "1" || globalFlag === "1";
  if (!explicitlyEnabled) return false;
  if (typeof (globalThis as { Bun?: unknown }).Bun !== "undefined") return true;
  return (
    (globalThis as { crossOriginIsolated?: boolean }).crossOriginIsolated ===
    true
  );
}

function syncWorkerGpuFilterProvider(): void {
  const enabled = workerGpuFiltersWanted();
  for (let i = 0; i < workers.length; i++) {
    const pw = workers[i]!;
    if (pw.gpuFiltersEnabled === enabled) continue;
    pw.worker.postMessage({ type: "gpu-filter-provider", enabled });
    pw.gpuFiltersEnabled = enabled;
  }
}

function syncResultDrainEnabled(): boolean {
  const env = (globalThis as any)?.process?.env?.SUBFRAME_BUN_RESULT_DELIVERY;
  if (env === "sync") return true;
  if (env === "event") return false;
  // Sync drain is the default wherever the runtime can do it: the boundary
  // scheduler needs completed worker frames to land inside renderFrame's call,
  // and event-delivered messages can sit in the macrotask queue until the next
  // paced frame, collapsing parked%. Browsers still deliver via onmessage
  // because the drain independently requires receiveMessageOnPort (see
  // getReceiveMessageOnPort), which they lack. The env override above keeps the
  // event path available as a diagnostic.
  return true;
}

// Lazy, bundler-safe lookup of node:worker_threads.receiveMessageOnPort.
type ReceiveMessageOnPort = (port: unknown) => { message: unknown } | undefined;
let receiveMessageOnPortFn: ReceiveMessageOnPort | null | undefined;

function getReceiveMessageOnPort(): ReceiveMessageOnPort | null {
  if (receiveMessageOnPortFn !== undefined) return receiveMessageOnPortFn;
  const metaReq = (import.meta as any).require as
    undefined | ((id: string) => unknown);
  const req = (globalThis as any).require ?? metaReq;
  if (typeof req !== "function") {
    receiveMessageOnPortFn = null;
    return null;
  }
  try {
    const wt = req("node:worker_threads") as {
      receiveMessageOnPort?: ReceiveMessageOnPort;
    };
    receiveMessageOnPortFn =
      typeof wt.receiveMessageOnPort === "function"
        ? wt.receiveMessageOnPort
        : null;
  } catch {
    receiveMessageOnPortFn = null;
  }
  return receiveMessageOnPortFn;
}

// Pull any finished results off the per-worker ports without waiting for an
// event-loop turn. Frees pool capacity before the dispatch gate below and
// lands prewarmed entries in the cache before this frame's deadline path
// re-renders them.
function drainWorkerResults(): void {
  const recv = getReceiveMessageOnPort();
  if (!recv) return;
  const t0 = performance.now();
  for (let i = 0; i < workers.length; i++) {
    const port = workers[i]!.resultPort;
    if (!port) continue;
    for (;;) {
      let msg: { message: unknown } | undefined;
      try {
        msg = recv(port);
      } catch {
        break;
      }
      if (!msg) break;
      const data = msg.message as
        (ResultMessage | FrameArenaMessage | SubsetArenaMessage) | undefined;
      if (!data) continue;
      if (data.type === "result") handleResult(data as ResultMessage);
      else if (data.type === "frame")
        handleFrameResult(i, data as FrameArenaMessage);
      else if (data.type === "subset")
        handleSubsetResult(i, data as SubsetArenaMessage);
    }
  }
  statDrainMsTotal += performance.now() - t0;
}

// ---------------------------------------------------------------------------
// Frame-dispatch mode (whole-frame-per-worker ring, STAGE 2).
//
// Distinct from prewarm: the ring scheduler in pipeline.ts dispatches whole
// FUTURE frames (worker-entry "renderFrame") one per worker, parks the packed
// arenas keyed by media time, and composites the ring-hit frame while the
// workers render further ahead. This section owns only the transport: place a
// request on a worker (reusing docsSent), track per-worker frame load, and
// route "frame" results back through a single callback the scheduler installs.
export type FrameResult = {
  workerIdx: number;
  timeMs: number;
  arena: ArenaBuffer;
  meta: Float64Array;
  count: number;
  sabSlotIdx?: number;
  staticOrdinals?: Int32Array;
  nonStaticOrdinals?: Int32Array;
  ms: number;
  arenaReused?: boolean;
  error?: string;
};

// Whole-frame (ring) production accounting. frameProduced counts every non-error
// frame a worker actually finished and the main thread absorbed; frameErrors the
// failures. frameCpuEmaMs is the EWMA of per-worker warm frame render ms — the
// ring's per-worker latency the lookahead depth must cover (~130ms warm). These
// are the ring-saturation instrument the mission asks for: production rate =
// frameProduced / wall, per-worker frame ms = frameCpuEmaMs.
let frameProduced = 0;
let frameErrors = 0;
let frameCpuMsTotal = 0;
let frameCpuEmaMs = 130;

export function getFrameThroughputStats(): {
  produced: number;
  errors: number;
  cpuEmaMs: number;
  cpuMsTotal: number;
  inFlight: number;
} {
  let inFlight = 0;
  for (let i = 0; i < workers.length; i++)
    inFlight += workers[i]!.frameInFlight;
  return {
    produced: frameProduced,
    errors: frameErrors,
    cpuEmaMs: frameCpuEmaMs,
    cpuMsTotal: frameCpuMsTotal,
    inFlight,
  };
}

export function resetFrameThroughputStats(): void {
  frameProduced = 0;
  frameErrors = 0;
  frameCpuMsTotal = 0;
  frameCpuEmaMs = 130;
}

// Cap concurrent frames per worker: one rendering + one queued keeps a worker
// pipelined (it starts the queued frame the instant it finishes the current one,
// with no main-thread round-trip) without letting the ring outrun the arena
// budget (N workers x depth in flight at most). Depth 2 is the saturation
// sweet spot: >=1 queued means zero worker idle between frames, and the parked
// (ready) frames the ring buffers on top of these do NOT count here (they are
// decremented on arrival), so the lookahead horizon, not this cap, sets buffer
// depth. Tunable via SUBFRAME_FRAME_QUEUE.
const FRAME_MAX_INFLIGHT_PER_WORKER = (() => {
  const env = Number((globalThis as any)?.process?.env?.SUBFRAME_FRAME_QUEUE);
  return Number.isFinite(env) && env > 0 ? Math.floor(env) : 2;
})();

let frameResultCb: ((r: FrameResult) => void) | null = null;
// Total "renderFrame" requests in flight across all workers; gates the pump's
// synchronous drain so frame results are absorbed even when no prewarm task is
// pending.
let framePending = 0;

// Install the scheduler's frame-result sink. Passing null detaches it.
export function setFrameResultHandler(
  cb: ((r: FrameResult) => void) | null,
): void {
  frameResultCb = cb;
}

function handleFrameResult(workerIdx: number, data: FrameArenaMessage): void {
  const pw = workers[workerIdx];
  noteWorkerHeapSample(workerIdx, data);
  if (pw && pw.frameInFlight > 0) pw.frameInFlight--;
  if (pw && data.arenaReused && data.sabSlotIdx === undefined) {
    if (pw.arenaFreeListMirror > 0) pw.arenaFreeListMirror--;
    statArenaReused++;
  }
  if (framePending > 0) framePending--;
  const ms = typeof data.ms === "number" ? data.ms : 0;
  if (data.error) {
    frameErrors++;
  } else {
    frameProduced++;
    if (ms > 0) {
      frameCpuMsTotal += ms;
      frameCpuEmaMs += (ms - frameCpuEmaMs) * 0.1;
    }
  }
  const cb = frameResultCb;
  if (!cb) {
    if (!data.error)
      releaseArenaToWorker(workerIdx, data.arena, data.sabSlotIdx);
    return;
  }
  if (cb) {
    cb({
      workerIdx,
      timeMs: data.timeMs,
      arena: data.arena,
      meta: data.meta,
      count: data.count,
      sabSlotIdx: data.sabSlotIdx,
      staticOrdinals: data.staticOrdinals,
      nonStaticOrdinals: data.nonStaticOrdinals,
      ms,
      arenaReused: data.arenaReused,
      error: data.error,
    });
  }
}

// Boot the (shared) pool if usable and report how many workers are available
// for whole-frame dispatch. N is capped at min(hardwareWorkerCap(), 6) by
// baseWorkerCount(); the frame ring never triggers prewarm auto-scaling. 0 when
// the pool is unusable, disabled, or failed.
export function ensureFrameWorkers(): number {
  if (!isWorkerPoolUsable()) return 0;
  if (!initPool()) return 0;
  if (poolFailed) return 0;
  // Forward any fonts registered since boot so workers render whole frames
  // self-sufficiently. Without this they fall back to per-glyph font-request
  // round-trips, which a render-bound main thread cannot answer promptly — the
  // worker render then fails or times out (measured: ~34% frame errors), so the
  // ring never lands a usable frame. Cheap no-op once the snapshot is unchanged.
  syncFontSources();
  syncWorkerGpuFilterProvider();
  if (poolFailed) return 0;
  return workers.length;
}

// Current usable worker count for frame dispatch without forcing a boot.
export function frameWorkerCount(): number {
  if (userDisabled || poolFailed) return 0;
  return workers.length;
}

// True when frame results can ONLY arrive via an event-loop turn (worker
// onmessage) because this runtime has no synchronous port drain. That is the
// browser: pumpWorkerPool's receiveMessageOnPort drain is a no-op there, so a
// render-bound caller loop that never yields to the macrotask queue would starve
// frame delivery. The ring scheduler yields once in that case. Bun/Node return
// false (pumpWorkerPool sync-drains their ports).
export function frameResultsNeedEventLoop(): boolean {
  return getReceiveMessageOnPort() === null || !syncResultDrainEnabled();
}

// Pick the least-frame-loaded worker with a free frame slot, or -1 when every
// worker is at FRAME_MAX_INFLIGHT_PER_WORKER (the scheduler then defers the
// dispatch and re-tries next frame as results drain).
export function pickFrameWorker(): number {
  if (userDisabled || poolFailed || workers.length === 0) return -1;
  let best = -1;
  let bestLoad = Infinity;
  for (let i = 0; i < workers.length; i++) {
    const load = workers[i]!.frameInFlight;
    if (load < bestLoad) {
      best = i;
      bestLoad = load;
    }
  }
  if (best < 0 || workers[best]!.frameInFlight >= FRAME_MAX_INFLIGHT_PER_WORKER)
    return -1;
  return best;
}

// Post a whole-frame render request to a specific worker. Reuses docsSent so the
// document is structured-cloned to each worker exactly once. Returns false (and
// leaves nothing in flight) when the pool is down or the index is invalid.
export function sendFrameRequest(
  workerIdx: number,
  doc: SubtitleDocument,
  timeMs: number,
  width: number,
  height: number,
): boolean {
  if (userDisabled || poolFailed) return false;
  if (workerIdx < 0 || workerIdx >= workers.length) return false;
  const pw = workers[workerIdx]!;
  const docId = docIdFor(doc);
  try {
    if (!pw.docsSent.has(docId)) {
      pw.worker.postMessage({
        type: "doc",
        docId,
        doc,
        fontSources: getFontRegistry(doc).snapshot(),
      });
      pw.docsSent.add(docId);
    }
    pw.worker.postMessage({
      type: "renderFrame",
      docId,
      timeMs,
      width,
      height,
    });
    pw.frameInFlight++;
    framePending++;
    return true;
  } catch (err) {
    failPool(err);
    return false;
  }
}

// ---------------------------------------------------------------------------
// Per-frame EVENT-SCATTER fork-join (PRIMARY path, STAGE 4).
//
// scatterFrame partitions ONE frame's active events across N workers (whole
// events, balanced by the caller), posts a "renderSubset" to each, and awaits
// ALL N subset arenas before returning. Cuts per-frame LATENCY from the
// whole-frame ~130ms to ~makespan(biggest worker) ~13-20ms, hitting the 16.7ms
// period directly with no lookahead. Distinct from the ring: the ring parks
// FUTURE whole frames; scatter renders the CURRENT frame in parallel and joins.
export type SubsetPart = {
  workerIdx: number;
  arena: ArenaBuffer;
  sabSlotIdx?: number;
  meta: Float64Array;
  ordinals: Int32Array;
  count: number;
  ms: number;
  staticOrdinals?: Int32Array;
  nonStaticOrdinals?: Int32Array;
  // Per-event warm render cost feedback for the measured-cost LPT balancer.
  costOrdinals?: Int32Array;
  costMs?: Float64Array;
};

type ScatterPending = {
  expected: number;
  received: number;
  parts: (SubsetPart | null)[];
  error: string | null;
};

let scatterIdCounter = 1;
const scatterPending = new Map<number, ScatterPending>();
// Guard against a fork-join wedging the render loop if a worker never answers
// (crash / lost message): bail to the single-thread fallback after this wall.
const SCATTER_TIMEOUT_MS = 2000;

export function returnArenaBufferToWorker(
  workerIdx: number,
  buffer: ArrayBuffer,
): boolean {
  if (buffer.byteLength <= 0) return false;
  if (
    typeof (globalThis as { Bun?: unknown }).Bun !== "undefined" &&
    (globalThis as any)?.process?.env?.SUBFRAME_BUN_ARENA_RETURN !== "1"
  ) {
    // Bun's event-delivered worker result path is fast only while the main
    // thread avoids posting large transfer messages back to the same workers.
    // Returning arenas there queues transfer work alongside boundary-scatter
    // messages; beastars then misses the 40.6ms boundary cadence and parked%
    // collapses. Dropping these buffers preserves pixels and restores the
    // Phase-N scheduler behavior. Opt in for diagnostics with
    // SUBFRAME_BUN_ARENA_RETURN=1.
    statArenaDropped++;
    return false;
  }
  const pw = workers[workerIdx];
  if (!pw || poolFailed) {
    statArenaDropped++;
    return false;
  }
  if (pw.arenaFreeListMirror >= ARENA_FREELIST_CAP) {
    statArenaDropped++;
    return false;
  }
  try {
    pw.worker.postMessage({ type: "arena-return", buffer }, [
      buffer as unknown as Transferable,
    ]);
    pw.arenaFreeListMirror++;
    statArenaReturned++;
    return true;
  } catch {
    statArenaDropped++;
    return false;
  }
}

export function releaseSabArenaSlotToWorker(
  workerIdx: number,
  slotIdx: number,
): boolean {
  if (slotIdx < 0) return false;
  const pw = workers[workerIdx];
  if (!pw || poolFailed) {
    statSabArenaSlotDropped++;
    return false;
  }
  try {
    pw.worker.postMessage({ type: "arena-slot-release", slotIdx });
    statSabArenaSlotReleased++;
    return true;
  } catch {
    statSabArenaSlotDropped++;
    return false;
  }
}

function releaseArenaToWorker(
  workerIdx: number,
  arena: ArenaBuffer,
  sabSlotIdx?: number,
): boolean {
  if (sabSlotIdx !== undefined)
    return releaseSabArenaSlotToWorker(workerIdx, sabSlotIdx);
  return returnArenaBufferToWorker(workerIdx, arena as ArrayBuffer);
}

function returnSubsetParts(parts: readonly (SubsetPart | null)[]): void {
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i];
    if (p) releaseArenaToWorker(p.workerIdx, p.arena, p.sabSlotIdx);
  }
}

// Route a subset result to its pending fork-join. Stale frames (timed out /
// aborted on teardown) are dropped. A subset error fails the whole frame so the
// caller falls back to a single-thread render (parity-safe).
function handleSubsetResult(workerIdx: number, data: SubsetArenaMessage): void {
  const pw = workers[workerIdx];
  noteWorkerHeapSample(workerIdx, data);
  if (pw && pw.subsetInFlight > 0) pw.subsetInFlight--;
  if (pw && data.arenaReused && data.sabSlotIdx === undefined) {
    if (pw.arenaFreeListMirror > 0) pw.arenaFreeListMirror--;
    statArenaReused++;
  }
  const rec = scatterPending.get(data.frameId);
  if (!rec) {
    releaseArenaToWorker(workerIdx, data.arena, data.sabSlotIdx);
    return;
  }
  if (data.subsetIdx < 0 || data.subsetIdx >= rec.parts.length) {
    releaseArenaToWorker(workerIdx, data.arena, data.sabSlotIdx);
    return;
  }
  if (rec.parts[data.subsetIdx] !== null) {
    releaseArenaToWorker(workerIdx, data.arena, data.sabSlotIdx);
    return; // duplicate (defensive)
  }
  rec.received++;
  if (data.error) {
    releaseArenaToWorker(workerIdx, data.arena, data.sabSlotIdx);
    if (rec.error === null) rec.error = data.error;
    return;
  }
  rec.parts[data.subsetIdx] = {
    workerIdx,
    arena: data.arena,
    sabSlotIdx: data.sabSlotIdx,
    meta: data.meta,
    ordinals: data.ordinals,
    count: data.count,
    ms: typeof data.ms === "number" ? data.ms : 0,
    staticOrdinals: data.staticOrdinals,
    nonStaticOrdinals: data.nonStaticOrdinals,
    costOrdinals: data.costOrdinals,
    costMs: data.costMs,
  };
}

// Fail every in-flight fork-join (pool teardown / failure) so their awaiters
// break out immediately instead of blocking to SCATTER_TIMEOUT_MS.
function abortScatters(reason: string): void {
  for (const [, rec] of scatterPending) {
    if (rec.error === null) rec.error = reason;
    rec.received = rec.expected;
  }
  scatterPending.clear();
}

// Macrotask yield used inside the fork-join await so (browser) queued worker
// `subset` onmessage events deliver and (Bun/Node) worker threads get CPU while
// we poll their ports. FIFO waiter queue so overlapping awaits (1-frame
// pipeline) each resolve exactly once. A MessageChannel ping runs with no
// setTimeout clamp.
let scatterYieldChannel: MessageChannel | null = null;
const scatterYieldWaiters: Array<() => void> = [];

function closeScatterYieldChannel(): void {
  const channel = scatterYieldChannel;
  scatterYieldChannel = null;
  if (channel) {
    channel.port1.onmessage = null;
    channel.port1.close();
    channel.port2.close();
  }
  while (scatterYieldWaiters.length > 0) scatterYieldWaiters.shift()!();
}

function scatterYield(): Promise<void> {
  if (typeof MessageChannel === "undefined") return Promise.resolve();
  if (!scatterYieldChannel) {
    scatterYieldChannel = new MessageChannel();
    scatterYieldChannel.port1.onmessage = (): void => {
      const w = scatterYieldWaiters.shift();
      if (w) w();
    };
    (scatterYieldChannel.port1 as unknown as { start?: () => void }).start?.();
  }
  return new Promise<void>((resolve) => {
    scatterYieldWaiters.push(resolve);
    scatterYieldChannel!.port2.postMessage(0);
  });
}

// Fork-join one frame across the pool. `subsets[i]` is worker i's list of event
// ordinals (positions in activeEventsAtTime(doc,timeMs)); the worker recomputes
// the same active set and renders exactly those. Returns the N subset parts in
// subset order (parts[i] is subsets[i]'s result) once all land, or null on any
// failure/timeout so the caller renders single-thread. Boots/reboots the pool
// as needed (handles the setWorkerPool/​setWorkerCount re-init).
export async function scatterFrame(
  doc: SubtitleDocument,
  timeMs: number,
  width: number,
  height: number,
  subsets: Int32Array[],
  afterDispatch?: () => void,
): Promise<SubsetPart[] | null> {
  if (!isWorkerPoolUsable()) return null;
  if (!initPool()) return null;
  if (poolFailed || workers.length === 0) return null;
  // Forward any fonts registered since boot (browser resolvers load async);
  // without them a worker render fails and the whole frame falls back.
  syncFontSources();
  syncWorkerGpuFilterProvider();
  if (poolFailed || workers.length === 0) return null;
  const n = subsets.length;
  if (n === 0) return [];

  // `subsets` is WORKER-SLOT indexed (subsets[i] is physical worker i's events):
  // this slot->worker identity is what keeps each pinned event on its own warm
  // worker frame after frame. Skip empty slots — an idle worker is not forked —
  // and fork only the non-empty ones, expecting exactly that many results.
  const wc = workers.length;
  let expected = 0;
  for (let i = 0; i < n; i++) if (subsets[i]!.length > 0) expected++;
  if (expected === 0) return [];

  const frameId = scatterIdCounter++;
  const rec: ScatterPending = {
    expected,
    received: 0,
    parts: new Array(n).fill(null),
    error: null,
  };
  scatterPending.set(frameId, rec);

  const docId = docIdFor(doc);
  for (let i = 0; i < n; i++) {
    if (subsets[i]!.length === 0) continue;
    const pw = workers[i % wc]!;
    try {
      if (!pw.docsSent.has(docId)) {
        pw.worker.postMessage({
          type: "doc",
          docId,
          doc,
          fontSources: getFontRegistry(doc).snapshot(),
        });
        pw.docsSent.add(docId);
      }
      pw.worker.postMessage({
        type: "renderSubset",
        docId,
        frameId,
        subsetIdx: i,
        timeMs,
        width,
        height,
        ordinals: subsets[i],
      });
      pw.subsetInFlight++;
    } catch (err) {
      scatterPending.delete(frameId);
      failPool(err);
      return null;
    }
  }
  afterDispatch?.();

  // Fork-join await: browsers deliver subset results via onmessage during the
  // yield; Bun/Node have no onmessage, so drain the ports each poll.
  const needDrain =
    getReceiveMessageOnPort() !== null && syncResultDrainEnabled();
  const t0 = performance.now();
  while (rec.received < rec.expected) {
    if (needDrain) drainWorkerResultsIfDue();
    if (rec.received >= rec.expected) break;
    if (performance.now() - t0 > SCATTER_TIMEOUT_MS) {
      if (rec.error === null) rec.error = "scatter-timeout";
      break;
    }
    await scatterYield();
  }
  scatterPending.delete(frameId);
  if (rec.error !== null || rec.received < rec.expected) {
    returnSubsetParts(rec.parts);
    return null;
  }
  // Compact away the skipped (empty-slot) holes; order is irrelevant to the
  // caller, which merges layers by event ordinal, not by subset position.
  const out: SubsetPart[] = [];
  for (let i = 0; i < rec.parts.length; i++) {
    const p = rec.parts[i];
    if (p !== null) out.push(p);
  }
  return out;
}

type Pending = {
  ev: SubtitleEvent;
  attempted: WeakSet<SubtitleEvent>;
  workerIndex: number;
  // Wall clock at dispatch, for the end-to-end latency estimate that drives
  // the deadline gate in tryDispatchPrewarm.
  sentAt: number;
};

// Deadline-aware dispatch gating. When the pool is CONTENDED (pending >=
// worker count) a queue slot given to a candidate that cannot finish before
// its start is a slot stolen from one that still can; the results fail to
// insert and pool throughput is wasted on dead work. Estimate (a) the
// end-to-end wall latency of a task (EMA over completed tasks; includes queue
// wait, which is what a newly dispatched task will also experience) and (b)
// how fast wall time burns per media millisecond (benches and heavy scenes
// run slower than real time), then skip candidates whose media lead converts
// to less wall time than a task needs. The gate NEVER applies to an idle pool:
// an idle worker always takes the soonest candidate — skipping it guarantees a
// deadline miss and saves nothing. Skipped events are NOT marked attempted:
// they stay eligible, so if the pool catches up (or playback pauses) they can
// still be prewarmed.
let taskWallEmaMs = 8;
let wallPerMediaEma = 1;
let lastGateWall = 0;
let lastGateMedia = -1;
const DEADLINE_GATE_SAFETY = 1.5;

function updateDispatchClocks(timeMs: number): void {
  const now = performance.now();
  if (lastGateMedia >= 0 && timeMs > lastGateMedia && now > lastGateWall) {
    const ratio = (now - lastGateWall) / (timeMs - lastGateMedia);
    if (Number.isFinite(ratio) && ratio > 0 && ratio < 1000) {
      wallPerMediaEma += (ratio - wallPerMediaEma) * 0.1;
    }
  }
  lastGateWall = now;
  lastGateMedia = timeMs;
}

let userDisabled = false;
let poolFailed = false;
let poolInited = false;
let workers: PoolWorker[] = [];

// How the pool obtains its Worker script. Embedders whose bundler does not
// emit/serve the worker entry alongside the main bundle (dev servers, custom
// pipelines) point the pool at a served copy or hand over a factory.
export type WorkerSource = string | URL | (() => Worker);

let workerSource: WorkerSource | null = null;

// Set an explicit worker bootstrap source, consulted before the built-in
// resolution (sibling worker-entry module next to this one). Passing null
// restores the default. Calling this re-arms a pool that previously failed to
// boot (e.g. a SecurityError from an unservable URL) so the next dispatch
// retries with the new source.
export function setWorkerSource(src: WorkerSource | null): void {
  workerSource = src;
  if (workers.length === 0) {
    poolInited = false;
    poolFailed = false;
  }
}

// (c) of the default bootstrap: a same-origin Blob module that imports the
// entry by absolute URL. A direct cross-origin `new Worker(url)` throws a
// same-origin SecurityError; the static import inside the Blob is governed by
// CORS instead, which CDN-hosted bundles can satisfy.
function blobWorker(entryHref: string): Worker {
  const code = `import ${JSON.stringify(entryHref)};`;
  const blob = new Blob([code], { type: "text/javascript" });
  // Deliberately never revoked: the worker script fetch is asynchronous and an
  // immediate revoke races it in some engines. At most MAX_POOL_SIZE tiny
  // one-line blobs per session leak, which is negligible.
  const url = URL.createObjectURL(blob);
  return new Worker(url, { type: "module" });
}

// Resolve a pool worker: (a) explicit setWorkerSource, (b) the sibling
// worker-entry module next to this one when it resolves to http(s) — the
// package build emits dist/worker-entry.js beside dist/index.js so bundled
// browser deployments work out of the box, (c) a Blob worker importing that
// URL when the direct constructor is blocked (cross-origin bundle). Outside
// http(s) (Bun/Node from file:) the sibling module is resolved natively.
function createPoolWorker(): Worker {
  const src = workerSource;
  if (src !== null) {
    if (typeof src === "function") return src();
    return new Worker(src, { type: "module" });
  }
  const sibling = new URL(
    import.meta.url.endsWith(".ts") ? "./worker-entry.ts" : "./worker-entry.js",
    import.meta.url,
  );
  if (sibling.protocol === "http:" || sibling.protocol === "https:") {
    try {
      return new Worker(sibling, { type: "module" });
    } catch {
      return blobWorker(sibling.href);
    }
  }
  return new Worker(sibling, { type: "module" });
}

let docIdCounter = 0;
const docIds = new WeakMap<SubtitleDocument, number>();
const docById = new Map<number, SubtitleDocument>();

let taskIdCounter = 0;
const pending = new Map<number, Pending>();

let statDispatched = 0;
let statInserted = 0;
let statResults = 0;
let statNoEntry = 0;
let statGateSkipped = 0;
let statTaskCpuMsTotal = 0;
let taskCpuEmaMs = 4;
// Diagnostic: cumulative main-thread wall spent absorbing worker results
// (receiveMessageOnPort deserialize + handleResult insert). Compared against
// total render time it quantifies prewarm-insertion contention.
let statDrainMsTotal = 0;

// Number of font sources last forwarded to the workers. Browser embedders
// register font sources asynchronously (resolver fetches) after the pool has
// booted, so dispatch re-syncs whenever the snapshot grows; without the fonts
// every worker render fails and the pool contributes nothing.
let fontSourcesSent = -1;

function syncFontSources(): void {
  const fontSources = snapshotFontSources();
  if (fontSources.length === fontSourcesSent) return;
  fontSourcesSent = fontSources.length;
  const fontSearchPaths = getFontSearchPaths();
  const gpuFiltersEnabled = workerGpuFiltersWanted();
  const sabArenasEnabled = sabArenasWanted();
  for (let i = 0; i < workers.length; i++) {
    try {
      workers[i]!.worker.postMessage({
        type: "init",
        fontSearchPaths,
        fontSources,
        workerIndex: i,
        workerCount: workerCap(),
        gpuFiltersEnabled,
        allocCensusEnabled: isAllocCensusEnabled(),
        sabArenasEnabled,
      });
      workers[i]!.gpuFiltersEnabled = gpuFiltersEnabled;
    } catch (err) {
      failPool(err);
      return;
    }
  }
}

// Diagnostic tally of worker-side failure reasons (bounded; first
// MAX_NO_ENTRY_REASONS distinct strings win). Not on the hot path: updated only
// for failed results.
const MAX_NO_ENTRY_REASONS = 8;
const noEntryReasons = new Map<string, number>();

export function pendingWorkerTaskCount(): number {
  return pending.size;
}

export function getWorkerPoolStats(): {
  active: boolean;
  workers: number;
  workerCap: number;
  scaleUps: number;
  maxPending: number;
  dispatched: number;
  results: number;
  inserted: number;
  noEntry: number;
  gateSkipped: number;
  pending: number;
  taskCpuEmaMs: number;
  taskCpuMsTotal: number;
  drainMsTotal: number;
  noEntryReasons: Record<string, number>;
  funnel?: ReturnType<typeof getPrewarmFunnelStats>;
  arenaReturned: number;
  arenaReused: number;
  arenaDropped: number;
  sabArenasWanted: boolean;
  sabArenaWorkers: number;
  sabArenaPacked: number;
  sabArenaFallbacks: number;
  sabArenaGrows: number;
  sabArenaBytes: number;
  sabArenaHeldSlots: number;
  sabArenaAllocatedSlots: number;
  sabArenaSlotReleased: number;
  sabArenaSlotDropped: number;
  workerHeapMeasured: boolean;
  workerHeapWorkers: number;
  workerHeapLatestBytes: number;
  workerHeapPeakBytes: number;
  workerHeapTotalBytes: number;
  workerHeapLimitBytes: number;
  bitmapPoolBytes: number;
  bitmapPoolBuckets: number;
  bitmapPoolHits: number;
  bitmapPoolMisses: number;
  bitmapPoolReleased: number;
  bitmapPoolDropped: number;
  allocCensus?: AllocCensusSnapshot;
} {
  const reasons: Record<string, number> = {};
  for (const [reason, count] of noEntryReasons) reasons[reason] = count;
  let workerHeapWorkers = 0;
  let workerHeapLatestBytes = 0;
  let workerHeapPeakBytes = 0;
  let workerHeapTotalBytes = 0;
  let workerHeapLimitBytes = 0;
  let bitmapPoolBytes = 0;
  let bitmapPoolBuckets = 0;
  let bitmapPoolHits = 0;
  let bitmapPoolMisses = 0;
  let bitmapPoolReleased = 0;
  let bitmapPoolDropped = 0;
  let sabArenaWorkers = 0;
  let sabArenaPacked = 0;
  let sabArenaFallbacks = 0;
  let sabArenaGrows = 0;
  let sabArenaBytes = 0;
  let sabArenaHeldSlots = 0;
  let sabArenaAllocatedSlots = 0;
  for (let i = 0; i < workers.length; i++) {
    const pw = workers[i]!;
    bitmapPoolBytes += pw.bitmapPoolBytes;
    bitmapPoolBuckets += pw.bitmapPoolBuckets;
    bitmapPoolHits += pw.bitmapPoolHits;
    bitmapPoolMisses += pw.bitmapPoolMisses;
    bitmapPoolReleased += pw.bitmapPoolReleased;
    bitmapPoolDropped += pw.bitmapPoolDropped;
    if (pw.sabArenasEnabled) sabArenaWorkers++;
    sabArenaPacked += pw.sabArenaPacked;
    sabArenaFallbacks += pw.sabArenaFallbacks;
    sabArenaGrows += pw.sabArenaGrows;
    sabArenaBytes += pw.sabArenaBytes;
    sabArenaHeldSlots += pw.sabArenaHeldSlots;
    sabArenaAllocatedSlots += pw.sabArenaAllocatedSlots;
    if (!pw.heapMeasured) continue;
    workerHeapWorkers++;
    workerHeapLatestBytes += pw.heapLatestBytes;
    workerHeapPeakBytes += pw.heapPeakBytes;
    workerHeapTotalBytes += pw.heapTotalBytes;
    workerHeapLimitBytes += pw.heapLimitBytes;
  }
  const stats: ReturnType<typeof getWorkerPoolStats> = {
    active: !userDisabled && !poolFailed && workers.length > 0,
    workers: workers.length,
    workerCap: workerCap(),
    scaleUps: statScaleUps,
    maxPending: statMaxPending,
    dispatched: statDispatched,
    results: statResults,
    inserted: statInserted,
    noEntry: statNoEntry,
    gateSkipped: statGateSkipped,
    pending: pending.size,
    taskCpuEmaMs: taskCpuEmaMs,
    taskCpuMsTotal: statTaskCpuMsTotal,
    drainMsTotal: statDrainMsTotal,
    noEntryReasons: reasons,
    arenaReturned: statArenaReturned,
    arenaReused: statArenaReused,
    arenaDropped: statArenaDropped,
    sabArenasWanted: sabArenasWanted(),
    sabArenaWorkers,
    sabArenaPacked,
    sabArenaFallbacks,
    sabArenaGrows,
    sabArenaBytes,
    sabArenaHeldSlots,
    sabArenaAllocatedSlots,
    sabArenaSlotReleased: statSabArenaSlotReleased,
    sabArenaSlotDropped: statSabArenaSlotDropped,
    workerHeapMeasured: workerHeapWorkers > 0,
    workerHeapWorkers,
    workerHeapLatestBytes,
    workerHeapPeakBytes,
    workerHeapTotalBytes,
    workerHeapLimitBytes,
    bitmapPoolBytes,
    bitmapPoolBuckets,
    bitmapPoolHits,
    bitmapPoolMisses,
    bitmapPoolReleased,
    bitmapPoolDropped,
  };
  if (statAllocCensus.size > 0) {
    const allocCensus: AllocCensusSnapshot = {};
    for (const [site, entry] of statAllocCensus) {
      allocCensus[site] = { bytes: entry.bytes, count: entry.count };
    }
    stats.allocCensus = allocCensus;
  }
  const funnel = getPrewarmFunnelStats();
  if (funnel.enabled) stats.funnel = funnel;
  return stats;
}

// event -> index into doc.events, cached per events array so dispatch avoids an
// O(n) indexOf per candidate.
const eventIndexMaps = new WeakMap<
  SubtitleEvent[],
  Map<SubtitleEvent, number>
>();

function eventIndexMap(events: SubtitleEvent[]): Map<SubtitleEvent, number> {
  let map = eventIndexMaps.get(events);
  if (map && map.size === events.length) return map;
  map = new Map();
  for (let i = 0; i < events.length; i++) map.set(events[i]!, i);
  eventIndexMaps.set(events, map);
  return map;
}

type ResultMessage = {
  type: "result";
  taskId: number;
  docId: number;
  eventIndex: number;
  ok: boolean;
  text?: string;
  entry?: PrewarmedEntry;
  reason?: string;
  // Worker-side render CPU (ms) for throughput accounting.
  ms?: number;
  workerHeapUsed?: number;
  workerHeapTotal?: number;
  workerHeapLimit?: number;
  bitmapPoolBytes?: number;
  bitmapPoolBuckets?: number;
  bitmapPoolHits?: number;
  bitmapPoolMisses?: number;
  bitmapPoolReleased?: number;
  bitmapPoolDropped?: number;
  allocCensus?: AllocCensusSnapshot;
};

function envWorkers(): string | undefined {
  const env = (globalThis as any)?.process?.env?.SUBFRAME_WORKERS;
  return typeof env === "string" ? env : undefined;
}

function inWorkerContext(): boolean {
  return !!(globalThis as any)?.__SUBFRAME_WORKER__;
}

export function isWorkerPoolUsable(): boolean {
  if (userDisabled || poolFailed) return false;
  if (typeof Worker === "undefined") return false;
  if (envWorkers() === "0") return false;
  if (inWorkerContext()) return false;
  return true;
}

// Worker-count policy. Each worker structured-clones the document and grows its
// own working caches, so the pool starts CONSERVATIVE (DEFAULT_MAX_WORKERS,
// leaving 2 cores for the main thread + compositor) and AUTO-SCALES up toward
// the hardware cap (hardwareConcurrency-2, capped at MAX_POOL_SIZE) only when it
// measurably runs out of capacity — a dispatch pass fills every in-flight slot
// with backlog still waiting (see refillFromBacklog / maybeScaleUp). Dense
// typeset windows (Beastars) hit that and halve their cold misses with the
// extra workers; steady scenes never trigger it and stay at DEFAULT_MAX_WORKERS,
// protecting their main-thread steady state from prewarm-insertion contention.
// SUBFRAME_WORKERS (or setWorkerCount) PIN the count (base == cap == n): benches
// and embedders that want a fixed pool get exactly that and no auto-scaling.
const DEFAULT_MAX_WORKERS = 6;

let pinnedWorkerCount: number | null = (() => {
  const env = envWorkers();
  if (env !== undefined && env !== "") {
    const n = Number(env);
    if (Number.isFinite(n) && n > 0)
      return Math.min(Math.floor(n), MAX_POOL_SIZE);
  }
  return null;
})();

function hardwareWorkerCap(): number {
  let cores = 4;
  const hc = (globalThis as any)?.navigator?.hardwareConcurrency;
  if (Number.isFinite(hc) && hc > 0) cores = hc as number;
  return Math.max(1, Math.min(cores - 2, MAX_POOL_SIZE));
}

// Count the pool boots with (base) and the ceiling auto-scaling may reach (cap).
function baseWorkerCount(): number {
  if (pinnedWorkerCount !== null) return pinnedWorkerCount;
  return Math.max(1, Math.min(hardwareWorkerCap(), DEFAULT_MAX_WORKERS));
}

function workerCap(): number {
  if (pinnedWorkerCount !== null) return pinnedWorkerCount;
  return hardwareWorkerCap();
}

// Pin the worker count (base == cap == n), disabling auto-scaling; pass null to
// restore the adaptive base/cap policy. Works in the browser where
// SUBFRAME_WORKERS (process.env) is unavailable — used by the A/B benches and
// available to embedders that want a fixed pool. Takes effect on the next pool
// init; if the pool is already up and larger than n, it is torn down so the
// next dispatch reboots at the pinned size.
export function setWorkerCount(n: number | null): void {
  if (n !== null && (!Number.isFinite(n) || n <= 0)) return;
  pinnedWorkerCount =
    n === null ? null : Math.min(Math.floor(n), MAX_POOL_SIZE);
  // Reboot a live pool whenever its current size no longer matches the pinned
  // target — GROW as well as shrink. The old code only tore down on a shrink,
  // so pinning a LARGER count on a running pool (setWorkerCount(8) over a live
  // 6) left poolInited=true and the pool stuck at the old size, and the frame
  // path kept dispatching against the stale worker set. Rebooting on any size
  // change makes the re-init deterministic (bug (1)). Unpinning (null) keeps the
  // live pool; the adaptive base/cap then governs it.
  const target = pinnedWorkerCount;
  if (target !== null && workers.length > 0 && workers.length !== target) {
    for (let i = 0; i < workers.length; i++) {
      try {
        workers[i]!.resultPort?.close();
      } catch {
        /* ignore */
      }
      try {
        workers[i]!.worker.terminate();
      } catch {
        /* ignore */
      }
    }
    workers = [];
    pending.clear();
    framePending = 0;
    abortScatters("worker-count-changed");
    backlog = null;
    backlogEvents.length = 0;
    backlogNext = 0;
    poolInited = false;
  }
}

function failPool(err?: unknown): void {
  if (poolFailed) return;
  poolFailed = true;
  console.warn(
    "[subframe] worker prewarm pool disabled; falling back to inline prewarm",
    err ?? "",
  );
  // Release any events still marked attempted so the inline path can retry them.
  for (const [, p] of pending) p.attempted.delete(p.ev);
  pending.clear();
  framePending = 0;
  abortScatters("pool-failed");
  backlog = null;
  backlogEvents.length = 0;
  backlogNext = 0;
  for (let i = 0; i < workers.length; i++) {
    try {
      workers[i]!.resultPort?.close();
    } catch {
      /* ignore */
    }
    try {
      workers[i]!.worker.terminate();
    } catch {
      /* ignore */
    }
  }
  workers = [];
  docById.clear();
}

function handleResult(msg: ResultMessage): void {
  const p = pending.get(msg.taskId);
  if (!p) return;
  pending.delete(msg.taskId);
  noteWorkerHeapSample(p.workerIndex, msg);
  const pw = workers[p.workerIndex];
  if (pw && pw.inFlight > 0) pw.inFlight--;
  statResults++;
  const waited = performance.now() - p.sentAt;
  if (Number.isFinite(waited) && waited >= 0) {
    taskWallEmaMs += (waited - taskWallEmaMs) * 0.05;
  }
  if (typeof msg.ms === "number" && msg.ms >= 0) {
    statTaskCpuMsTotal += msg.ms;
    taskCpuEmaMs += (msg.ms - taskCpuEmaMs) * 0.05;
  }
  funnelNoteCompleted(p.ev, msg.ok && !!msg.entry, msg.reason);
  if (msg.ok && msg.entry) {
    try {
      if (insertPrewarmedLayers(p.ev, msg.entry)) statInserted++;
    } catch (err) {
      failPool(err);
    }
  } else {
    statNoEntry++;
    const reason =
      typeof msg.reason === "string" ? msg.reason.slice(0, 200) : "unknown";
    const count = noEntryReasons.get(reason);
    if (count !== undefined) noEntryReasons.set(reason, count + 1);
    else if (noEntryReasons.size < MAX_NO_ENTRY_REASONS)
      noEntryReasons.set(reason, 1);
  }
}

// A browser worker hit a font its realm cannot resolve (prewarm runs ahead of
// playback, so the pool's init snapshot may predate the font). Drive the app's
// resolver via getFont — resolvers that call registerFontSource (playground,
// tools) make the source snapshotable — then answer the requesting worker with
// the registered source, or null so its task fails cleanly instead of hanging.
async function handleFontRequest(
  workerIndex: number,
  name: string,
): Promise<void> {
  if (typeof name !== "string" || name.length === 0) return;
  try {
    await getFont(name);
  } catch {
    /* unresolvable on the main thread too; answer null below */
  }
  let source: string | ArrayBuffer | Uint8Array | null = null;
  const snapshot = snapshotFontSources();
  const lower = name.toLowerCase();
  for (let i = 0; i < snapshot.length; i++) {
    const s = snapshot[i]!;
    if (s.name === name || s.name.toLowerCase() === lower) {
      source = s.source;
      break;
    }
  }
  const pw = workers[workerIndex];
  if (!pw) return;
  try {
    pw.worker.postMessage({ type: "font-response", name, source });
  } catch (err) {
    failPool(err);
  }
}

// Boot one worker at slot `index` and wire its message/result plumbing. Reads
// the CURRENT font snapshot so a worker spawned mid-run by auto-scaling starts
// with the fonts the pool has resolved so far (later additions arrive via
// syncFontSources). Throws on a construction failure; callers wrap in failPool.
function spawnWorker(index: number): PoolWorker {
  const fontSearchPaths = getFontSearchPaths();
  const fontSources = snapshotFontSources();
  const canDrainPorts =
    syncResultDrainEnabled() &&
    getReceiveMessageOnPort() !== null &&
    typeof MessageChannel === "function";
  const gpuFiltersEnabled = workerGpuFiltersWanted();
  const sabArenasEnabled = sabArenasWanted();
  const worker = createPoolWorker();
  worker.onmessage = (event: MessageEvent): void => {
    const data = event.data as { type?: string; name?: string };
    if (!data) return;
    if (data.type === "result") {
      handleResult(data as unknown as ResultMessage);
      // Browsers have no synchronous drain: keep workers fed by refilling
      // the freed slot as soon as its result arrives instead of waiting
      // for the next frame's dispatch.
      refillFromBacklog();
    } else if (data.type === "frame") {
      // Whole-frame ring result (browser transfer path). The scheduler drops it
      // if its media time no longer matches a live ring slot (seek/invalidate).
      handleFrameResult(index, data as unknown as FrameArenaMessage);
    } else if (data.type === "subset") {
      // Per-frame event-scatter subset result (browser transfer path). Routed to
      // its fork-join; dropped if the frame already timed out / was aborted.
      handleSubsetResult(index, data as unknown as SubsetArenaMessage);
    } else if (data.type === "font-request") {
      void handleFontRequest(index, data.name ?? "");
    }
  };
  worker.onerror = (event: unknown): void => {
    failPool(event);
  };
  let resultPort: MessagePort | null = null;
  if (canDrainPorts) {
    // Hand the worker a dedicated port for results so the main thread can
    // sync-drain them (see drainWorkerResults). No listener is attached to
    // our end: receiveMessageOnPort only returns queued messages on ports
    // without an active handler.
    const channel = new MessageChannel();
    resultPort = channel.port1;
    worker.postMessage(
      {
        type: "init",
        fontSearchPaths,
        fontSources,
        resultPort: channel.port2,
        workerIndex: index,
        workerCount: workerCap(),
        gpuFiltersEnabled,
        allocCensusEnabled: isAllocCensusEnabled(),
        sabArenasEnabled,
      },
      [channel.port2 as unknown as Transferable],
    );
  } else {
    worker.postMessage({
      type: "init",
      fontSearchPaths,
      fontSources,
      workerIndex: index,
      workerCount: workerCap(),
      gpuFiltersEnabled,
      allocCensusEnabled: isAllocCensusEnabled(),
      sabArenasEnabled,
    });
  }
  // Prewarm is best-effort background work; never let a live worker keep a
  // Bun/Node process alive after its real work is done (CLI tools, tests).
  const unref = (worker as unknown as { unref?: () => void }).unref;
  if (typeof unref === "function") unref.call(worker);
  return {
    worker,
    inFlight: 0,
    frameInFlight: 0,
    subsetInFlight: 0,
    docsSent: new Set(),
    resultPort,
    gpuFiltersEnabled,
    arenaFreeListMirror: 0,
    heapMeasured: false,
    heapLatestBytes: 0,
    heapPeakBytes: 0,
    heapTotalBytes: 0,
    heapLimitBytes: 0,
    bitmapPoolBytes: 0,
    bitmapPoolBuckets: 0,
    bitmapPoolHits: 0,
    bitmapPoolMisses: 0,
    bitmapPoolReleased: 0,
    bitmapPoolDropped: 0,
    sabArenasEnabled: false,
    sabArenaPacked: 0,
    sabArenaFallbacks: 0,
    sabArenaGrows: 0,
    sabArenaBytes: 0,
    sabArenaHeldSlots: 0,
    sabArenaAllocatedSlots: 0,
  };
}

function initPool(): boolean {
  if (poolInited) return !poolFailed && workers.length > 0;
  poolInited = true;
  const size = baseWorkerCount();
  fontSourcesSent = snapshotFontSources().length;
  capacityPressureRuns = 0;
  try {
    for (let i = 0; i < size; i++) workers[i] = spawnWorker(i);
  } catch (err) {
    failPool(err);
    return false;
  }
  return workers.length > 0;
}

// Auto-scaling. A dispatch pass that fills every in-flight slot while the
// backlog still holds soonest-first candidates it could not place is the live
// signature of capacity loss (those events become NEVER_DISPATCHED cold misses
// on the deadline path). refillFromBacklog raises refillHitCapacity on such a
// pass; the once-per-frame dispatch (tryDispatchPrewarm) integrates it into a
// decaying run counter and grows the pool ONE worker at a time toward
// workerCap() once the counter clears a small threshold, so a brief spike does
// not scale but a sustained dense window ramps 6 -> cap within a handful of
// frames. No scale-down: warm working caches are the pool's throughput and a
// calm section that follows produces no prewarm candidates, hence no insertion
// contention from the idle extra workers.
let refillHitCapacity = false;
let capacityPressureRuns = 0;
let statScaleUps = 0;
let statMaxPending = 0;
const SCALE_UP_PRESSURE_THRESHOLD = 3;

function maybeScaleUp(): void {
  if (poolFailed || workers.length === 0) return;
  if (workers.length >= workerCap()) return;
  if (capacityPressureRuns < SCALE_UP_PRESSURE_THRESHOLD) return;
  // Auto-scaling is BROWSER-ONLY, for two measured reasons on the sync-drain
  // (Bun/Node receiveMessageOnPort) path:
  //   1. Correctness/stability: spawning a Worker + MessageChannel mid-run and
  //      immediately sync-draining its new port reliably trips the Bun <= 1.3.13
  //      MessagePort SIGSEGV (see drainWorkerResults' note). Browsers deliver
  //      results via onmessage and are unaffected.
  //   2. Throughput: on the sync-drain path the main thread absorbs each result
  //      by STRUCTURED CLONE (bitmaps are cloned, not transferred — transfer on
  //      the concurrent port path also segfaults Bun). Measured on Beastars,
  //      8 workers emit results faster than the main thread can deserialize
  //      them (~12ms/frame of drain), so extra workers only deepen the undrained
  //      backlog and WORSEN dropped frames. Browsers transfer the bitmaps, so
  //      absorption is cheap and the extra parallelism is a net win.
  // On the sync-drain path we therefore stay at the (measured-optimal) base
  // count; the browser scales toward workerCap() under sustained capacity loss.
  if (getReceiveMessageOnPort() !== null && syncResultDrainEnabled()) return;
  capacityPressureRuns = 0;
  const idx = workers.length;
  try {
    workers[idx] = spawnWorker(idx);
    statScaleUps++;
  } catch (err) {
    failPool(err);
    return;
  }
  // Use the freshly-added slot immediately rather than waiting a frame.
  refillFromBacklog();
}

function docIdFor(doc: SubtitleDocument): number {
  let id = docIds.get(doc);
  if (id === undefined) {
    id = docIdCounter++;
    docIds.set(doc, id);
    docById.set(id, doc);
  }
  return id;
}

function leastLoadedWorker(): number {
  let best = 0;
  let bestLoad = workers[0]!.inFlight;
  for (let i = 1; i < workers.length; i++) {
    const load = workers[i]!.inFlight;
    if (load < bestLoad) {
      best = i;
      bestLoad = load;
    }
  }
  return best;
}

// Pool-owned backlog: the soonest-first candidate list handed over on the
// last dispatch, consumed incrementally by refillFromBacklog. Keeping it in
// the pool (instead of dispatching only once per frame) lets pumpWorkerPool
// drain finished results and refill idle workers DURING a long frame render;
// without that, worker queues empty a few milliseconds into an expensive
// frame and the pool sits idle exactly when its parallel headroom matters
// most (the funnel showed this refill starvation — not capacity — as the
// dominant prewarm loss on dense scripts).
type Backlog = {
  doc: SubtitleDocument;
  docId: number;
  width: number;
  height: number;
  attempted: WeakSet<SubtitleEvent>;
  timeMs: number; // last known playhead; -1 when no clock was provided
};

let backlog: Backlog | null = null;
const backlogEvents: SubtitleEvent[] = [];
let backlogNext = 0;

// Dispatch tasks from the backlog until the pool is full or the backlog is
// exhausted. Soonest-deadline-first (the backlog arrives sorted by start).
// The deadline gate only applies while the pool has real competition for
// slots (pending >= worker count): an idle worker always takes the soonest
// candidate — skipping it would guarantee a deadline miss, while dispatching
// it costs nothing when nothing else is queued. Gated events are passed over
// for this pass but stay unattempted, so the next frame's candidate collection
// retries them.
function refillFromBacklog(): void {
  const b = backlog;
  if (!b || poolFailed || workers.length === 0) return;
  const capacity = workers.length * MAX_INFLIGHT_PER_WORKER;
  if (pending.size >= capacity) {
    // Every slot taken and the backlog still holds candidates: capacity loss.
    if (backlogNext < backlogEvents.length) refillHitCapacity = true;
    return;
  }
  const indexMap = eventIndexMap(b.doc.events);
  const haveClock = b.timeMs >= 0;
  const minLeadWallMs = taskWallEmaMs * DEADLINE_GATE_SAFETY;
  while (backlogNext < backlogEvents.length && pending.size < capacity) {
    const ev = backlogEvents[backlogNext++]!;
    if (b.attempted.has(ev)) continue;
    if (haveClock && pending.size >= workers.length) {
      const leadWallMs = (ev.start - b.timeMs) * wallPerMediaEma;
      if (leadWallMs < minLeadWallMs) {
        statGateSkipped++;
        funnelNoteGateSkip(ev);
        continue;
      }
    }
    // Match by index into the shared document; the worker's cloned document has
    // identical ordering (structured clone preserves array order).
    const eventIndex = indexMap.get(ev);
    if (eventIndex === undefined) continue;

    const workerIndex = leastLoadedWorker();
    const pw = workers[workerIndex]!;
    try {
      if (!pw.docsSent.has(b.docId)) {
        pw.worker.postMessage({
          type: "doc",
          docId: b.docId,
          doc: b.doc,
          fontSources: getFontRegistry(b.doc).snapshot(),
        });
        pw.docsSent.add(b.docId);
      }
      const taskId = taskIdCounter++;
      pw.worker.postMessage({
        type: "task",
        taskId,
        docId: b.docId,
        eventIndex,
        width: b.width,
        height: b.height,
      });
      pw.inFlight++;
      statDispatched++;
      pending.set(taskId, {
        ev,
        attempted: b.attempted,
        workerIndex,
        sentAt: performance.now(),
      });
      if (pending.size > statMaxPending) statMaxPending = pending.size;
      b.attempted.add(ev);
      funnelNoteDispatched(ev);
    } catch (err) {
      failPool(err);
      return;
    }
  }
  // Stopped because every slot filled while soonest-first candidates still
  // wait: the live capacity-loss signal that drives maybeScaleUp.
  if (pending.size >= capacity && backlogNext < backlogEvents.length) {
    refillHitCapacity = true;
  }
}

// Collect finished worker results and refill freed slots from the backlog.
// Called from the render path at frame start and between events, so prewarmed
// entries land in the cache mid-frame (saving events later in the SAME frame)
// and workers never starve while a long frame renders. Near-free when the
// pool has nothing in flight and no backlog. Bun/Node only for the drain
// (synchronous port receive); in browsers results arrive via onmessage, which
// triggers its own refill (see initPool).
//
// The drain is rate-limited: Bun <= 1.3.13 has a native race in
// MessagePort::tryTakeMessage (GC marker thread vs concurrent enqueue,
// SIGSEGV; fixed in Bun 1.3.14) whose exposure scales with receive-call
// frequency. Draining at most once per DRAIN_MIN_INTERVAL_MS keeps exposure
// near the pre-pump baseline while still landing results with sub-frame
// latency; tasks take ~1-4ms, so a 1ms cap costs nothing in freshness.
const DRAIN_MIN_INTERVAL_MS = 1;
let lastDrainWall = 0;

function drainWorkerResultsIfDue(force = false): void {
  const now = performance.now();
  if (!force && now - lastDrainWall < DRAIN_MIN_INTERVAL_MS) return;
  lastDrainWall = now;
  drainWorkerResults();
}

export function pumpWorkerPool(): void {
  if (userDisabled || poolFailed || workers.length === 0) return;
  if (syncResultDrainEnabled() && (pending.size > 0 || framePending > 0)) {
    drainWorkerResultsIfDue();
  }
  refillFromBacklog();
}

// Hand candidate events to the pool. Returns true when the pool handled
// dispatch (so the caller skips inline prewarm this frame), false when the pool
// is unavailable/failed and the caller should run the inline fallback. The
// candidate list replaces the pool's backlog; only events actually dispatched
// are added to `attempted`, anything left when the pool is saturated stays
// unattempted and is retried on a later frame.
export function tryDispatchPrewarm(
  doc: SubtitleDocument,
  candidates: SubtitleEvent[],
  width: number,
  height: number,
  attempted: WeakSet<SubtitleEvent>,
  timeMs?: number,
): boolean {
  if (!isWorkerPoolUsable()) return false;
  if (!initPool()) return false;
  if (workers.length === 0) return false;

  // Collect finished results FIRST: it frees in-flight capacity for the
  // dispatch below and inserts prewarmed entries before this frame's
  // deadline path would re-render them. Without this, a render loop that
  // never yields to the macrotask queue (Bun benches, batch tools) starves
  // onmessage delivery and the pool wedges at capacity after the first burst.
  if (syncResultDrainEnabled()) drainWorkerResultsIfDue(true);

  // Forward font sources registered after pool boot (browser resolvers load
  // fonts asynchronously); cheap no-op when the snapshot size is unchanged.
  syncFontSources();
  if (poolFailed || workers.length === 0) return false;

  const docId = docIdFor(doc);
  const haveClock = timeMs !== undefined && Number.isFinite(timeMs);
  if (haveClock) updateDispatchClocks(timeMs!);

  // Copy into the pool-owned backlog (the caller reuses its candidate array).
  backlogEvents.length = 0;
  for (let i = 0; i < candidates.length; i++) backlogEvents[i] = candidates[i]!;
  backlogNext = 0;
  backlog = {
    doc,
    docId,
    width,
    height,
    attempted,
    timeMs: haveClock ? timeMs! : -1,
  };

  // Fresh-backlog dispatch for this frame: measure whether the full candidate
  // set saturates the pool, then feed the once-per-frame auto-scale controller.
  refillHitCapacity = false;
  refillFromBacklog();
  if (refillHitCapacity) {
    capacityPressureRuns++;
    maybeScaleUp();
  } else if (capacityPressureRuns > 0) {
    capacityPressureRuns--;
  }
  return !poolFailed && workers.length > 0;
}

export function setWorkerPool(enabled: boolean): void {
  if (enabled) {
    userDisabled = false;
    // Allow a fresh init on next dispatch if it had been torn down.
    if (workers.length === 0) {
      poolInited = false;
      poolFailed = false;
      capacityPressureRuns = 0;
      statScaleUps = 0;
      statMaxPending = 0;
      statDrainMsTotal = 0;
      statArenaReturned = 0;
      statArenaReused = 0;
      statArenaDropped = 0;
      statAllocCensus.clear();
      refillHitCapacity = false;
    }
    return;
  }
  userDisabled = true;
  closeScatterYieldChannel();
  capacityPressureRuns = 0;
  statScaleUps = 0;
  statMaxPending = 0;
  statDrainMsTotal = 0;
  statArenaReturned = 0;
  statArenaReused = 0;
  statArenaDropped = 0;
  statAllocCensus.clear();
  refillHitCapacity = false;
  for (let i = 0; i < workers.length; i++) {
    try {
      workers[i]!.resultPort?.close();
    } catch {
      /* ignore */
    }
    try {
      workers[i]!.worker.terminate();
    } catch {
      /* ignore */
    }
  }
  workers = [];
  pending.clear();
  framePending = 0;
  abortScatters("pool-disabled");
  docById.clear();
  backlog = null;
  backlogEvents.length = 0;
  backlogNext = 0;
  poolInited = false;
}
