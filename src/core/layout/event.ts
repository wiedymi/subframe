import type { SubtitleDocument, SubtitleEvent, Effect } from "subforge/core";
import type { GlyphBuffer } from "text-shaper";
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
import {
  fadeFactorComplex,
  fadeFactorSimple,
  findFadeComplexEffect,
  findFadeEffect,
} from "../animate/fade";
import { applyAnimateColors, applyAnimateNumeric, findAnimateEffects } from "../animate/apply";
import { computeMovePosition } from "../animate/move";
import { parseDrawingPath } from "../clip/parser";
import { findClipEffect } from "../clip/apply";
import { quantizeBlur } from "../filters/blur";
import { computeRunMetrics } from "../raster/metrics";
import {
  detectDirection,
  kerning,
  type ShapeFeature,
  getEmbeddings,
  getVisualOrder,
  Direction,
} from "text-shaper";

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

  const kerningEnabled = (doc.info as { kerning?: boolean } | undefined)
    ?.kerning !== false;
  const shapeFeatures: ShapeFeature[] | undefined = kerningEnabled
    ? undefined
    : [kerning(false)];

  const eventBaseStyle = doc.styles.get(ev.style);
  if (!eventBaseStyle) return null;
  let baseStyle = eventBaseStyle;

  const segments = resolveSegments(ev, frame.wrapStyle);
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
  let currentLine: Line = {
    items: [],
    width: 0,
    ascent: 0,
    descent: 0,
    height: 0,
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
    const font = await getFontForStyle(
      fontName,
      boldRequested,
      italicRequested,
      sampleCodepoint ?? undefined,
    );
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
        const anim = animateEffects[i] as Effect<"animate", AnimateParams>;
        if (anim.type !== "animate") continue;
        if (anim.params.target.border !== undefined) {
          animateBorder = true;
          break;
        }
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
    let fadeFactor = 1;
    if (currentFadeComplex) {
      fadeFactor = fadeFactorComplex(timeMs, ev, currentFadeComplex);
    } else if (currentFadeSimple) {
      fadeFactor = fadeFactorSimple(
        timeMs,
        ev,
        currentFadeSimple.in,
        currentFadeSimple.out,
      );
    }
    const colorState = {
      primary: resolvePrimaryColor(baseStyle, inlineStyle),
      secondary: resolveSecondaryColor(baseStyle, inlineStyle),
      outline: resolveOutlineColor(baseStyle, inlineStyle),
      shadow: resolveShadowColor(baseStyle, inlineStyle),
    };
    if (animateEffects.length > 0)
      applyAnimateColors(colorState, animateEffects, timeMs, ev);

    const blurQuantX = quantizeBlur(blur, safeBlurScaleX);
    const blurQuantY = quantizeBlur(blur, safeBlurScaleY);
    const blurSigmaX = blurQuantX.sigma;
    const blurSigmaY = blurQuantY.sigma;
    const shadowMaskX = blurQuantX.mask;
    const shadowMaskY = blurQuantY.mask;

    if (drawing && drawing.scale > 0) {
      const drawingScale = drawing.scale;
      const scaleFactor = 1 / (1 << (drawingScale - 1));
      const path = parseDrawingPath(drawing.commands, scaleFactor);
      if (path && path.bounds) {
        const pbo = drawingBaseline ?? 0;
        const pboScaled = pbo * scaleFactor;
        const xMin = path.bounds.xMin;
        const xMax = path.bounds.xMax;
        const yMin = path.bounds.yMin;
        const yMax = path.bounds.yMax;
        const height = yMax - yMin;
        const ascRaw = height - pboScaled;
        const drawBaselineRaw = yMax - pboScaled;
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
      const tokens = reorderTokensForBidi(
        part,
        tokenize(part),
        lineBaseDirection,
      );
      for (let t = 0; t < tokens.length; t++) {
        const token = tokens[t]!;
        if (token.text.length === 0) continue;
        if (token.isSpace && currentLine.width === 0) continue;

        const spacingScaled = quantSubpixel(
          spacing * scaleXFactor * safeScreenScaleXPar,
        );
        const runs = await splitTokenByFont(
          token,
          font,
          fontName,
          boldRequested,
          italicRequested,
        );
        if (runs.length === 0) continue;

        const runRecords: Array<{
          font: Awaited<ReturnType<typeof getFont>>;
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

        for (let r = 0; r < runs.length; r++) {
          const run = runs[r]!;
          const runFont = run.font;
          const runFontStyle =
            runFont === font
              ? baseFontStyle
              : resolveFontStyle(runFont, boldRequested, italicRequested);
          const runFontScale = getFontScaleForSize(runFont, fontSizePx);
          const runScaleX = runFontScale * scaleXFactor;
          const runScaleY = runFontScale * scaleYFactor;

          const shaped = acquireGlyphBuffer(run.text.length);
          usedGlyphBuffers[usedGlyphBuffers.length] = shaped;
          const baseDirection = lineBaseDirection;
          shapeTextWithRuns(
            runFont,
            run.text,
            baseDirection,
            shapeCtx,
            shaped,
            shapeFeatures,
          );
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
            text: run.text,
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
            currentLine = {
              items: [],
              width: 0,
              ascent: 0,
              descent: 0,
              height: 0,
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
          };

          currentLine.width = quantSubpixel(
            currentLine.width + record.width,
          );
          if (record.ascent > currentLine.ascent)
            currentLine.ascent = record.ascent;
          if (record.descent > currentLine.descent)
            currentLine.descent = record.descent;
        }
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
        };
      }
    }

    segmentIndex++;
  }

  if (currentLine.items.length > 0 || lines.length === 0) {
    finalizeLineMetrics(currentLine);
    lines[lines.length] = currentLine;
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


  return {
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
  };
}
