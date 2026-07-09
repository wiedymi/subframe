import { test, expect } from "bun:test";
import { parseASS } from "subforge/ass";
import { renderFrame, renderFrameWithTrace } from "../src/core/pipeline";

const ASS = String.raw`[Script Info]
Title: drawing
ScriptType: v4.00+
PlayResX: 320
PlayResY: 200

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,Arial,28,&H00FFFFFF,&H000000FF,&H00000000,&H00000000,-1,0,0,0,100,100,0,0,1,0,0,2,10,10,10,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
Dialogue: 0,0:00:00.00,0:00:02.00,Default,,0,0,0,,{\\bord0\\shad0\\pos(60,120)\\p1}m 0 0 l 80 0 l 80 60 l 0 60{\\p0}
`;

test("\\p drawing renders as bitmap layers", async () => {
  const parsed = parseASS(ASS, { onError: "collect", strict: false, preserveOrder: true });
  expect(parsed.ok).toBe(true);
  const result = await renderFrame(parsed.document, 500, 320, 200);
  expect(result.layers.length).toBeGreaterThan(0);
});

test("\\pbo affects drawing metrics", async () => {
  const base = String.raw`[Script Info]
Title: drawing-pbo
ScriptType: v4.00+
PlayResX: 320
PlayResY: 200

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,Arial,28,&H00FFFFFF,&H000000FF,&H00000000,&H00000000,-1,0,0,0,100,100,0,0,1,0,0,2,10,10,10,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
Dialogue: 0,0:00:00.00,0:00:02.00,Default,,0,0,0,,{\\bord0\\shad0\\pos(60,120)\\p1}m 0 0 l 80 0 l 80 60 l 0 60{\\p0}
`;
  const shifted = base.replace("\\\\p1", "\\\\p1\\\\pbo20");

  const parsedBase = parseASS(base, { onError: "collect", strict: false, preserveOrder: true });
  const parsedShift = parseASS(shifted, { onError: "collect", strict: false, preserveOrder: true });
  expect(parsedBase.ok).toBe(true);
  expect(parsedShift.ok).toBe(true);

  const baseTrace = await renderFrameWithTrace(parsedBase.document, 500, 320, 200);
  const shiftTrace = await renderFrameWithTrace(parsedShift.document, 500, 320, 200);

  const baseLine = baseTrace.trace.events[0]?.lines[0];
  const shiftLine = shiftTrace.trace.events[0]?.lines[0];
  expect(baseLine).toBeDefined();
  expect(shiftLine).toBeDefined();
  // libass ass_render.c:1370-1371: desc = 64 * pbo; asc = bbox_height - desc.
  // A positive \pbo DECREASES the drawing's ascent and increases its descent.
  expect(shiftLine!.ascent).toBeLessThan(baseLine!.ascent);
  expect(shiftLine!.descent).toBeGreaterThan(baseLine!.descent);
});
