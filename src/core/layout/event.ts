import type { SubtitleDocument, SubtitleEvent } from "subforge/core";
import { GlyphBuffer } from "text-shaper";
import type { FrameContext } from "../data/types";
import { getFontForStyle } from "../../io/fonts/cache";
import { quantSubpixel } from "../math/fixed";
import {
  resolveOutlineColor,
  resolvePrimaryColor,
  resolveSecondaryColor,
  resolveShadowColor,
} from "../style/color";
import {
  getFontScaleForSize,
  resolveFontStyle,
  type ResolvedFontStyle,
} from "../style/font";
import {
  acquireGlyphBuffer,
  shapeTextWithRuns,
  type ShapeContext,
} from "../shape/shaper";
import { splitTokenByFont } from "../shape/font-runs";
import {
  computeLineWidth,
  finalizeLineMetrics,
  splitByNewline,
  tokenize,
  trimTrailingWhitespace,
  type Line,
  type LineItem,
  type Token,
} from "./line";
import { resolveSegments } from "../tags/parser";
import {
  findBlurEffect,
  findBorderEffect,
  findDrawingBaselineEffect,
  findDrawingEffect,
  findEdgeBlurEffect,
  findKaraokeAbsoluteEffect,
  findKaraokeEffect,
  findMoveEffect,
  findOriginEffect,
  findRotateEffect,
  findScaleEffect,
  findShadowEffect,
  findShearEffect,
  findSpacingEffect,
} from "../tags/effects";
import type {
  AnimateParams,
  ClipShape,
  MoveParams,
  OriginParams,
  ResetParams,
} from "../tags/types";
import { findFadeComplexEffect, findFadeEffect } from "../animate/fade";
import {
  applyAnimateNumeric,
  animateProgress,
  findAnimateEffects,
} from "../animate/apply";
import { computeMovePosition } from "../animate/move";
import { parseDrawingPath } from "../clip/parser";

// Shaped glyph runs keyed by text + base direction + kerning, per font.
// Buffers are retained by the cache (never pooled/released) and treated as
// immutable by all consumers.
let SHAPED_RUN_CACHE_LIMIT = 1024;
const shapedRunCache = new WeakMap<object, Map<string, GlyphBuffer>>();

function getShapedRunCache(font: object, key: string): GlyphBuffer | null {
  const map = shapedRunCache.get(font);
  if (!map) return null;
  const value = map.get(key) ?? null;
  if (value) {
    map.delete(key);
    map.set(key, value);
  }
  return value;
}

function setShapedRunCache(font: object, key: string, value: GlyphBuffer): void {
  let map = shapedRunCache.get(font);
  if (!map) {
    map = new Map();
    shapedRunCache.set(font, map);
  }
  map.set(key, value);
  if (map.size > SHAPED_RUN_CACHE_LIMIT) {
    const first = map.keys().next();
    if (!first.done) map.delete(first.value);
  }
}

// Parsed drawing paths keyed by source text + \p scale. Scripts that stamp
// one drawing across many events (gradient strips) parse it once. Consumers
// never mutate the parsed path (PathBuilder.fromPath and quantizePath copy).
let DRAWING_PATH_CACHE_LIMIT = 128;
const DRAWING_PATH_CACHE = new Map<
  string,
  ReturnType<typeof parseDrawingPath>
>();

// Mutable ceilings (limits/stats only; no rendering-semantics change). Undefined
// leaves a ceiling untouched.
export function setLayoutCacheLimits(limits: { shapedRun?: number; drawingPath?: number }): void {
  if (limits.shapedRun !== undefined) SHAPED_RUN_CACHE_LIMIT = Math.max(0, limits.shapedRun);
  if (limits.drawingPath !== undefined) {
    DRAWING_PATH_CACHE_LIMIT = Math.max(0, limits.drawingPath);
    while (DRAWING_PATH_CACHE.size > DRAWING_PATH_CACHE_LIMIT) {
      const first = DRAWING_PATH_CACHE.keys().next();
      if (first.done) break;
      DRAWING_PATH_CACHE.delete(first.value);
    }
  }
}

export function getLayoutCacheStats(): {
  drawingPathEntries: number;
  limits: { shapedRun: number; drawingPath: number };
} {
  return {
    drawingPathEntries: DRAWING_PATH_CACHE.size,
    limits: { shapedRun: SHAPED_RUN_CACHE_LIMIT, drawingPath: DRAWING_PATH_CACHE_LIMIT },
  };
}

function parseDrawingPathCached(
  source: string,
  scaleFactor: number,
): ReturnType<typeof parseDrawingPath> {
  const key = `${scaleFactor}|${source}`;
  const cached = DRAWING_PATH_CACHE.get(key);
  if (cached !== undefined) {
    DRAWING_PATH_CACHE.delete(key);
    DRAWING_PATH_CACHE.set(key, cached);
    return cached;
  }
  const parsed = parseDrawingPath(source, scaleFactor);
  DRAWING_PATH_CACHE.set(key, parsed);
  if (DRAWING_PATH_CACHE.size > DRAWING_PATH_CACHE_LIMIT) {
    const first = DRAWING_PATH_CACHE.keys().next();
    if (!first.done) DRAWING_PATH_CACHE.delete(first.value);
  }
  return parsed;
}
import { findClipEffect } from "../clip/apply";
import { quantizeBlur } from "../filters/blur";
import { computeRunMetrics } from "../raster/metrics";
import { addFontMs, addShapeMs, isProfiling, profileNow } from "../profile";
import {
  detectDirection,
  kerning,
  type ShapeFeature,
  getEmbeddings,
  getVisualOrder,
  Direction,
} from "text-shaper";

const EVENT_LAYOUT_CACHE = new WeakMap<
  SubtitleEvent,
  { key: string; text: string; value: EventLayoutResult }
>();

function layoutCacheKey(input: {
  frame: FrameContext;
  playResX: number;
  playResY: number;
  parScaleX: number;
  baseContentWidth: number;
  baseContentHeight: number;
  fitWidth: number;
  fitHeight: number;
  scaleBorderAndShadow: boolean | undefined;
  info: SubtitleDocument["info"];
}): string {
  const info = input.info as {
    layoutResX?: number;
    layoutResY?: number;
    storageWidth?: number;
    storageHeight?: number;
  };
  const q = (v: number) => Math.round(v * 1e4);
  return [
    input.frame.width,
    input.frame.height,
    input.frame.wrapStyle,
    input.playResX,
    input.playResY,
    q(input.parScaleX),
    q(input.baseContentWidth),
    q(input.baseContentHeight),
    q(input.fitWidth),
    q(input.fitHeight),
    input.scaleBorderAndShadow ? 1 : 0,
    q(Number.isFinite(info.layoutResX) ? (info.layoutResX as number) : 0),
    q(Number.isFinite(info.layoutResY) ? (info.layoutResY as number) : 0),
    q(Number.isFinite(info.storageWidth) ? (info.storageWidth as number) : 0),
    q(Number.isFinite(info.storageHeight) ? (info.storageHeight as number) : 0),
  ].join("|");
}

function animateAffectsLayout(target: {
  fontSize?: number;
  scaleX?: number;
  scaleY?: number;
  rotateZ?: number;
  rotateX?: number;
  rotateY?: number;
  shearX?: number;
  shearY?: number;
  spacing?: number;
  border?: number;
  shadow?: number;
  shadowX?: number;
  shadowY?: number;
  blur?: number;
  edgeBlur?: number;
}): boolean {
  return (
    target.fontSize !== undefined ||
    target.scaleX !== undefined ||
    target.scaleY !== undefined ||
    target.rotateZ !== undefined ||
    target.rotateX !== undefined ||
    target.rotateY !== undefined ||
    target.shearX !== undefined ||
    target.shearY !== undefined ||
    target.spacing !== undefined ||
    target.border !== undefined ||
    target.shadow !== undefined ||
    target.shadowX !== undefined ||
    target.shadowY !== undefined ||
    target.blur !== undefined ||
    target.edgeBlur !== undefined
  );
}

function hasTimeVariantEffects(segments: ReturnType<typeof resolveSegments>): boolean {
  for (let s = 0; s < segments.length; s++) {
    const effects = segments[s]!.effects;
    if (!effects || effects.length === 0) continue;
    for (let i = 0; i < effects.length; i++) {
      const type = effects[i]!.type;
      if (type === "move") return true;
      if (type === "animate") {
        const anim = effects[i]!.params as AnimateParams;
        if (anim?.target && animateAffectsLayout(anim.target)) return true;
      }
    }
  }
  return false;
}

function animateAffectsColor(target: {
  primaryColor?: number;
  secondaryColor?: number;
  outlineColor?: number;
  backColor?: number;
  alpha?: number;
  primaryAlpha?: number;
  secondaryAlpha?: number;
  outlineAlpha?: number;
  backAlpha?: number;
}): boolean {
  return (
    target.primaryColor !== undefined ||
    target.secondaryColor !== undefined ||
    target.outlineColor !== undefined ||
    target.backColor !== undefined ||
    target.alpha !== undefined ||
    target.primaryAlpha !== undefined ||
    target.secondaryAlpha !== undefined ||
    target.outlineAlpha !== undefined ||
    target.backAlpha !== undefined
  );
}

function hasKaraokeEffects(segments: ReturnType<typeof resolveSegments>): boolean {
  for (let s = 0; s < segments.length; s++) {
    const effects = segments[s]!.effects;
    if (!effects || effects.length === 0) continue;
    for (let i = 0; i < effects.length; i++) {
      const type = effects[i]!.type;
      if (type === "karaoke" || type === "karaokeAbsolute") return true;
    }
  }
  return false;
}

function hasColorVariantEffects(segments: ReturnType<typeof resolveSegments>): boolean {
  for (let s = 0; s < segments.length; s++) {
    const effects = segments[s]!.effects;
    if (!effects || effects.length === 0) continue;
    for (let i = 0; i < effects.length; i++) {
      const type = effects[i]!.type;
      if (type === "fade" || type === "fadeComplex") return true;
      if (type === "animate") {
        const anim = effects[i]!.params as AnimateParams;
        if (anim?.target && animateAffectsColor(anim.target)) return true;
      }
    }
  }
  return false;
}

function reorderTokensForBidi(
  text: string,
  tokens: Token[],
  baseDirection: Direction,
): Token[] {
  if (tokens.length <= 1 || text.length === 0) return tokens;
  const bidi = getEmbeddings(text, baseDirection);
  const order = getVisualOrder(text, bidi);
  if (order.length === 0) return tokens;

  const map = new Int32Array(text.length);
  map.fill(-1);
  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i]!;
    for (let cu = tok.start; cu < tok.end; cu++) {
      map[cu] = i;
    }
  }

  const seen = new Uint8Array(tokens.length);
  const out: Token[] = [];
  for (let i = 0; i < order.length; i++) {
    const cu = order[i]!;
    const idx = map[cu] ?? -1;
    if (idx < 0 || seen[idx]) continue;
    seen[idx] = 1;
    out[out.length] = tokens[idx]!;
  }
  if (out.length < tokens.length) {
    for (let i = 0; i < tokens.length; i++) {
      if (!seen[i]) out[out.length] = tokens[i]!;
    }
  }
  return out;
}

type LayoutFontHandle = Awaited<ReturnType<typeof getFontForStyle>>;

// A shaped span assigned to one line item: a font-run's glyphs sliced to a
// single token. `shaped` shares glyph objects with the retained whole-run
// buffer (treated as immutable), so slicing never copies glyph data.
type ShapedRunSpec = {
  font: LayoutFontHandle;
  shaped: GlyphBuffer;
  text: string;
};

// True when the line requires bidi reordering. Pure-LTR lines (base LTR, no
// RTL embedding levels) can be shaped as whole runs and sliced by token in
// logical order; anything with RTL keeps the per-token reorder path.
function partHasRtl(text: string, baseDirection: Direction): boolean {
  if (text.length === 0) return false;
  const bidi = getEmbeddings(text, baseDirection);
  const levels = bidi.levels;
  for (let i = 0; i < levels.length; i++) {
    if ((levels[i] ?? 0) & 1) return true;
  }
  return false;
}

// Build a GlyphBuffer view over [start, end) of `whole`. Reuses the source
// glyph info/position objects (the whole-run buffer is cached and immutable),
// so this is an array slice, not a per-glyph copy.
function sliceShapedBuffer(
  whole: GlyphBuffer,
  start: number,
  end: number,
): GlyphBuffer {
  const sub = GlyphBuffer.withCapacity(end - start);
  sub.infos = whole.infos.slice(start, end);
  sub.positions = whole.positions.slice(start, end);
  return sub;
}

// Shape a pure-LTR part as whole style runs (libass/HarfBuzz itemization:
// maximal same-font spans shaped with their real neighbors), then partition
// each run's glyphs across the part's tokens by cluster. Contextual GSUB
// (calt/liga/cross-space rules) that spans token boundaries is preserved,
// while line-breaking still operates per token. Returns one ShapedRunSpec[]
// per token (parallel to `tokens`).
async function buildLtrTokenRuns(
  part: string,
  tokens: Token[],
  baseFont: LayoutFontHandle,
  fontName: string,
  boldRequested: boolean,
  italicRequested: boolean,
  baseDirection: Direction,
  shapeCtx: ShapeContext,
  shapeFeatures: ShapeFeature[] | undefined,
  kerningEnabled: boolean,
): Promise<ShapedRunSpec[][]> {
  // Font-runs over the whole part (fallback splits at HarfBuzz item
  // boundaries). splitTokenByFont slices its input contiguously, so
  // consecutive run texts concatenate back to `part`.
  const pseudoToken: Token = {
    text: part,
    isSpace: false,
    start: 0,
    end: part.length,
  };
  const fontRuns = await splitTokenByFont(
    pseudoToken,
    baseFont,
    fontName,
    boldRequested,
    italicRequested,
  );

  type RunShape = {
    font: LayoutFontHandle;
    startCU: number;
    endCU: number;
    shaped: GlyphBuffer;
    glyphCU: Int32Array;
  };
  const runShapes: RunShape[] = [];
  let cursorCU = 0;
  for (let i = 0; i < fontRuns.length; i++) {
    const fr = fontRuns[i]!;
    const startCU = cursorCU;
    const endCU = startCU + fr.text.length;
    cursorCU = endCU;
    if (fr.text.length === 0) continue;

    // Whole-run shaping cached by run text (runs repeat across events).
    const shapeKey = `${baseDirection}|${kerningEnabled ? 1 : 0}|${fr.text}`;
    let shaped = getShapedRunCache(fr.font, shapeKey);
    if (!shaped) {
      shaped = GlyphBuffer.withCapacity(fr.text.length);
      shapeTextWithRuns(
        fr.font,
        fr.text,
        baseDirection,
        shapeCtx,
        shaped,
        shapeFeatures,
      );
      setShapedRunCache(fr.font, shapeKey, shaped);
    }

    // Map each glyph's cluster (codepoint index within fr.text) to an
    // absolute code-unit offset within `part`.
    const cpToCU: number[] = [];
    for (let c = 0; c < fr.text.length; ) {
      const cp = fr.text.codePointAt(c) ?? 0;
      cpToCU[cpToCU.length] = c;
      c += cp >= 0x10000 ? 2 : 1;
    }
    const infos = shaped.infos;
    const glyphCU = new Int32Array(infos.length);
    for (let g = 0; g < infos.length; g++) {
      const cl = infos[g]!.cluster;
      const cu = cl >= 0 && cl < cpToCU.length ? cpToCU[cl]! : 0;
      glyphCU[g] = startCU + cu;
    }
    runShapes[runShapes.length] = { font: fr.font, startCU, endCU, shaped, glyphCU };
  }

  const out: ShapedRunSpec[][] = new Array(tokens.length);
  for (let t = 0; t < tokens.length; t++) {
    const tok = tokens[t]!;
    const specs: ShapedRunSpec[] = [];
    if (tok.text.length > 0) {
      for (let r = 0; r < runShapes.length; r++) {
        const rs = runShapes[r]!;
        if (rs.endCU <= tok.start || rs.startCU >= tok.end) continue;
        const gcu = rs.glyphCU;
        // Glyphs whose cluster maps into the token; contiguous for LTR.
        let g0 = -1;
        let g1 = -1;
        for (let g = 0; g < gcu.length; g++) {
          const cu = gcu[g]!;
          if (cu >= tok.start && cu < tok.end) {
            if (g0 < 0) g0 = g;
            g1 = g + 1;
          }
        }
        if (g0 < 0) continue;
        const sliceStart = tok.start > rs.startCU ? tok.start : rs.startCU;
        const sliceEnd = tok.end < rs.endCU ? tok.end : rs.endCU;
        specs[specs.length] = {
          font: rs.font,
          shaped: sliceShapedBuffer(rs.shaped, g0, g1),
          text: part.slice(sliceStart, sliceEnd),
        };
      }
    }
    out[t] = specs;
  }
  return out;
}

function findSampleCodepoint(text: string): number | null {
  for (let i = 0; i < text.length; ) {
    const cp = text.codePointAt(i) ?? 0;
    if (cp !== 0 && cp !== 10 && cp !== 13) return cp;
    i += cp >= 0x10000 ? 2 : 1;
  }
  return null;
}

export type EventLayoutInput = {
  doc: SubtitleDocument;
  ev: SubtitleEvent;
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
  shapeCtx: ShapeContext;
  usedGlyphBuffers: GlyphBuffer[];
};

export type EventLayoutResult = {
  lines: Line[];
  align: number;
  wrapStyle: number;
  posX: number | null;
  posY: number | null;
  move: MoveParams | null;
  clip: ClipShape | null;
  marginL: number;
  marginR: number;
  marginV: number;
  availableWidth: number;
  topY: number;
  blockAnchorX: number;
  blockAnchorY: number;
  safeScreenScaleXPar: number;
  safeScreenScaleY: number;
  safeBlurScaleX: number;
  safeBlurScaleY: number;
  cacheKey?: string;
  layerCacheMode: "none" | "static" | "tint";
};

export async function buildEventLayout(input: EventLayoutInput): Promise<EventLayoutResult | null> {
  const {
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
  } = input;

  // ASS Kerning defaults to false (libass track->Kerning=0 when the
  // [Script Info] Kerning field is absent), so the GPOS kern feature is
  // disabled unless the script explicitly opts in.
  const kerningEnabled =
    (doc.info as { kerning?: boolean } | undefined)?.kerning === true;
  const shapeFeatures: ShapeFeature[] | undefined = kerningEnabled
    ? undefined
    : [kerning(false)];

  const eventBaseStyle = doc.styles.get(ev.style);
  if (!eventBaseStyle) return null;
  let baseStyle = eventBaseStyle;

  let cacheKey: string | null = null;
  if (!ev.dirty) {
    cacheKey = layoutCacheKey({
      frame,
      playResX,
      playResY,
      parScaleX,
      baseContentWidth,
      baseContentHeight,
      fitWidth,
      fitHeight,
      scaleBorderAndShadow,
      info: doc.info,
    });
    const cached = EVENT_LAYOUT_CACHE.get(ev);
    if (cached && cached.key === cacheKey && cached.text === ev.text) {
      return cached.value;
    }
  }

  const segments = resolveSegments(ev, frame.wrapStyle);
  const layoutCacheable = !ev.dirty && !hasTimeVariantEffects(segments);
  const hasKaraoke = hasKaraokeEffects(segments);
  const hasColorVariants = hasColorVariantEffects(segments);
  let layerCacheMode: "none" | "static" | "tint" = "none";
  if (layoutCacheable) {
    if (!hasKaraoke && hasColorVariants) layerCacheMode = "tint";
    else if (!hasKaraoke && !hasColorVariants) layerCacheMode = "static";
  }
  if (layoutCacheable && !cacheKey) {
    cacheKey = layoutCacheKey({
      frame,
      playResX,
      playResY,
      parScaleX,
      baseContentWidth,
      baseContentHeight,
      fitWidth,
      fitHeight,
      scaleBorderAndShadow,
      info: doc.info,
    });
  }
  const hasHardOverrides = segments.some((seg) => {
    if (seg.style?.pos) return true;
    if (!seg.effects || seg.effects.length === 0) return false;
    for (let i = 0; i < seg.effects.length; i++) {
      const effect = seg.effects[i]!;
      if (
        effect.type === "move" ||
        effect.type === "clip" ||
        effect.type === "origin" ||
        effect.type === "drawing" ||
        effect.type === "drawingBaseline"
      ) {
        return true;
      }
    }
    return false;
  });
  const useMargins = true;
  const fontScrW = (!hasHardOverrides && useMargins) ? fitWidth : baseContentWidth;
  const fontScrH = (!hasHardOverrides && useMargins) ? fitHeight : baseContentHeight;
  const screenScaleX = fontScrW / playResX;
  const screenScaleY = fontScrH / playResY;
  const safeScreenScaleX =
    Number.isFinite(screenScaleX) && screenScaleX > 0 ? screenScaleX : 1;
  const safeScreenScaleY =
    Number.isFinite(screenScaleY) && screenScaleY > 0 ? screenScaleY : 1;
  const safeScreenScaleXPar = safeScreenScaleX / parScaleX;

  const info = doc.info as unknown as {
    layoutResX?: number;
    layoutResY?: number;
    storageWidth?: number;
    storageHeight?: number;
  };
  let layoutResX = Number.isFinite(info.layoutResX) ? (info.layoutResX as number) : 0;
  let layoutResY = Number.isFinite(info.layoutResY) ? (info.layoutResY as number) : 0;
  if (!(layoutResX > 0 && layoutResY > 0)) {
    const storageWidth = Number.isFinite(info.storageWidth)
      ? (info.storageWidth as number)
      : 0;
    const storageHeight = Number.isFinite(info.storageHeight)
      ? (info.storageHeight as number)
      : 0;
    if (storageWidth > 0 && storageHeight > 0) {
      layoutResX = storageWidth;
      layoutResY = storageHeight;
    } else {
      layoutResX = frame.width;
      layoutResY = frame.height;
    }
  }
  const blurScaleX = fontScrW / layoutResX;
  const blurScaleY = fontScrH / layoutResY;
  const safeBlurScaleX =
    Number.isFinite(blurScaleX) && blurScaleX > 0 ? blurScaleX : 1;
  const safeBlurScaleY =
    Number.isFinite(blurScaleY) && blurScaleY > 0 ? blurScaleY : 1;
  const borderScaleX = scaleBorderAndShadow ? safeScreenScaleX : safeBlurScaleX;
  const borderScaleY = scaleBorderAndShadow ? safeScreenScaleY : safeBlurScaleY;
  const safeBorderScaleX = borderScaleX / parScaleX;
  const safeBorderScaleY = borderScaleY;
  const toScreenX = (x: number): number => x * safeScreenScaleXPar;
  const toScreenY = (y: number): number => y * safeScreenScaleY;

  const marginL = quantSubpixel(
    toScreenX(ev.marginL > 0 ? ev.marginL : eventBaseStyle.marginL),
  );
  const marginR = quantSubpixel(
    toScreenX(ev.marginR > 0 ? ev.marginR : eventBaseStyle.marginR),
  );
  const marginV = quantSubpixel(
    toScreenY(ev.marginV > 0 ? ev.marginV : eventBaseStyle.marginV),
  );

  const availableWidth = Math.max(0, frame.width - marginL - marginR);
  let wrapStyle = frame.wrapStyle;
  const lines: Line[] = [];
  // Soft-break bookkeeping for libass wrap_lines_rebalance parity:
  // softLineStart[i] is true when lines[i] was started by the greedy wrap
  // (libass linebreak == 1) rather than by \N (linebreak == 2).
  const softLineStart: boolean[] = [];
  // First item of each non-space token: the only positions where a soft
  // break may be placed (libass ALLOWBREAK boundaries).
  const wordStartItems = new WeakSet<LineItem>();
  let currentLine: Line = {
    items: [],
    width: 0,
    ascent: 0,
    descent: 0,
    height: 0,
    cacheable: layoutCacheable,
  };

  let align = baseStyle.alignment;
  let posX: number | null = null;
  let posY: number | null = null;
  let posSeq = -1;
  let moveSeq = -1;
  let seq = 0;
  let move: MoveParams | null = null;
  let clip: ClipShape | null = null;
  let currentScaleX = baseStyle.scaleX;
  let currentScaleY = baseStyle.scaleY;
  let currentRotateZ = baseStyle.angle ?? 0;
  let currentRotateX = 0;
  let currentRotateY = 0;
  let currentShearX = 0;
  let currentShearY = 0;
  let currentOrigin: OriginParams | null = null;
  let currentFadeSimple: { in: number; out: number } | null = null;
  let currentFadeComplex: {
    alphas: [number, number, number];
    times: [number, number, number, number];
  } | null = null;
  let karaokeTime = 0;
  let karaokeAbsolutePending: number | null = null;
  let segmentIndex = 0;

  for (let s = 0; s < segments.length; s++) {
    const seg = segments[s]!;
    if (!seg.text) continue;

    const inlineStyle = seg.style;
    let segEffects = seg.effects;
    let resetStyle: string | undefined;
    let hasReset = false;
    if (segEffects && segEffects.length > 0) {
      let resetIndex = -1;
      for (let i = 0; i < segEffects.length; i++) {
        if (segEffects[i]!.type === "reset") resetIndex = i;
      }
      if (resetIndex !== -1) {
        hasReset = true;
        resetStyle = (segEffects[resetIndex]!.params as ResetParams).style;
        segEffects = segEffects.slice(resetIndex + 1);
      }
    }
    if (hasReset) {
      baseStyle = resetStyle
        ? (doc.styles.get(resetStyle) ?? eventBaseStyle)
        : eventBaseStyle;
      align = baseStyle.alignment;
      wrapStyle = frame.wrapStyle;
      posX = null;
      posY = null;
      posSeq = -1;
      moveSeq = -1;
      move = null;
      clip = null;
      currentScaleX = baseStyle.scaleX;
      currentScaleY = baseStyle.scaleY;
      currentRotateZ = baseStyle.angle ?? 0;
      currentRotateX = 0;
      currentRotateY = 0;
      currentShearX = 0;
      currentShearY = 0;
      currentOrigin = null;
      currentFadeSimple = null;
      currentFadeComplex = null;
    }
    if (inlineStyle?.alignment !== undefined) align = inlineStyle.alignment;
    if (inlineStyle?.pos) {
      posX = toScreenX(inlineStyle.pos[0]);
      posY = toScreenY(inlineStyle.pos[1]);
      posSeq = seq++;
    }
    if (inlineStyle?.wrapStyle !== undefined)
      wrapStyle = inlineStyle.wrapStyle;
    if (segEffects && segEffects.length > 0) {
      const found = findMoveEffect(segEffects);
      if (found) {
        move = {
          from: [found.from[0], found.from[1]],
          to: [found.to[0], found.to[1]],
          t1: found.t1,
          t2: found.t2,
        };
        moveSeq = seq++;
      }
    }
    if (segEffects && segEffects.length > 0) {
      const foundClip = findClipEffect(
        segEffects,
        safeScreenScaleX,
        safeScreenScaleY,
      );
      if (foundClip) clip = foundClip;
    }
    if (segEffects && segEffects.length > 0) {
      const rotate = findRotateEffect(segEffects);
      if (rotate?.x !== undefined) currentRotateX = rotate.x;
      if (rotate?.y !== undefined) currentRotateY = rotate.y;
      if (rotate?.z !== undefined) currentRotateZ = rotate.z;
      const shear = findShearEffect(segEffects);
      if (shear?.x !== undefined) currentShearX = shear.x;
      if (shear?.y !== undefined) currentShearY = shear.y;
      const origin = findOriginEffect(segEffects);
      if (origin)
        currentOrigin = { x: toScreenX(origin.x), y: toScreenY(origin.y) };
    }
    if (segEffects && segEffects.length > 0) {
      const scale = findScaleEffect(segEffects);
      if (scale) {
        currentScaleX = scale.x;
        currentScaleY = scale.y;
      }
    }
    if (segEffects && segEffects.length > 0) {
      const fadeComplex = findFadeComplexEffect(segEffects);
      if (fadeComplex) {
        currentFadeComplex = fadeComplex;
        currentFadeSimple = null;
      } else {
        const fadeSimple = findFadeEffect(segEffects);
        if (fadeSimple) {
          currentFadeSimple = fadeSimple;
          currentFadeComplex = null;
        }
      }
    }
    const karaokeAbsolute = segEffects
      ? findKaraokeAbsoluteEffect(segEffects)
      : null;
    if (karaokeAbsolute !== null) karaokeAbsolutePending = karaokeAbsolute;
    const karaoke = segEffects ? findKaraokeEffect(segEffects) : null;
    let karaokeStart: number | null = null;
    let karaokeEnd: number | null = null;
    let karaokeMode: "fill" | "fade" | "outline" | null = null;
    if (karaoke) {
      if (karaokeAbsolutePending !== null) {
        karaokeTime = karaokeAbsolutePending;
        karaokeAbsolutePending = null;
      }
      karaokeStart = ev.start + karaokeTime;
      karaokeEnd = karaokeStart + karaoke.duration;
      karaokeMode = karaoke.mode;
      karaokeTime += karaoke.duration;
    }
    const drawing = segEffects ? findDrawingEffect(segEffects) : null;
    const drawingBaseline = segEffects
      ? findDrawingBaselineEffect(segEffects)
      : null;
    const animateEffects = segEffects ? findAnimateEffects(segEffects) : [];

    let spacing = baseStyle.spacing;
    let borderX = baseStyle.outline;
    let borderY = baseStyle.outline;
    let border = Math.max(borderX, borderY);
    let shadow = baseStyle.shadow;
    let shadowX = 0;
    let shadowY = 0;
    let blur = 0;
    let edgeBlur = 0;
    let hasBorderX = false;
    let hasBorderY = false;
    let hasShadowX = false;
    let hasShadowY = false;
    if (segEffects && segEffects.length > 0) {
      const spacingOverride = findSpacingEffect(segEffects);
      if (spacingOverride !== null) spacing = spacingOverride;
      const borderOverride = findBorderEffect(segEffects);
      if (borderOverride) {
        if (borderOverride.size !== undefined) {
          borderX = borderOverride.size;
          borderY = borderOverride.size;
        }
        if (borderOverride.x !== undefined) {
          borderX = Math.abs(borderOverride.x);
          hasBorderX = true;
        }
        if (borderOverride.y !== undefined) {
          borderY = Math.abs(borderOverride.y);
          hasBorderY = true;
        }
        border = Math.max(borderX, borderY);
      }
      const shadowOverride = findShadowEffect(segEffects);
      if (shadowOverride) {
        if (shadowOverride.depth !== undefined) shadow = shadowOverride.depth;
        if (shadowOverride.x !== undefined) {
          shadowX = shadowOverride.x;
          hasShadowX = true;
        }
        if (shadowOverride.y !== undefined) {
          shadowY = shadowOverride.y;
          hasShadowY = true;
        }
      }
      const blurOverride = findBlurEffect(segEffects);
      if (blurOverride !== null) blur = blurOverride;
      const edgeBlurOverride = findEdgeBlurEffect(segEffects);
      if (edgeBlurOverride !== null) edgeBlur = edgeBlurOverride;
    }

    const boldValue = inlineStyle?.bold ?? baseStyle.bold;
    const italicValue = inlineStyle?.italic ?? baseStyle.italic;
    const boldRequested =
      typeof boldValue === "number" ? boldValue !== 0 : !!boldValue;
    const italicRequested = !!italicValue;
    const fontName = inlineStyle?.fontName ?? baseStyle.fontName;
    let fontSize = inlineStyle?.fontSize ?? baseStyle.fontSize;
    const sampleCodepoint = findSampleCodepoint(seg.text);
    const fontStart = isProfiling() ? profileNow() : 0;
    const font = await getFontForStyle(
      fontName,
      boldRequested,
      italicRequested,
      sampleCodepoint ?? undefined,
    );
    if (isProfiling()) addFontMs(profileNow() - fontStart);
    const baseFontStyle = resolveFontStyle(
      font,
      boldRequested,
      italicRequested,
    );
    const underlineEnabled = inlineStyle?.underline ?? baseStyle.underline;
    const strikeoutEnabled = inlineStyle?.strikeout ?? baseStyle.strikeout;
    const upos = baseFontStyle.underlinePos;
    const uthick = baseFontStyle.underlineThickness;
    const spos = baseFontStyle.strikeoutPos;
    const sthick = baseFontStyle.strikeoutThickness;
    const baseSyntheticBold = baseFontStyle.syntheticBold;
    const baseSyntheticItalic = baseFontStyle.syntheticItalic;
    const baseFontHintingSupported = baseFontStyle.fontHintingSupported;
    let scaleXValue = currentScaleX;
    let scaleYValue = currentScaleY;
    let rotateZValue = currentRotateZ;
    let rotateXValue = currentRotateX;
    let rotateYValue = currentRotateY;
    let shearXValue = currentShearX;
    let shearYValue = currentShearY;
    const animState = {
      fontSize,
      scaleX: scaleXValue,
      scaleY: scaleYValue,
      rotateZ: rotateZValue,
      rotateX: rotateXValue,
      rotateY: rotateYValue,
      shearX: shearXValue,
      shearY: shearYValue,
      spacing,
      border,
      shadow,
      shadowX,
      shadowY,
      blur,
      edgeBlur,
    };
    let animateBorder = false;
    if (animateEffects.length > 0) {
      applyAnimateNumeric(animState, animateEffects, timeMs, ev);
      for (let i = 0; i < animateEffects.length; i++) {
        const anim = animateEffects[i]!;
        const target = anim.target;
        const active = animateProgress(timeMs, ev, anim) > 0;
        if (target.border !== undefined) {
          animateBorder = true;
        }
        // libass applies \t by recursively parsing the target tags with the
        // clamped progress value, then stores shadow_x/shadow_y on every glyph
        // info. Once an axis animation is active, that axis is explicit just as
        // if \xshad/\yshad had appeared outside \t; otherwise rasterization
        // falls back to scalar \shad and loses persisted kfx shadows.
        if (active) {
          if (target.shadowX !== undefined) hasShadowX = true;
          if (target.shadowY !== undefined) hasShadowY = true;
        }
        if (animateBorder && hasShadowX && hasShadowY) break;
      }
    }
    fontSize = animState.fontSize;
    scaleXValue = animState.scaleX;
    scaleYValue = animState.scaleY;
    rotateZValue = animState.rotateZ;
    rotateXValue = animState.rotateX;
    rotateYValue = animState.rotateY;
    shearXValue = animState.shearX;
    shearYValue = animState.shearY;
    spacing = animState.spacing;
    border = animState.border;
    if (animateBorder || (!hasBorderX && !hasBorderY)) {
      borderX = border;
      borderY = border;
    }
    border = Math.max(borderX, borderY);
    shadow = animState.shadow;
    shadowX = animState.shadowX;
    shadowY = animState.shadowY;
    blur = animState.blur;
    edgeBlur = animState.edgeBlur;

    if (scaleBorderAndShadow) {
      borderX *= safeBorderScaleX;
      borderY *= safeBorderScaleY;
      shadowX *= safeBorderScaleX;
      shadowY *= safeBorderScaleY;
    }
    const shadowScaleX = scaleBorderAndShadow ? safeBorderScaleX : 1;
    const shadowScaleY = scaleBorderAndShadow ? safeBorderScaleY : 1;
    border = Math.max(borderX, borderY);

    const scaleXFactor = scaleXValue / 100;
    const scaleYFactor = scaleYValue / 100;
    const fontSizePx = fontSize * safeScreenScaleY;
    const fontScale = getFontScaleForSize(font, fontSizePx);
    const scaleX = fontScale * scaleXFactor;
    const scaleY = fontScale * scaleYFactor;
    const fadeSimple = currentFadeSimple;
    const fadeComplex = currentFadeComplex;
    const fadeFactor = 1;
    const colorState = {
      primary: resolvePrimaryColor(baseStyle, inlineStyle),
      secondary: resolveSecondaryColor(baseStyle, inlineStyle),
      outline: resolveOutlineColor(baseStyle, inlineStyle),
      shadow: resolveShadowColor(baseStyle, inlineStyle),
    };
    // Color animation is applied during raster to allow layout caching.

    const blurQuantX = quantizeBlur(blur, safeBlurScaleX);
    const blurQuantY = quantizeBlur(blur, safeBlurScaleY);
    const blurSigmaX = blurQuantX.sigma;
    const blurSigmaY = blurQuantY.sigma;
    const shadowMaskX = blurQuantX.mask;
    const shadowMaskY = blurQuantY.mask;

    if (drawing && drawing.scale > 0) {
      const drawingScale = drawing.scale;
      const scaleFactor = 1 / (1 << (drawingScale - 1));
      const path = parseDrawingPathCached(drawing.commands, scaleFactor);
      if (path && path.bounds) {
        const pbo = drawingBaseline ?? 0;
        const pboScaled = pbo * scaleFactor;
        const xMin = path.bounds.xMin;
        const xMax = path.bounds.xMax;
        const yMin = path.bounds.yMin;
        const yMax = path.bounds.yMax;
        const height = yMax - yMin;
        const ascRaw = height - pboScaled;
        // libass shifts drawings up by asc = (yMax - yMin) - pbo relative to
        // the baseline (ass_render.c: offset.y = -asc * scale.y), independent
        // of where the bbox sits; yMax - pbo is wrong when yMin != 0.
        const drawBaselineRaw = ascRaw;
        const drawWidth = quantSubpixel(
          (xMax - xMin) * scaleXFactor * safeScreenScaleXPar,
        );
        const drawAscent = quantSubpixel(
          Math.max(0, ascRaw) * scaleYFactor * safeScreenScaleY,
        );
        const drawDescent = quantSubpixel(
          Math.max(0, pboScaled) * scaleYFactor * safeScreenScaleY,
        );

        currentLine.items[currentLine.items.length] = {
          font,
          fontSize: fontSizePx,
          color: resolvePrimaryColor(baseStyle, inlineStyle),
          primaryColor: colorState.primary,
          secondaryColor: colorState.secondary,
          outlineColor: colorState.outline,
          shadowColor: colorState.shadow,
          shaped: null,
          width: drawWidth,
          spacing: 0,
          spacingAfter: 0,
          baseStyle,
          inlineStyle,
          animates: animateEffects,
          scaleX,
          scaleY,
          scaleXFactor,
          scaleYFactor,
          rotateZ: rotateZValue,
          rotateX: rotateXValue,
          rotateY: rotateYValue,
          shearX: shearXValue,
          shearY: shearYValue,
          originOverride: currentOrigin
            ? { x: currentOrigin.x, y: currentOrigin.y }
            : null,
          drawingPath: path,
          drawingBaseline: drawBaselineRaw,
          border,
          borderX,
          borderY,
          borderStyle: baseStyle.borderStyle,
          shadow,
          shadowX,
          shadowY,
          shadowXExplicit: hasShadowX,
          shadowYExplicit: hasShadowY,
          shadowScaleX,
          shadowScaleY,
          blur,
          blurSigmaX,
          blurSigmaY,
          edgeBlur,
          shadowMaskX,
          shadowMaskY,
          ascent: drawAscent,
          descent: drawDescent,
          underline: false,
          strikeout: false,
          underlinePos: upos,
          underlineThickness: uthick,
          strikeoutPos: spos,
          strikeoutThickness: sthick,
          syntheticBold: baseSyntheticBold,
          syntheticItalic: baseSyntheticItalic,
          fontHintingSupported: baseFontHintingSupported,
          isWhitespace: false,
          text: drawing.commands,
          segmentIndex,
          karaokeStart,
          karaokeEnd,
          karaokeMode,
          fadeFactor,
          fadeSimple,
          fadeComplex,
        };

        currentLine.width = quantSubpixel(currentLine.width + drawWidth);
        if (drawAscent > currentLine.ascent) currentLine.ascent = drawAscent;
        if (drawDescent > currentLine.descent)
          currentLine.descent = drawDescent;
      }
      segmentIndex++;
      continue;
    }

    const fontEncoding = inlineStyle?.fontEncoding ?? baseStyle.encoding;
    const useAutoDirection = fontEncoding === -1;

    const parts = splitByNewline(seg.text);
    for (let p = 0; p < parts.length; p++) {
      const part = parts[p]!;
      const lineBaseDirection = useAutoDirection
        ? detectDirection(part)
        : Direction.LTR;
      // Pure-LTR lines shape each style run as a whole (with its real
      // neighbors) so contextual GSUB across token boundaries is preserved;
      // the shaped glyphs are then sliced back to tokens for line-breaking.
      // Bidi lines keep the per-token reorder + isolated shaping path.
      const rawTokens = tokenize(part);
      const pureLtr =
        lineBaseDirection === Direction.LTR &&
        !partHasRtl(part, lineBaseDirection);
      const tokens = pureLtr
        ? rawTokens
        : reorderTokensForBidi(part, rawTokens, lineBaseDirection);
      const tokenRunSpecs = pureLtr
        ? await buildLtrTokenRuns(
            part,
            tokens,
            font,
            fontName,
            boldRequested,
            italicRequested,
            lineBaseDirection,
            shapeCtx,
            shapeFeatures,
            kerningEnabled,
          )
        : null;
      for (let t = 0; t < tokens.length; t++) {
        const token = tokens[t]!;
        if (token.text.length === 0) continue;
        if (token.isSpace && currentLine.width === 0) continue;

        const spacingScaled = quantSubpixel(
          spacing * scaleXFactor * safeScreenScaleXPar,
        );
        const shapeStart = isProfiling() ? profileNow() : 0;
        // Pure-LTR: reuse the whole-run shaping sliced to this token. Bidi:
        // split the token by font and shape each sub-run in isolation (the
        // per-token reorder path). Both yield ShapedRunSpec[] in visual order.
        let specs: ShapedRunSpec[];
        if (tokenRunSpecs) {
          specs = tokenRunSpecs[t]!;
        } else {
          const runs = await splitTokenByFont(
            token,
            font,
            fontName,
            boldRequested,
            italicRequested,
          );
          specs = [];
          for (let r = 0; r < runs.length; r++) {
            const run = runs[r]!;
            // Shaping is independent of size/scale/transform (positions are in
            // font units), so shaped runs cache by font+text+direction+kerning.
            // Cached buffers are retained and must never enter the reuse pool.
            const shapeKey = `${lineBaseDirection}|${kerningEnabled ? 1 : 0}|${run.text}`;
            let shaped = getShapedRunCache(run.font, shapeKey);
            if (!shaped) {
              shaped = GlyphBuffer.withCapacity(run.text.length);
              shapeTextWithRuns(
                run.font,
                run.text,
                lineBaseDirection,
                shapeCtx,
                shaped,
                shapeFeatures,
              );
              setShapedRunCache(run.font, shapeKey, shaped);
            }
            specs[specs.length] = { font: run.font, shaped, text: run.text };
          }
        }
        if (specs.length === 0) {
          if (isProfiling()) addShapeMs(profileNow() - shapeStart);
          continue;
        }

        const runRecords: Array<{
          font: LineItem["font"];
          fontStyle: ResolvedFontStyle;
          shaped: GlyphBuffer;
          width: number;
          scaleX: number;
          scaleY: number;
          ascent: number;
          descent: number;
          text: string;
        }> = [];
        let tokenWidth = 0;

        for (let r = 0; r < specs.length; r++) {
          const spec = specs[r]!;
          const runFont = spec.font;
          const shaped = spec.shaped;
          const runFontStyle =
            runFont === font
              ? baseFontStyle
              : resolveFontStyle(runFont, boldRequested, italicRequested);
          const runFontScale = getFontScaleForSize(runFont, fontSizePx);
          const runScaleX = runFontScale * scaleXFactor;
          const runScaleY = runFontScale * scaleYFactor;
          const useHinting =
            runFontStyle.fontHintingSupported && !runFontStyle.syntheticBold;
          const boldStrength = runFontStyle.syntheticBold
            ? fontSizePx / 64
            : 0;
          const runMetrics = computeRunMetrics(
            runFont,
            shaped,
            fontSizePx,
            scaleYFactor,
            useHinting,
            boldStrength,
          );
          const runAscent = runMetrics.ascent;
          const runDescent = runMetrics.descent;
          const width = computeLineWidth(shaped, runScaleX, spacingScaled);
          runRecords[runRecords.length] = {
            font: runFont,
            fontStyle: runFontStyle,
            shaped,
            width,
            scaleX: runScaleX,
            scaleY: runScaleY,
            ascent: runAscent,
            descent: runDescent,
            text: spec.text,
          };
          tokenWidth = quantSubpixel(tokenWidth + width);
        }

        if (
          wrapStyle !== 2 &&
          !token.isSpace &&
          currentLine.width > 0 &&
          availableWidth > 0
        ) {
          if (currentLine.width + tokenWidth > availableWidth) {
            finalizeLineMetrics(currentLine);
            lines[lines.length] = currentLine;
            softLineStart[lines.length] = true;
            currentLine = {
              items: [],
              width: 0,
              ascent: 0,
              descent: 0,
              height: 0,
            cacheable: layoutCacheable,
            };
          }
        }

        for (let r = 0; r < runRecords.length; r++) {
          const record = runRecords[r]!;
          const style = record.fontStyle;
          currentLine.items[currentLine.items.length] = {
            font: record.font,
            fontSize: fontSizePx,
            color: resolvePrimaryColor(baseStyle, inlineStyle),
            primaryColor: colorState.primary,
            secondaryColor: colorState.secondary,
            outlineColor: colorState.outline,
            shadowColor: colorState.shadow,
            shaped: record.shaped,
            width: record.width,
            spacing: spacingScaled,
            spacingAfter: 0,
            baseStyle,
            inlineStyle,
            animates: animateEffects,
            scaleX: record.scaleX,
            scaleY: record.scaleY,
            scaleXFactor,
            scaleYFactor,
            rotateZ: rotateZValue,
            rotateX: rotateXValue,
            rotateY: rotateYValue,
            shearX: shearXValue,
            shearY: shearYValue,
            originOverride: currentOrigin
              ? { x: currentOrigin.x, y: currentOrigin.y }
              : null,
            drawingBaseline: drawingBaseline ?? 0,
            border,
            borderX,
            borderY,
            borderStyle: baseStyle.borderStyle,
            shadow,
            shadowX,
            shadowY,
            shadowXExplicit: hasShadowX,
            shadowYExplicit: hasShadowY,
            shadowScaleX,
            shadowScaleY,
            blur,
            blurSigmaX,
            blurSigmaY,
            edgeBlur,
            shadowMaskX,
            shadowMaskY,
            ascent: record.ascent,
            descent: record.descent,
            underline: !!underlineEnabled,
            strikeout: !!strikeoutEnabled,
            underlinePos: style.underlinePos,
            underlineThickness: style.underlineThickness,
            strikeoutPos: style.strikeoutPos,
            strikeoutThickness: style.strikeoutThickness,
            syntheticBold: style.syntheticBold,
            syntheticItalic: style.syntheticItalic,
            fontHintingSupported: style.fontHintingSupported,
            isWhitespace: token.isSpace,
            text: record.text,
            segmentIndex,
            karaokeStart,
            karaokeEnd,
            karaokeMode,
            fadeFactor,
            fadeSimple,
            fadeComplex,
          };
          if (r === 0 && !token.isSpace)
            wordStartItems.add(
              currentLine.items[currentLine.items.length - 1]!,
            );

          currentLine.width = quantSubpixel(
            currentLine.width + record.width,
          );
          if (record.ascent > currentLine.ascent)
            currentLine.ascent = record.ascent;
          if (record.descent > currentLine.descent)
            currentLine.descent = record.descent;
        }
        if (isProfiling()) addShapeMs(profileNow() - shapeStart);
      }

      if (p < parts.length - 1) {
        finalizeLineMetrics(currentLine);
        lines[lines.length] = currentLine;
        currentLine = {
          items: [],
          width: 0,
          ascent: 0,
          descent: 0,
          height: 0,
          cacheable: layoutCacheable,
        };
      }
    }

    segmentIndex++;
  }

  if (currentLine.items.length > 0 || lines.length === 0) {
    finalizeLineMetrics(currentLine);
    lines[lines.length] = currentLine;
  }

  // Port of libass wrap_lines_rebalance (ass_render.c): shift soft
  // linebreaks to balance out line lengths without changing the break
  // count. Applies to every wrap style except 1 (styles 0 and 3; style 2
  // never produces soft breaks). Runs before trailing-whitespace trimming,
  // like libass runs it before trim_whitespace().
  if (wrapStyle !== 1 && lines.length > 1) {
    let exit = false;
    while (!exit) {
      exit = true;
      for (let k = 0; k + 1 < lines.length; k++) {
        // Only soft breaks may move (libass: s2->linebreak == 1).
        if (!softLineStart[k + 1]) continue;
        const items1 = lines[k]!.items;
        const items2 = lines[k + 1]!.items;
        if (items1.length === 0 || items2.length === 0) continue;

        // Last non-whitespace item of line k (rewind_trailing_spaces).
        let e1old = items1.length - 1;
        while (e1old > 0 && items1[e1old]!.isWhitespace) e1old--;

        // Word to move starts at the last break opportunity at or before
        // e1old; index 0 is excluded (libass: if (w == s1) continue —
        // merging linebreaks is never beneficial).
        let ws = -1;
        for (let j = e1old; j >= 1; j--) {
          if (wordStartItems.has(items1[j]!)) {
            ws = j;
            break;
          }
        }
        if (ws < 1) continue;

        // New end of line k after the move: last non-whitespace before ws.
        let e1 = ws - 1;
        while (e1 > 0 && items1[e1]!.isWhitespace) e1--;

        // Last non-whitespace item of line k+1.
        let e2 = items2.length - 1;
        while (e2 > 0 && items2[e2]!.isWhitespace) e2--;

        // Trimmed widths before/after moving the word. l2new includes the
        // whitespace items between the word and the old break, which become
        // interior separators on line k+1 (libass measures span w..e2).
        let l1 = 0;
        for (let j = 0; j <= e1old; j++)
          l1 += items1[j]!.width + items1[j]!.spacingAfter;
        let l1new = 0;
        for (let j = 0; j <= e1; j++)
          l1new += items1[j]!.width + items1[j]!.spacingAfter;
        let tail = 0;
        for (let j = ws; j < items1.length; j++)
          tail += items1[j]!.width + items1[j]!.spacingAfter;
        let l2 = 0;
        for (let j = 0; j <= e2; j++)
          l2 += items2[j]!.width + items2[j]!.spacingAfter;
        const l2new = tail + l2;

        // libass: if (DIFF(l1_new, l2_new) < DIFF(l1, l2))
        if (Math.abs(l1new - l2new) < Math.abs(l1 - l2)) {
          lines[k + 1]!.items = items1.splice(ws).concat(items2);
          exit = false;
        }
      }
    }
  }

  for (let i = 0; i < lines.length; i++) trimTrailingWhitespace(lines[i]!);

  let totalHeight = 0;
  for (let i = 0; i < lines.length; i++) totalHeight += lines[i]!.height;
  totalHeight = quantSubpixel(totalHeight);

  if (move && moveSeq >= posSeq) {
    const pos = computeMovePosition(ev, timeMs, move);
    posX = toScreenX(pos.x);
    posY = toScreenY(pos.y);
  }
  if (posX !== null) posX = quantSubpixel(posX);
  if (posY !== null) posY = quantSubpixel(posY);

  let topY = marginV;
  if (posY === null) {
    if (align >= 4 && align <= 6) {
      topY = (frame.height - totalHeight) / 2;
    } else if (align <= 3) {
      topY = frame.height - marginV - totalHeight;
    }
  } else {
    if (align >= 4 && align <= 6) {
      topY = posY - totalHeight / 2;
    } else if (align <= 3) {
      topY = posY - totalHeight;
    } else {
      topY = posY;
    }
  }
  topY = quantSubpixel(topY);

  const hAlign = align % 3;
  let blockAnchorX = marginL;
  if (posX !== null) {
    blockAnchorX = posX;
  } else if (hAlign === 2) {
    blockAnchorX = marginL + (frame.width - marginL - marginR) / 2;
  } else if (hAlign === 0) {
    blockAnchorX = frame.width - marginR;
  }
  blockAnchorX = quantSubpixel(blockAnchorX);

  let blockAnchorY = topY;
  if (posY !== null) {
    blockAnchorY = posY;
  } else if (align >= 4 && align <= 6) {
    blockAnchorY = topY + totalHeight / 2;
  } else if (align <= 3) {
    blockAnchorY = topY + totalHeight;
  }
  blockAnchorY = quantSubpixel(blockAnchorY);


  const result = {
    lines,
    align,
    wrapStyle,
    posX,
    posY,
    move,
    clip,
    marginL,
    marginR,
    marginV,
    availableWidth,
    topY,
    blockAnchorX,
    blockAnchorY,
    safeScreenScaleXPar,
    safeScreenScaleY,
    safeBlurScaleX,
    safeBlurScaleY,
    cacheKey: cacheKey ?? undefined,
    layerCacheMode,
  };

  if (layoutCacheable && cacheKey) {
    EVENT_LAYOUT_CACHE.set(ev, { key: cacheKey, text: ev.text, value: result });
  }

  return result;
}
