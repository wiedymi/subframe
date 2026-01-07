import type { SubtitleDocument, SubtitleEvent } from "subforge/core";
import type { GlyphBuffer } from "text-shaper";
import type { FrameContext, BitmapLayer } from "./data/types";
import type { TraceContext } from "./trace";
import { createTraceContext, toFrameTrace } from "./trace";
import { activeEventsAtTime, computeParScaleX, frameContextFromDocument } from "./frame";
import { createShapeContext, releaseGlyphBuffer } from "./shape/shaper";
import { renderEvent } from "./pipeline/event";

export type RenderResult = {
  layers: BitmapLayer[];
  activeEvents: SubtitleEvent[];
  frame: FrameContext;
};

async function renderFrameInternal(
  doc: SubtitleDocument,
  timeMs: number,
  width?: number,
  height?: number,
  traceCtx?: TraceContext,
): Promise<RenderResult> {
  const frame = frameContextFromDocument(doc, timeMs, width, height);
  const scaleBorderAndShadow = doc.info.scaleBorderAndShadow;
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
  const activeEvents = activeEventsAtTime(doc, timeMs);

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
  }

  for (let i = 0; i < usedGlyphBuffers.length; i++) {
    releaseGlyphBuffer(usedGlyphBuffers[i]!);
  }

  const sortedLayers = layers
    .map((layer, order) => ({ layer, order }))
    .sort((a, b) => {
      if (a.layer.z !== b.layer.z) return a.layer.z - b.layer.z;
      return a.order - b.order;
    })
    .map((entry) => entry.layer);

  return { layers: sortedLayers, activeEvents, frame };
}

export async function renderFrame(
  doc: SubtitleDocument,
  timeMs: number,
  width?: number,
  height?: number,
): Promise<RenderResult> {
  return renderFrameInternal(doc, timeMs, width, height);
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
