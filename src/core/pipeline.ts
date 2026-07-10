import type { SubtitleDocument, SubtitleEvent } from "subforge/core";
import type { GlyphBuffer } from "text-shaper";
import type { ArenaBuffer, FrameContext, BitmapLayer } from "./data/types";
import type { TraceContext } from "./trace";
import { createTraceContext, toFrameTrace } from "./trace";
import { activeEventsAtTime, frameContextFromDocument, frameEventParams } from "./frame";
import {
  tryDispatchPrewarm,
  isWorkerPoolUsable,
  pumpWorkerPool,
  ensureFrameWorkers,
  frameWorkerCount,
  pickFrameWorker,
  sendFrameRequest,
  setFrameResultHandler,
  frameResultsNeedEventLoop,
  scatterFrame,
  returnArenaBufferToWorker,
  releaseSabArenaSlotToWorker,
  getFrameThroughputStats,
  pendingWorkerTaskCount,
  resetFrameThroughputStats,
  type FrameResult,
  type SubsetPart,
} from "./worker-pool";
import { reassembleFrameArena, mergeScatterLayers, type SubsetLayers } from "./frame-arena";
import { createShapeContext, releaseGlyphBuffer } from "./shape/shaper";
import {
  renderEvent,
  noteFrameMediaTime,
  lastFrameMediaTimeMs,
  funnelNoteCandidates,
  isEventCacheReusable,
  isEventFullyStaticForFrameDedup,
  recordEventOrdinalStaticVerdicts,
} from "./pipeline/event";
import { endFrameProfile, setEventCount, setLayerCount, startFrameProfile } from "./profile";
import { getFontForStyle } from "../io/fonts/cache";
export { getEventLayerCacheStats, clearEventLayerCache } from "./pipeline/event";
export {
  isEventCacheReusable,
  setEventCacheReuseGate,
  getEventCacheReuseGate,
} from "./pipeline/event";
export { clearRasterCaches } from "./raster/event";
export { setGpuFilterProvider, getGpuFilterProvider, setGpuFilterDeferEnabled, isGpuFilterDeferEnabled, type GpuFilterProvider } from "./filters/gpu-provider";
export {
  setWorkerPool,
  setWorkerSource,
  setWorkerCount,
  getWorkerPoolStats,
  type WorkerSource,
} from "./worker-pool";

export type RenderResult = {
  layers: BitmapLayer[];
  activeEvents: SubtitleEvent[];
  frame: FrameContext;
};

type ArenaRef = {
  buffer: ArenaBuffer;
  workerId: number;
  sabSlotIdx?: number;
  byteLength: number;
  holders: number;
  publicHolders: number;
};

const RESULT_ARENAS = new WeakMap<RenderResult, ArenaRef[]>();
const EMPTY_ARENA_REFS: ArenaRef[] = [];
const PUBLIC_RESULT_HELD = new WeakMap<RenderResult, boolean>();
let lastReturnedResult: RenderResult | null = null;

function makeArenaRef(buffer: ArenaBuffer, workerId: number, sabSlotIdx?: number): ArenaRef {
  return {
    buffer,
    workerId,
    sabSlotIdx,
    byteLength: buffer.byteLength,
    holders: 0,
    publicHolders: 0,
  };
}

function attachArenaRefs(result: RenderResult, refs: ArenaRef[]): RenderResult {
  if (refs.length > 0) RESULT_ARENAS.set(result, refs);
  return result;
}

function copyArenaRefs(from: RenderResult, to: RenderResult): RenderResult {
  const refs = RESULT_ARENAS.get(from);
  if (refs && refs.length > 0) RESULT_ARENAS.set(to, refs);
  return to;
}

function arenaRefsFor(result: RenderResult | null): ArenaRef[] {
  return result ? (RESULT_ARENAS.get(result) ?? EMPTY_ARENA_REFS) : EMPTY_ARENA_REFS;
}

function recycleArenaRef(ref: ArenaRef): void {
  if (ref.buffer.byteLength <= 0) return;
  if (ref.sabSlotIdx !== undefined) {
    releaseSabArenaSlotToWorker(ref.workerId, ref.sabSlotIdx);
  } else {
    returnArenaBufferToWorker(ref.workerId, ref.buffer as ArrayBuffer);
  }
}

function maybeRecycleArenaRef(ref: ArenaRef): void {
  if (ref.holders !== 0 || ref.publicHolders !== 0) return;
  recycleArenaRef(ref);
}

function recycleUnheldResult(result: RenderResult | null): void {
  const refs = arenaRefsFor(result);
  for (let i = 0; i < refs.length; i++) {
    const ref = refs[i]!;
    maybeRecycleArenaRef(ref);
  }
}

function retainResultArenas(result: RenderResult | null): void {
  const refs = arenaRefsFor(result);
  for (let i = 0; i < refs.length; i++) refs[i]!.holders++;
}

function releaseResultArenas(result: RenderResult | null): void {
  const refs = arenaRefsFor(result);
  for (let i = 0; i < refs.length; i++) {
    const ref = refs[i]!;
    if (ref.holders <= 0) continue;
    ref.holders--;
    // Safety invariant: an arena may be transferred back to a worker, or a SAB
    // slot may be marked writable, only after both internal scheduler holders
    // (last returned, dedup previous, boundary/ring slots) AND public returned
    // RenderResults have released it. Public callers may buffer RenderResults
    // after renderFrame returns; releaseRenderResult is their explicit opt-in to
    // recycling. Without that opt-in the arena is left for GC instead of being
    // detached or overwritten under live layer views.
    maybeRecycleArenaRef(ref);
  }
}

function retainPublicResult(result: RenderResult): void {
  if (PUBLIC_RESULT_HELD.get(result) === true) return;
  const refs = arenaRefsFor(result);
  if (refs.length === 0) return;
  for (let i = 0; i < refs.length; i++) refs[i]!.publicHolders++;
  PUBLIC_RESULT_HELD.set(result, true);
}

export function releaseRenderResult(result: RenderResult | null | undefined): void {
  if (!result || PUBLIC_RESULT_HELD.get(result) !== true) return;
  PUBLIC_RESULT_HELD.set(result, false);
  const refs = arenaRefsFor(result);
  for (let i = 0; i < refs.length; i++) {
    const ref = refs[i]!;
    if (ref.publicHolders <= 0) continue;
    ref.publicHolders--;
    maybeRecycleArenaRef(ref);
  }
}

function setLastReturnedResult(result: RenderResult): RenderResult {
  retainPublicResult(result);
  if (lastReturnedResult !== result) {
    releaseResultArenas(lastReturnedResult);
    retainResultArenas(result);
    lastReturnedResult = result;
  }
  return result;
}

type FrameDedupContext = {
  width: number;
  height: number;
  marginL: number;
  marginR: number;
  marginV: number;
  wrapStyle: number;
  scaleBorderAndShadow: boolean | undefined;
  playResX: number;
  playResY: number;
  parScaleX: number;
  baseContentWidth: number;
  baseContentHeight: number;
  fitWidth: number;
  fitHeight: number;
};

type FrameDedupEntry = {
  doc: SubtitleDocument;
  context: FrameDedupContext;
  activeEvents: SubtitleEvent[];
  result: RenderResult;
};

type BoundaryIndex = {
  events: SubtitleEvent[];
  length: number;
  boundaries: Float64Array;
};

type BoundarySlot = {
  doc: SubtitleDocument;
  context: FrameDedupContext;
  timeMs: number;
  triggerTimeMs: number;
  firedAt: number;
  landedAt: number;
  activeEvents: SubtitleEvent[];
  result: RenderResult | null;
  promise: Promise<RenderResult | null> | null;
};

const BOUNDARY_LOOKAHEAD_MS = 250;
const BOUNDARY_PIPELINE_DEPTH = 2;
const BOUNDARY_SUSTAINED_PIPELINE_DEPTH = 3;
const BOUNDARY_CONCURRENCY = (() => {
  const env = Number((globalThis as any)?.process?.env?.SUBFRAME_BOUNDARY_CONCURRENCY);
  if (Number.isFinite(env)) return env <= 1 ? 1 : 2;
  return 2;
})();
const boundaryIndexCache = new WeakMap<SubtitleDocument, BoundaryIndex>();
let frameDedupEnabled =
  (globalThis as any)?.process?.env?.SUBFRAME_FRAME_DEDUP !== "0";
let frameDedupHits = 0;
let frameDedupFrames = 0;
let boundaryHits = 0;
let boundaryAwaited = 0;
let boundaryMisfires = 0;
let boundaryFiredEarly = 0;
let boundaryStale = 0;
let boundaryStaticReuseHits = 0;
let boundaryPrewarmSuppressed = 0;
let lastFrameDedup: FrameDedupEntry | null = null;
const boundarySlots: BoundarySlot[] = [];
const boundaryTimingSamples: string[] = [];

function isBunRuntime(): boolean {
  return typeof (globalThis as { Bun?: unknown }).Bun !== "undefined";
}

function sampleBoundaryTiming(slot: BoundarySlot, label: string): void {
  if (boundaryTimingSamples.length >= 12) return;
  const now = performance.now();
  const age = now - slot.firedAt;
  const lead = slot.timeMs - slot.triggerTimeMs;
  const land = slot.landedAt > 0 ? slot.landedAt - slot.firedAt : -1;
  boundaryTimingSamples.push(
    `${label} t=${slot.timeMs.toFixed(2)} lead=${lead.toFixed(2)}ms age=${age.toFixed(1)}ms land=${land.toFixed(1)}ms`,
  );
}

function previousStaticDedupContext(
  doc: SubtitleDocument,
  context: FrameDedupContext,
): boolean {
  const prev = lastFrameDedup;
  return (
    !!prev &&
    prev.doc === doc &&
    sameFrameDedupContext(prev.context, context) &&
    allEventsFullyStatic(prev.activeEvents)
  );
}

function makeFrameDedupContext(
  doc: SubtitleDocument,
  frame: FrameContext,
): FrameDedupContext {
  const params = frameEventParams(doc, frame);
  return {
    width: frame.width,
    height: frame.height,
    marginL: frame.marginL,
    marginR: frame.marginR,
    marginV: frame.marginV,
    wrapStyle: frame.wrapStyle,
    scaleBorderAndShadow: params.scaleBorderAndShadow,
    playResX: params.playResX,
    playResY: params.playResY,
    parScaleX: params.parScaleX,
    baseContentWidth: params.baseContentWidth,
    baseContentHeight: params.baseContentHeight,
    fitWidth: params.fitWidth,
    fitHeight: params.fitHeight,
  };
}

function sameFrameDedupContext(
  a: FrameDedupContext,
  b: FrameDedupContext,
): boolean {
  return (
    a.width === b.width &&
    a.height === b.height &&
    a.marginL === b.marginL &&
    a.marginR === b.marginR &&
    a.marginV === b.marginV &&
    a.wrapStyle === b.wrapStyle &&
    a.scaleBorderAndShadow === b.scaleBorderAndShadow &&
    a.playResX === b.playResX &&
    a.playResY === b.playResY &&
    a.parScaleX === b.parScaleX &&
    a.baseContentWidth === b.baseContentWidth &&
    a.baseContentHeight === b.baseContentHeight &&
    a.fitWidth === b.fitWidth &&
    a.fitHeight === b.fitHeight
  );
}

function sameActiveEventSet(
  a: readonly SubtitleEvent[],
  b: readonly SubtitleEvent[],
): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

function tryReuseFrameDedup(
  doc: SubtitleDocument,
  context: FrameDedupContext,
  activeEvents: SubtitleEvent[],
): RenderResult | null {
  const prev = lastFrameDedup;
  if (!prev) return null;
  if (prev.doc !== doc) return null;
  if (!sameFrameDedupContext(prev.context, context)) return null;
  if (!sameActiveEventSet(prev.activeEvents, activeEvents)) return null;
  for (let i = 0; i < activeEvents.length; i++) {
    if (!isEventFullyStaticForFrameDedup(activeEvents[i]!)) return null;
  }
  // Byte-identical: with the same active event refs/order, same frame context,
  // and prior layout-classified fully-static events, renderFrameInternal is a
  // pure function of those inputs. Collision/stacking and layer order depend on
  // the set/order; positions, masks, colors, and alpha are time-invariant.
  return copyArenaRefs(prev.result, {
    layers: prev.result.layers,
    activeEvents: prev.result.activeEvents,
    frame: prev.result.frame,
  });
}

function eventsHaveDirtyFlag(events: readonly SubtitleEvent[]): boolean {
  for (let i = 0; i < events.length; i++) {
    if (events[i]!.dirty) return true;
  }
  return false;
}

function boundaryIndexFor(doc: SubtitleDocument): BoundaryIndex {
  const events = doc.events;
  const cached = boundaryIndexCache.get(doc);
  if (
    cached &&
    cached.events === events &&
    cached.length === events.length &&
    !eventsHaveDirtyFlag(events)
  ) {
    return cached;
  }
  const times: number[] = [];
  for (let i = 0; i < events.length; i++) {
    const ev = events[i]!;
    if (Number.isFinite(ev.start)) times[times.length] = ev.start;
    if (Number.isFinite(ev.end)) times[times.length] = ev.end;
  }
  times.sort((a, b) => a - b);
  let write = 0;
  for (let i = 0; i < times.length; i++) {
    const t = times[i]!;
    if (write === 0 || t !== times[write - 1]) times[write++] = t;
  }
  const index = {
    events,
    length: events.length,
    boundaries: Float64Array.from(times.slice(0, write)),
  };
  boundaryIndexCache.set(doc, index);
  return index;
}

function nextBoundaryAfter(doc: SubtitleDocument, timeMs: number): number {
  const boundaries = boundaryIndexFor(doc).boundaries;
  let lo = 0;
  let hi = boundaries.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (boundaries[mid]! <= timeMs + RING_MATCH_EPS_MS) lo = mid + 1;
    else hi = mid;
  }
  return lo < boundaries.length ? boundaries[lo]! : Number.POSITIVE_INFINITY;
}

function nextActiveSetBoundaryAfter(doc: SubtitleDocument, timeMs: number): number {
  const baseEvents = activeEventsAtTime(doc, timeMs);
  let cursor = timeMs;
  for (;;) {
    const t = nextBoundaryAfter(doc, cursor);
    if (!Number.isFinite(t)) return t;
    const nextEvents = activeEventsAtTime(doc, t);
    if (!sameActiveEventSet(baseEvents, nextEvents)) return t;
    cursor = t;
  }
}

function allEventsFullyStatic(activeEvents: readonly SubtitleEvent[]): boolean {
  for (let i = 0; i < activeEvents.length; i++) {
    if (!isEventFullyStaticForFrameDedup(activeEvents[i]!)) return false;
  }
  return true;
}

function clearBoundarySlots(): void {
  for (let i = 0; i < boundarySlots.length; i++) {
    releaseResultArenas(boundarySlots[i]!.result);
  }
  boundarySlots.length = 0;
}

function boundarySchedulerActive(): boolean {
  return frameDedupEnabled && boundarySlots.length > 0;
}

function boundarySlotMatchesContext(
  slot: BoundarySlot,
  doc: SubtitleDocument,
  context: FrameDedupContext,
): boolean {
  return slot.doc === doc && sameFrameDedupContext(slot.context, context);
}

function boundarySlotIndex(slot: BoundarySlot): number {
  for (let i = 0; i < boundarySlots.length; i++) {
    if (boundarySlots[i] === slot) return i;
  }
  return -1;
}

function removeBoundarySlot(slot: BoundarySlot): boolean {
  const i = boundarySlotIndex(slot);
  if (i === -1) return false;
  releaseResultArenas(slot.result);
  slot.result = null;
  boundarySlots.splice(i, 1);
  return true;
}

function removeBoundarySlotAt(index: number): BoundarySlot {
  const slot = boundarySlots[index]!;
  releaseResultArenas(slot.result);
  slot.result = null;
  boundarySlots.splice(index, 1);
  return slot;
}

function setBoundarySlotResult(slot: BoundarySlot, result: RenderResult): void {
  if (slot.result !== result) {
    releaseResultArenas(slot.result);
    retainResultArenas(result);
    slot.result = result;
  }
}

function insertBoundarySlot(slot: BoundarySlot): void {
  let i = boundarySlots.length;
  while (i > 0 && boundarySlots[i - 1]!.timeMs > slot.timeMs) i--;
  boundarySlots.splice(i, 0, slot);
}

function findBoundarySlotForTime(timeMs: number): BoundarySlot | null {
  for (let i = 0; i < boundarySlots.length; i++) {
    const slot = boundarySlots[i]!;
    if (Math.abs(slot.timeMs - timeMs) <= RING_MATCH_EPS_MS) return slot;
  }
  return null;
}

function boundaryInFlightCount(): number {
  let count = 0;
  for (let i = 0; i < boundarySlots.length; i++) {
    if (boundarySlots[i]!.promise) count++;
  }
  return count;
}

function shouldSuppressPrewarmForBoundary(): boolean {
  // Bun's event-delivered worker results share the same worker queues for
  // boundary scatter and event-layer prewarm. During static dedup windows the
  // boundary scatter is the scheduler; letting duplicate frames enqueue
  // per-event prewarm behind/in front of it starves parked-boundary production
  // and collapses parked%. Browser workers do not show this contention, so keep
  // their prewarm behavior unchanged.
  if (!isBunRuntime()) return false;
  if (boundaryStaticReuseHits <= 0) return false;
  boundaryPrewarmSuppressed++;
  return true;
}

function boundaryPipelineDepth(): number {
  return boundaryStaticReuseHits >= 8
    ? BOUNDARY_SUSTAINED_PIPELINE_DEPTH
    : BOUNDARY_PIPELINE_DEPTH;
}

function pruneBoundarySlotsForContext(
  doc: SubtitleDocument,
  context: FrameDedupContext,
): void {
  for (let i = boundarySlots.length - 1; i >= 0; i--) {
    if (!boundarySlotMatchesContext(boundarySlots[i]!, doc, context)) {
      removeBoundarySlotAt(i);
    }
  }
}

function pruneBoundarySlotsForSchedule(
  doc: SubtitleDocument,
  timeMs: number,
  context: FrameDedupContext,
): void {
  pruneBoundarySlotsForContext(doc, context);
  // Staleness is judged against the CONSUMER's clock, never the scheduling
  // time. The chained fire after a slot lands passes that slot's own (future)
  // boundary time as `timeMs`; pruning against it discarded every still-pending
  // EARLIER slot whenever a later boundary landed first (concurrency 2 makes
  // that common) — the consumer then found no slot for its window and fell back
  // to a synchronous scatter, which starved the next boundary in turn. Measured
  // on beastars: 103 of 123 fired slots died that way (hits 20). liveMediaMs
  // is set at every renderFrame entry, so it is always current here.
  const consumerMs = lastFrameMediaTimeMs();
  const pruneMs = consumerMs >= 0 ? Math.min(timeMs, consumerMs) : timeMs;
  for (let i = boundarySlots.length - 1; i >= 0; i--) {
    const slot = boundarySlots[i]!;
    if (slot.timeMs < pruneMs - RING_MATCH_EPS_MS) {
      const hadResult = !!slot.result;
      removeBoundarySlotAt(i);
      boundaryStale++;
      sampleBoundaryTiming(slot, hadResult ? "schedule-stale-ready" : "schedule-stale-inflight");
    } else if (slot.timeMs - pruneMs > BOUNDARY_LOOKAHEAD_MS) {
      removeBoundarySlotAt(i);
    }
  }
}

function promoteFrameDedup(
  doc: SubtitleDocument,
  context: FrameDedupContext,
  result: RenderResult,
): void {
  if (lastFrameDedup?.result !== result) {
    releaseResultArenas(lastFrameDedup?.result ?? null);
    retainResultArenas(result);
  }
  lastFrameDedup = {
    doc,
    context,
    activeEvents: result.activeEvents,
    result,
  };
}

function serveReadyBoundarySlot(
  slot: BoundarySlot,
  doc: SubtitleDocument,
  context: FrameDedupContext,
  activeEvents: SubtitleEvent[],
  awaited: boolean,
): RenderResult | null {
  if (!slot || !slot.result) return null;
  if (!boundarySlotMatchesContext(slot, doc, context)) {
    removeBoundarySlot(slot);
    return null;
  }
  if (
    !sameActiveEventSet(slot.activeEvents, activeEvents) ||
    !allEventsFullyStatic(activeEvents)
  ) {
    boundaryMisfires++;
    boundaryStale++;
    removeBoundarySlot(slot);
    return null;
  }
  const result = copyArenaRefs(slot.result, {
    layers: slot.result.layers,
    activeEvents: slot.result.activeEvents,
    frame: slot.result.frame,
  });
  // Byte-identical: a parked boundary frame is rendered at the first timestamp
  // of this static active set. Any later timestamp inside the same static
  // typeset window has the same active event refs/order and same frame context,
  // so the render output is identical to a fresh render at `timeMs`.
  promoteFrameDedup(doc, context, result);
  boundaryHits++;
  if (awaited) boundaryAwaited++;
  sampleBoundaryTiming(slot, awaited ? "hit-awaited" : "hit-parked");
  removeBoundarySlot(slot);
  return result;
}

function discardDueBoundarySlots(
  timeMs: number,
  activeEvents: SubtitleEvent[],
  keep: BoundarySlot | null,
): void {
  for (let i = boundarySlots.length - 1; i >= 0; i--) {
    const slot = boundarySlots[i]!;
    if (slot === keep) continue;
    if (slot.timeMs > timeMs + RING_MATCH_EPS_MS) continue;
    const hadResult = !!slot.result;
    const mismatched = hadResult && !sameActiveEventSet(slot.activeEvents, activeEvents);
    removeBoundarySlotAt(i);
    boundaryStale++;
    sampleBoundaryTiming(slot, hadResult ? "stale-ready" : "stale-inflight");
    if (mismatched) boundaryMisfires++;
  }
}

function serveParkedBoundaryFrame(
  doc: SubtitleDocument,
  timeMs: number,
  context: FrameDedupContext,
  activeEvents: SubtitleEvent[],
): RenderResult | null {
  pruneBoundarySlotsForContext(doc, context);
  let match: BoundarySlot | null = null;
  for (let i = boundarySlots.length - 1; i >= 0; i--) {
    const slot = boundarySlots[i]!;
    if (!slot.result) continue;
    if (slot.timeMs > timeMs + RING_MATCH_EPS_MS) continue;
    if (sameActiveEventSet(slot.activeEvents, activeEvents)) {
      match = slot;
      break;
    }
  }
  if (!match) {
    for (let i = boundarySlots.length - 1; i >= 0; i--) {
      const slot = boundarySlots[i]!;
      if (!slot.result) continue;
      if (slot.timeMs > timeMs + RING_MATCH_EPS_MS) continue;
      removeBoundarySlotAt(i);
      boundaryStale++;
      boundaryMisfires++;
    }
    return null;
  }
  discardDueBoundarySlots(timeMs, activeEvents, match);
  return serveReadyBoundarySlot(match, doc, context, activeEvents, false);
}

function startBoundaryPrewarm(
  doc: SubtitleDocument,
  tB: number,
  width: number,
  height: number,
  context: FrameDedupContext,
  triggerTimeMs: number,
): void {
  const slot: BoundarySlot = {
    doc,
    context,
    timeMs: tB,
    triggerTimeMs,
    firedAt: performance.now(),
    landedAt: 0,
    activeEvents: activeEventsAtTime(doc, tB),
    result: null,
    promise: null,
  };
  insertBoundarySlot(slot);
  boundaryFiredEarly++;
  slot.promise = renderFrameScatter(doc, tB, width, height)
    .then((result) => {
      if (boundarySlotIndex(slot) === -1) {
        recycleUnheldResult(result);
        return null;
      }
      slot.landedAt = performance.now();
      setBoundarySlotResult(slot, result);
      slot.activeEvents = result.activeEvents;
      slot.promise = null;
      if (!allEventsFullyStatic(result.activeEvents)) {
        removeBoundarySlot(slot);
        return null;
      }
      maybeStartBoundaryPrewarm(
        doc,
        slot.timeMs,
        width,
        height,
        context,
        BOUNDARY_CONCURRENCY > 1,
        slot.timeMs,
      );
      return result;
    })
    .catch(() => {
      removeBoundarySlot(slot);
      return null;
    });
}

function maybeStartBoundaryPrewarm(
  doc: SubtitleDocument,
  timeMs: number,
  width: number,
  height: number,
  context: FrameDedupContext,
  allowConcurrent = BOUNDARY_CONCURRENCY > 1,
  triggerTimeMs = timeMs,
): void {
  if (!frameDedupEnabled || !isWorkerPoolUsable()) return;
  pruneBoundarySlotsForSchedule(doc, timeMs, context);
  let baseTime = timeMs;
  for (let i = 0; i < boundarySlots.length; i++) {
    const slot = boundarySlots[i]!;
    if (slot.timeMs > baseTime) baseTime = slot.timeMs;
  }
  const maxInFlight = allowConcurrent ? BOUNDARY_CONCURRENCY : 1;
  const depth = boundaryPipelineDepth();
  while (boundarySlots.length < depth) {
    if (boundaryInFlightCount() >= maxInFlight) return;
    const tB = nextActiveSetBoundaryAfter(doc, baseTime);
    if (!(tB > baseTime) || tB - timeMs > BOUNDARY_LOOKAHEAD_MS) return;
    if (findBoundarySlotForTime(tB)) {
      baseTime = tB;
      continue;
    }
    startBoundaryPrewarm(doc, tB, width, height, context, triggerTimeMs);
    baseTime = tB;
  }
}

async function awaitBoundaryFrame(
  doc: SubtitleDocument,
  timeMs: number,
  context: FrameDedupContext,
  activeEvents: SubtitleEvent[],
): Promise<RenderResult | null> {
  pruneBoundarySlotsForContext(doc, context);
  let slot: BoundarySlot | null = null;
  for (let i = boundarySlots.length - 1; i >= 0; i--) {
    const candidate = boundarySlots[i]!;
    if (!candidate.promise) continue;
    if (candidate.timeMs > timeMs + RING_MATCH_EPS_MS) continue;
    if (sameActiveEventSet(candidate.activeEvents, activeEvents)) {
      slot = candidate;
      break;
    }
    removeBoundarySlotAt(i);
    boundaryStale++;
    boundaryMisfires++;
  }
  if (!slot) return null;
  const deadline = performance.now() + ringAwaitMaxMs();
  while (boundarySlotIndex(slot) !== -1 && slot.promise && performance.now() < deadline) {
    pumpWorkerPool();
    await macrotaskYield();
  }
  if (boundarySlotIndex(slot) === -1) return null;
  if (slot.promise) {
    sampleBoundaryTiming(slot, "await-timeout");
    removeBoundarySlot(slot);
    return null;
  }
  discardDueBoundarySlots(timeMs, activeEvents, slot);
  return serveReadyBoundarySlot(slot, doc, context, activeEvents, true);
}

// Reused scratch for stable layer sorting. Holds indices into the layer array
// being sorted; grown geometrically and never released so per-frame sorting
// allocates only the output array. The sort tail runs synchronously (no await
// between claiming and releasing layerSortRef), so a single module-level
// scratch is safe under interleaved async renderFrame calls.
const EMPTY_LAYERS: BitmapLayer[] = [];
let layerSortScratch = new Int32Array(64);
let layerSortRef: BitmapLayer[] = EMPTY_LAYERS;

function compareLayerOrder(a: number, b: number): number {
  const za = layerSortRef[a]!.z;
  const zb = layerSortRef[b]!.z;
  if (za !== zb) return za - zb;
  return a - b;
}

function sortLayersStable(layers: BitmapLayer[]): BitmapLayer[] {
  const n = layers.length;
  if (n <= 1) return layers;
  if (layerSortScratch.length < n) {
    let cap = layerSortScratch.length;
    while (cap < n) cap *= 2;
    layerSortScratch = new Int32Array(cap);
  }
  const order = layerSortScratch;
  for (let i = 0; i < n; i++) order[i] = i;
  layerSortRef = layers;
  order.subarray(0, n).sort(compareLayerOrder);
  const out: BitmapLayer[] = new Array(n);
  for (let i = 0; i < n; i++) out[i] = layers[order[i]!]!;
  layerSortRef = EMPTY_LAYERS;
  return out;
}

function renumberGpuFilterGroups(
  layers: BitmapLayer[],
  nextGroupId: { value: number },
): void {
  const remap = new Map<number, number>();
  for (let i = 0; i < layers.length; i++) {
    const gpu = layers[i]!.gpuFilter;
    if (!gpu) continue;
    let mapped = remap.get(gpu.groupId);
    if (mapped === undefined) {
      mapped = nextGroupId.value++;
      remap.set(gpu.groupId, mapped);
    }
    gpu.groupId = mapped;
  }
}

async function renderFrameInternal(
  doc: SubtitleDocument,
  timeMs: number,
  width?: number,
  height?: number,
  traceCtx?: TraceContext,
): Promise<RenderResult> {
  const profileEnabled =
    typeof process !== "undefined" && !!(process as any).env?.SUBFRAME_PROFILE;
  const profile = startFrameProfile(profileEnabled);
  const frame = frameContextFromDocument(doc, timeMs, width, height);
  const {
    scaleBorderAndShadow,
    playResX,
    playResY,
    parScaleX,
    baseContentWidth,
    baseContentHeight,
    fitWidth,
    fitHeight,
  } = frameEventParams(doc, frame);
  const activeEvents = activeEventsAtTime(doc, timeMs);
  if (profile) setEventCount(activeEvents.length);

  const layers: BitmapLayer[] = [];
  const shapeCtx = createShapeContext();
  const usedGlyphBuffers: GlyphBuffer[] = [];

  const eventCtx = {
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
  };

  for (let e = 0; e < activeEvents.length; e++) {
    await renderEvent(eventCtx, activeEvents[e]!);
    // Keep the prewarm pool fed while this frame renders: collect finished
    // results (they may satisfy events LATER in this same frame) and refill
    // idle workers from the backlog. Near-free when the pool is idle; without
    // it, worker queues drain a few ms into an expensive frame and the pool
    // idles exactly when its parallelism matters most.
    pumpWorkerPool();
  }

  for (let i = 0; i < usedGlyphBuffers.length; i++) {
    releaseGlyphBuffer(usedGlyphBuffers[i]!);
  }

  const sortedLayers = sortLayersStable(layers);

  if (profile) {
    setLayerCount(sortedLayers.length);
    const done = endFrameProfile();
    if (done) {
      const blurPct = done.frameMs > 0 ? (done.blurMs / done.frameMs) * 100 : 0;
      const layoutPct = done.frameMs > 0 ? (done.layoutMs / done.frameMs) * 100 : 0;
      const rasterPct = done.frameMs > 0 ? (done.rasterMs / done.frameMs) * 100 : 0;
      const shapePct = done.frameMs > 0 ? (done.shapeMs / done.frameMs) * 100 : 0;
      const fontPct = done.frameMs > 0 ? (done.fontMs / done.frameMs) * 100 : 0;
      console.log(
        `[subframe] frame=${done.frameMs.toFixed(2)}ms layout=${done.layoutMs.toFixed(2)}ms (${layoutPct.toFixed(
          1,
        )}%) raster=${done.rasterMs.toFixed(2)}ms (${rasterPct.toFixed(
          1,
        )}%) blur=${done.blurMs.toFixed(2)}ms (${blurPct.toFixed(
          1,
        )}%) shape=${done.shapeMs.toFixed(2)}ms (${shapePct.toFixed(
          1,
        )}%) font=${done.fontMs.toFixed(2)}ms (${fontPct.toFixed(
          1,
        )}%) events=${done.eventCount} layers=${done.layerCount}`,
      );
    }
  }

  return { layers: sortedLayers, activeEvents, frame };
}

// Event-wise render-ahead: after a cheap frame, leftover frame budget renders
// upcoming events (start within the lookahead window) once, event-by-event,
// so their layers land in the event-layer cache before their start time hits
// a frame deadline. Iterating events (not sampling future frames) also
// catches 1-2 frame lifetimes. Deadline frames that already used the budget
// skip prewarming entirely. Zero-config; opt out via setRenderAhead(false)
// or SUBFRAME_RENDER_AHEAD=0.
const RENDER_AHEAD_LOOKAHEAD_MS = 2000;
const RENDER_AHEAD_TARGET_MS = 12;
const RENDER_AHEAD_MAX_SLICE_MS = 6;
let renderAheadEnabled =
  (globalThis as any)?.process?.env?.SUBFRAME_RENDER_AHEAD !== "0";

export function setRenderAhead(enabled: boolean): void {
  renderAheadEnabled = enabled;
}

export type PrepareDocumentOptions = {
  timeMs?: number;
  renderFirstFrame?: boolean;
  boundaryWarmupMs?: number;
};

export type AttachDocumentOptions = {
  timeMs?: number;
  boundaryWarmupMs?: number;
  playbackFps?: number;
};

export type AttachDocumentStats = {
  timeMs: number;
  totalMs: number;
  fontMs: number;
  workerMs: number;
  prepareMs: number;
  primeMs?: number;
  primedRingFrames?: number;
  workers: number;
};

function firstDocumentEventTime(doc: SubtitleDocument): number {
  let first = Number.POSITIVE_INFINITY;
  const events = doc.events;
  for (let i = 0; i < events.length; i++) {
    const t = events[i]!.start;
    if (Number.isFinite(t) && t < first) first = t;
  }
  return Number.isFinite(first) ? first : 0;
}

async function preResolveStyleFonts(doc: SubtitleDocument): Promise<void> {
  const pending: Promise<unknown>[] = [];
  for (const style of doc.styles.values()) {
    const boldValue = (style as { bold: boolean | number }).bold;
    const bold =
      typeof boldValue === "number" ? boldValue !== 0 : !!boldValue;
    pending[pending.length] = getFontForStyle(
      style.fontName,
      bold,
      !!style.italic,
    ).catch(() => null);
  }
  if (pending.length > 0) await Promise.all(pending);
}

type DocumentWarmupState = {
  width: number;
  height: number;
  kicked: boolean;
  prepared: boolean;
  seenFrame: boolean;
  lastTimeMs: number;
  fontPromise: Promise<void> | null;
};

const documentWarmupState = new WeakMap<SubtitleDocument, DocumentWarmupState>();
let prepareDocumentDepth = 0;

function warmupStateFor(
  doc: SubtitleDocument,
  width: number,
  height: number,
): DocumentWarmupState {
  const existing = documentWarmupState.get(doc);
  if (existing && existing.width === width && existing.height === height) {
    return existing;
  }
  const state: DocumentWarmupState = {
    width,
    height,
    kicked: false,
    prepared: false,
    seenFrame: false,
    lastTimeMs: NaN,
    fontPromise: null,
  };
  documentWarmupState.set(doc, state);
  return state;
}

function markDocumentWarmupStarted(
  doc: SubtitleDocument,
  width: number,
  height: number,
  fontPromise: Promise<void> | null,
): void {
  const state = warmupStateFor(doc, width, height);
  state.kicked = true;
  if (fontPromise) state.fontPromise = fontPromise;
}

function markDocumentWarmupPrepared(
  doc: SubtitleDocument,
  width: number,
  height: number,
): void {
  const state = warmupStateFor(doc, width, height);
  state.kicked = true;
  state.prepared = true;
}

function maybeStartDocumentAutoWarmup(
  doc: SubtitleDocument,
  timeMs: number,
  width: number,
  height: number,
): void {
  if (prepareDocumentDepth > 0) return;
  const state = warmupStateFor(doc, width, height);
  if (state.kicked || state.prepared) return;
  if (!renderAheadEnabled) return;
  const prevTimeMs = state.lastTimeMs;
  state.lastTimeMs = timeMs;
  if (!state.seenFrame) {
    state.seenFrame = true;
    return;
  }
  const delta = timeMs - prevTimeMs;
  if (!(delta > 0) || delta > RING_MAX_DELTA_MS) return;
  state.kicked = true;
  state.fontPromise = preResolveStyleFonts(doc).catch(() => undefined);
  // Product callers should not have to call prepareDocument. This background
  // kick primes the same cheap resources the explicit API does without blocking
  // playback, but only after a second forward frame proves this is playback and
  // not a one-shot/offline render. Golden/parity tools render one frame per
  // process and must not leave background workers or macrotasks alive.
  void macrotaskYield().then(() => {
    if (documentWarmupState.get(doc) !== state) return;
    if (isWorkerPoolUsable()) ensureFrameWorkers();
    dispatchPrewarmToPool(doc, timeMs, width, height);
  });
}

export async function prepareDocument(
  doc: SubtitleDocument,
  width?: number,
  height?: number,
  options: PrepareDocumentOptions | number = {},
): Promise<RenderResult | null> {
  const opts =
    typeof options === "number" ? { timeMs: options } : options;
  const timeMs = opts.timeMs ?? firstDocumentEventTime(doc);
  const frame = frameContextFromDocument(doc, timeMs, width, height);
  const fontPromise = preResolveStyleFonts(doc);
  markDocumentWarmupStarted(doc, frame.width, frame.height, fontPromise);
  await fontPromise;
  if (opts.renderFirstFrame === false) {
    markDocumentWarmupPrepared(doc, frame.width, frame.height);
    return null;
  }
  // The first render runs the real layout/raster path, which records static
  // verdicts, warms worker font snapshots, populates dedup state, and starts the
  // first boundary render before playback asks for its first display frame.
  prepareDocumentDepth++;
  try {
    const result = await renderFrame(doc, timeMs, width, height);
    const boundaryWarmupMs =
      opts.boundaryWarmupMs === undefined ? 250 : Math.max(0, opts.boundaryWarmupMs);
    if (boundaryWarmupMs > 0) {
      const deadline = performance.now() + boundaryWarmupMs;
      while (
        (boundaryInFlightCount() > 0 || ringHasInFlight()) &&
        performance.now() < deadline
      ) {
        pumpWorkerPool();
        await macrotaskYield();
      }
    } else {
      pumpWorkerPool();
      if (frameResultsNeedEventLoop()) await macrotaskYield();
    }
    markDocumentWarmupPrepared(doc, frame.width, frame.height);
    return result;
  } finally {
    prepareDocumentDepth--;
  }
}

export async function attachDocument(
  doc: SubtitleDocument,
  width?: number,
  height?: number,
  options: AttachDocumentOptions | number = {},
): Promise<AttachDocumentStats> {
  const opts =
    typeof options === "number" ? { timeMs: options } : options;
  const timeMs = opts.timeMs ?? firstDocumentEventTime(doc);
  const fps = Number(opts.playbackFps);
  const playbackDeltaMs =
    Number.isFinite(fps) && fps > 0 ? 1000 / fps : 0;
  // For playback attach, render the immediately-previous cadence point so the
  // first timed render at timeMs is a normal forward step. Preparing exactly at
  // timeMs makes that first public render look like a repeat/seek, which drops
  // the freshly-seeded ring and starts the cold grid one frame too late.
  const prepareTimeMs =
    playbackDeltaMs > 0 && timeMs >= playbackDeltaMs
      ? timeMs - playbackDeltaMs
      : timeMs;
  const warmupBudgetMs =
    opts.boundaryWarmupMs === undefined ? 500 : Math.max(0, opts.boundaryWarmupMs);
  const totalStart = performance.now();
  const fontStart = totalStart;
  await preResolveStyleFonts(doc);
  const fontMs = performance.now() - fontStart;

  const workerStart = performance.now();
  const workers = isWorkerPoolUsable() ? ensureFrameWorkers() : 0;
  if (workers > 0 && frameResultsNeedEventLoop()) await macrotaskYield();
  const workerMs = performance.now() - workerStart;

  const prepareStart = performance.now();
  const prepared = await prepareDocument(doc, width, height, {
    timeMs: prepareTimeMs,
    // Playback attach does its bounded ring/boundary wait after the grid is
    // seeded below; non-playback callers keep the previous prepareDocument wait.
    boundaryWarmupMs: playbackDeltaMs > 0 ? 0 : warmupBudgetMs,
  });
  releaseRenderResult(prepared);
  const prepareMs = performance.now() - prepareStart;
  let primeMs = 0;
  let primedRingFrames = 0;
  if (playbackDeltaMs > 0 && workers > 0) {
    const primeStart = performance.now();
    const frame =
      prepared?.frame ?? frameContextFromDocument(doc, prepareTimeMs, width, height);
    if (frameDedupEnabled) {
      const playbackFrame = frameContextFromDocument(doc, timeMs, width, height);
      const activeEvents = activeEventsAtTime(doc, timeMs);
      if (activeEvents.length > 0 && allEventsFullyStatic(activeEvents)) {
        maybeStartBoundaryPrewarm(
          doc,
          timeMs,
          playbackFrame.width,
          playbackFrame.height,
          makeFrameDedupContext(doc, playbackFrame),
          true,
          timeMs,
        );
      }
    }
    // Spend the existing bounded attach budget on the upcoming reusable event
    // set as well as whole-frame/boundary work. Without this explicit kick,
    // starting deep in a dense script can return from attach with idle workers
    // and then pay a large synchronous scatter several frames into playback.
    dispatchPrewarmToPool(doc, timeMs, frame.width, frame.height);
    primeRingGridForWarmup(playbackDeltaMs);
    primedRingFrames = seedRing(
      doc,
      prepareTimeMs,
      frame.width,
      frame.height,
      boundedRingPrimeDepth(workers, 2),
    );
    if (primedRingFrames > 0) suppressRingGuardForFrames(workers * 8);
    if (warmupBudgetMs > 0) {
      const deadline = performance.now() + warmupBudgetMs;
      while (
        (boundaryInFlightCount() > 0 ||
          ringHasInFlight() ||
          pendingWorkerTaskCount() > 0) &&
        performance.now() < deadline
      ) {
        pumpWorkerPool();
        await macrotaskYield();
      }
    } else {
      pumpWorkerPool();
      if (frameResultsNeedEventLoop()) await macrotaskYield();
    }
    primeMs = performance.now() - primeStart;
  }
  return {
    timeMs,
    totalMs: performance.now() - totalStart,
    fontMs,
    workerMs,
    prepareMs,
    primeMs,
    primedRingFrames,
    workers,
  };
}

// How far ahead workers prewarm. The event-layer cache byte budget is
// adaptive (pipeline/event.ts): when prewarmed entries start dying before
// their first read the cap grows toward its ceiling, so the old ~1000ms
// eviction cliff is gone. A larger horizon matters on dense typeset scripts
// (Beastars) where event density RISES through a sign section (measured
// 1.3k/s -> 2.9k/s across the dense window): the pool's spare capacity in the
// lighter lead-in must be spent prewarming the dense tail, which a short
// horizon makes invisible. The pool dispatches soonest-first and its deadline
// gate skips candidates it cannot finish in time, so a generous horizon does
// not waste worker throughput; the cache's temporal eviction (ended events
// first) keeps the deeper horizon from displacing entries still awaiting
// their first read. Tunable via SUBFRAME_WORKER_LOOKAHEAD.
const RENDER_AHEAD_WORKER_LOOKAHEAD_MS = (() => {
  const env = Number((globalThis as any)?.process?.env?.SUBFRAME_WORKER_LOOKAHEAD);
  return Number.isFinite(env) && env > 0 ? env : 8000;
})();

const PREWARM_ATTEMPTED = new WeakMap<SubtitleDocument, WeakSet<SubtitleEvent>>();
const prewarmLayers: BitmapLayer[] = [];
const prewarmCandidates: SubtitleEvent[] = [];

function prewarmAttemptedFor(doc: SubtitleDocument): WeakSet<SubtitleEvent> {
  let attempted = PREWARM_ATTEMPTED.get(doc);
  if (!attempted) {
    attempted = new WeakSet();
    PREWARM_ATTEMPTED.set(doc, attempted);
  }
  return attempted;
}

// Fill prewarmCandidates with not-yet-attempted events starting inside the
// lookahead window, sorted by start time (soonest first).
function collectPrewarmCandidates(
  doc: SubtitleDocument,
  timeMs: number,
  horizonMs: number,
  attempted: WeakSet<SubtitleEvent>,
): void {
  const horizon = timeMs + horizonMs;
  prewarmCandidates.length = 0;
  const events = doc.events;
  for (let i = 0; i < events.length; i++) {
    const ev = events[i]!;
    if (ev.start <= timeMs || ev.start > horizon) continue;
    if (ev.end <= ev.start) continue;
    // Never prewarm an event that will not be cached: sub-frame / time-variant
    // events can never be read from cache on a later frame, so dispatching them
    // wastes pool throughput and, once inserted, is pure retention (the OOM on
    // dense typeset scripts). Cheap O(1) duration check; no segment resolve.
    if (!isEventCacheReusable(ev)) continue;
    if (attempted.has(ev)) continue;
    prewarmCandidates[prewarmCandidates.length] = ev;
  }
  if (prewarmCandidates.length > 1) {
    prewarmCandidates.sort((a, b) => a.start - b.start);
  }
}

// Cheap, unbudgeted worker dispatch: hand upcoming events to the pool every
// frame. Workers render them in parallel and post results back into the
// event-layer cache, so the synchronous deadline path gets hits later. Runs
// even on expensive frames (unlike the inline slice) precisely because that is
// when the pool's parallel headroom matters most.
function dispatchPrewarmToPool(
  doc: SubtitleDocument,
  timeMs: number,
  width: number,
  height: number,
): void {
  if (shouldSuppressPrewarmForBoundary()) return;
  const attempted = prewarmAttemptedFor(doc);
  collectPrewarmCandidates(doc, timeMs, RENDER_AHEAD_WORKER_LOOKAHEAD_MS, attempted);
  if (prewarmCandidates.length === 0) return;
  funnelNoteCandidates(prewarmCandidates);
  tryDispatchPrewarm(doc, prewarmCandidates, width, height, attempted, timeMs);
}

// Inline render-ahead fallback used when no worker pool is available: spend the
// leftover frame budget rendering upcoming events on the main thread.
async function renderAheadSlice(
  doc: SubtitleDocument,
  timeMs: number,
  width: number,
  height: number,
  budgetMs: number,
): Promise<void> {
  const attempted = prewarmAttemptedFor(doc);
  collectPrewarmCandidates(doc, timeMs, RENDER_AHEAD_LOOKAHEAD_MS, attempted);
  if (prewarmCandidates.length === 0) return;

  const shapeCtx = createShapeContext();
  const deadline = performance.now() + budgetMs;
  for (let i = 0; i < prewarmCandidates.length; i++) {
    if (performance.now() >= deadline) break;
    const ev = prewarmCandidates[i]!;
    attempted.add(ev);
    const frame = frameContextFromDocument(doc, ev.start, width, height);
    const params = frameEventParams(doc, frame);
    prewarmLayers.length = 0;
    await renderEvent(
      {
        doc,
        frame,
        timeMs: ev.start,
        ...params,
        layers: prewarmLayers,
        shapeCtx,
        usedGlyphBuffers: [],
        prewarm: true,
      },
      ev,
    );
  }
  prewarmLayers.length = 0;
}

export async function renderFrame(
  doc: SubtitleDocument,
  timeMs: number,
  width?: number,
  height?: number,
): Promise<RenderResult> {
  noteFrameMediaTime(timeMs);
  // Land any worker results (prewarm cache entries AND parked ring frames) that
  // finished since the last frame before this frame's decision path runs; an
  // undrained result is a guaranteed miss for the frame/event it was meant to
  // save.
  pumpWorkerPool();
  const frame = frameContextFromDocument(doc, timeMs, width, height);
  maybeStartDocumentAutoWarmup(doc, timeMs, frame.width, frame.height);
  let dedupContext: FrameDedupContext | null = null;
  let startBoundaryAfterCurrentDispatch: (() => void) | null = null;
  if (frameDedupEnabled) {
    const activeEvents = activeEventsAtTime(doc, timeMs);
    dedupContext = makeFrameDedupContext(doc, frame);
    frameDedupFrames++;
    const reused = tryReuseFrameDedup(doc, dedupContext, activeEvents);
    if (reused) {
      frameDedupHits++;
      boundaryStaticReuseHits++;
      maybeStartBoundaryPrewarm(
        doc,
        timeMs,
        frame.width,
        frame.height,
        dedupContext,
        BOUNDARY_CONCURRENCY > 1,
      );
      if (isBunRuntime() && allEventsFullyStatic(activeEvents)) {
        // In Bun's event-delivered worker mode, duplicate static frames are
        // already served by frame dedup/boundary scheduling. Event-layer prewarm
        // queued here during the warmup frames occupies all worker slots before
        // playback starts, so the first boundary renders land too late and the
        // scheduler falls back to synchronous scatter. FGOBD-class animated
        // content has no static dedup hits and keeps the normal prewarm path.
        boundaryPrewarmSuppressed++;
      } else {
        dispatchPrewarmToPool(doc, timeMs, frame.width, frame.height);
      }
      return setLastReturnedResult(reused);
    }
    const parked = serveParkedBoundaryFrame(doc, timeMs, dedupContext, activeEvents);
    if (parked) {
      maybeStartBoundaryPrewarm(doc, timeMs, frame.width, frame.height, dedupContext);
      return setLastReturnedResult(parked);
    }
    const awaited = await awaitBoundaryFrame(doc, timeMs, dedupContext, activeEvents);
    if (awaited) {
      maybeStartBoundaryPrewarm(doc, timeMs, frame.width, frame.height, dedupContext);
      return setLastReturnedResult(awaited);
    }
    if (previousStaticDedupContext(doc, dedupContext)) {
      let fired = false;
      startBoundaryAfterCurrentDispatch = () => {
        if (fired) return;
        fired = true;
        // Fire the next unique static boundary as soon as the current unique
        // frame has posted its scatter work. Waiting until this frame is served
        // spends most of the ~40.6ms typeset window; firing before current work
        // is queued starves the frame being awaited. Queueing after dispatch
        // preserves current-frame priority while still buying one render period.
        maybeStartBoundaryPrewarm(doc, timeMs, frame.width, frame.height, dedupContext!);
      };
    }
  }

  let result: RenderResult;
  // Frame pipeline: opt-in, and only when a worker pool can actually run render
  // work. When off or the pool is unavailable, fall back to the single-thread
  // path below — byte-for-byte the pre-pipeline behavior.
  if (frameRingEnabled && isWorkerPoolUsable()) {
    // PRIMARY (default): the HYBRID — whole-frame ring as the throughput engine
    // (prefetch T+1..T+K across N workers, warm caches, embarrassingly parallel
    // so it can hit the pool's full N/frame_ms ceiling), with per-frame
    // event-SCATTER as the ring-MISS fallback (parallel current frame, ~22fps
    // floor) instead of a single-thread stall (~7fps). Seek/discontinuity ->
    // scatter the target + reseed. So floor 22fps, ceiling ~60fps, never 7fps.
    if (hybridEnabled) {
      result = await renderFrameHybrid(
        doc,
        timeMs,
        frame.width,
        frame.height,
        startBoundaryAfterCurrentDispatch ?? undefined,
      );
    } else if (scatterEnabled) {
      // A/B baselines: pure event-scatter (no ring) and pure whole-frame ring
      // (miss -> single-thread). Kept for the mission's ring/scatter comparison.
      result = await renderFrameScatter(
        doc,
        timeMs,
        frame.width,
        frame.height,
        startBoundaryAfterCurrentDispatch ?? undefined,
      );
    } else {
      result = await renderFrameRing(doc, timeMs, frame.width, frame.height);
    }
  } else {
    result = await renderFrameLegacy(doc, timeMs, frame.width, frame.height);
  }
  if (frameDedupEnabled && dedupContext)
    promoteFrameDedup(doc, dedupContext, result);
  if (frameDedupEnabled && dedupContext && allEventsFullyStatic(result.activeEvents)) {
    maybeStartBoundaryPrewarm(
      doc,
      timeMs,
      result.frame.width,
      result.frame.height,
      dedupContext,
    );
  }
  return setLastReturnedResult(result);
}

// Single-thread deadline path + event-wise render-ahead prewarm. Unchanged from
// the pre-frame-ring renderFrame; the STAGE 3 fallback whenever the ring is
// disabled or no worker pool is available (identical pixels either way).
async function renderFrameLegacy(
  doc: SubtitleDocument,
  timeMs: number,
  width?: number,
  height?: number,
): Promise<RenderResult> {
  const start = renderAheadEnabled ? performance.now() : 0;
  const result = await renderFrameInternal(doc, timeMs, width, height);
  if (renderAheadEnabled) {
    if (isWorkerPoolUsable()) {
      // Dispatch to the pool every frame; it is cheap and must keep workers fed
      // even while an expensive frame renders on the main thread.
      dispatchPrewarmToPool(doc, timeMs, result.frame.width, result.frame.height);
    } else {
      const budget = Math.min(
        RENDER_AHEAD_MAX_SLICE_MS,
        RENDER_AHEAD_TARGET_MS - (performance.now() - start),
      );
      if (budget > 0.5) {
        await renderAheadSlice(
          doc,
          timeMs,
          result.frame.width,
          result.frame.height,
          budget,
        );
      }
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// PRIMARY RENDER PATH — per-frame EVENT-SCATTER fork-join (STAGE 4).
//
// For an animated frame the whole-frame ring's ~130ms per-frame latency is the
// wall: 6-8 workers cannot saturate the ~8-frame lookahead needed to hide it, so
// the ring caps ~14fps. This path makes the PARALLEL UNIT SUB-FRAME instead:
// partition the frame's ~118 active events across the N workers (WHOLE events —
// a segment/shaped run is NEVER split, which would break the qtRunDelta residual
// chain and parity), fork a "renderSubset" to each, await all N, reassemble by
// (eventOrdinal, intra-event order) into the exact single-thread layer order,
// z-sort with the SAME stable comparator, and composite. Per-frame latency drops
// from ~130ms to ~makespan(biggest worker) ~13-20ms, hitting the 16.7ms period
// with NO lookahead. Every worker runs the IDENTICAL renderEventLines path with
// blur on CPU (suppressGpuDefer), so each subset's layers are FINAL and the
// reassembled+sorted set is byte-identical to the single-thread renderFrame.
//
// Parity contract: whole events only; deterministic ordinal reassembly BEFORE
// the z-sort (mergeScatterLayers); on any worker failure/timeout the frame falls
// back to a single-thread renderFrameInternal — the exact same pixels.

// Scatter is the default whenever the frame pipeline is on. SUBFRAME_SCATTER=0
// reverts to the whole-frame ring (kept for comparison / fallback); =1 forces it.
function frameScatterDefaultEnabled(): boolean {
  const env = (globalThis as any)?.process?.env?.SUBFRAME_SCATTER;
  if (env === "0") return false;
  if (env === "1") return true;
  return true;
}
let scatterEnabled = frameScatterDefaultEnabled();

export function setFrameScatter(enabled: boolean): void {
  scatterEnabled = enabled;
}
export function isFrameScatterEnabled(): boolean {
  return scatterEnabled;
}

// The HYBRID (ring primary + scatter miss-fallback + adaptive guard) is the
// default product path whenever the frame pipeline is on. Where whole-frame
// worker renders are light enough to fit the pool (measured FGOBD/kusriya:
// ~37-45ms/worker), the ring saturates at 97% hits and hits 60fps / <5% dropped,
// beating scatter. Where N concurrent whole-frame renders contend hard (beastars
// sign frames: ~753ms/worker at N=8), the adaptive guard concedes to scatter so
// the hybrid never regresses below the scatter floor. SUBFRAME_HYBRID=0 forces
// off (pure scatter / ring A-B); =1 forces on.
function frameHybridDefaultEnabled(): boolean {
  const env = (globalThis as any)?.process?.env?.SUBFRAME_HYBRID;
  if (env === "0") return false;
  if (env === "1") return true;
  return true;
}
let hybridEnabled = frameHybridDefaultEnabled();

export function setFrameHybrid(enabled: boolean): void {
  hybridEnabled = enabled;
  if (!enabled) invalidateRing();
}
export function isFrameHybridEnabled(): boolean {
  return hybridEnabled;
}

// Hybrid diagnostics: how the ring MISS was served. Ring HITS are counted in
// ringHits; scatter fallbacks land in scatterFrames (renderFrameScatter owns
// that counter), so hit% = ringHits / (ringHits + scatterFrames + scatterSingle).
let hybridSeekScatter = 0; // seek/discontinuity served by scatter + reseed
let hybridColdScatter = 0; // cold start (no cadence yet) served by scatter
let ringAwaited = 0; // ring hits that required awaiting an in-flight frame
let hybridRingConceded = 0; // misses where the guard chose scatter over the ring
// Ring depth samples, so the report can show how deep the buffer ran.
let hybridDepthSamples = 0;
let hybridReadySum = 0;
let hybridInFlightSum = 0;
let hybridReadyMax = 0;

// Scatter diagnostics (surfaced in getFramePipelineStats).
let scatterFrames = 0; // frames served by a completed fork-join
let scatterFallbacks = 0; // frames that fell back to single-thread (fail/timeout)
let scatterSingle = 0; // frames rendered single-thread (no pool / no events)
let scatterWorstSubsetMs = 0; // worst per-subset worker CPU seen (makespan proxy)
let scatterLastSubsets = 0; // subset count of the most recent fork-join

// Cheap per-event cost proxy for balancing the partition. No shaping: character
// count dominates render cost; drawings (path raster) and blur (per-pixel
// convolution) are weighted up so the makespan-dominating events do not pile on
// one worker. Only needs to be monotone enough to spread the heavy events.
// MEASURED per-event render cost, EWMA over the worker-reported ms each event
// took on its subset (noteScatterEventCosts). Static text/segment estimates were
// tried and REJECTED: ev.segments is empty at partition time (resolved lazily in
// buildEventLayout), and a text-derived proxy correlates poorly with real cost
// (Pearson ~0.24 on beastars — a long \iclip path that clips a tiny/off-screen
// region parses as "huge" but renders in <1ms), so it mis-ranks the heavy units
// and REGRESSES the makespan below plain count-balancing. The measured signal is
// accurate AND stable (a given event's warm cost barely varies frame-to-frame),
// so the LPT assignment it produces is itself stable — preserving each worker's
// warm caches — which is why it beats count-balancing (heavy-frame makespan
// -25%, worst-subset -36% in the per-worker scatter simulation) where the static
// proxy could not. Keyed by the persistent doc.events object (WeakMap).
const measuredEventCostEwma = new WeakMap<SubtitleEvent, number>();
// Running mean of all measured costs, the prior handed to an event the pool has
// not rendered yet (a fresh event on the frame it first appears). A neutral
// prior spreads unseen events by count until their first measurement lands; it
// self-corrects the very next frame the event is active.
let measuredCostMean = 4;
let measuredCostSamples = 0;
const EVENT_COST_EWMA_ALPHA = 0.25;

function estimateEventCost(ev: SubtitleEvent): number {
  const m = measuredEventCostEwma.get(ev);
  return m !== undefined ? m : measuredCostMean;
}

// Fold a worker-measured per-event render ms into the EWMA the next partition
// reads. `ms` is warm worker CPU for exactly this event (renderSubsetToLayers
// times each event it renders). Cheap; runs once per (event, frame).
function noteEventCost(ev: SubtitleEvent, ms: number): void {
  if (!(ms >= 0) || !Number.isFinite(ms)) return;
  const prev = measuredEventCostEwma.get(ev);
  const next = prev === undefined ? ms : prev + (ms - prev) * EVENT_COST_EWMA_ALPHA;
  measuredEventCostEwma.set(ev, next);
  measuredCostMean += (ms - measuredCostMean) / Math.min(++measuredCostSamples, 256);
}

// Which worker slot an event is PINNED to. The scatter path's dominant cost is
// per-worker cache warmth: a worker's transform-glyph raster is ~4x slower cold
// than warm, and an event's glyphs stay warm only on the worker that rendered it
// last frame. A cost-sorted LPT re-partition (biggest-first bin-packing) reshapes
// the whole assignment whenever ANY cost or the active set shifts, migrating
// events between workers every frame — which cold-misses their glyphs and, when
// measured live, REGRESSED the beastars heavy-frame render from ~16ms to ~56ms
// (measured in headless Chrome), swamping any balance gain. So instead of
// re-partitioning, we PIN each event to a worker the first frame it appears and
// never move it: warmth is fully preserved (an event renders on the same worker
// for its whole on-screen life) while new events are still placed cost-aware, on
// the least-loaded worker at entry. As events leave, their worker frees capacity
// and subsequent new events fill it, so load self-balances without any migration.
const pinnedWorker = new WeakMap<SubtitleEvent, number>();

// Assign the frame's active events to <= nWorkers subsets. Previously-seen events
// keep their pinned worker (warmth); each new event is pinned to the worker with
// the least CURRENT measured-cost load (balance). Returns only the non-empty
// subsets — a worker with no active events is simply not forked this frame.
function partitionEventsLPT(
  activeEvents: SubtitleEvent[],
  nWorkers: number,
): Int32Array[] {
  const k = activeEvents.length;
  const loads = partitionLoadScratch.length >= nWorkers ? partitionLoadScratch : (partitionLoadScratch = new Float64Array(nWorkers));
  for (let w = 0; w < nWorkers; w++) loads[w] = 0;
  const cost = new Float64Array(k);
  const slot = new Int32Array(k);
  // Pass 1: place already-pinned events (stable) and accumulate their load.
  for (let i = 0; i < k; i++) {
    const ev = activeEvents[i]!;
    cost[i] = estimateEventCost(ev);
    let w = pinnedWorker.get(ev) ?? -1;
    if (w < 0 || w >= nWorkers) w = -1;
    slot[i] = w;
    if (w >= 0) loads[w]! += cost[i]!;
  }
  // Pass 2: pin each new event to the least-loaded worker (ties -> lowest index,
  // deterministic) so the assignment is reproducible frame-to-frame.
  for (let i = 0; i < k; i++) {
    if (slot[i]! >= 0) continue;
    let best = 0;
    let bestLoad = loads[0]!;
    for (let w = 1; w < nWorkers; w++) {
      if (loads[w]! < bestLoad) {
        best = w;
        bestLoad = loads[w]!;
      }
    }
    slot[i] = best;
    loads[best]! += cost[i]!;
    pinnedWorker.set(activeEvents[i]!, best);
  }
  // Build per-worker ordinal lists. The result is WORKER-SLOT indexed (length
  // nWorkers, empties kept) so subset i always dispatches to physical worker i —
  // that slot->worker identity is exactly what keeps a pinned event on the same
  // warm worker. scatterFrame skips the empty slots (no fork for an idle worker).
  const buckets: number[][] = new Array(nWorkers);
  for (let w = 0; w < nWorkers; w++) buckets[w] = [];
  for (let i = 0; i < k; i++) buckets[slot[i]!]!.push(i);
  const out: Int32Array[] = new Array(nWorkers);
  for (let w = 0; w < nWorkers; w++) out[w] = Int32Array.from(buckets[w]!);
  return out;
}
let partitionLoadScratch = new Float64Array(8);

async function renderFrameScatter(
  doc: SubtitleDocument,
  timeMs: number,
  width?: number,
  height?: number,
  afterDispatch?: () => void,
): Promise<RenderResult> {
  const frame = frameContextFromDocument(doc, timeMs, width, height);
  const w = frame.width;
  const h = frame.height;
  const activeEvents = activeEventsAtTime(doc, timeMs);
  const k = activeEvents.length;

  // Boot / re-establish the frame workers (also resumes dispatch after a
  // setWorkerPool/​setWorkerCount switch — bug (1)). 0 => no usable pool.
  const n = ensureFrameWorkers();
  if (n <= 0 || k === 0) {
    scatterSingle++;
    return renderFrameInternal(doc, timeMs, w, h);
  }

  const subsets = partitionEventsLPT(activeEvents, n);
  let nonEmpty = 0;
  for (let i = 0; i < subsets.length; i++) if (subsets[i]!.length > 0) nonEmpty++;
  scatterLastSubsets = nonEmpty;

  const parts = await scatterFrame(doc, timeMs, w, h, subsets, afterDispatch);
  if (!parts) {
    // Fork-join failed / timed out: single-thread render (identical pixels).
    scatterFallbacks++;
    return renderFrameInternal(doc, timeMs, w, h);
  }

  scatterFrames++;
  const subLayers: SubsetLayers[] = new Array(parts.length);
  const arenaRefs: ArenaRef[] = [];
  const nextGpuGroupId = { value: 1 };
  let worstMs = 0;
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i]!;
    if (p.ms > worstMs) worstMs = p.ms;
    if (p.arena.byteLength > 0) {
      arenaRefs[arenaRefs.length] = makeArenaRef(p.arena, p.workerIdx, p.sabSlotIdx);
    }
    const layers = reassembleFrameArena(p.arena, p.meta, p.count);
    // gpuGroupCounter is realm-local. Each worker starts at zero, but the
    // WebGPU backend deduplicates filter groups across the merged frame by
    // groupId. Renumber each subset into one frame-local namespace so unrelated
    // worker-produced glyphs never share source masks.
    renumberGpuFilterGroups(layers, nextGpuGroupId);
    subLayers[i] = {
      layers,
      ordinals: p.ordinals,
      staticOrdinals: p.staticOrdinals ?? new Int32Array(0),
      nonStaticOrdinals: p.nonStaticOrdinals ?? new Int32Array(0),
    };
    recordEventOrdinalStaticVerdicts(
      activeEvents,
      p.staticOrdinals,
      p.nonStaticOrdinals,
    );
    // Fold this subset's per-event warm render ms into the cost EWMA the NEXT
    // frame's partition reads, so LPT balances by measured cost (parity-free —
    // the partition never changes pixels). costOrdinals[j] indexes activeEvents.
    const co = p.costOrdinals;
    const cm = p.costMs;
    if (co && cm) {
      const m = Math.min(co.length, cm.length);
      for (let j = 0; j < m; j++) {
        const o = co[j]!;
        if (o >= 0 && o < k) noteEventCost(activeEvents[o]!, cm[j]!);
      }
    }
  }
  if (worstMs > scatterWorstSubsetMs) scatterWorstSubsetMs = worstMs;
  // EMA of the scatter makespan (worst subset), the hybrid's guard reference:
  // it compares the ring's per-frame production time (frameCpuEmaMs / N) against
  // this to decide, on a miss, whether awaiting the ring or scattering is faster.
  scatterMakespanEma = scatterMakespanEma === 0 ? worstMs : scatterMakespanEma + (worstMs - scatterMakespanEma) * 0.2;

  const layers = sortLayersStable(mergeScatterLayers(subLayers));
  return attachArenaRefs({ layers, activeEvents, frame }, arenaRefs);
}
// EMA of the scatter fork-join makespan (worst subset ms). 0 until the first
// scatter runs (cold frame / miss bootstraps it).
let scatterMakespanEma = 0;

// ---------------------------------------------------------------------------
// FRAME PIPELINE — whole-frame-per-worker ring (STAGE 2 scheduler + STAGE 3
// seek/fallback).
//
// renderFrame is called with an arbitrary media time. Under uniform playback
// the ring observes the per-call step (delta), keeps up to N future whole-frame
// renders in flight at t+delta, t+2*delta, ..., and parks each finished frame
// (Stage-1 arena) keyed by its media time. A later renderFrame(t) that matches a
// parked frame reassembles it (zero-copy views onto the arena), z-sorts with the
// SAME stable comparator renderFrameInternal uses, and returns it — no main-
// thread raster. The worker ran the IDENTICAL render path over every active
// event, so the reassembled+sorted layer set equals the single-thread result
// for that time (0 pixels diff in the same blur realm).
//
// A ring hit is only ever taken for a parked frame whose render time equals the
// requested time within RING_MATCH_EPS_MS — a bound far below any pixel-visible
// animation step (1/64px quantization swallows it) yet wide enough to absorb the
// float non-associativity of a uniform caller's t0 + i*step. So the win only
// appears when the caller's timeline reproduces the predicted grid; any other
// time is a MISS and renders synchronously on the main thread — the exact
// single-thread pixels. That keeps the ring a pure performance layer: hit or
// miss, the returned pixels match the single-thread path.
//
// Static-cacheable events still populate the main-thread event-layer cache on
// every synchronous (cold / seek / miss) render, so the fallback path keeps its
// cross-frame reuse; the ring's worker renders the WHOLE frame (Stage-1
// contract) so hits need no separate main-thread merge.
//
// STAGE 3: a delta discontinuity (seek, rate change, reverse) invalidates the
// ring and renders the target synchronously on the main thread — the parity-safe
// equivalent of a scatter (Stage-1 exposes only whole-frame worker renders, no
// per-event subset primitive), with the same latency as the single-thread
// fallback — then re-seeds the ring ahead once the new step is confirmed.

// Ring hit tolerance. Sized just above the ~1e-10 ms float non-associativity
// between a uniform caller's successive times (measured: t0 + i*step and the
// additive prediction t + k*delta diverge by ~1e-10) so those legitimately-equal
// times still match, yet ~1e-3x the smallest time step that could perturb any
// quantized layer parameter — a served frame within this bound composites
// identically to the requested time. Larger values are pure hit-rate at no
// measured parity cost on this content; 0 forces exact-double match (fewer hits
// on a multiply-stepped caller, since t0 + i*step rarely reproduces the additive
// prediction bit-for-bit). Override with SUBFRAME_FRAME_RING_EPS.
const RING_MATCH_EPS_MS = (() => {
  const v = Number((globalThis as any)?.process?.env?.SUBFRAME_FRAME_RING_EPS);
  return Number.isFinite(v) && v >= 0 ? v : 1e-9;
})();
// A per-call step larger than this is not smooth playback; treat as a seek.
const RING_MAX_DELTA_MS = 1000;
// Continuity tolerance on the step: within this of the learned delta is "same
// cadence"; outside is a rate change / seek.
const RING_DELTA_ABS_TOL_MS = 0.25;
const RING_DELTA_REL_TOL = 0.125;
// Require this many consecutive same-cadence steps before dispatching any worker
// frame. Keeps single/double-call callers (unit tests, one-off renders) fully on
// the single-thread path — the ring never boots a pool for them.
const RING_SEED_MIN_RUN = 2;

// Default ON in the browser (the real-GPU playback target this ring exists for);
// default OFF under Bun/Node where heavy worker-port draining of whole-frame
// arenas is the documented Bun <= 1.3.13 segfault surface and where the test
// suite must stay on the deterministic single-thread path. Force either way with
// SUBFRAME_FRAME_PIPELINE=1|0.
function frameRingDefaultEnabled(): boolean {
  const env = (globalThis as any)?.process?.env?.SUBFRAME_FRAME_PIPELINE;
  if (env === "0") return false;
  if (env === "1") return true;
  return typeof (globalThis as any).Bun === "undefined";
}
let frameRingEnabled = frameRingDefaultEnabled();

// Enable/disable the ring at runtime. Disabling invalidates any parked frames so
// the next call starts clean on the single-thread path.
export function setFramePipeline(enabled: boolean): void {
  frameRingEnabled = enabled;
  if (!enabled) invalidateRing();
}
export function isFramePipelineEnabled(): boolean {
  return frameRingEnabled;
}

type RingEntry = {
  doc: SubtitleDocument;
  timeMs: number; // exact media time the worker rendered / is rendering
  ready: boolean; // false while in flight, true once the arena has landed
  arena: ArenaBuffer | null;
  arenaRef: ArenaRef | null;
  meta: Float64Array | null;
  count: number;
  staticOrdinals: Int32Array | null;
  nonStaticOrdinals: Int32Array | null;
};
// Small (<= 2N) parked-frame set. Linear scans are cheaper than a Map here and
// avoid float-key hashing; N <= 6 so the ring holds a handful of entries.
const ring: RingEntry[] = [];
let ringLastTime = NaN; // media time of the previous renderFrame call
let ringDelta = NaN; // learned playback step (ms); NaN until confirmed
let ringContinuousRun = 0; // consecutive same-cadence steps
let ringHandlerInstalled = false;
// Document + resolution the ring is currently predicting for. A change in any of
// them makes every parked/in-flight frame wrong (different doc events, or layers
// packed at the old size), so the ring is dropped and the cadence relearned.
let ringLastDoc: SubtitleDocument | null = null;
let ringLastW = 0;
let ringLastH = 0;

let ringHits = 0;
let ringMisses = 0;
let ringSeeks = 0;
let ringStaleDrops = 0;
let ringErrors = 0;
let ringGuardGraceUntilProduced = 0;

function installRingHandler(): void {
  if (ringHandlerInstalled) return;
  ringHandlerInstalled = true;
  setFrameResultHandler(onFrameResult);
}

// Index of any ring entry (ready or in flight) whose time matches t, or -1.
function findRingIndex(t: number): number {
  for (let i = 0; i < ring.length; i++) {
    if (Math.abs(ring[i]!.timeMs - t) <= RING_MATCH_EPS_MS) return i;
  }
  return -1;
}

function recycleRawArena(
  workerId: number,
  buffer: ArenaBuffer | null,
  sabSlotIdx?: number,
): void {
  if (!buffer || buffer.byteLength <= 0) return;
  if (sabSlotIdx !== undefined) releaseSabArenaSlotToWorker(workerId, sabSlotIdx);
  else returnArenaBufferToWorker(workerId, buffer as ArrayBuffer);
}

function releaseRingEntry(entry: RingEntry): void {
  if (entry.arenaRef) {
    recycleArenaRef(entry.arenaRef);
    entry.arenaRef = null;
  } else if (entry.arena) {
    // A defensive fallback for partially-filled entries; normal ready ring
    // entries always have arenaRef set with their origin worker id.
    entry.arena = null;
  }
}

function removeRingEntryAt(index: number): RingEntry {
  const entry = ring[index]!;
  releaseRingEntry(entry);
  ring.splice(index, 1);
  return entry;
}

// A finished worker frame arrives. Match it to its in-flight slot; a no-match
// means the slot was invalidated (seek) or evicted (stale) — drop it and let its
// buffers be collected. An error result removes the slot so the requested time
// falls through to a synchronous render.
function onFrameResult(r: FrameResult): void {
  const i = findRingIndex(r.timeMs);
  if (i === -1) {
    ringStaleDrops++;
    recycleRawArena(r.workerIdx, r.error ? null : r.arena, r.sabSlotIdx);
    return;
  }
  const e = ring[i]!;
  if (e.ready) {
    recycleRawArena(r.workerIdx, r.error ? null : r.arena, r.sabSlotIdx);
    return; // already landed (defensive)
  }
  if (r.error) {
    removeRingEntryAt(i);
    ringErrors++;
    return;
  }
  e.ready = true;
  e.arena = r.arena;
  e.arenaRef = makeArenaRef(r.arena, r.workerIdx, r.sabSlotIdx);
  e.meta = r.meta;
  e.count = r.count;
  e.staticOrdinals = r.staticOrdinals ?? null;
  e.nonStaticOrdinals = r.nonStaticOrdinals ?? null;
  recordEventOrdinalStaticVerdicts(
    activeEventsAtTime(e.doc, r.timeMs),
    r.staticOrdinals,
    r.nonStaticOrdinals,
  );
}

// Drop parked/in-flight entries strictly in the past. An evicted in-flight entry
// keeps rendering on its worker but its result no longer matches the ring, so it
// is dropped on arrival (findRingIndex miss). Keeps the ring bounded and never
// serves a stale frame.
function evictStaleRing(t: number): void {
  for (let i = ring.length - 1; i >= 0; i--) {
    if (ring[i]!.timeMs < t - RING_MATCH_EPS_MS) removeRingEntryAt(i);
  }
}

// Take a READY parked frame for time t (removing it), or null.
function takeReadyRing(t: number): RingEntry | null {
  for (let i = 0; i < ring.length; i++) {
    const e = ring[i]!;
    if (e.ready && Math.abs(e.timeMs - t) <= RING_MATCH_EPS_MS) {
      ring.splice(i, 1);
      return e;
    }
  }
  return null;
}

function invalidateRing(): void {
  for (let i = 0; i < ring.length; i++) releaseRingEntry(ring[i]!);
  ring.length = 0;
}

function suppressRingGuardForFrames(frames: number): void {
  if (!(frames > 0)) return;
  const until = getFrameThroughputStats().produced + Math.floor(frames);
  if (until > ringGuardGraceUntilProduced) ringGuardGraceUntilProduced = until;
}

function ringHasInFlight(): boolean {
  for (let i = 0; i < ring.length; i++) if (!ring[i]!.ready) return true;
  return false;
}

// Yield exactly one macrotask so queued worker `message` events (frame results)
// are delivered before the ring is re-checked. Only needed in the browser, where
// results arrive via worker.onmessage and a render-bound caller loop that never
// returns to the event loop would otherwise never receive them. A MessageChannel
// ping is a task that runs immediately (no setTimeout clamp) and, being queued
// after any already-pending worker results, guarantees those are processed first.
let ringYieldChannel: MessageChannel | null = null;
let ringYieldResolve: (() => void) | null = null;

function closeRingYieldChannel(): void {
  const channel = ringYieldChannel;
  ringYieldChannel = null;
  if (channel) {
    channel.port1.onmessage = null;
    channel.port1.close();
    channel.port2.close();
  }
  const resolve = ringYieldResolve;
  ringYieldResolve = null;
  resolve?.();
}

function macrotaskYield(): Promise<void> {
  if (typeof MessageChannel === "undefined") return Promise.resolve();
  if (!ringYieldChannel) {
    ringYieldChannel = new MessageChannel();
    ringYieldChannel.port1.onmessage = () => {
      const r = ringYieldResolve;
      ringYieldResolve = null;
      if (r) r();
    };
    (ringYieldChannel.port1 as unknown as { start?: () => void }).start?.();
  }
  return new Promise<void>((resolve) => {
    ringYieldResolve = resolve;
    ringYieldChannel!.port2.postMessage(0);
  });
}

type StepClass = "cold" | "continuous" | "discontinuity";

// Classify this call's step relative to the last, learning/updating the delta.
// Re-learns the delta on every continuous step so predictions track the caller's
// actual latest cadence (keeps t+k*delta on the caller's grid for exact hits).
function classifyStep(t: number): StepClass {
  const prev = ringLastTime;
  ringLastTime = t;
  if (Number.isNaN(prev)) {
    ringDelta = NaN;
    ringContinuousRun = 0;
    return "cold";
  }
  const d = t - prev;
  if (!(d > 0) || d > RING_MAX_DELTA_MS) {
    // Reverse, repeat, or a jump too large to be smooth playback: a seek.
    ringDelta = NaN;
    ringContinuousRun = 0;
    return "discontinuity";
  }
  if (Number.isNaN(ringDelta)) {
    // First measured step after a cold start / seek: learn it, but do not seed
    // until it is confirmed by a second matching step (RING_SEED_MIN_RUN).
    ringDelta = d;
    ringContinuousRun = 1;
    return "continuous";
  }
  const tol = Math.max(RING_DELTA_ABS_TOL_MS, ringDelta * RING_DELTA_REL_TOL);
  if (Math.abs(d - ringDelta) <= tol) {
    ringDelta = d;
    ringContinuousRun++;
    return "continuous";
  }
  // Cadence changed (rate change / small seek): re-anchor on the new step.
  ringDelta = d;
  ringContinuousRun = 1;
  return "discontinuity";
}

// Lookahead depth K: how many future frames the ring keeps buffered ahead of the
// playhead. It must cover the per-worker frame LATENCY at the playback rate:
// K >= ceil(frameCpuMs / delta) so a frame dispatched K steps ahead finishes
// before it is needed (~130ms / 16.7ms ~= 8). We buffer DEEPER than that (up to
// ~2N) so light frames prefetch runway that heavy runs then drain — the ring
// becomes a shock absorber, turning a heavy frame into a HIT off the buffer
// instead of a scatter stall. Parked (ready) frames do not count against the
// per-worker in-flight cap, so this horizon (not the queue depth) sets the
// buffer. Bounded by SUBFRAME_RING_LOOKAHEAD (absolute) and the 2N+ arena cap.
const RING_LOOKAHEAD_ABS = (() => {
  const v = Number((globalThis as any)?.process?.env?.SUBFRAME_RING_LOOKAHEAD);
  return Number.isFinite(v) && v > 0 ? Math.floor(v) : 0;
})();

function ringLookahead(n: number): number {
  if (RING_LOOKAHEAD_ABS > 0) return RING_LOOKAHEAD_ABS;
  // Cover one worker's warm frame latency, then buffer to ~2N for the shock
  // absorber. frameCpuEmaMs seeds ~130 before the first measurement lands.
  const d = ringDelta;
  const latency = getFrameThroughputStats().cpuEmaMs;
  const cover = d > 0 ? Math.ceil(latency / d) + 2 : 2 * n;
  return Math.min(Math.max(cover, 2 * n), 3 * n);
}

// Keep up to K future whole-frame renders buffered at t+delta .. t+K*delta.
// Only not-yet-parked/in-flight times are dispatched; each goes to the
// least-frame-loaded worker with a free queue slot. When every worker queue is
// full pickFrameWorker returns -1 and we stop — the undispatched far frames are
// picked up on later calls as workers free. No-op until the cadence is confirmed
// and a pool is available (boots it lazily here, never for a one-off render).
function seedRing(
  doc: SubtitleDocument,
  t: number,
  width: number,
  height: number,
  maxLookahead?: number,
): number {
  if (boundarySchedulerActive()) return 0;
  if (ringContinuousRun < RING_SEED_MIN_RUN) return 0;
  if (Number.isNaN(ringDelta) || ringDelta <= 0) return 0;
  const n = ensureFrameWorkers();
  if (n <= 0) return 0;
  const d = ringDelta;
  let K = ringLookahead(n);
  if (maxLookahead !== undefined) {
    const m = Math.floor(maxLookahead);
    K = m > 0 ? Math.min(K, m) : 0;
  }
  if (K <= 0) return 0;
  // Ring bound: the K-deep horizon plus slack for the worker-held in-flight
  // frames that have not yet parked. Keeps memory to ~(K+N) arenas.
  const cap = K + n;
  let dispatched = 0;
  for (let k = 1; k <= K; k++) {
    const p = t + k * d;
    if (findRingIndex(p) !== -1) continue;
    if (ring.length >= cap) break;
    const widx = pickFrameWorker();
    if (widx < 0) break;
    if (!sendFrameRequest(widx, doc, p, width, height)) break;
    dispatched++;
    ring[ring.length] = {
      doc,
      timeMs: p,
      ready: false,
      arena: null,
      arenaRef: null,
      meta: null,
      count: 0,
      staticOrdinals: null,
      nonStaticOrdinals: null,
    };
  }
  return dispatched;
}

const DEFAULT_PLAYBACK_DELTA_MS = 1000 / 60;

function boundedRingPrimeDepth(workers: number, queueDepth: number): number {
  if (workers <= 0) return 0;
  const depth = queueDepth > 0 ? Math.floor(queueDepth) : 1;
  // Cold attach/seek priming should be small and predictable: fill the existing
  // per-worker frame queue as requested but do not use the full adaptive ring
  // horizon here. Normal continuous playback expands the horizon after these
  // first slots start landing.
  return Math.min(workers * depth, 12);
}

function primeRingGridForWarmup(previousDelta: number): void {
  ringDelta =
    previousDelta > 0 && previousDelta <= RING_MAX_DELTA_MS
      ? previousDelta
      : DEFAULT_PLAYBACK_DELTA_MS;
  ringContinuousRun = RING_SEED_MIN_RUN;
}

function composeAfterScatterDispatch(
  a: (() => void) | undefined,
  b: () => void,
): () => void {
  return () => {
    if (a) a();
    b();
  };
}

async function renderFrameRing(
  doc: SubtitleDocument,
  timeMs: number,
  width?: number,
  height?: number,
): Promise<RenderResult> {
  installRingHandler();
  const frame = frameContextFromDocument(doc, timeMs, width, height);
  const w = frame.width;
  const h = frame.height;

  // A new document or output size invalidates every parked/in-flight frame; drop
  // them and relearn the cadence from scratch (this call becomes a cold render).
  if (doc !== ringLastDoc || w !== ringLastW || h !== ringLastH) {
    ringLastDoc = doc;
    ringLastW = w;
    ringLastH = h;
    invalidateRing();
    ringLastTime = NaN;
    ringDelta = NaN;
    ringContinuousRun = 0;
  }

  const previousDelta = ringDelta;
  const cls = classifyStep(timeMs);

  if (cls === "cold") {
    // No cadence yet: render synchronously, nothing to seed.
    return renderFrameInternal(doc, timeMs, w, h);
  }
  if (cls === "discontinuity") {
    // STAGE 3 seek/rate-change: drop the (now-wrong) ring, render the target on
    // the main thread (parity-safe, same cost as the single-thread fallback),
    // and seed the new position from the last known playback cadence while this
    // frame is being served. The next frame validates or drops that grid.
    ringSeeks++;
    invalidateRing();
    primeRingGridForWarmup(previousDelta);
    const seekWorkers = frameWorkerCount();
    seedRing(doc, timeMs, w, h, boundedRingPrimeDepth(seekWorkers, 1));
    suppressRingGuardForFrames(seekWorkers * 4);
    const result = await renderFrameInternal(doc, timeMs, w, h);
    seedRing(doc, timeMs, w, h, boundedRingPrimeDepth(seekWorkers, 1));
    return result;
  }

  // Continuous cadence: try the ring.
  evictStaleRing(timeMs);
  let hit = takeReadyRing(timeMs);
  // Browser bootstrap: no ready frame but renders are in flight and this runtime
  // delivers results only through the event loop — yield once so a just-finished
  // worker frame lands, then re-check before falling back to a sync render.
  // Without this, a render-bound caller loop starves onmessage and the ring
  // never warms up. Bun/Node sync-drain in pumpWorkerPool, so this is skipped.
  if (!hit && ringHasInFlight() && frameResultsNeedEventLoop()) {
    await macrotaskYield();
    hit = takeReadyRing(timeMs);
  }
  if (hit) {
    ringHits++;
    seedRing(doc, timeMs, w, h);
    const layers = sortLayersStable(reassembleFrameArena(hit.arena!, hit.meta!, hit.count));
    return attachArenaRefs(
      {
        layers,
        activeEvents: activeEventsAtTime(doc, timeMs),
        frame,
      },
      hit.arenaRef ? [hit.arenaRef] : [],
    );
  }
  // Miss (not predicted yet, or worker not finished): render synchronously and
  // keep seeding so the ring catches up.
  ringMisses++;
  const result = await renderFrameInternal(doc, timeMs, w, h);
  seedRing(doc, timeMs, w, h);
  return result;
}

// ---------------------------------------------------------------------------
// HYBRID — ring primary + scatter miss-fallback (the product path).
//
// Same cadence machinery as renderFrameRing, but a MISS never single-threads:
//   hit          -> serve the parked frame (reassemble + z-sort), reseed.
//   miss         -> renderFrameScatter THIS frame (parallel current frame,
//                   ~22fps floor, and its fork-join await yields the event loop
//                   so in-flight ring frames LAND while it runs), then reseed.
//   cold         -> scatter (no cadence to predict yet).
//   seek / rate  -> invalidate the ring, scatter the target, reseed ahead.
// The ring's per-worker whole-frame renders (embarrassingly parallel, no barrier)
// are the throughput engine; scatter is the safety net that keeps the floor at
// ~22fps and, critically, keeps the main thread yielding so the ring warms up
// instead of starving on 132ms sync blocks. Parity is identical either way: ring
// hits, scatter frames, and the sync fallback are all 0-pixel vs single-thread.
async function renderFrameHybrid(
  doc: SubtitleDocument,
  timeMs: number,
  width?: number,
  height?: number,
  afterScatterDispatch?: () => void,
): Promise<RenderResult> {
  installRingHandler();
  const frame = frameContextFromDocument(doc, timeMs, width, height);
  const w = frame.width;
  const h = frame.height;

  // A new document or output size invalidates every parked/in-flight frame.
  if (doc !== ringLastDoc || w !== ringLastW || h !== ringLastH) {
    ringLastDoc = doc;
    ringLastW = w;
    ringLastH = h;
    invalidateRing();
    ringLastTime = NaN;
    ringDelta = NaN;
    ringContinuousRun = 0;
  }

  const previousDelta = ringDelta;
  const cls = classifyStep(timeMs);

  if (cls === "cold") {
    // No cadence yet: serve the current frame in parallel (scatter), not a
    // 132ms single-thread block. Do not seed a guessed grid here: the first
    // scatter owns all workers and an optimistic ring seed competes with it,
    // making the load/seek worst-frame worse. Discontinuities with a known prior
    // cadence are primed below; true cold starts use the explicit/auto warmup.
    hybridColdScatter++;
    return renderFrameScatter(doc, timeMs, w, h, afterScatterDispatch);
  }
  if (cls === "discontinuity") {
    // Seek / rate change: the ring is now wrong. Scatter the target (parallel,
    // ~22fps) and start seeding the new grid as soon as the target scatter has
    // posted. The next call still validates the guessed cadence, so a one-off
    // seek cannot serve mismatched frames.
    hybridSeekScatter++;
    invalidateRing();
    const seekWorkers = frameWorkerCount();
    const result = await renderFrameScatter(
      doc,
      timeMs,
      w,
      h,
      composeAfterScatterDispatch(afterScatterDispatch, () => {
        primeRingGridForWarmup(previousDelta);
        seedRing(doc, timeMs, w, h, boundedRingPrimeDepth(seekWorkers, 1));
        suppressRingGuardForFrames(seekWorkers * 4);
      }),
    );
    seedRing(doc, timeMs, w, h, boundedRingPrimeDepth(seekWorkers, 1));
    return result;
  }

  // Continuous cadence.
  evictStaleRing(timeMs);
  sampleRingDepth();

  // Adaptive guard, evaluated EVERY continuous frame. ringPerFrameMs is the
  // ring's per-frame PRODUCTION time: its per-worker warm whole-frame ms spread
  // across N workers (frameCpuEmaMs / N). When that exceeds the scatter makespan,
  // the whole-frame ring is the SLOWER engine — beastars runs N concurrent
  // whole-frame renders that contend to ~558ms/worker (~70ms/frame at N=8) vs
  // scatter's ~45ms makespan — so we STOP feeding the ring (gate every seedRing
  // below) and stop awaiting it: the buffer drains and the hybrid degrades to
  // pure scatter, never regressing below it. On light content the ring produces
  // in a few ms/frame (FGOBD ~4ms/frame << ~11ms scatter) so this never trips and
  // the ring wins with ~0.5ms parked hits. Gating on EVERY frame (not just misses)
  // is what makes it bite: otherwise a 96%-parked-hit heavy frame keeps refilling
  // the slow buffer and the guard never sees a miss to act on.
  const nWorkers = frameWorkerCount() || 1;
  const tp = getFrameThroughputStats();
  const ringPerFrameMs = tp.cpuEmaMs / nWorkers;
  // SUSTAINABILITY guard (the primary heavy-content concede). The ring only
  // smooths playback while it stays AHEAD of the consumer: its amortized
  // production time per frame — per-worker whole-frame ms spread across N workers
  // — must fit inside the playback period. When it cannot (beastars: ~410ms/worker
  // / 8 = ~51ms >> the 16.7ms period), the ring buffer DEPLETES and every few
  // frames the consumer STALLS on an in-flight whole-frame render — the periodic
  // ~900ms+ spike (a scatter fallback then queues BEHIND those in-flight whole
  // frames and blows past its makespan). Scatter's bounded makespan (~45-90ms) is
  // far smoother, so concede whenever the ring cannot sustain the frame rate.
  //
  // The concede is DECAYING (reacts to the recent whole-frame ms via the EMA, so
  // a mid-stream density rise flips it within ~10-20 frames — the real-playback
  // case) yet cold-start robust: it is gated on >= 3N produced frames, by which
  // point the EMA's 130ms cold-start seed and a light script's first few COLD
  // whole-frame renders have washed out. That gate is what keeps FGOBD/kusriya on
  // the ring — at produced>=N their cumulative-cold mean tripped the guard and
  // dropped them from 98% ring hits to scatter. It is also STABLE (no scatter
  // makespan feedback), fixing the old scatterMakespanEma-only guard that
  // oscillated: concede -> scatter runs clean -> makespan drops -> un-concede ->
  // ring reseeds -> blocks scatter -> 900ms spike, which is why h8 still spiked
  // despite 126 concedes. The ring must be measurably slow AND warm to concede.
  const period = ringDelta > 0 ? ringDelta : 1000 / 60;
  const ringWarm = tp.produced >= 3 * nWorkers;
  const ringGuardReady = ringWarm && tp.produced >= ringGuardGraceUntilProduced;
  const ringUnsustainable = ringGuardReady && ringPerFrameMs > period * RING_SUSTAIN_MARGIN;
  const ringLosing =
    ringUnsustainable ||
    (ringGuardReady &&
      scatterMakespanEma > 0 &&
      ringPerFrameMs > scatterMakespanEma * RING_GUARD_MARGIN);

  let hit = takeReadyRing(timeMs);
  if (hit) {
    ringHits++;
    if (!ringLosing) seedRing(doc, timeMs, w, h); // stop refilling once losing
    const layers = sortLayersStable(reassembleFrameArena(hit.arena!, hit.meta!, hit.count));
    return attachArenaRefs(
      {
        layers,
        activeEvents: activeEventsAtTime(doc, timeMs),
        frame,
      },
      hit.arenaRef ? [hit.arenaRef] : [],
    );
  }
  // Not parked yet. While the ring is WINNING, if the pool is ALREADY RENDERING
  // this exact frame (seeded a few frames back, near the front of a worker
  // queue), AWAIT it instead of scattering a duplicate. This is the saturation
  // unlock:
  //   - zero redundant work — we wait for the frame the pool is already making;
  //   - while we wait, the OTHER workers finish FUTURE frames, so the ring buffer
  //     BUILDS during the wait (full ring efficiency, no barrier);
  //   - it avoids the scatter-on-miss trap, where the current frame queued BEHIND
  //     the deep ring backlog and ballooned to ~800ms — the tail that capped the
  //     hybrid at 13fps despite 85% hits.
  // Consecutive awaits pace the consumer to the pool's production rate
  // (N / frame_ms ~ 60fps on light content), the ring's throughput ceiling.
  if (!ringLosing && findRingIndex(timeMs) !== -1) {
    const deadline = performance.now() + ringAwaitMaxMs();
    for (;;) {
      pumpWorkerPool(); // Bun: sync-drain result ports. Browser: cheap no-op.
      hit = takeReadyRing(timeMs);
      if (hit) break;
      if (findRingIndex(timeMs) === -1) break; // errored / evicted under us
      if (performance.now() >= deadline) break; // worker wedged — fall to scatter
      await macrotaskYield(); // browser: deliver onmessage; Bun: let threads run
    }
    if (hit) {
      ringHits++;
      ringAwaited++;
      seedRing(doc, timeMs, w, h);
      const layers = sortLayersStable(reassembleFrameArena(hit.arena!, hit.meta!, hit.count));
      return attachArenaRefs(
        {
          layers,
          activeEvents: activeEventsAtTime(doc, timeMs),
          frame,
        },
        hit.arenaRef ? [hit.arenaRef] : [],
      );
    }
  }
  // Genuine miss (gap / seed lag / await timed out) or the ring conceded to the
  // guard: serve this frame via event-scatter (parallel current frame, ~22fps
  // floor). Re-seed only while the ring is still competitive.
  if (ringLosing) hybridRingConceded++;
  ringMisses++;
  const result = await renderFrameScatter(doc, timeMs, w, h, afterScatterDispatch);
  if (!ringLosing) seedRing(doc, timeMs, w, h);
  return result;
}

// How much worse than scatter the ring's per-frame production must be before the
// hybrid concedes. Just above 1 gives the ring a little credit for its buffering
// and ~0.5ms parked-hit cost so a near-tie stays on the ring; light content beats
// scatter by ~3x so it never trips there, and beastars is ~1.5x worse so it does.
const RING_GUARD_MARGIN = 1.05;

// How far the ring's amortized per-frame production may exceed the playback
// period before the sustainability guard concedes to scatter. Just above 1 (with
// a little slack so a ring that only marginally keeps up is not thrashed): the
// separation is large in practice — beastars runs ~3x over the period, FGOBD/
// kusriya ~0.1-0.3x under it — so this never trips on content the ring can
// actually sustain.
const RING_SUSTAIN_MARGIN = 1.1;

// How long to wait for an in-flight ring frame before giving up and scattering.
// ~2x the measured per-worker frame ms: long enough that an in-flight current
// frame (near the front of its queue) almost always lands, short enough that a
// genuinely wedged worker falls through to the scatter fallback promptly. We
// break out the instant the frame lands, so this only bounds the pathological
// case; normal awaits resolve in the frame's remaining render time.
function ringAwaitMaxMs(): number {
  const c = getFrameThroughputStats().cpuEmaMs;
  const v = c * 2;
  // Keep this wide enough for near-miss whole-frame renders to land. A tight
  // cap turns almost-finished ring work into a scatter fallback, duplicating the
  // frame and spiking the tail while the original worker render still contends.
  return v < 120 ? 120 : v > 400 ? 400 : v;
}

// Sample ring occupancy each continuous frame for the saturation report.
function sampleRingDepth(): void {
  let ready = 0;
  let inFlight = 0;
  for (let i = 0; i < ring.length; i++) {
    if (ring[i]!.ready) ready++;
    else inFlight++;
  }
  hybridDepthSamples++;
  hybridReadySum += ready;
  hybridInFlightSum += inFlight;
  if (ready > hybridReadyMax) hybridReadyMax = ready;
}

export type FramePipelineStats = {
  enabled: boolean;
  scatter: boolean;
  hybrid: boolean;
  dedupHits: number;
  dedupFrames: number;
  boundaryHits: number;
  boundaryAwaited: number;
  boundaryMisfires: number;
  boundaryFiredEarly: number;
  boundaryStale: number;
  boundaryPrewarmSuppressed: number;
  boundaryDepth: number;
  boundaryTimingSamples: string[];
  boundarySlots: number;
  boundaryReady: number;
  boundaryInFlight: number;
  workers: number;
  ringSize: number;
  ready: number;
  inFlight: number;
  delta: number;
  continuousRun: number;
  hits: number;
  misses: number;
  seeks: number;
  staleDrops: number;
  errors: number;
  // Per-frame event-scatter (fallback / A/B) diagnostics.
  scatterFrames: number;
  scatterFallbacks: number;
  scatterSingle: number;
  scatterWorstSubsetMs: number;
  scatterLastSubsets: number;
  // Hybrid saturation instrument: how misses were served + ring occupancy +
  // whole-frame production. hit% = hits / (hits + scatterFrames + scatterSingle).
  hybridColdScatter: number;
  hybridSeekScatter: number;
  ringAwaited: number; // ring hits that needed an await (in-flight, not yet parked)
  ringConceded: number; // misses the adaptive guard routed to scatter (ring losing)
  ringReadyAvg: number; // mean parked (ready) frames per continuous frame
  ringInFlightAvg: number; // mean in-flight (rendering/queued) frames
  ringReadyMax: number; // deepest the ready buffer ever got
  frameProduced: number; // whole frames workers finished + main thread absorbed
  frameErrors: number;
  frameCpuEmaMs: number; // per-worker warm frame render ms (should be ~130)
  frameCpuMsTotal: number;
};

export function getFramePipelineStats(): FramePipelineStats {
  let ready = 0;
  for (let i = 0; i < ring.length; i++) if (ring[i]!.ready) ready++;
  let boundaryReady = 0;
  let boundaryInFlight = 0;
  for (let i = 0; i < boundarySlots.length; i++) {
    if (boundarySlots[i]!.result) boundaryReady++;
    if (boundarySlots[i]!.promise) boundaryInFlight++;
  }
  const tp = getFrameThroughputStats();
  const samples = hybridDepthSamples || 1;
  return {
    enabled: frameRingEnabled,
    scatter: scatterEnabled,
    hybrid: hybridEnabled,
    dedupHits: frameDedupHits,
    dedupFrames: frameDedupFrames,
    boundaryHits,
    boundaryAwaited,
    boundaryMisfires,
    boundaryFiredEarly,
    boundaryStale,
    boundaryPrewarmSuppressed,
    boundaryDepth: boundaryPipelineDepth(),
    boundaryTimingSamples: boundaryTimingSamples.slice(),
    boundarySlots: boundarySlots.length,
    boundaryReady,
    boundaryInFlight,
    workers: frameWorkerCount(),
    ringSize: ring.length,
    ready,
    inFlight: ring.length - ready,
    delta: ringDelta,
    continuousRun: ringContinuousRun,
    hits: ringHits,
    misses: ringMisses,
    seeks: ringSeeks,
    staleDrops: ringStaleDrops,
    errors: ringErrors,
    scatterFrames,
    scatterFallbacks,
    scatterSingle,
    scatterWorstSubsetMs,
    scatterLastSubsets,
    hybridColdScatter,
    hybridSeekScatter,
    ringAwaited,
    ringConceded: hybridRingConceded,
    ringReadyAvg: hybridReadySum / samples,
    ringInFlightAvg: hybridInFlightSum / samples,
    ringReadyMax: hybridReadyMax,
    frameProduced: tp.produced,
    frameErrors: tp.errors,
    frameCpuEmaMs: tp.cpuEmaMs,
    frameCpuMsTotal: tp.cpuMsTotal,
  };
}

// Reset ring scheduler state (parked frames + learned cadence + counters).
// Callers switching documents or seeking out-of-band can force a clean slate.
export function resetFramePipeline(): void {
  closeRingYieldChannel();
  invalidateRing();
  releaseResultArenas(lastReturnedResult);
  lastReturnedResult = null;
  releaseResultArenas(lastFrameDedup?.result ?? null);
  lastFrameDedup = null;
  clearBoundarySlots();
  frameDedupHits = 0;
  frameDedupFrames = 0;
  boundaryHits = 0;
  boundaryAwaited = 0;
  boundaryMisfires = 0;
  boundaryFiredEarly = 0;
  boundaryStale = 0;
  boundaryStaticReuseHits = 0;
  boundaryPrewarmSuppressed = 0;
  boundaryTimingSamples.length = 0;
  ringLastTime = NaN;
  ringDelta = NaN;
  ringContinuousRun = 0;
  ringLastDoc = null;
  ringLastW = 0;
  ringLastH = 0;
  ringHits = 0;
  ringMisses = 0;
  ringSeeks = 0;
  ringStaleDrops = 0;
  ringErrors = 0;
  ringGuardGraceUntilProduced = 0;
  scatterFrames = 0;
  scatterFallbacks = 0;
  scatterSingle = 0;
  scatterWorstSubsetMs = 0;
  scatterLastSubsets = 0;
  hybridColdScatter = 0;
  hybridSeekScatter = 0;
  ringAwaited = 0;
  hybridRingConceded = 0;
  scatterMakespanEma = 0;
  hybridDepthSamples = 0;
  hybridReadySum = 0;
  hybridInFlightSum = 0;
  hybridReadyMax = 0;
  resetFrameThroughputStats();
}

export async function renderFrameWithTrace(
  doc: SubtitleDocument,
  timeMs: number,
  width?: number,
  height?: number,
): Promise<{ result: RenderResult; trace: ReturnType<typeof toFrameTrace> }> {
  const frame = frameContextFromDocument(doc, timeMs, width, height);
  const traceCtx = createTraceContext(frame.timeMs, frame.width, frame.height);
  const result = await renderFrameInternal(
    doc,
    timeMs,
    frame.width,
    frame.height,
    traceCtx,
  );
  return { result, trace: toFrameTrace(traceCtx) };
}
