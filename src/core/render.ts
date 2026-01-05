import type { SubtitleDocument, SubtitleEvent } from "subforge/core";
import type { FrameTrace } from "./trace";
import { renderFrame, renderFrameWithTrace, type RenderResult } from "./pipeline";

export type RenderDocumentResult = {
  frame: RenderResult["frame"];
  events: SubtitleEvent[];
  result: RenderResult;
  document: SubtitleDocument;
};

export type RenderTraceResult = {
  frame: RenderResult["frame"];
  events: SubtitleEvent[];
  result: RenderResult;
  document: SubtitleDocument;
  trace: FrameTrace;
};

export async function renderFrameFromDocument(
  document: SubtitleDocument,
  timeMs: number,
  width?: number,
  height?: number
): Promise<RenderDocumentResult> {
  const result = await renderFrame(document, timeMs, width, height);
  return {
    frame: result.frame,
    events: result.activeEvents,
    result,
    document,
  };
}

export async function renderFrameFromDocumentWithTrace(
  document: SubtitleDocument,
  timeMs: number,
  width?: number,
  height?: number
): Promise<RenderTraceResult> {
  const { result, trace } = await renderFrameWithTrace(document, timeMs, width, height);
  return {
    frame: result.frame,
    events: result.activeEvents,
    result,
    document,
    trace,
  };
}
