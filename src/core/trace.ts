import type { SubtitleEvent } from "subforge/core";

export type TraceGlyph = {
  text: string;
  isDrawing: boolean;
  isWhitespace: boolean;
  x: number;
  y: number;
  width: number;
  ascent: number;
  descent: number;
  fontSize: number;
  spacing: number;
  spacingAfter: number;
  rotateZ: number;
  rotateX: number;
  rotateY: number;
  shearX: number;
  shearY: number;
  originX: number;
  originY: number;
  scaleX: number;
  scaleY: number;
  scaleXFactor: number;
  scaleYFactor: number;
  border: number;
  borderX: number;
  borderY: number;
  borderStyle: 1 | 3;
  shadow: number;
  shadowX: number;
  shadowY: number;
  blur: number;
  edgeBlur: number;
  underline: boolean;
  strikeout: boolean;
  syntheticBold: boolean;
  syntheticItalic: boolean;
  karaokeStart: number | null;
  karaokeEnd: number | null;
  segmentIndex: number;
};

export type TraceLine = {
  x: number;
  y: number;
  width: number;
  height: number;
  ascent: number;
  descent: number;
  items: TraceGlyph[];
};

export type TraceLayer = {
  index: number;
  z: number;
  width: number;
  height: number;
  originX: number;
  originY: number;
  color: [number, number, number, number];
  clip: "rect" | "mask" | null;
  kind: "shadow" | "outline" | "fill";
  segmentIndex: number;
  text: string;
  glyphIndex?: number;
  glyphId?: number;
  padding: number;
  outline: number;
  outlineX: number;
  outlineY: number;
  borderStyle: 1 | 3;
  shadow: number;
  shadowX: number;
  shadowY: number;
  blur: number;
  edgeBlur: number;
  fontSize: number;
  scaleXFactor: number;
  scaleYFactor: number;
  syntheticBold: boolean;
  syntheticItalic: boolean;
  fontHintingSupported: boolean;
  underline: boolean;
  strikeout: boolean;
  isDrawing: boolean;
};

export type TraceEvent = {
  eventId: number;
  style: string;
  start: number;
  end: number;
  layer: number;
  align: number;
  pos: [number | null, number | null];
  move: [number, number] | null;
  clip: "rect" | "mask" | null;
  clipInverse: boolean;
  margins: { l: number; r: number; v: number };
  wrapStyle: number;
  availableWidth: number;
  blockAnchor: { x: number; y: number };
  layerCount: number;
  lines: TraceLine[];
  layers: TraceLayer[];
};

export type FrameTrace = {
  timeMs: number;
  viewport: { width: number; height: number };
  events: TraceEvent[];
};

export type TraceContext = {
  frame: FrameTrace;
  nextEventId: number;
};

export function createTraceContext(timeMs: number, width: number, height: number): TraceContext {
  return {
    frame: { timeMs, viewport: { width, height }, events: [] },
    nextEventId: 0,
  };
}

export function startTraceEvent(
  ctx: TraceContext,
  ev: SubtitleEvent,
  align: number,
  pos: [number | null, number | null],
  move: [number, number] | null,
  clip: "rect" | "mask" | null,
  clipInverse: boolean,
  margins: { l: number; r: number; v: number },
  wrapStyle: number,
  availableWidth: number,
  blockAnchor: { x: number; y: number }
): TraceEvent {
  const event: TraceEvent = {
    eventId: ctx.nextEventId++,
    style: ev.style,
    start: ev.start,
    end: ev.end,
    layer: ev.layer,
    align,
    pos,
    move,
    clip,
    clipInverse,
    margins,
    wrapStyle,
    availableWidth,
    blockAnchor,
    layerCount: 0,
    lines: [],
    layers: [],
  };
  ctx.frame.events[ctx.frame.events.length] = event;
  return event;
}

export function pushTraceLine(event: TraceEvent, line: TraceLine): void {
  event.lines[event.lines.length] = line;
}

export function pushTraceGlyph(line: TraceLine, glyph: TraceGlyph): void {
  line.items[line.items.length] = glyph;
}

export function toFrameTrace(ctx: TraceContext): FrameTrace {
  return ctx.frame;
}
