import type { SubtitleDocument, SubtitleEvent } from "subforge/core";
import type { FrameContext } from "./data/types";

export type FrameEventParams = {
  scaleBorderAndShadow: boolean | undefined;
  playResX: number;
  playResY: number;
  parScaleX: number;
  baseContentWidth: number;
  baseContentHeight: number;
  fitWidth: number;
  fitHeight: number;
};

// Frame-level scalars shared by every event in a frame. Lives here (not in
// pipeline.ts) so the worker prewarm path can rebuild an identical render
// context without importing the frame orchestrator.
export function frameEventParams(
  doc: SubtitleDocument,
  frame: FrameContext,
): FrameEventParams {
  const playResX = doc.info.playResX || frame.width;
  const playResY = doc.info.playResY || frame.height;
  const parScaleX = computeParScaleX(doc, frame);
  const contentWidth = Math.max(
    0,
    frame.width - (frame.marginL + frame.marginR),
  );
  const contentHeight = Math.max(0, frame.height - frame.marginV * 2);
  const baseContentWidth = contentWidth > 0 ? contentWidth : frame.width;
  const baseContentHeight = contentHeight > 0 ? contentHeight : frame.height;
  const fitWidth =
    baseContentWidth > 0 && baseContentHeight > 0
      ? baseContentWidth * frame.height >= baseContentHeight * frame.width
        ? frame.width
        : (baseContentWidth * frame.height) / baseContentHeight
      : frame.width;
  const fitHeight =
    baseContentWidth > 0 && baseContentHeight > 0
      ? baseContentWidth * frame.height <= baseContentHeight * frame.width
        ? frame.height
        : (baseContentHeight * frame.width) / baseContentWidth
      : frame.height;
  return {
    scaleBorderAndShadow: doc.info.scaleBorderAndShadow,
    playResX,
    playResY,
    parScaleX,
    baseContentWidth,
    baseContentHeight,
    fitWidth,
    fitHeight,
  };
}

export function frameContextFromDocument(
  doc: SubtitleDocument,
  timeMs: number,
  width?: number,
  height?: number,
): FrameContext {
  const w = width ?? doc.info.playResX ?? 1920;
  const h = height ?? doc.info.playResY ?? 1080;
  return {
    timeMs,
    width: w,
    height: h,
    marginL: 0,
    marginR: 0,
    marginV: 0,
    wrapStyle: doc.info.wrapStyle ?? 0,
  };
}

export function computeParScaleX(
  doc: SubtitleDocument,
  frame: FrameContext,
): number {
  const info = doc.info as unknown as {
    par?: number;
    layoutResX?: number;
    layoutResY?: number;
    storageWidth?: number;
    storageHeight?: number;
  };
  let par = Number.isFinite(info.par) ? (info.par as number) : 1;
  const layoutResX = Number.isFinite(info.layoutResX)
    ? (info.layoutResX as number)
    : 0;
  const layoutResY = Number.isFinite(info.layoutResY)
    ? (info.layoutResY as number)
    : 0;
  const storageWidth = Number.isFinite(info.storageWidth)
    ? (info.storageWidth as number)
    : 0;
  const storageHeight = Number.isFinite(info.storageHeight)
    ? (info.storageHeight as number)
    : 0;
  const hasLayout = layoutResX > 0 && layoutResY > 0;

  if (par === 0 || hasLayout) {
    if (
      frame.width > 0 &&
      frame.height > 0 &&
      (hasLayout || (storageWidth > 0 && storageHeight > 0))
    ) {
      const dar = frame.width / frame.height;
      const layoutX = hasLayout
        ? layoutResX
        : storageWidth > 0
          ? storageWidth
          : doc.info.playResX;
      const layoutY = hasLayout
        ? layoutResY
        : storageHeight > 0
          ? storageHeight
          : doc.info.playResY;
      const sar = layoutY !== 0 ? layoutX / layoutY : 1;
      par = sar !== 0 ? dar / sar : 1;
    } else {
      par = 1;
    }
  }

  if (!Number.isFinite(par) || par <= 0) return 1;
  return par;
}

// Per-document index of events sorted by start time. Lets activeEventsAtTime
// binary-search the events that could be live instead of scanning the whole
// document every frame. Cached by the events-array identity and invalidated
// when its identity or length changes.
type EventTimeIndex = {
  events: SubtitleEvent[];
  length: number;
  // Original event indices sorted by start time (stable by original index).
  order: Int32Array;
  // starts[k] === events[order[k]].start, kept parallel for branchless search.
  starts: Float64Array;
};

const eventTimeIndexCache = new WeakMap<SubtitleEvent[], EventTimeIndex>();

// Reused scratch for collecting active original indices. Truncated (not
// reallocated) each call and sorted by (layer, original index). activeEventsAtTime
// runs fully synchronously, so a single module-level scratch is safe.
const EMPTY_EVENTS: SubtitleEvent[] = [];
const activeScratch: number[] = [];
let activeSortRef: SubtitleEvent[] = EMPTY_EVENTS;

function compareActive(a: number, b: number): number {
  const la = activeSortRef[a]!.layer;
  const lb = activeSortRef[b]!.layer;
  if (la !== lb) return la - lb;
  return a - b;
}

function getEventTimeIndex(events: SubtitleEvent[]): EventTimeIndex {
  const cached = eventTimeIndexCache.get(events);
  if (cached && cached.length === events.length) return cached;
  const n = events.length;
  const order = new Int32Array(n);
  for (let i = 0; i < n; i++) order[i] = i;
  // Stable sort by start time, tie-break by original index so ties keep
  // document order.
  order.sort((a, b) => {
    const sa = events[a]!.start;
    const sb = events[b]!.start;
    if (sa !== sb) return sa - sb;
    return a - b;
  });
  const starts = new Float64Array(n);
  for (let i = 0; i < n; i++) starts[i] = events[order[i]!]!.start;
  const index: EventTimeIndex = { events, length: n, order, starts };
  eventTimeIndexCache.set(events, index);
  return index;
}

export function activeEventsAtTime(
  doc: SubtitleDocument,
  timeMs: number,
): SubtitleEvent[] {
  const events = doc.events;
  const index = getEventTimeIndex(events);
  const order = index.order;
  const starts = index.starts;
  const n = index.length;

  // Upper bound: first position whose start > timeMs. Everything before it has
  // start <= timeMs and is a candidate; everything after cannot be active yet.
  let lo = 0;
  let hi = n;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (starts[mid]! <= timeMs) lo = mid + 1;
    else hi = mid;
  }
  const upper = lo;

  const active = activeScratch;
  active.length = 0;
  for (let k = 0; k < upper; k++) {
    const i = order[k]!;
    // start <= timeMs is guaranteed by the binary search; only end matters.
    if (events[i]!.end > timeMs) active[active.length] = i;
  }

  if (active.length > 1) {
    activeSortRef = events;
    active.sort(compareActive);
    activeSortRef = EMPTY_EVENTS;
  }

  const ordered: SubtitleEvent[] = new Array(active.length);
  for (let i = 0; i < active.length; i++) ordered[i] = events[active[i]!]!;
  return ordered;
}
