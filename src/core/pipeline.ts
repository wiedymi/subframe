import type { SubtitleDocument, SubtitleEvent } from "subforge/core";
import type { GlyphBuffer } from "text-shaper";
import type { FrameContext, BitmapLayer } from "./data/types";
import type { TraceContext } from "./trace";
import { createTraceContext, toFrameTrace } from "./trace";
import { activeEventsAtTime, computeParScaleX, frameContextFromDocument } from "./frame";
import { createShapeContext, releaseGlyphBuffer } from "./shape/shaper";
import { renderEvent } from "./pipeline/event";
import { endFrameProfile, setEventCount, setLayerCount, startFrameProfile } from "./profile";
export { getEventLayerCacheStats, clearEventLayerCache } from "./pipeline/event";

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
  const profileEnabled =
    typeof process !== "undefined" && !!(process as any).env?.SUBFRAME_PROFILE;
  const profile = startFrameProfile(profileEnabled);
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
