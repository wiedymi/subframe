import type { SubtitleDocument, SubtitleEvent } from "subforge/core";
import type { GlyphBuffer } from "text-shaper";
import type { FrameContext, BitmapLayer } from "../data/types";
import type { TraceContext, TraceEvent } from "../trace";
import { startTraceEvent } from "../trace";
import type { ShapeContext } from "../shape/shaper";
import { buildEventLayout } from "../layout/event";
import { renderEventLines } from "../raster/event";

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
  if (!layout) return;

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
  });
}
