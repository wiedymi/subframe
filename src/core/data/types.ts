import type { Fixed26_6 } from "../math/fixed";

export type ColorRGBA = [number, number, number, number];
export type ArenaBuffer = ArrayBuffer | SharedArrayBuffer;

export type FrameContext = {
  timeMs: number;
  width: number;
  height: number;
  marginL: number;
  marginR: number;
  marginV: number;
  wrapStyle: number;
};

export type GlyphRun = {
  fontName: string;
  fontSizePx: number;
  glyphIds: number[];
  advances: Fixed26_6[];
  offsets: Array<{ x: Fixed26_6; y: Fixed26_6 }>;
};

export type LayoutLine = {
  glyphs: GlyphRun[];
  x: Fixed26_6;
  y: Fixed26_6;
  width: Fixed26_6;
  height: Fixed26_6;
};

// Deferred-filter descriptor: set only when a GPU filter provider is active and
// the layer qualifies (see src/core/filters/gpu-provider.ts). The backend
// produces the filtered pixels on the GPU. Layers sharing filtered inputs share
// a `groupId`; `source` selects which produced buffer this layer composites.
// When present, `bitmap` holds the UNFILTERED source mask (fill role) and is
// only ever consumed by the WebGPU backend with GPU filters enabled.
// Which GPU-produced buffer a layer composites. `outlinePunched` is always
// punch(copy(outlineRaw), fill), so shadow variants reduce to these three
// (verified vs the CPU FILL_IN_SHADOW ordering).
export type GpuFilterSource = "fill" | "outlineRaw" | "outlinePunched";
export type GpuFilterDesc = {
  groupId: number;
  source: GpuFilterSource;
  r2x: number;
  r2y: number;
  // Per-layer subpixel shift (quantized 1/64ths, each in [0,63]) the GPU bakes in
  // via bShiftH/bShiftV — exactly what normalizeLayerOrigin's shiftBitmapSubpixel
  // does on the CPU path. The core computes these from the layer's fractional
  // origin and leaves the layer origin integer.
  sx: number;
  sy: number;
  // Source masks (unfiltered). fill is always present; outline present when the
  // group has a border. Dims are the pre-blur mask dims.
  fillMask: Uint8Array;
  fillW: number;
  fillH: number;
  fillStride: number;
  outlineMask?: Uint8Array;
  outlineW?: number;
  outlineH?: number;
  outlineStride?: number;
  // Integer punch offsets (fixOutlineBitmap alignment), for outline/shadow
  // sources that are punched. Absent => no punch.
  punchOX?: number;
  punchOY?: number;
  punchFX?: number;
  punchFY?: number;
};

export type BitmapLayer = {
  bitmap: Uint8Array;
  width: number;
  height: number;
  stride: number;
  originX: Fixed26_6;
  originY: Fixed26_6;
  color: ColorRGBA;
  z: number;
  clip?:
    | { type: "rect"; x0: number; y0: number; x1: number; y1: number; inverse: boolean }
    | {
        type: "mask";
        bitmap: Uint8Array;
        width: number;
        height: number;
        stride: number;
        originX: number;
        originY: number;
        inverse: boolean;
      };
  gpuFilter?: GpuFilterDesc;
};

export type RenderItem = {
  textureId: number;
  x: Fixed26_6;
  y: Fixed26_6;
  width: Fixed26_6;
  height: Fixed26_6;
  color: ColorRGBA;
};

// ---------------------------------------------------------------------------
// Frame-arena wire format (whole-frame-per-worker ring, STAGE 1).
//
// A worker renders EVERY active layer of a future frame and bump-packs their
// masks into ONE arena ArrayBuffer; a parallel Float64Array carries the
// per-layer geometry/color/clip/gpuFilter fields. Both are transferred to the
// main thread, which rebuilds BitmapLayer[] as zero-copy subarray views via
// reassembleFrameArena (src/core/frame-arena.ts). Packer + reassembler are the
// only two places that know the slot layout; FRAME_ARENA_META_STRIDE is the
// per-layer width and must stay in sync with the M_* offsets in frame-arena.ts.

// Number of Float64 slots the metadata array uses per packed layer.
export const FRAME_ARENA_META_STRIDE = 40;

// Whole-frame render result a worker posts for a "renderFrame" request. `arena`
// holds every layer mask (plus clip-mask and gpuFilter source masks) tightly
// packed; `meta` is FRAME_ARENA_META_STRIDE-wide per layer; `count` is the
// layer count (meta.length / FRAME_ARENA_META_STRIDE). Both buffers are
// transferred on the browser path.
export type FrameArenaMessage = {
  type: "frame";
  arena: ArenaBuffer;
  meta: Float64Array;
  count: number;
  timeMs: number;
  sabSlotIdx?: number;
  staticOrdinals?: Int32Array;
  nonStaticOrdinals?: Int32Array;
  // True when the worker packed this result into a buffer previously returned
  // by the main thread's arena recycler.
  arenaReused?: boolean;
  // Worker-side render CPU (ms) for this whole frame — the ring's per-worker
  // frame render time (should be ~130ms warm). Drives the pool's frame-throughput
  // accounting (getFrameThroughputStats).
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
  allocCensus?: Record<string, { bytes: number; count: number }>;
  // Set only when the worker failed to render the frame; arena is then empty.
  error?: string;
};

// Per-frame event-scatter subset result a worker posts for a "renderSubset"
// request (PRIMARY path). Same arena/meta layout as FrameArenaMessage but scoped
// to ONE subset of the frame's active events, plus `ordinals` — the per-layer
// event ordinal (position in activeEventsAtTime) the main thread merges on to
// reconstruct single-thread insertion order. `frameId`/`subsetIdx` route the
// fork-join. All three buffers are transferred on the browser path.
export type SubsetArenaMessage = {
  type: "subset";
  frameId: number;
  subsetIdx: number;
  arena: ArenaBuffer;
  meta: Float64Array;
  ordinals: Int32Array;
  count: number;
  timeMs: number;
  sabSlotIdx?: number;
  staticOrdinals?: Int32Array;
  nonStaticOrdinals?: Int32Array;
  // True when the worker packed this result into a buffer previously returned
  // by the main thread's arena recycler.
  arenaReused?: boolean;
  // Worker-side render CPU (ms) for this subset — the makespan term.
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
  allocCensus?: Record<string, { bytes: number; count: number }>;
  // Per-event warm render cost for the measured-cost LPT balancer: costOrdinals[j]
  // is the event ordinal (position in activeEventsAtTime) and costMs[j] the ms it
  // took on this worker. Parity-free feedback (steers partition, not pixels).
  costOrdinals?: Int32Array;
  costMs?: Float64Array;
  // Set only when the worker failed; arena/meta/ordinals are then empty.
  error?: string;
};
