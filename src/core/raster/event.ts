import type { SubtitleEvent } from "subforge/core";
import type { FrameContext, BitmapLayer, ColorRGBA } from "../data/types";
import type { TraceEvent, TraceLayer, TraceLine } from "../trace";
import { pushTraceGlyph, pushTraceLine } from "../trace";
import {
  BitmapBuilder,
  FillRule,
  PathBuilder,
  PixelMode,
  createBitmap,
  computeControlBox,
  getFillRuleFromFlags,
  rasterizePath,
} from "text-shaper";
import type { RasterizedGlyph } from "text-shaper";
import { quantSubpixel } from "../math/fixed";
import type { ClipShape } from "../tags/types";
import type { Line, LineItem } from "../layout/line";
import {
  addBitmapClamped,
  fixOutlineBitmap,
  normalizeLayerOrigin,
  shiftBitmapSubpixel,
  splitSubpixel,
} from "../raster/bitmap";
import {
  applyBeBlur,
  applyLibassGaussianBlur,
  bePadding,
  quantizeBlur,
  quantizeShadowOffset,
  quantizeTransformPos,
} from "../filters/blur";
import { applyClip } from "../clip/apply";
import { applyFade } from "../animate/fade";
import { itemRotateOrShear } from "../transform/affine";
import { buildTransformMatrix, flipYMatrix3, transformPoint } from "../transform/matrix";

const KARAOKE_CLIP_INF = 1_000_000_000;
const SYNTHETIC_ITALIC_SHEAR = 0.2;
const LIBASS_BBOX_EXPAND_MIN = 1;
const LIBASS_BBOX_EXPAND_MAX = 127;

function shouldBlurFill(borderStyle: number, borderMax: number): boolean {
  return borderStyle === 3 || borderMax <= 0;
}

function mulFix(value: number, scaleFix: number): number {
  if (value === 0 || scaleFix === 0) return 0;
  let sign = 1;
  let a = value;
  let b = scaleFix;
  if (a < 0) {
    a = -a;
    sign = -sign;
  }
  if (b < 0) {
    b = -b;
    sign = -sign;
  }
  const result = Math.floor((a * b + 0x8000) / 0x10000);
  return sign < 0 ? -result : result;
}

function getPathBoundsLibass(
  path: { commands: Array<any> },
  flipY: boolean,
): { minX: number; minY: number; maxX: number; maxY: number } | null {
  const scale26Fix = Math.round(1 * 64 * 0x10000);
  let minX26 = Infinity;
  let minY26 = Infinity;
  let maxX26 = -Infinity;
  let maxY26 = -Infinity;

  const box = computeControlBox(path as any);
  if (box) {
    minX26 = mulFix(box.xMin, scale26Fix);
    minY26 = mulFix(box.yMin, scale26Fix);
    maxX26 = mulFix(box.xMax, scale26Fix);
    maxY26 = mulFix(box.yMax, scale26Fix);
  } else {
    const update = (x: number, y: number): void => {
      const rx = mulFix(x, scale26Fix);
      const ry = mulFix(y, scale26Fix);
      if (rx < minX26) minX26 = rx;
      if (rx > maxX26) maxX26 = rx;
      if (ry < minY26) minY26 = ry;
      if (ry > maxY26) maxY26 = ry;
    };

    for (const cmd of path.commands) {
      switch (cmd.type) {
        case "M":
        case "L":
          update(cmd.x, cmd.y);
          break;
        case "Q":
          update(cmd.x1, cmd.y1);
          update(cmd.x, cmd.y);
          break;
        case "C":
          update(cmd.x1, cmd.y1);
          update(cmd.x2, cmd.y2);
          update(cmd.x, cmd.y);
          break;
        default:
          break;
      }
    }
  }

  if (!Number.isFinite(minX26) || !Number.isFinite(minY26)) return null;

  if (flipY) {
    const flippedMinY = -maxY26;
    const flippedMaxY = -minY26;
    return {
      minX: Math.floor((minX26 - LIBASS_BBOX_EXPAND_MIN) / 64),
      minY: Math.floor((flippedMinY - LIBASS_BBOX_EXPAND_MIN) / 64),
      maxX: Math.floor((maxX26 + LIBASS_BBOX_EXPAND_MAX) / 64),
      maxY: Math.floor((flippedMaxY + LIBASS_BBOX_EXPAND_MAX) / 64),
    };
  }
  return {
    minX: Math.floor((minX26 - LIBASS_BBOX_EXPAND_MIN) / 64),
    minY: Math.floor((minY26 - LIBASS_BBOX_EXPAND_MIN) / 64),
    maxX: Math.floor((maxX26 + LIBASS_BBOX_EXPAND_MAX) / 64),
    maxY: Math.floor((maxY26 + LIBASS_BBOX_EXPAND_MAX) / 64),
  };
}

function applySyntheticPathEffects(
  builder: PathBuilder,
  italic: boolean,
  boldStrength: number,
): PathBuilder {
  let out = builder;
  if (italic) out = out.shear(SYNTHETIC_ITALIC_SHEAR, 0);
  if (boldStrength > 0) out = out.embolden(boldStrength);
  return out;
}

function quantizePathInPlace(path: { commands: Array<any>; bounds?: any }): void {
  const cmds = path.commands;
  for (let i = 0; i < cmds.length; i++) {
    const cmd = cmds[i]!;
    switch (cmd.type) {
      case "M":
      case "L":
        cmd.x = quantSubpixel(cmd.x);
        cmd.y = quantSubpixel(cmd.y);
        break;
      case "Q":
        cmd.x1 = quantSubpixel(cmd.x1);
        cmd.y1 = quantSubpixel(cmd.y1);
        cmd.x = quantSubpixel(cmd.x);
        cmd.y = quantSubpixel(cmd.y);
        break;
      case "C":
        cmd.x1 = quantSubpixel(cmd.x1);
        cmd.y1 = quantSubpixel(cmd.y1);
        cmd.x2 = quantSubpixel(cmd.x2);
        cmd.y2 = quantSubpixel(cmd.y2);
        cmd.x = quantSubpixel(cmd.x);
        cmd.y = quantSubpixel(cmd.y);
        break;
      default:
        break;
    }
  }
  if ("bounds" in path) path.bounds = null;
}

function buildGlyphPath(
  font: LineItem["font"],
  glyphId: number,
  scaleX: number,
  scaleY: number,
  italic: boolean,
  boldStrength: number,
): PathBuilder | null {
  let builder = PathBuilder.fromGlyph(font, glyphId);
  if (!builder) return null;
  builder = builder.scale(scaleX, scaleY);
  builder = applySyntheticPathEffects(builder, italic, boldStrength);
  return builder;
}

function rasterizeFillFromPath(
  builder: PathBuilder,
  flipY: boolean,
  fillRuleOverride?: FillRule,
): RasterizedGlyph | null {
  const RASTER_Y_BIAS = 0;
  const path = builder.toPath();
  if (fillRuleOverride === FillRule.EvenOdd) path.flags = 1;
  quantizePathInPlace(path);
  const bounds = getPathBoundsLibass(path, flipY);
  if (!bounds) {
    return {
      bitmap: createBitmap(1, 1, PixelMode.Gray),
      bearingX: 0,
      bearingY: 0,
    };
  }
  const width = bounds.maxX - bounds.minX;
  const height = bounds.maxY - bounds.minY;
  if (width <= 0 || height <= 0) {
    return {
      bitmap: createBitmap(1, 1, PixelMode.Gray),
      bearingX: 0,
      bearingY: 0,
    };
  }
  const offsetX = -bounds.minX;
  const offsetY = -bounds.minY + (flipY ? RASTER_Y_BIAS : 0);
  const fillRule = fillRuleOverride ?? getFillRuleFromFlags(path);
  const bitmap = rasterizePath(path, {
    width,
    height,
    scale: 1,
    offsetX,
    offsetY,
    pixelMode: PixelMode.Gray,
    fillRule,
    flipY,
  });
  return {
    bitmap,
    bearingX: bounds.minX,
    bearingY: -bounds.minY,
  };
}

function rasterizeOutlineFromPath(
  builder: PathBuilder,
  borderX: number,
  borderY: number,
  flipY: boolean,
): RasterizedGlyph | null {
  if (!(borderX > 0 || borderY > 0)) return null;
  const LIBASS_STROKER_EPS = 0.25;
  const stroked = builder.clone().strokeAsymmetricCombined({
    xBorder: borderX,
    yBorder: borderY,
    eps: LIBASS_STROKER_EPS,
    lineJoin: "miter",
    miterLimit: 4,
  });
  return rasterizeFillFromPath(stroked, flipY, FillRule.EvenOdd);
}

export type RenderLinesInput = {
  ev: SubtitleEvent;
  frame: FrameContext;
  timeMs: number;
  lines: Line[];
  align: number;
  posX: number | null;
  posY: number | null;
  marginL: number;
  marginR: number;
  blockAnchorX: number;
  blockAnchorY: number;
  topY: number;
  clip: ClipShape | null;
  parScaleX: number;
  safeScreenScaleXPar: number;
  safeScreenScaleY: number;
  safeBlurScaleX: number;
  safeBlurScaleY: number;
  layers: BitmapLayer[];
  traceEvent: TraceEvent | null;
};

export function renderEventLines(input: RenderLinesInput): void {
  const {
    ev,
    frame,
    timeMs,
    lines,
    align,
    posX,
    posY,
    marginL,
    marginR,
    blockAnchorX,
    blockAnchorY,
    topY,
    clip,
    parScaleX,
    safeScreenScaleXPar,
    safeScreenScaleY,
    safeBlurScaleX,
    safeBlurScaleY,
    layers,
    traceEvent,
  } = input;
  const hAlign = align % 3;

  let penY = topY;
  const pushLayer = (
    layer: BitmapLayer,
    kind: TraceLayer["kind"],
    item: LineItem,
    padding: number,
    extraClip?: ClipShape,
    glyphMeta?: { glyphIndex?: number; glyphId?: number },
  ) => {
    normalizeLayerOrigin(layer);
    if (extraClip) applyClip(layer, extraClip);
    if (layer.clip) applyClip(layer, layer.clip);
    if (traceEvent) {
      traceEvent.layerCount++;
      const traceLayer: TraceLayer = {
        index: layers.length,
        z: layer.z,
        width: layer.width,
        height: layer.height,
        originX: layer.originX,
        originY: layer.originY,
        color: layer.color,
        clip: layer.clip ? layer.clip.type : null,
        kind,
        segmentIndex: item.segmentIndex,
        text: item.text,
        padding,
        outline: item.border,
        outlineX: item.borderX,
        outlineY: item.borderY,
        borderStyle: item.borderStyle,
        shadow: item.shadow,
        shadowX: item.shadowXExplicit
          ? item.shadowX
          : item.shadow * item.shadowScaleX,
        shadowY: item.shadowYExplicit
          ? item.shadowY
          : item.shadow * item.shadowScaleY,
        blur: item.blur,
        edgeBlur: item.edgeBlur,
        fontSize: item.fontSize,
        scaleXFactor: item.scaleXFactor,
        scaleYFactor: item.scaleYFactor,
        syntheticBold: item.syntheticBold,
        syntheticItalic: item.syntheticItalic,
        fontHintingSupported: item.fontHintingSupported,
        underline: item.underline,
        strikeout: item.strikeout,
        isDrawing: !!item.drawingPath,
      };
      if (glyphMeta) {
        if (glyphMeta.glyphIndex !== undefined)
          traceLayer.glyphIndex = glyphMeta.glyphIndex;
        if (glyphMeta.glyphId !== undefined)
          traceLayer.glyphId = glyphMeta.glyphId;
      }
      traceEvent.layers[traceEvent.layers.length] = traceLayer;
    }
    layers[layers.length] = layer;
  };
  for (let li = 0; li < lines.length; li++) {
    const line = lines[li]!;
    const lineWidth = line.width;

    const segStartX = new Map<number, number>();
    const segWidth = new Map<number, number>();
    let segCursor = 0;
    for (let ii = 0; ii < line.items.length; ii++) {
      const item = line.items[ii]!;
      const segAdvance = item.width + item.spacingAfter;
      if (!segStartX.has(item.segmentIndex))
        segStartX.set(item.segmentIndex, segCursor);
      const prev = segWidth.get(item.segmentIndex) ?? 0;
      segWidth.set(item.segmentIndex, prev + segAdvance);
      segCursor = quantSubpixel(segCursor + segAdvance);
    }

    let xStart = marginL;
    if (posX === null) {
      if (hAlign === 2) {
        xStart = marginL + (frame.width - marginL - marginR - lineWidth) / 2;
      } else if (hAlign === 0) {
        xStart = frame.width - marginR - lineWidth;
      }
    } else {
      if (hAlign === 2) {
        xStart = posX - lineWidth / 2;
      } else if (hAlign === 0) {
        xStart = posX - lineWidth;
      } else {
        xStart = posX;
      }
    }

    xStart = quantSubpixel(xStart);
    const baselineY = quantSubpixel(penY + line.ascent);
    let penX = xStart;
    let traceLine: TraceLine | null = null;
    if (traceEvent) {
      traceLine = {
        x: xStart,
        y: baselineY,
        width: line.width,
        height: line.height,
        ascent: line.ascent,
        descent: line.descent,
        items: [],
      };
      pushTraceLine(traceEvent, traceLine);
    }

    let boxItem: LineItem | null = null;
    let boxPadX = 0;
    let boxPadY = 0;
    let boxShadow = 0;
    let boxShadowX = 0;
    let boxShadowY = 0;
    let boxShadowXExplicit = false;
    let boxShadowYExplicit = false;
    let boxBlur = 0;
    let boxEdgeBlur = 0;
    for (let ii = 0; ii < line.items.length; ii++) {
      const item = line.items[ii]!;
      if (item.borderStyle !== 3) continue;
      if (!boxItem) boxItem = item;
      boxPadX = Math.max(boxPadX, item.borderX);
      boxPadY = Math.max(boxPadY, item.borderY);
      boxShadow = Math.max(boxShadow, item.shadow);
      if (item.shadowXExplicit) {
        boxShadowX = item.shadowX;
        boxShadowXExplicit = true;
      }
      if (item.shadowYExplicit) {
        boxShadowY = item.shadowY;
        boxShadowYExplicit = true;
      }
      boxBlur = Math.max(boxBlur, item.blur);
      boxEdgeBlur = Math.max(boxEdgeBlur, item.edgeBlur);
    }

    if (boxItem && lineWidth > 0 && line.height > 0) {
      const padX = Math.max(1, boxPadX);
      const padY = Math.max(1, boxPadY);
      const boxWidth = Math.max(1, Math.ceil(lineWidth + padX * 2));
      const boxHeight = Math.max(1, Math.ceil(line.height + padY * 2));
      const buffer = new Uint8Array(boxWidth * boxHeight);
      buffer.fill(255);
      const bitmap = {
        buffer,
        width: boxWidth,
        rows: boxHeight,
        pitch: boxWidth,
        pixelMode: PixelMode.Gray,
        numGrays: 256,
      };
      const extraPad = Math.ceil(Math.max(boxShadow, boxEdgeBlur));
      let baseBuilder = BitmapBuilder.fromBitmap(bitmap);
      if (extraPad > 0) baseBuilder = baseBuilder.pad(extraPad);

      const baseX = xStart - padX;
      const baseY = baselineY - line.ascent - padY;
      const boxColor = applyFade(boxItem.outlineColor, boxItem.fadeFactor);
      const boxShadowColor = applyFade(
        boxItem.shadowColor,
        boxItem.fadeFactor,
      );
      const shadowXRaw = boxShadowXExplicit
        ? boxShadowX
        : boxShadow * boxItem.shadowScaleX;
      const shadowYRaw = boxShadowYExplicit
        ? boxShadowY
        : boxShadow * boxItem.shadowScaleY;
      const shadowX = quantizeShadowOffset(shadowXRaw, boxItem.shadowMaskX);
      const shadowY = quantizeShadowOffset(shadowYRaw, boxItem.shadowMaskY);
      const boxBlurQuantX = quantizeBlur(boxBlur, safeBlurScaleX);
      const boxBlurQuantY = quantizeBlur(boxBlur, safeBlurScaleY);
      const boxBlurSigmaX = boxBlurQuantX.sigma;
      const boxBlurSigmaY = boxBlurQuantY.sigma;

      let baseGlyph = baseBuilder.toRasterizedGlyph();
      if (boxBlurSigmaX > 0 || boxBlurSigmaY > 0) {
        baseGlyph = applyLibassGaussianBlur(
          baseGlyph,
          boxBlurSigmaX,
          boxBlurSigmaY,
        );
      }
      if (boxEdgeBlur > 0) {
        applyBeBlur(baseGlyph.bitmap, boxEdgeBlur);
      }

      if (shadowX !== 0 || shadowY !== 0) {
        const shadowBuilder = BitmapBuilder.fromRasterizedGlyph(
          baseGlyph,
        ).shift(shadowX, shadowY);
        const sg = shadowBuilder.toRasterizedGlyph();
        const shadowLayer = {
          bitmap: sg.bitmap.buffer,
          width: sg.bitmap.width,
          height: sg.bitmap.rows,
          stride: sg.bitmap.pitch,
          originX: baseX + sg.bearingX,
          originY: baseY - sg.bearingY,
          color: boxShadowColor,
          z: ev.layer - 1,
          clip: clip ?? undefined,
        } as BitmapLayer;
        pushLayer(
          shadowLayer,
          "shadow",
          boxItem,
          Math.max(padX, padY, extraPad),
        );
      }

      const bg = baseGlyph;
      const boxLayer = {
        bitmap: bg.bitmap.buffer,
        width: bg.bitmap.width,
        height: bg.bitmap.rows,
        stride: bg.bitmap.pitch,
        originX: baseX + bg.bearingX,
        originY: baseY - bg.bearingY,
        color: boxColor,
        z: ev.layer,
        clip: clip ?? undefined,
      } as BitmapLayer;
      pushLayer(boxLayer, "outline", boxItem, Math.max(padX, padY, extraPad));
    }

    for (let ii = 0; ii < line.items.length; ii++) {
      const item = line.items[ii]!;
      const scaleX = item.scaleX;
      const scaleY = item.scaleY;
      const combineEnabled =
        (globalThis as any)?.process?.env?.SUBFRAME_COMBINE_GLYPHS !== "0";
      const shearXAdj =
        item.shearX !== 0 && scaleX !== 0 && scaleY !== 0
          ? item.shearX * (scaleX / scaleY)
          : item.shearX;
      const shearYAdj =
        item.shearY !== 0 && scaleX !== 0 && scaleY !== 0
          ? item.shearY * (scaleY / scaleX)
          : item.shearY;
      const fade = item.fadeFactor;
      const originX = item.originOverride
        ? quantSubpixel(item.originOverride.x)
        : blockAnchorX;
      const originY = item.originOverride
        ? quantSubpixel(item.originOverride.y)
        : blockAnchorY;
      const outlineBase = item.outlineColor;
      const shadowBase = item.shadowColor;
      const primaryBase = item.primaryColor;
      const secondaryBase = item.secondaryColor;
      const segStart = segStartX.get(item.segmentIndex) ?? 0;
      const segW = segWidth.get(item.segmentIndex) ?? item.width;
      // libass embolden strength ~= fontSize / 64 (see ass_font.c ass_glyph_embolden)
      const boldStrength = item.syntheticBold ? item.fontSize / 64 : 0;
      let karaokeSplitX: number | null = null;
      let karaokeFillColor = primaryBase;
      let karaokeFillPrimary = primaryBase;
      let karaokeFillSecondary = secondaryBase;
      let karaokeOutlineEnabled = true;
      if (
        item.karaokeStart !== null &&
        item.karaokeEnd !== null &&
        item.karaokeMode
      ) {
        const start = item.karaokeStart;
        const end = item.karaokeEnd;
        if (item.karaokeMode === "fade") {
          if (timeMs <= start) {
            karaokeSplitX = -KARAOKE_CLIP_INF;
          } else if (timeMs >= end || end <= start || segW <= 0) {
            karaokeSplitX = KARAOKE_CLIP_INF;
          } else {
            let t = (timeMs - start) / (end - start);
            if (t < 0) t = 0;
            if (t > 1) t = 1;
            let primary = primaryBase;
            let secondary = secondaryBase;
            let frz = item.rotateZ % 360;
            if (frz < 0) frz += 360;
            if (frz > 90 && frz < 270) {
              t = 1 - t;
              const tmp = primary;
              primary = secondary;
              secondary = tmp;
            }
            karaokeFillPrimary = primary;
            karaokeFillSecondary = secondary;
            karaokeSplitX = Math.round(xStart + segStart + segW * t);
          }
        } else {
          const active = timeMs >= start;
          karaokeFillColor = active ? primaryBase : secondaryBase;
          if (item.karaokeMode === "outline") karaokeOutlineEnabled = active;
        }
      }
      const fillSolidFinal = applyFade(karaokeFillColor, fade);
      const fillPrimaryFinal = applyFade(karaokeFillPrimary, fade);
      const fillSecondaryFinal = applyFade(karaokeFillSecondary, fade);
      const outlineColor = applyFade(outlineBase, fade);
      const shadowColor = applyFade(shadowBase, fade);

      if (traceLine) {
        pushTraceGlyph(traceLine, {
          text: item.text,
          isDrawing: !!item.drawingPath,
          isWhitespace: item.isWhitespace,
          x: penX,
          y: baselineY,
          width: item.width,
          ascent: item.ascent,
          descent: item.descent,
          fontSize: item.fontSize,
          spacing: item.spacing,
          spacingAfter: item.spacingAfter,
          rotateZ: item.rotateZ,
          rotateX: item.rotateX,
          rotateY: item.rotateY,
          shearX: item.shearX,
          shearY: item.shearY,
          originX,
          originY,
          scaleX: item.scaleXFactor,
          scaleY: item.scaleYFactor,
          scaleXFactor: item.scaleXFactor,
          scaleYFactor: item.scaleYFactor,
          border: item.border,
          borderX: item.borderX,
          borderY: item.borderY,
          borderStyle: item.borderStyle,
          shadow: item.shadow,
          shadowX: item.shadowXExplicit
            ? item.shadowX
            : item.shadow * item.shadowScaleX,
          shadowY: item.shadowYExplicit
            ? item.shadowY
            : item.shadow * item.shadowScaleY,
          blur: item.blur,
          edgeBlur: item.edgeBlur,
          underline: item.underline,
          strikeout: item.strikeout,
          syntheticBold: item.syntheticBold,
          syntheticItalic: item.syntheticItalic,
          karaokeStart: item.karaokeStart,
          karaokeEnd: item.karaokeEnd,
          segmentIndex: item.segmentIndex,
        });
      }

      if (item.drawingPath) {
        const useTransform = itemRotateOrShear(
          item.rotateZ,
          item.rotateX,
          item.rotateY,
          item.shearX,
          item.shearY,
        );
        const gx = penX;
        const gy = baselineY;
        let px = gx;
        let py = gy;

        let builder = PathBuilder.fromPath(item.drawingPath);
        const drawScaleX = item.scaleXFactor * safeScreenScaleXPar;
        const drawScaleY = item.scaleYFactor * safeScreenScaleY;
        builder = builder.scale(drawScaleX, drawScaleY);
        if (item.drawingBaseline !== 0)
          builder = builder.translate(0, -item.drawingBaseline * drawScaleY);
        if (useTransform) {
          const matrix = buildTransformMatrix(
            gx,
            gy,
            originX,
            originY,
            item.rotateZ,
            item.rotateX,
            item.rotateY,
            shearXAdj,
            shearYAdj,
            item.ascent,
            parScaleX,
            safeBlurScaleY,
          );
          builder = builder.perspective(matrix);
          px = 0;
          py = 0;
        }

        const raster = builder
          .rasterizeAuto({
            padding: 1,
            pixelMode: PixelMode.Gray,
            flipY: false,
          })
          .toRasterizedGlyph();
        if (raster) {
          const baseBuilder = BitmapBuilder.fromRasterizedGlyph(raster);
          const borderMax = Math.max(item.borderX, item.borderY);
          const pad = bePadding(item.edgeBlur);
          const padded = pad > 0 ? baseBuilder.pad(pad) : baseBuilder;
          const useBox = item.borderStyle === 3;
          const outlineRaster =
            !useBox && borderMax > 0
              ? rasterizeOutlineFromPath(
                  builder,
                  item.borderX,
                  item.borderY,
                  false,
                )
              : null;
          const outlineBase = outlineRaster
            ? pad > 0
              ? BitmapBuilder.fromRasterizedGlyph(outlineRaster).pad(pad)
              : BitmapBuilder.fromRasterizedGlyph(outlineRaster)
            : null;

          const sxRaw = item.shadowXExplicit
            ? item.shadowX
            : item.shadow * item.shadowScaleX;
          const syRaw = item.shadowYExplicit
            ? item.shadowY
            : item.shadow * item.shadowScaleY;
          const sx = quantizeShadowOffset(sxRaw, item.shadowMaskX);
          const sy = quantizeShadowOffset(syRaw, item.shadowMaskY);

          const blurSigmaX = item.blurSigmaX;
          const blurSigmaY = item.blurSigmaY;
          const blurFill = shouldBlurFill(item.borderStyle, borderMax);
          const fgBase = padded.clone().toRasterizedGlyph();
          const fg =
            (blurSigmaX > 0 || blurSigmaY > 0) && blurFill
              ? applyLibassGaussianBlur(fgBase, blurSigmaX, blurSigmaY)
              : fgBase;
          if (blurFill && item.edgeBlur > 0) applyBeBlur(fg.bitmap, item.edgeBlur);

          let og: ReturnType<BitmapBuilder["toRasterizedGlyph"]> | null = null;
          if (outlineBase) {
            const ogBase = outlineBase.clone().toRasterizedGlyph();
            og =
              blurSigmaX > 0 || blurSigmaY > 0
                ? applyLibassGaussianBlur(ogBase, blurSigmaX, blurSigmaY)
                : ogBase;
            if (og && item.edgeBlur > 0) applyBeBlur(og.bitmap, item.edgeBlur);
          }
          const fillOpaque =
            fillPrimaryFinal[3] === 255 && fillSecondaryFinal[3] === 255;
          const fillInBorder = borderMax > 0 && fillOpaque;
          if (og && fg && item.borderStyle !== 3 && !fillInBorder) {
            fixOutlineBitmap(
              og,
              px + og.bearingX,
              py - og.bearingY,
              fg,
              px + fg.bearingX,
              py - fg.bearingY,
            );
          }

          if (!useBox && (sx !== 0 || sy !== 0)) {
            const sg = og ?? fg;
            const layer = {
              bitmap: sg.bitmap.buffer,
              width: sg.bitmap.width,
              height: sg.bitmap.rows,
              stride: sg.bitmap.pitch,
              originX: px + sg.bearingX + sx,
              originY: py - sg.bearingY + sy,
              color: shadowColor,
              z: ev.layer - 1,
              clip: clip ?? undefined,
            } as BitmapLayer;
            pushLayer(layer, "shadow", item, pad);
          }

          if (og && karaokeOutlineEnabled) {
            const layer = {
              bitmap: og.bitmap.buffer,
              width: og.bitmap.width,
              height: og.bitmap.rows,
              stride: og.bitmap.pitch,
              originX: px + og.bearingX,
              originY: py - og.bearingY,
              color: outlineColor,
              z: ev.layer,
              clip: clip ?? undefined,
            } as BitmapLayer;
            pushLayer(layer, "outline", item, pad);
          }

          const fgOriginX = px + fg.bearingX;
          const fgOriginY = py - fg.bearingY;
          if (karaokeSplitX !== null) {
            const left = Math.round(fgOriginX);
            const right = left + fg.bitmap.width;
            if (karaokeSplitX <= left) {
              const layer = {
                bitmap: fg.bitmap.buffer,
                width: fg.bitmap.width,
                height: fg.bitmap.rows,
                stride: fg.bitmap.pitch,
                originX: fgOriginX,
                originY: fgOriginY,
                color: fillSecondaryFinal,
                z: ev.layer + 1,
                clip: clip ?? undefined,
              } as BitmapLayer;
              pushLayer(layer, "fill", item, pad);
            } else if (karaokeSplitX >= right) {
              const layer = {
                bitmap: fg.bitmap.buffer,
                width: fg.bitmap.width,
                height: fg.bitmap.rows,
                stride: fg.bitmap.pitch,
                originX: fgOriginX,
                originY: fgOriginY,
                color: fillPrimaryFinal,
                z: ev.layer + 1,
                clip: clip ?? undefined,
              } as BitmapLayer;
              pushLayer(layer, "fill", item, pad);
            } else {
              const leftLayer = {
                bitmap: fg.bitmap.buffer.slice(),
                width: fg.bitmap.width,
                height: fg.bitmap.rows,
                stride: fg.bitmap.pitch,
                originX: fgOriginX,
                originY: fgOriginY,
                color: fillPrimaryFinal,
                z: ev.layer + 1,
                clip: clip ?? undefined,
              } as BitmapLayer;
              pushLayer(leftLayer, "fill", item, pad, {
                type: "rect",
                x0: -KARAOKE_CLIP_INF,
                y0: -KARAOKE_CLIP_INF,
                x1: karaokeSplitX,
                y1: KARAOKE_CLIP_INF,
                inverse: false,
              });
              const rightLayer = {
                bitmap: fg.bitmap.buffer.slice(),
                width: fg.bitmap.width,
                height: fg.bitmap.rows,
                stride: fg.bitmap.pitch,
                originX: fgOriginX,
                originY: fgOriginY,
                color: fillSecondaryFinal,
                z: ev.layer + 1,
                clip: clip ?? undefined,
              } as BitmapLayer;
              pushLayer(rightLayer, "fill", item, pad, {
                type: "rect",
                x0: karaokeSplitX,
                y0: -KARAOKE_CLIP_INF,
                x1: KARAOKE_CLIP_INF,
                y1: KARAOKE_CLIP_INF,
                inverse: false,
              });
            }
          } else {
            const layer = {
              bitmap: fg.bitmap.buffer,
              width: fg.bitmap.width,
              height: fg.bitmap.rows,
              stride: fg.bitmap.pitch,
              originX: fgOriginX,
              originY: fgOriginY,
              color: fillSolidFinal,
              z: ev.layer + 1,
              clip: clip ?? undefined,
            } as BitmapLayer;
            pushLayer(layer, "fill", item, pad);
          }
        }

        penX = quantSubpixel(penX + item.width + item.spacingAfter);
        continue;
      }

      const shaped = item.shaped;
      if (!shaped) {
        penX = quantSubpixel(penX + item.width + item.spacingAfter);
        continue;
      }
      const infos = shaped.infos;
      const positions = shaped.positions;
      let baselineShear = 0;
      const itemHasTransform =
        item.rotateZ !== 0 ||
        item.shearX !== 0 ||
        item.shearY !== 0 ||
        item.rotateX !== 0 ||
        item.rotateY !== 0;
      if (!itemHasTransform && combineEnabled) {
        const fillGlyphs: Array<{
          bitmap: {
            buffer: Uint8Array;
            width: number;
            rows: number;
            pitch: number;
          };
          x: number;
          y: number;
        }> = [];
        const outlineGlyphs: Array<{
          bitmap: {
            buffer: Uint8Array;
            width: number;
            rows: number;
            pitch: number;
          };
          x: number;
          y: number;
        }> = [];
        let minX = 0;
        let minY = 0;
        let maxX = 0;
        let maxY = 0;
        let haveBounds = false;
        let glyphPenX = penX;

        for (let gi = 0; gi < infos.length; gi++) {
          const glyphId = infos[gi]!.glyphId;
          const pos = positions[gi]!;

          const xOffset = quantSubpixel(pos.xOffset * scaleX);
          const yOffset = quantSubpixel(pos.yOffset * scaleY);
          const xAdvance = quantSubpixel(pos.xAdvance * scaleX);
          const isLastGlyph = gi === infos.length - 1;
          const advance =
            xAdvance + (isLastGlyph ? item.spacingAfter : item.spacing);

          const gx = quantSubpixel(glyphPenX + xOffset);
          let gy = quantSubpixel(baselineY - yOffset);
          if (shearYAdj !== 0) {
            gy = quantSubpixel(gy + baselineShear + shearYAdj * xOffset);
            baselineShear = quantSubpixel(
              baselineShear + shearYAdj * xAdvance,
            );
          }

          const useBox = item.borderStyle === 3;
          const borderMax = Math.max(item.borderX, item.borderY);
          const glyphPath = buildGlyphPath(
            item.font,
            glyphId,
            scaleX,
            scaleY,
            item.syntheticItalic,
            boldStrength,
          );
          if (!glyphPath) {
            glyphPenX = quantSubpixel(glyphPenX + advance);
            continue;
          }

          const fillRaster = rasterizeFillFromPath(glyphPath, true);
          if (fillRaster) {
            const originX = gx + fillRaster.bearingX;
            const originY = gy - fillRaster.bearingY;
            const sx = splitSubpixel(originX);
            const sy = splitSubpixel(originY);
            let fillBitmap = fillRaster.bitmap;
            if (sx.s !== 0 || sy.s !== 0) {
              const buf = new Uint8Array(fillBitmap.pitch * fillBitmap.rows);
              buf.set(fillBitmap.buffer);
              fillBitmap = {
                buffer: buf,
                width: fillBitmap.width,
                rows: fillBitmap.rows,
                pitch: fillBitmap.pitch,
              };
              shiftBitmapSubpixel(
                fillBitmap.buffer,
                fillBitmap.width,
                fillBitmap.rows,
                fillBitmap.pitch,
                sx.s,
                sy.s,
              );
            }
            const ix = sx.i;
            const iy = sy.i;
            const right = ix + fillBitmap.width;
            const bottom = iy + fillBitmap.rows;
            if (!haveBounds) {
              minX = ix;
              minY = iy;
              maxX = right;
              maxY = bottom;
              haveBounds = true;
            } else {
              if (ix < minX) minX = ix;
              if (iy < minY) minY = iy;
              if (right > maxX) maxX = right;
              if (bottom > maxY) maxY = bottom;
            }
            fillGlyphs[fillGlyphs.length] = {
              bitmap: fillBitmap,
              x: ix,
              y: iy,
            };
          }

          if (!useBox && borderMax > 0) {
            const outlineRaster = rasterizeOutlineFromPath(
              glyphPath,
              item.borderX,
              item.borderY,
              true,
            );
            if (outlineRaster) {
              const originX = gx + outlineRaster.bearingX;
              const originY = gy - outlineRaster.bearingY;
              const sx = splitSubpixel(originX);
              const sy = splitSubpixel(originY);
              let outlineBitmap = outlineRaster.bitmap;
              if (sx.s !== 0 || sy.s !== 0) {
                const buf = new Uint8Array(
                  outlineBitmap.pitch * outlineBitmap.rows,
                );
                buf.set(outlineBitmap.buffer);
                outlineBitmap = {
                  buffer: buf,
                  width: outlineBitmap.width,
                  rows: outlineBitmap.rows,
                  pitch: outlineBitmap.pitch,
                };
                shiftBitmapSubpixel(
                  outlineBitmap.buffer,
                  outlineBitmap.width,
                  outlineBitmap.rows,
                  outlineBitmap.pitch,
                  sx.s,
                  sy.s,
                );
              }
              const ix = sx.i;
              const iy = sy.i;
              const right = ix + outlineBitmap.width;
              const bottom = iy + outlineBitmap.rows;
              if (!haveBounds) {
                minX = ix;
                minY = iy;
                maxX = right;
                maxY = bottom;
                haveBounds = true;
              } else {
                if (ix < minX) minX = ix;
                if (iy < minY) minY = iy;
                if (right > maxX) maxX = right;
                if (bottom > maxY) maxY = bottom;
              }
              outlineGlyphs[outlineGlyphs.length] = {
                bitmap: outlineBitmap,
                x: ix,
                y: iy,
              };
            }
          }

          glyphPenX = quantSubpixel(glyphPenX + advance);
        }

        if (fillGlyphs.length > 0 && haveBounds) {
          const combinedWidth = Math.max(1, maxX - minX);
          const combinedHeight = Math.max(1, maxY - minY);
          const fillBitmap = createBitmap(
            combinedWidth,
            combinedHeight,
            PixelMode.Gray,
          );
          for (let gi = 0; gi < fillGlyphs.length; gi++) {
            const g = fillGlyphs[gi]!;
            addBitmapClamped(
              fillBitmap.buffer,
              combinedWidth,
              combinedHeight,
              fillBitmap.pitch,
              g.bitmap.buffer,
              g.bitmap.width,
              g.bitmap.rows,
              g.bitmap.pitch,
              g.x - minX,
              g.y - minY,
            );
          }
          const outlineBitmap =
            outlineGlyphs.length > 0
              ? createBitmap(combinedWidth, combinedHeight, PixelMode.Gray)
              : null;
          if (outlineBitmap) {
            for (let gi = 0; gi < outlineGlyphs.length; gi++) {
              const g = outlineGlyphs[gi]!;
              addBitmapClamped(
                outlineBitmap.buffer,
                combinedWidth,
                combinedHeight,
                outlineBitmap.pitch,
                g.bitmap.buffer,
                g.bitmap.width,
                g.bitmap.rows,
                g.bitmap.pitch,
                g.x - minX,
                g.y - minY,
              );
            }
          }

          const baseOriginX = minX;
          const baseOriginY = minY;
          const combinedFill = {
            bitmap: fillBitmap,
            bearingX: 0,
            bearingY: 0,
          };
          const useBox = item.borderStyle === 3;
          const borderMax = Math.max(item.borderX, item.borderY);
          const pad = bePadding(item.edgeBlur);
          const fillBase =
            pad > 0
              ? BitmapBuilder.fromRasterizedGlyph(combinedFill).pad(pad)
              : BitmapBuilder.fromRasterizedGlyph(combinedFill);
          const combinedOutline = outlineBitmap
            ? { bitmap: outlineBitmap, bearingX: 0, bearingY: 0 }
            : null;
          const outlineBase =
            !useBox && combinedOutline
              ? pad > 0
                ? BitmapBuilder.fromRasterizedGlyph(combinedOutline).pad(pad)
                : BitmapBuilder.fromRasterizedGlyph(combinedOutline)
              : null;

          const blurSigmaX = item.blurSigmaX;
          const blurSigmaY = item.blurSigmaY;
          const blurFill = shouldBlurFill(item.borderStyle, borderMax);
          const fgBase = fillBase.clone().toRasterizedGlyph();
          const fg =
            (blurSigmaX > 0 || blurSigmaY > 0) && blurFill
              ? applyLibassGaussianBlur(fgBase, blurSigmaX, blurSigmaY)
              : fgBase;
          if (blurFill && item.edgeBlur > 0)
            applyBeBlur(fg.bitmap, item.edgeBlur);

          let og: ReturnType<BitmapBuilder["toRasterizedGlyph"]> | null =
            null;
          if (outlineBase) {
            const ogBase = outlineBase.clone().toRasterizedGlyph();
            og =
              blurSigmaX > 0 || blurSigmaY > 0
                ? applyLibassGaussianBlur(ogBase, blurSigmaX, blurSigmaY)
                : ogBase;
            if (og && item.edgeBlur > 0) applyBeBlur(og.bitmap, item.edgeBlur);
          }
          const fillOpaque =
            fillPrimaryFinal[3] === 255 && fillSecondaryFinal[3] === 255;
          const fillInBorder = borderMax > 0 && fillOpaque;
          if (og && fg && item.borderStyle !== 3 && !fillInBorder) {
            fixOutlineBitmap(
              og,
              baseOriginX + og.bearingX,
              baseOriginY - og.bearingY,
              fg,
              baseOriginX + fg.bearingX,
              baseOriginY - fg.bearingY,
            );
          }

          if (!useBox) {
            const sxRaw = item.shadowXExplicit
              ? item.shadowX
              : item.shadow * item.shadowScaleX;
            const syRaw = item.shadowYExplicit
              ? item.shadowY
              : item.shadow * item.shadowScaleY;
            const sx = quantizeShadowOffset(sxRaw, item.shadowMaskX);
            const sy = quantizeShadowOffset(syRaw, item.shadowMaskY);
            if (sx !== 0 || sy !== 0) {
              const sg = og ?? fg;
              const layer = {
                bitmap: sg.bitmap.buffer,
                width: sg.bitmap.width,
                height: sg.bitmap.rows,
                stride: sg.bitmap.pitch,
                originX: baseOriginX + sg.bearingX + sx,
                originY: baseOriginY - sg.bearingY + sy,
                color: shadowColor,
                z: ev.layer - 1,
                clip: clip ?? undefined,
              } as BitmapLayer;
              pushLayer(layer, "shadow", item, pad);
            }
          }

          if (og && karaokeOutlineEnabled) {
            const layer = {
              bitmap: og.bitmap.buffer,
              width: og.bitmap.width,
              height: og.bitmap.rows,
              stride: og.bitmap.pitch,
              originX: baseOriginX + og.bearingX,
              originY: baseOriginY - og.bearingY,
              color: outlineColor,
              z: ev.layer,
              clip: clip ?? undefined,
            } as BitmapLayer;
            pushLayer(layer, "outline", item, pad);
          }

          const fgOriginX = baseOriginX + fg.bearingX;
          const fgOriginY = baseOriginY - fg.bearingY;
          if (karaokeSplitX !== null) {
            const left = Math.round(fgOriginX);
            const right = left + fg.bitmap.width;
            if (karaokeSplitX <= left) {
              const layer = {
                bitmap: fg.bitmap.buffer,
                width: fg.bitmap.width,
                height: fg.bitmap.rows,
                stride: fg.bitmap.pitch,
                originX: fgOriginX,
                originY: fgOriginY,
                color: fillSecondaryFinal,
                z: ev.layer + 1,
                clip: clip ?? undefined,
              } as BitmapLayer;
              pushLayer(layer, "fill", item, pad);
            } else if (karaokeSplitX >= right) {
              const layer = {
                bitmap: fg.bitmap.buffer,
                width: fg.bitmap.width,
                height: fg.bitmap.rows,
                stride: fg.bitmap.pitch,
                originX: fgOriginX,
                originY: fgOriginY,
                color: fillPrimaryFinal,
                z: ev.layer + 1,
                clip: clip ?? undefined,
              } as BitmapLayer;
              pushLayer(layer, "fill", item, pad);
            } else {
              const leftLayer = {
                bitmap: fg.bitmap.buffer.slice(),
                width: fg.bitmap.width,
                height: fg.bitmap.rows,
                stride: fg.bitmap.pitch,
                originX: fgOriginX,
                originY: fgOriginY,
                color: fillPrimaryFinal,
                z: ev.layer + 1,
                clip: clip ?? undefined,
              } as BitmapLayer;
              pushLayer(leftLayer, "fill", item, pad, {
                type: "rect",
                x0: -KARAOKE_CLIP_INF,
                y0: -KARAOKE_CLIP_INF,
                x1: karaokeSplitX,
                y1: KARAOKE_CLIP_INF,
                inverse: false,
              });
              const rightLayer = {
                bitmap: fg.bitmap.buffer.slice(),
                width: fg.bitmap.width,
                height: fg.bitmap.rows,
                stride: fg.bitmap.pitch,
                originX: fgOriginX,
                originY: fgOriginY,
                color: fillSecondaryFinal,
                z: ev.layer + 1,
                clip: clip ?? undefined,
              } as BitmapLayer;
              pushLayer(rightLayer, "fill", item, pad, {
                type: "rect",
                x0: karaokeSplitX,
                y0: -KARAOKE_CLIP_INF,
                x1: KARAOKE_CLIP_INF,
                y1: KARAOKE_CLIP_INF,
                inverse: false,
              });
            }
          } else {
            const layer = {
              bitmap: fg.bitmap.buffer,
              width: fg.bitmap.width,
              height: fg.bitmap.rows,
              stride: fg.bitmap.pitch,
              originX: fgOriginX,
              originY: fgOriginY,
              color: fillSolidFinal,
              z: ev.layer + 1,
              clip: clip ?? undefined,
            } as BitmapLayer;
            pushLayer(layer, "fill", item, pad);
          }
        }

        penX = quantSubpixel(penX + item.width + item.spacingAfter);
        continue;
      }

      for (let gi = 0; gi < infos.length; gi++) {
        const glyphId = infos[gi]!.glyphId;
        const glyphMeta = { glyphIndex: gi, glyphId };
        const pos = positions[gi]!;

        const xOffset = quantSubpixel(pos.xOffset * scaleX);
        const yOffset = quantSubpixel(pos.yOffset * scaleY);
        const xAdvance = quantSubpixel(pos.xAdvance * scaleX);
        const isLastGlyph = gi === infos.length - 1;
        const advance =
          xAdvance + (isLastGlyph ? item.spacingAfter : item.spacing);

        const gx = quantSubpixel(penX + xOffset);
        const useTransform = itemHasTransform;
        let gy = quantSubpixel(baselineY - yOffset);
        if (shearYAdj !== 0) {
          gy = quantSubpixel(gy + baselineShear + shearYAdj * xOffset);
          baselineShear = quantSubpixel(baselineShear + shearYAdj * xAdvance);
        }
        let px = gx;
        let py = gy;
        let qgx = gx;
        let qgy = gy;
        let qOriginX = originX;
        let qOriginY = originY;
        let transformMatrix: ReturnType<typeof buildTransformMatrix> | null =
          null;
        if (useTransform) {
          qgx = quantizeTransformPos(gx);
          qgy = quantizeTransformPos(gy);
          qOriginX = quantizeTransformPos(originX);
          qOriginY = quantizeTransformPos(originY);
          const placed = transformPoint(
            qgx,
            qgy,
            qOriginX,
            qOriginY,
            item.rotateZ,
            shearXAdj,
            shearYAdj,
            item.rotateX,
            item.rotateY,
            item.ascent,
            parScaleX,
            safeBlurScaleY,
          );
          px = placed.x;
          py = placed.y;
          transformMatrix = buildTransformMatrix(
            qgx,
            qgy,
            qOriginX,
            qOriginY,
            item.rotateZ,
            item.rotateX,
            item.rotateY,
            shearXAdj,
            shearYAdj,
            item.ascent,
            parScaleX,
            safeBlurScaleY,
          );
        }
        const useBox = item.borderStyle === 3;
        const borderMax = Math.max(item.borderX, item.borderY);
        let glyphPath = buildGlyphPath(
          item.font,
          glyphId,
          scaleX,
          scaleY,
          item.syntheticItalic,
          boldStrength,
        );
        if (!glyphPath) {
          penX = quantSubpixel(penX + advance);
          continue;
        }
        if (useTransform && transformMatrix) {
          glyphPath = glyphPath.perspective(flipYMatrix3(transformMatrix));
        }
        const fillRaster = rasterizeFillFromPath(glyphPath, true);

        let outlineRaster: RasterizedGlyph | null = null;
        if (!useBox && borderMax > 0) {
          outlineRaster = rasterizeOutlineFromPath(
            glyphPath,
            item.borderX,
            item.borderY,
            true,
          );
        }
        if (useTransform && transformMatrix) {
          px = 0;
          py = 0;
        }

        if (fillRaster) {
          const baseFill = fillRaster;

          const pad = bePadding(item.edgeBlur);
          const fillBase =
            pad > 0
              ? BitmapBuilder.fromRasterizedGlyph(baseFill).pad(pad)
              : BitmapBuilder.fromRasterizedGlyph(baseFill);
          const outlineBase =
            outlineRaster && !useBox
              ? pad > 0
                ? BitmapBuilder.fromRasterizedGlyph(outlineRaster).pad(pad)
                : BitmapBuilder.fromRasterizedGlyph(outlineRaster)
              : null;

          // Fill
          const blurSigmaX = item.blurSigmaX;
          const blurSigmaY = item.blurSigmaY;
          const blurFill = shouldBlurFill(item.borderStyle, borderMax);
          const fgBase = fillBase.clone().toRasterizedGlyph();
          const fg =
            (blurSigmaX > 0 || blurSigmaY > 0) && blurFill
              ? applyLibassGaussianBlur(fgBase, blurSigmaX, blurSigmaY)
              : fgBase;
          if (blurFill && item.edgeBlur > 0)
            applyBeBlur(fg.bitmap, item.edgeBlur);

          // Outline
          let og: ReturnType<BitmapBuilder["toRasterizedGlyph"]> | null =
            null;
          if (outlineBase) {
            const ogBase = outlineBase.clone().toRasterizedGlyph();
            og =
              blurSigmaX > 0 || blurSigmaY > 0
                ? applyLibassGaussianBlur(ogBase, blurSigmaX, blurSigmaY)
                : ogBase;
            if (og && item.edgeBlur > 0) applyBeBlur(og.bitmap, item.edgeBlur);
          }
          const fillOpaque =
            fillPrimaryFinal[3] === 255 && fillSecondaryFinal[3] === 255;
          const fillInBorder = borderMax > 0 && fillOpaque;
          if (og && fg && item.borderStyle !== 3 && !fillInBorder) {
            const fgOriginX = px + fg.bearingX;
            const fgOriginY = py - fg.bearingY;
            const ogOriginX = px + og.bearingX;
            const ogOriginY = py - og.bearingY;
            fixOutlineBitmap(
              og,
              ogOriginX,
              ogOriginY,
              fg,
              fgOriginX,
              fgOriginY,
            );
          }

          if (!useBox) {
            const sxRaw = item.shadowXExplicit
              ? item.shadowX
              : item.shadow * item.shadowScaleX;
            const syRaw = item.shadowYExplicit
              ? item.shadowY
              : item.shadow * item.shadowScaleY;
            const sx = quantizeShadowOffset(sxRaw, item.shadowMaskX);
            const sy = quantizeShadowOffset(syRaw, item.shadowMaskY);
            if (sx !== 0 || sy !== 0) {
              const sg = og ?? fg;
              const layer = {
                bitmap: sg.bitmap.buffer,
                width: sg.bitmap.width,
                height: sg.bitmap.rows,
                stride: sg.bitmap.pitch,
                originX: px + sg.bearingX + sx,
                originY: py - sg.bearingY + sy,
                color: shadowColor,
                z: ev.layer - 1,
                clip: clip ?? undefined,
              } as BitmapLayer;
              pushLayer(layer, "shadow", item, pad, undefined, glyphMeta);
            }
          }

          if (og && karaokeOutlineEnabled) {
            const layer = {
              bitmap: og.bitmap.buffer,
              width: og.bitmap.width,
              height: og.bitmap.rows,
              stride: og.bitmap.pitch,
              originX: px + og.bearingX,
              originY: py - og.bearingY,
              color: outlineColor,
              z: ev.layer,
              clip: clip ?? undefined,
            } as BitmapLayer;
            pushLayer(layer, "outline", item, pad, undefined, glyphMeta);
          }

          const fgOriginX = px + fg.bearingX;
          const fgOriginY = py - fg.bearingY;
          if (karaokeSplitX !== null) {
            const left = Math.round(fgOriginX);
            const right = left + fg.bitmap.width;
            if (karaokeSplitX <= left) {
              const layer = {
                bitmap: fg.bitmap.buffer,
                width: fg.bitmap.width,
                height: fg.bitmap.rows,
                stride: fg.bitmap.pitch,
                originX: fgOriginX,
                originY: fgOriginY,
                color: fillSecondaryFinal,
                z: ev.layer + 1,
                clip: clip ?? undefined,
              } as BitmapLayer;
              pushLayer(layer, "fill", item, pad, undefined, glyphMeta);
            } else if (karaokeSplitX >= right) {
              const layer = {
                bitmap: fg.bitmap.buffer,
                width: fg.bitmap.width,
                height: fg.bitmap.rows,
                stride: fg.bitmap.pitch,
                originX: fgOriginX,
                originY: fgOriginY,
                color: fillPrimaryFinal,
                z: ev.layer + 1,
                clip: clip ?? undefined,
              } as BitmapLayer;
              pushLayer(layer, "fill", item, pad, undefined, glyphMeta);
            } else {
              const leftLayer = {
                bitmap: fg.bitmap.buffer.slice(),
                width: fg.bitmap.width,
                height: fg.bitmap.rows,
                stride: fg.bitmap.pitch,
                originX: fgOriginX,
                originY: fgOriginY,
                color: fillPrimaryFinal,
                z: ev.layer + 1,
                clip: clip ?? undefined,
              } as BitmapLayer;
              pushLayer(
                leftLayer,
                "fill",
                item,
                pad,
                {
                  type: "rect",
                  x0: -KARAOKE_CLIP_INF,
                  y0: -KARAOKE_CLIP_INF,
                  x1: karaokeSplitX,
                  y1: KARAOKE_CLIP_INF,
                  inverse: false,
                },
                glyphMeta,
              );
              const rightLayer = {
                bitmap: fg.bitmap.buffer.slice(),
                width: fg.bitmap.width,
                height: fg.bitmap.rows,
                stride: fg.bitmap.pitch,
                originX: fgOriginX,
                originY: fgOriginY,
                color: fillSecondaryFinal,
                z: ev.layer + 1,
                clip: clip ?? undefined,
              } as BitmapLayer;
              pushLayer(
                rightLayer,
                "fill",
                item,
                pad,
                {
                  type: "rect",
                  x0: karaokeSplitX,
                  y0: -KARAOKE_CLIP_INF,
                  x1: KARAOKE_CLIP_INF,
                  y1: KARAOKE_CLIP_INF,
                  inverse: false,
                },
                glyphMeta,
              );
            }
          } else {
            const layer = {
              bitmap: fg.bitmap.buffer,
              width: fg.bitmap.width,
              height: fg.bitmap.rows,
              stride: fg.bitmap.pitch,
              originX: fgOriginX,
              originY: fgOriginY,
              color: fillSolidFinal,
              z: ev.layer + 1,
              clip: clip ?? undefined,
            } as BitmapLayer;
            pushLayer(layer, "fill", item, pad, undefined, glyphMeta);
          }
        }

        penX = quantSubpixel(penX + advance);
      }
    }

    // Underline / strikeout lines (per line, after glyph rendering)
    if (lineWidth > 0) {
      let maxUnderlineThickness = 0;
      let maxStrikeoutThickness = 0;
      let underlinePos: number | null = null;
      let strikeoutPos: number | null = null;
      let underlineColor: ColorRGBA | null = null;
      let strikeoutColor: ColorRGBA | null = null;

      for (let ii = 0; ii < line.items.length; ii++) {
        const item = line.items[ii]!;
        if (item.underline) {
          maxUnderlineThickness = Math.max(
            maxUnderlineThickness,
            item.underlineThickness * item.scaleY,
          );
          const pos = item.underlinePos * item.scaleY;
          underlinePos =
            underlinePos === null ? pos : Math.min(underlinePos, pos);
          underlineColor = item.primaryColor;
        }
        if (item.strikeout) {
          maxStrikeoutThickness = Math.max(
            maxStrikeoutThickness,
            item.strikeoutThickness * item.scaleY,
          );
          const pos = item.strikeoutPos * item.scaleY;
          strikeoutPos =
            strikeoutPos === null ? pos : Math.min(strikeoutPos, pos);
          strikeoutColor = item.primaryColor;
        }
      }

      const drawLine = (
        yPos: number,
        thickness: number,
        color: ColorRGBA | null,
      ) => {
        if (!color || thickness <= 0) return;
        const height = Math.max(1, Math.round(Math.abs(thickness)));
        const width = Math.max(1, Math.ceil(lineWidth));
        const buffer = new Uint8Array(width * height);
        buffer.fill(255);
        const bitmap = {
          buffer,
          width,
          rows: height,
          pitch: width,
          pixelMode: PixelMode.Gray,
          numGrays: 256,
        };
        const builder = BitmapBuilder.fromBitmap(bitmap);
        const glyph = builder.toRasterizedGlyph();
        const layer = {
          bitmap: glyph.bitmap.buffer,
          width: glyph.bitmap.width,
          height: glyph.bitmap.rows,
          stride: glyph.bitmap.pitch,
          originX: xStart + glyph.bearingX,
          originY: yPos - glyph.bearingY,
          color,
          z: ev.layer + 1,
          clip: clip ?? undefined,
        } as BitmapLayer;
        pushLayer(layer, "fill", line.items[0]!, 0);
      };

      if (maxUnderlineThickness > 0 && underlinePos !== null) {
        const yPos = baselineY - underlinePos;
        drawLine(yPos, maxUnderlineThickness, underlineColor);
      }
      if (maxStrikeoutThickness > 0 && strikeoutPos !== null) {
        const yPos = baselineY - strikeoutPos;
        drawLine(yPos, maxStrikeoutThickness, strikeoutColor);
      }
    }

    penY = quantSubpixel(penY + line.height);
  }


}
