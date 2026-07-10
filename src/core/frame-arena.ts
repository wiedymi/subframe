// Whole-frame-per-worker ring — STAGE 1: render loop + arena pack/reassemble.
//
// A worker renders EVERY active layer of a future frame with the IDENTICAL
// render path the main thread uses (activeEventsAtTime -> buildEventLayout ->
// renderEventLines), collecting BitmapLayers in the exact single-thread
// event/line/role order, then z-sorts them the same way renderFrameInternal
// does so the packed order is composite-ready. packFrameArena bump-packs every
// layer mask (plus any clip mask and gpuFilter source masks) into ONE arena
// ArrayBuffer and a parallel Float64Array of per-layer metadata; the main
// thread rebuilds BitmapLayer[] as zero-copy subarray views via
// reassembleFrameArena. Round-tripping the LOGICAL pixel grid (width*height read
// through stride) makes the reassembled layers composite byte-identically to the
// single-thread renderFrame — masks are repacked tight (stride === width), which
// preserves every pixel a compositor reads while dropping padding.
//
// This module only READS the raster/layout stages (renderEventLines,
// buildEventLayout); it never modifies them.
import type { SubtitleDocument, SubtitleEvent } from "subforge/core";
import type { GlyphBuffer } from "text-shaper";
import type {
  ArenaBuffer,
  BitmapLayer,
  ColorRGBA,
  GpuFilterDesc,
  GpuFilterSource,
} from "./data/types";
import { FRAME_ARENA_META_STRIDE } from "./data/types";
import { activeEventsAtTime, frameContextFromDocument, frameEventParams } from "./frame";
import { buildEventLayout } from "./layout/event";
import { renderEventLines } from "./raster/event";
import { recordAllocCensus } from "./raster/bitmap";
import { releaseGlyphBuffer, type ShapeContext } from "./shape/shaper";

// Per-layer metadata slot offsets (Float64). Must fit inside
// FRAME_ARENA_META_STRIDE; the static check below fails the module load if a
// slot is ever added past the stride without bumping it.
const M_ARENA_OFF = 0; // byte offset of the main mask in the arena
const M_W = 1;
const M_H = 2;
const M_STRIDE = 3; // packed stride (== width; masks are repacked tight)
const M_ORIGIN_X = 4;
const M_ORIGIN_Y = 5;
const M_COL_R = 6;
const M_COL_G = 7;
const M_COL_B = 8;
const M_COL_A = 9;
const M_Z = 10;
const M_CLIP_KIND = 11; // 0 none, 1 rect, 2 mask
const M_CLIP_INV = 12; // clip.inverse (0/1)
const M_CLIP_A = 13; // rect x0 | mask originX
const M_CLIP_B = 14; // rect y0 | mask originY
const M_CLIP_C = 15; // rect x1 | mask width
const M_CLIP_D = 16; // rect y1 | mask height
const M_CLIP_MASK_OFF = 17; // byte offset of clip mask (mask kind only)
const M_CLIP_MASK_STRIDE = 18; // packed clip-mask stride (== mask width)
const M_GPU = 19; // 0/1 gpuFilter present
const M_GPU_GROUP = 20;
const M_GPU_SRC = 21; // 0 fill, 1 outlineRaw, 2 outlinePunched
const M_GPU_R2X = 22;
const M_GPU_R2Y = 23;
const M_GPU_SX = 24;
const M_GPU_SY = 25;
const M_GPU_FILL_OFF = 26; // byte offset of gpuFilter fill mask
const M_GPU_FILL_W = 27;
const M_GPU_FILL_H = 28;
const M_GPU_FILL_STRIDE = 29; // packed (== fillW)
const M_GPU_HAS_OUTLINE = 30; // 0/1
const M_GPU_OUT_OFF = 31; // byte offset of gpuFilter outline mask
const M_GPU_OUT_W = 32;
const M_GPU_OUT_H = 33;
const M_GPU_OUT_STRIDE = 34; // packed (== outlineW)
const M_GPU_HAS_PUNCH = 35; // 0/1 punch offsets present
const M_GPU_PUNCH_OX = 36;
const M_GPU_PUNCH_OY = 37;
const M_GPU_PUNCH_FX = 38;
const M_GPU_PUNCH_FY = 39;

// Load-time guard: keep FRAME_ARENA_META_STRIDE wide enough for every slot.
if (M_GPU_PUNCH_FY >= FRAME_ARENA_META_STRIDE) {
  throw new Error("FRAME_ARENA_META_STRIDE too small for frame-arena meta slots");
}

const SRC_FILL = 0;
const SRC_OUTLINE_RAW = 1;
const SRC_OUTLINE_PUNCHED = 2;
const EMPTY_BITMAP = new Uint8Array(0);

function sourceToCode(src: GpuFilterSource): number {
  if (src === "fill") return SRC_FILL;
  if (src === "outlineRaw") return SRC_OUTLINE_RAW;
  return SRC_OUTLINE_PUNCHED;
}

function codeToSource(code: number): GpuFilterSource {
  if (code === SRC_FILL) return "fill";
  if (code === SRC_OUTLINE_RAW) return "outlineRaw";
  return "outlinePunched";
}

// Stable z-sort matching pipeline.ts sortLayersStable: ascending z, ties broken
// by original (insertion) index, so the packed order equals renderFrameInternal's
// returned order. The comparator is a total order, so the result is identical
// regardless of the engine's sort stability.
function sortLayersByZStable(layers: BitmapLayer[]): BitmapLayer[] {
  const n = layers.length;
  if (n <= 1) return layers;
  const order = new Array<number>(n);
  for (let i = 0; i < n; i++) order[i] = i;
  order.sort((a, b) => {
    const za = layers[a]!.z;
    const zb = layers[b]!.z;
    if (za !== zb) return za - zb;
    return a - b;
  });
  const out: BitmapLayer[] = new Array(n);
  for (let i = 0; i < n; i++) out[i] = layers[order[i]!]!;
  return out;
}

type FrameEventParams = ReturnType<typeof frameEventParams>;

// Render ONE event's lines with the identical single-thread layout+raster path,
// appending its layers to `layers`. Returns the number of layers appended plus
// the real layout cache-mode verdict. Shared by the whole-frame ring render and
// the per-event scatter render so both traverse byte-identical layout/raster
// stages.
async function renderEventLayers(
  doc: SubtitleDocument,
  ev: SubtitleEvent,
  frame: ReturnType<typeof frameContextFromDocument>,
  params: FrameEventParams,
  timeMs: number,
  shapeCtx: ShapeContext,
  usedGlyphBuffers: GlyphBuffer[],
  layers: BitmapLayer[],
  suppressGpuDefer: boolean,
): Promise<{ added: number; fullyStatic: boolean }> {
  const before = layers.length;
  const layout = await buildEventLayout({
    doc,
    ev,
    frame,
    timeMs,
    scaleBorderAndShadow: params.scaleBorderAndShadow,
    playResX: params.playResX,
    playResY: params.playResY,
    parScaleX: params.parScaleX,
    baseContentWidth: params.baseContentWidth,
    baseContentHeight: params.baseContentHeight,
    fitWidth: params.fitWidth,
    fitHeight: params.fitHeight,
    shapeCtx,
    usedGlyphBuffers,
  });
  if (!layout) return { added: 0, fullyStatic: false };
  const fullyStatic = !ev.dirty && layout.layerCacheMode === "static";
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
    parScaleX: params.parScaleX,
    safeScreenScaleXPar: layout.safeScreenScaleXPar,
    safeScreenScaleY: layout.safeScreenScaleY,
    safeBlurScaleX: layout.safeBlurScaleX,
    safeBlurScaleY: layout.safeBlurScaleY,
    layers,
    traceEvent: null,
    cacheTemplates: undefined,
    suppressGpuDefer,
    poolFrameLocalBitmaps: true,
  });
  return { added: layers.length - before, fullyStatic };
}

export type FrameLayersResult = {
  layers: BitmapLayer[];
  staticOrdinals: Int32Array;
  nonStaticOrdinals: Int32Array;
};

// Render every active layer of a frame with the identical single-thread path,
// then z-sort. Renders the FULL animated body — no isEventCacheReusable gate —
// and never suppresses GPU deferral (suppressGpuDefer=false) so a GpuFilterDesc
// is emitted for the main thread's GPU blur whenever a provider is registered in
// the worker realm; with no provider (Bun / CPU) the path is byte-for-byte the
// CPU-blur path, matching renderFrame exactly. Releases the frame's glyph
// buffers before returning.
export async function renderFrameToLayers(
  doc: SubtitleDocument,
  timeMs: number,
  width: number,
  height: number,
  shapeCtx: ShapeContext,
): Promise<FrameLayersResult> {
  const frame = frameContextFromDocument(doc, timeMs, width, height);
  const params = frameEventParams(doc, frame);
  const activeEvents = activeEventsAtTime(doc, timeMs);
  const layers: BitmapLayer[] = [];
  const staticOrdinals: number[] = [];
  const nonStaticOrdinals: number[] = [];
  const usedGlyphBuffers: GlyphBuffer[] = [];
  try {
    for (let e = 0; e < activeEvents.length; e++) {
      const verdict = await renderEventLayers(
        doc,
        activeEvents[e]!,
        frame,
        params,
        timeMs,
        shapeCtx,
        usedGlyphBuffers,
        layers,
        false,
      );
      (verdict.fullyStatic ? staticOrdinals : nonStaticOrdinals).push(e);
    }
  } finally {
    for (let i = 0; i < usedGlyphBuffers.length; i++) {
      releaseGlyphBuffer(usedGlyphBuffers[i]!);
    }
  }
  return {
    layers: sortLayersByZStable(layers),
    staticOrdinals: Int32Array.from(staticOrdinals),
    nonStaticOrdinals: Int32Array.from(nonStaticOrdinals),
  };
}

// Result of a per-event SUBSET render: the event layers (in ascending
// event-ordinal, intra-event insertion order) plus a parallel `ordinals` array
// giving each layer's ordinal — its POSITION in activeEventsAtTime(doc,timeMs).
// The ordinal is the deterministic reassembly key: whole events are never split,
// so a stable sort of the merged layer set by ordinal reconstructs the exact
// single-thread insertion order (frame-arena.mergeScatterLayers) before the
// global z-sort.
export type SubsetLayers = {
  layers: BitmapLayer[];
  ordinals: Int32Array;
  staticOrdinals: Int32Array;
  nonStaticOrdinals: Int32Array;
};

// Per-event warm render cost measured while rendering a subset: `costOrdinals[j]`
// is the event ordinal (position in activeEventsAtTime) and `costMs[j]` the ms it
// took on this worker. Fed back to the main thread's measured-cost EWMA so the
// next frame's LPT partition balances by real cost (parity-free — cost only
// steers which worker renders which event, never the pixels).
export type SubsetCost = { costOrdinals: Int32Array; costMs: Float64Array };

// Render a SUBSET of a frame's active events (by ordinal) with the identical
// single-thread path. CPU/Bun workers have no GPU provider and keep producing
// final CPU-filtered layers. Browser WebGPU workers receive a provider stub from
// the main thread; qualifying layers then carry deferred-filter source masks and
// params through the arena for compositor-side WGSL filtering.
// Never z-sorts (the global z-sort runs once on the merged set); returns layers
// in (ordinal asc, intra-event) order with the parallel ordinal tags.
export async function renderSubsetToLayers(
  doc: SubtitleDocument,
  timeMs: number,
  width: number,
  height: number,
  ordinals: ArrayLike<number>,
  shapeCtx: ShapeContext,
): Promise<SubsetLayers & SubsetCost> {
  const frame = frameContextFromDocument(doc, timeMs, width, height);
  const params = frameEventParams(doc, frame);
  const activeEvents = activeEventsAtTime(doc, timeMs);
  const layers: BitmapLayer[] = [];
  const layerOrdinals: number[] = [];
  const staticOrdinals: number[] = [];
  const nonStaticOrdinals: number[] = [];
  const usedGlyphBuffers: GlyphBuffer[] = [];
  // Render ordinals in ascending order so a worker's own layers are already
  // ordinal-sorted; the cross-worker merge is then a stable sort by ordinal.
  const ord = Int32Array.from(ordinals);
  ord.sort();
  const costOrdinals = new Int32Array(ord.length);
  const costMs = new Float64Array(ord.length);
  let nCost = 0;
  try {
    for (let k = 0; k < ord.length; k++) {
      const o = ord[k]!;
      const ev = activeEvents[o];
      if (!ev) continue;
      // Per-event warm CPU: drives the main thread's measured-cost LPT balancer.
      // Cheap (two clock reads per event); fed back via the subset message.
      const t0 = performance.now();
      const verdict = await renderEventLayers(
        doc,
        ev,
        frame,
        params,
        timeMs,
        shapeCtx,
        usedGlyphBuffers,
        layers,
        false,
      );
      const added = verdict.added;
      (verdict.fullyStatic ? staticOrdinals : nonStaticOrdinals).push(o);
      costOrdinals[nCost] = o;
      costMs[nCost] = performance.now() - t0;
      nCost++;
      for (let j = 0; j < added; j++) layerOrdinals[layerOrdinals.length] = o;
    }
  } finally {
    for (let i = 0; i < usedGlyphBuffers.length; i++) {
      releaseGlyphBuffer(usedGlyphBuffers[i]!);
    }
  }
  return {
    layers,
    ordinals: Int32Array.from(layerOrdinals),
    staticOrdinals: Int32Array.from(staticOrdinals),
    nonStaticOrdinals: Int32Array.from(nonStaticOrdinals),
    costOrdinals: nCost === ord.length ? costOrdinals : costOrdinals.subarray(0, nCost),
    costMs: nCost === ord.length ? costMs : costMs.subarray(0, nCost),
  };
}

// Merge scattered subset results into single-thread insertion order. Each event
// lives entirely in one subset (whole events are never split) and its layers are
// contiguous + intra-ordered inside that subset, so a STABLE sort of the
// concatenated layer set by ordinal reproduces the exact order renderFrameInternal
// appends them in — which is the tie-break sortLayersStable relies on. The caller
// runs sortLayersStable(...) on the returned array to get the composite order.
export function mergeScatterLayers(parts: readonly SubsetLayers[]): BitmapLayer[] {
  if (parts.length === 1) {
    // Single subset: already in (ordinal, intra) order, no merge needed.
    return parts[0]!.layers;
  }
  let total = 0;
  for (let i = 0; i < parts.length; i++) total += parts[i]!.layers.length;
  const flatLayers: BitmapLayer[] = new Array(total);
  const flatOrd = new Int32Array(total);
  let w = 0;
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i]!;
    const pl = p.layers;
    const po = p.ordinals;
    for (let j = 0; j < pl.length; j++) {
      flatLayers[w] = pl[j]!;
      flatOrd[w] = po[j]!;
      w++;
    }
  }
  const order = new Int32Array(total);
  for (let i = 0; i < total; i++) order[i] = i;
  // Stable by ordinal: tie-break on original concatenation index keeps each
  // event's contiguous intra-event run intact (a given ordinal is present in
  // exactly one subset, so the tie-break never crosses subsets).
  order.sort((a, b) => {
    const oa = flatOrd[a]!;
    const ob = flatOrd[b]!;
    if (oa !== ob) return oa - ob;
    return a - b;
  });
  const out: BitmapLayer[] = new Array(total);
  for (let i = 0; i < total; i++) out[i] = flatLayers[order[i]!]!;
  return out;
}

// Copy the logical width*height region of a (possibly strided/subarray) mask
// into `dst` at `dstOff`, tightly packed (row stride === width in the output).
function copyTight(
  dst: Uint8Array,
  dstOff: number,
  src: Uint8Array,
  width: number,
  height: number,
  stride: number,
): void {
  if (width <= 0 || height <= 0) return;
  if (stride === width) {
    dst.set(src.subarray(0, width * height), dstOff);
    return;
  }
  for (let row = 0; row < height; row++) {
    const srcRow = row * stride;
    dst.set(src.subarray(srcRow, srcRow + width), dstOff + row * width);
  }
}

// Bump-pack every layer's mask (plus clip mask and gpuFilter source masks) into
// one arena ArrayBuffer, filling a parallel metadata Float64Array.
//
// Masks are DEDUPLICATED by source-buffer identity: one `\clip` event shares a
// single clip-mask object across all its glyph layers, and drawing/karaoke
// scripts stamp one rasterized bitmap across many layers. Copying each once and
// having every referencing layer point at the same arena offset ("clip ref")
// keeps the arena proportional to the frame's UNIQUE pixels — the dense beastars
// sign frame drops from ~930MB (per-layer clip copies) to <10MB. Deduping is
// safe because a shared object with identical dims is byte-identical content;
// per-layer color/origin stay in the metadata, so tinted reuse is preserved.
type ArenaAcquireResult = { buffer: ArenaBuffer; reused: boolean; sabSlotIdx?: number };

export function packFrameArena(
  layers: BitmapLayer[],
  acquireArena?: (minBytes: number) => ArenaAcquireResult | null,
): {
  arena: ArenaBuffer;
  meta: Float64Array;
  count: number;
  reused: boolean;
  sabSlotIdx?: number;
} {
  const count = layers.length;
  const meta = new Float64Array(count * FRAME_ARENA_META_STRIDE);

  // Dedup map: source Uint8Array -> its packed region. A hit with matching dims
  // reuses the region (no copy, no offset bump); a mismatch packs a fresh region.
  type Region = { w: number; h: number; stride: number; off: number };
  const dedup = new Map<Uint8Array, Region>();
  const copyOps: Array<{ src: Uint8Array } & Region> = [];
  let offset = 0;

  // Assign (or reuse) an arena region for `src`'s logical w*h grid. Returns the
  // byte offset the reassembler reads; the packed region is always tight
  // (stride === w). Recorded copy ops run after the arena is sized.
  const place = (src: Uint8Array, w: number, h: number, stride: number): number => {
    const rec = dedup.get(src);
    if (rec && rec.w === w && rec.h === h && rec.stride === stride) return rec.off;
    const off = offset;
    offset += w * h;
    const region: Region = { w, h, stride, off };
    dedup.set(src, region);
    copyOps[copyOps.length] = { src, w, h, stride, off };
    return off;
  };

  // Pass 1: assign offsets (with dedup) + write scalar metadata. `offset`
  // bump-allocates the arena; integers/colors/radii are exact in Float64.
  for (let i = 0; i < count; i++) {
    const layer = layers[i]!;
    const base = i * FRAME_ARENA_META_STRIDE;
    const w = layer.width;
    const h = layer.height;
    const gpu = layer.gpuFilter;
    // GPU-filtered layers composite from `gpuFilter` source masks; `bitmap` is a
    // phantom geometry carrier and is never sampled by WebGPU. Do not pack that
    // per-layer bitmap into the arena. The real source masks are packed below
    // through the gpuFilter fields and remain deduped by buffer identity.
    meta[base + M_ARENA_OFF] = gpu ? 0 : place(layer.bitmap, w, h, layer.stride);
    meta[base + M_W] = w;
    meta[base + M_H] = h;
    meta[base + M_STRIDE] = w;
    meta[base + M_ORIGIN_X] = layer.originX;
    meta[base + M_ORIGIN_Y] = layer.originY;
    const color = layer.color;
    meta[base + M_COL_R] = color[0];
    meta[base + M_COL_G] = color[1];
    meta[base + M_COL_B] = color[2];
    meta[base + M_COL_A] = color[3];
    meta[base + M_Z] = layer.z;

    const clip = layer.clip;
    if (!clip) {
      meta[base + M_CLIP_KIND] = 0;
    } else if (clip.type === "rect") {
      meta[base + M_CLIP_KIND] = 1;
      meta[base + M_CLIP_INV] = clip.inverse ? 1 : 0;
      meta[base + M_CLIP_A] = clip.x0;
      meta[base + M_CLIP_B] = clip.y0;
      meta[base + M_CLIP_C] = clip.x1;
      meta[base + M_CLIP_D] = clip.y1;
    } else {
      meta[base + M_CLIP_KIND] = 2;
      meta[base + M_CLIP_INV] = clip.inverse ? 1 : 0;
      meta[base + M_CLIP_A] = clip.originX;
      meta[base + M_CLIP_B] = clip.originY;
      meta[base + M_CLIP_C] = clip.width;
      meta[base + M_CLIP_D] = clip.height;
      meta[base + M_CLIP_MASK_OFF] = place(clip.bitmap, clip.width, clip.height, clip.stride);
      meta[base + M_CLIP_MASK_STRIDE] = clip.width;
    }

    if (!gpu) {
      meta[base + M_GPU] = 0;
    } else {
      meta[base + M_GPU] = 1;
      meta[base + M_GPU_GROUP] = gpu.groupId;
      meta[base + M_GPU_SRC] = sourceToCode(gpu.source);
      meta[base + M_GPU_R2X] = gpu.r2x;
      meta[base + M_GPU_R2Y] = gpu.r2y;
      meta[base + M_GPU_SX] = gpu.sx;
      meta[base + M_GPU_SY] = gpu.sy;
      meta[base + M_GPU_FILL_OFF] = place(gpu.fillMask, gpu.fillW, gpu.fillH, gpu.fillStride);
      meta[base + M_GPU_FILL_W] = gpu.fillW;
      meta[base + M_GPU_FILL_H] = gpu.fillH;
      meta[base + M_GPU_FILL_STRIDE] = gpu.fillW;
      if (gpu.outlineMask && gpu.outlineW && gpu.outlineH) {
        meta[base + M_GPU_HAS_OUTLINE] = 1;
        meta[base + M_GPU_OUT_OFF] = place(
          gpu.outlineMask,
          gpu.outlineW,
          gpu.outlineH,
          gpu.outlineStride ?? gpu.outlineW,
        );
        meta[base + M_GPU_OUT_W] = gpu.outlineW;
        meta[base + M_GPU_OUT_H] = gpu.outlineH;
        meta[base + M_GPU_OUT_STRIDE] = gpu.outlineW;
      } else {
        meta[base + M_GPU_HAS_OUTLINE] = 0;
      }
      if (gpu.punchOX !== undefined) {
        meta[base + M_GPU_HAS_PUNCH] = 1;
        meta[base + M_GPU_PUNCH_OX] = gpu.punchOX;
        meta[base + M_GPU_PUNCH_OY] = gpu.punchOY ?? 0;
        meta[base + M_GPU_PUNCH_FX] = gpu.punchFX ?? 0;
        meta[base + M_GPU_PUNCH_FY] = gpu.punchFY ?? 0;
      } else {
        meta[base + M_GPU_HAS_PUNCH] = 0;
      }
    }
  }

  // A recycled arena is safe without zero-fill: copyOps covers every byte in
  // [0, offset), and reassembleFrameArena only reads the regions addressed by
  // metadata within that range. Any capacity beyond offset is unreachable.
  const acquiredArena = acquireArena?.(offset) ?? null;
  const arena = acquiredArena && acquiredArena.buffer.byteLength >= offset
    ? acquiredArena.buffer
    : new ArrayBuffer(offset);
  if (
    (globalThis as any).__SUBFRAME_ALLOC_CENSUS__ &&
    acquiredArena &&
    acquiredArena.buffer === arena &&
    acquiredArena.reused
  ) {
    recordAllocCensus("frameArena.reuse", offset);
  } else if ((globalThis as any).__SUBFRAME_ALLOC_CENSUS__) {
    recordAllocCensus("frameArena.alloc", offset);
  }
  const view = new Uint8Array(arena);

  // Pass 2: copy each unique region's pixel bytes into its assigned slot.
  let copyBytes = 0;
  for (let i = 0; i < copyOps.length; i++) {
    const op = copyOps[i]!;
    copyBytes += op.w * op.h;
    copyTight(view, op.off, op.src, op.w, op.h, op.stride);
  }
  if ((globalThis as any).__SUBFRAME_ALLOC_CENSUS__)
    recordAllocCensus("frameArena.copy", copyBytes, copyOps.length);

  return {
    arena,
    meta,
    count,
    reused: acquiredArena?.buffer === arena && acquiredArena.reused,
    sabSlotIdx: acquiredArena?.buffer === arena ? acquiredArena.sabSlotIdx : undefined,
  };
}

// Rebuild BitmapLayer[] from a packed arena + metadata array. Every mask is a
// zero-copy subarray view onto the arena; the layers composite byte-identically
// to the single-thread renderFrame that produced them. `count` defaults to
// meta.length / FRAME_ARENA_META_STRIDE.
export function reassembleFrameArena(
  arena: ArenaBuffer,
  meta: Float64Array,
  count?: number,
): BitmapLayer[] {
  const view = new Uint8Array(arena);
  const n = count ?? (meta.length / FRAME_ARENA_META_STRIDE) | 0;
  const layers: BitmapLayer[] = new Array(n);
  for (let i = 0; i < n; i++) {
    const base = i * FRAME_ARENA_META_STRIDE;
    const off = meta[base + M_ARENA_OFF]!;
    const w = meta[base + M_W]!;
    const h = meta[base + M_H]!;
    const isGpuLayer = meta[base + M_GPU] === 1;
    const color: ColorRGBA = [
      meta[base + M_COL_R]!,
      meta[base + M_COL_G]!,
      meta[base + M_COL_B]!,
      meta[base + M_COL_A]!,
    ];
    const layer: BitmapLayer = {
      bitmap: isGpuLayer ? EMPTY_BITMAP : view.subarray(off, off + w * h),
      width: w,
      height: h,
      stride: isGpuLayer ? w : meta[base + M_STRIDE]!,
      originX: meta[base + M_ORIGIN_X]!,
      originY: meta[base + M_ORIGIN_Y]!,
      color,
      z: meta[base + M_Z]!,
    };

    const clipKind = meta[base + M_CLIP_KIND];
    if (clipKind === 1) {
      layer.clip = {
        type: "rect",
        x0: meta[base + M_CLIP_A]!,
        y0: meta[base + M_CLIP_B]!,
        x1: meta[base + M_CLIP_C]!,
        y1: meta[base + M_CLIP_D]!,
        inverse: meta[base + M_CLIP_INV] === 1,
      };
    } else if (clipKind === 2) {
      const cw = meta[base + M_CLIP_C]!;
      const ch = meta[base + M_CLIP_D]!;
      const coff = meta[base + M_CLIP_MASK_OFF]!;
      layer.clip = {
        type: "mask",
        bitmap: view.subarray(coff, coff + cw * ch),
        width: cw,
        height: ch,
        stride: meta[base + M_CLIP_MASK_STRIDE]!,
        originX: meta[base + M_CLIP_A]!,
        originY: meta[base + M_CLIP_B]!,
        inverse: meta[base + M_CLIP_INV] === 1,
      };
    }

    if (meta[base + M_GPU] === 1) {
      const fillOff = meta[base + M_GPU_FILL_OFF]!;
      const fillW = meta[base + M_GPU_FILL_W]!;
      const fillH = meta[base + M_GPU_FILL_H]!;
      const gpu: GpuFilterDesc = {
        groupId: meta[base + M_GPU_GROUP]!,
        source: codeToSource(meta[base + M_GPU_SRC]!),
        r2x: meta[base + M_GPU_R2X]!,
        r2y: meta[base + M_GPU_R2Y]!,
        sx: meta[base + M_GPU_SX]!,
        sy: meta[base + M_GPU_SY]!,
        fillMask: view.subarray(fillOff, fillOff + fillW * fillH),
        fillW,
        fillH,
        fillStride: meta[base + M_GPU_FILL_STRIDE]!,
      };
      if (meta[base + M_GPU_HAS_OUTLINE] === 1) {
        const outOff = meta[base + M_GPU_OUT_OFF]!;
        const outW = meta[base + M_GPU_OUT_W]!;
        const outH = meta[base + M_GPU_OUT_H]!;
        gpu.outlineMask = view.subarray(outOff, outOff + outW * outH);
        gpu.outlineW = outW;
        gpu.outlineH = outH;
        gpu.outlineStride = meta[base + M_GPU_OUT_STRIDE]!;
      }
      if (meta[base + M_GPU_HAS_PUNCH] === 1) {
        gpu.punchOX = meta[base + M_GPU_PUNCH_OX]!;
        gpu.punchOY = meta[base + M_GPU_PUNCH_OY]!;
        gpu.punchFX = meta[base + M_GPU_PUNCH_FX]!;
        gpu.punchFY = meta[base + M_GPU_PUNCH_FY]!;
      }
      layer.gpuFilter = gpu;
    }

    layers[i] = layer;
  }
  return layers;
}
