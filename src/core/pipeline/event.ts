import type { SubtitleDocument, SubtitleEvent } from "subforge/core";
import type { GlyphBuffer } from "text-shaper";
import type { FrameContext, BitmapLayer } from "../data/types";
import type { TraceContext, TraceEvent } from "../trace";
import { startTraceEvent } from "../trace";
import type { ShapeContext } from "../shape/shaper";
import { buildEventLayout } from "../layout/event";
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
    }
  | {
      mode: "tint";
      key: string;
      text: string;
      templates: CacheLayerTemplate[];
      bytes: number;
      layerCount: number;
    };

const EVENT_LAYER_CACHE_LIMIT = 512;
const EVENT_LAYER_CACHE_BYTES_LIMIT = 256 * 1024 * 1024;
const EVENT_LAYER_CACHE = new Map<SubtitleEvent, CachedEntry>();
let eventLayerCacheBytes = 0;
let eventLayerCacheLayers = 0;
let eventLayerCacheHits = 0;
let eventLayerCacheMisses = 0;
let eventLayerCacheEvictions = 0;

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
    const first = EVENT_LAYER_CACHE.keys().next();
    if (first.done) break;
    const key = first.value;
    const removed = EVENT_LAYER_CACHE.get(key);
    if (removed) {
      eventLayerCacheBytes -= removed.bytes;
      eventLayerCacheLayers -= removed.layerCount;
      EVENT_LAYER_CACHE.delete(key);
      eventLayerCacheEvictions++;
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
  limitEntries: number;
  limitBytes: number;
} {
  return {
    entries: EVENT_LAYER_CACHE.size,
    layers: eventLayerCacheLayers,
    bytes: eventLayerCacheBytes,
    hits: eventLayerCacheHits,
    misses: eventLayerCacheMisses,
    evictions: eventLayerCacheEvictions,
    limitEntries: EVENT_LAYER_CACHE_LIMIT,
    limitBytes: EVENT_LAYER_CACHE_BYTES_LIMIT,
  };
}

export function clearEventLayerCache(): void {
  EVENT_LAYER_CACHE.clear();
  eventLayerCacheBytes = 0;
  eventLayerCacheLayers = 0;
  eventLayerCacheHits = 0;
  eventLayerCacheMisses = 0;
  eventLayerCacheEvictions = 0;
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

  const cacheMode = !traceCtx ? layout.layerCacheMode : "none";
  if (cacheMode !== "none" && layout.cacheKey) {
    const cached = EVENT_LAYER_CACHE.get(ev);
    if (
      cached &&
      cached.key === layout.cacheKey &&
      cached.text === ev.text &&
      cached.mode === cacheMode
    ) {
      eventLayerCacheHits++;
      cacheTouch(ev, cached);
      if (cached.mode === "static") {
        pushCachedLayers(layers, cached.layers);
      } else {
        pushTintCachedLayers(layers, cached.templates, layout.lines, ev, timeMs);
      }
      return;
    }
    eventLayerCacheMisses++;
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
    cacheMode === "tint" ? [] : undefined;
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
  });
  if (isProfiling()) addRasterMs(profileNow() - rasterStart);

  if (cacheMode !== "none" && layout.cacheKey) {
    if (cacheMode === "static") {
      const cachedLayers = layers.slice(cacheStart);
      cacheInsert(ev, {
        mode: "static",
        key: layout.cacheKey,
        text: ev.text,
        layers: cachedLayers,
        bytes: cacheEntryBytes(cachedLayers),
        layerCount: cachedLayers.length,
      });
    } else if (cacheTemplates) {
      cacheInsert(ev, {
        mode: "tint",
        key: layout.cacheKey,
        text: ev.text,
        templates: cacheTemplates,
        bytes: cacheEntryBytes(cacheTemplates),
        layerCount: cacheTemplates.length,
      });
    }
  }
}
