import type { SubtitleDocument, SubtitleEvent } from "subforge/core";
import type { FrameContext } from "./data/types";

export function frameContextFromDocument(
  doc: SubtitleDocument,
  timeMs: number,
  width?: number,
  height?: number,
): FrameContext {
  const w = width ?? doc.info.playResX ?? 1920;
  const h = height ?? doc.info.playResY ?? 1080;
  return {
    timeMs,
    width: w,
    height: h,
    marginL: doc.info.marginL ?? 0,
    marginR: doc.info.marginR ?? 0,
    marginV: doc.info.marginV ?? 0,
    wrapStyle: doc.info.wrapStyle ?? 0,
  };
}

export function computeParScaleX(
  doc: SubtitleDocument,
  frame: FrameContext,
): number {
  const info = doc.info as unknown as {
    par?: number;
    layoutResX?: number;
    layoutResY?: number;
    storageWidth?: number;
    storageHeight?: number;
  };
  let par = Number.isFinite(info.par) ? (info.par as number) : 1;
  const layoutResX = Number.isFinite(info.layoutResX)
    ? (info.layoutResX as number)
    : 0;
  const layoutResY = Number.isFinite(info.layoutResY)
    ? (info.layoutResY as number)
    : 0;
  const storageWidth = Number.isFinite(info.storageWidth)
    ? (info.storageWidth as number)
    : 0;
  const storageHeight = Number.isFinite(info.storageHeight)
    ? (info.storageHeight as number)
    : 0;
  const hasLayout = layoutResX > 0 && layoutResY > 0;

  if (par === 0 || hasLayout) {
    if (
      frame.width > 0 &&
      frame.height > 0 &&
      (hasLayout || (storageWidth > 0 && storageHeight > 0))
    ) {
      const dar = frame.width / frame.height;
      const layoutX = hasLayout
        ? layoutResX
        : storageWidth > 0
          ? storageWidth
          : doc.info.playResX;
      const layoutY = hasLayout
        ? layoutResY
        : storageHeight > 0
          ? storageHeight
          : doc.info.playResY;
      const sar = layoutY !== 0 ? layoutX / layoutY : 1;
      par = sar !== 0 ? dar / sar : 1;
    } else {
      par = 1;
    }
  }

  if (!Number.isFinite(par) || par <= 0) return 1;
  return par;
}

export function activeEventsAtTime(
  doc: SubtitleDocument,
  timeMs: number,
): SubtitleEvent[] {
  const events = doc.events;
  const out: Array<{ ev: SubtitleEvent; idx: number }> = [];
  for (let i = 0; i < events.length; i++) {
    const ev = events[i]!;
    if (timeMs < ev.start || timeMs >= ev.end) continue;
    out[out.length] = { ev, idx: i };
  }
  if (out.length > 1) {
    out.sort((a, b) => {
      if (a.ev.layer !== b.ev.layer) return a.ev.layer - b.ev.layer;
      return a.idx - b.idx;
    });
  }
  const ordered: SubtitleEvent[] = new Array(out.length);
  for (let i = 0; i < out.length; i++) ordered[i] = out[i]!.ev;
  return ordered;
}
