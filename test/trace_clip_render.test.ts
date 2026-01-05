import { test, expect } from "bun:test";
import { parseASS } from "subforge/ass";
import { renderFrameWithTrace } from "../src/core/pipeline";

const BASE = String.raw`[Script Info]
Title: trace-clip
ScriptType: v4.00+
PlayResX: 320
PlayResY: 200

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,Arial,28,&H00FFFFFF,&H000000FF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,0,0,7,10,10,10,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
Dialogue: 0,0:00:00.00,0:00:02.00,Default,,0,0,0,,%TEXT%
`;

test("trace records clip type and inversion", async () => {
  const rect = BASE.replace("%TEXT%", "{\\\\clip(0,0,100,100)}Hello");
  const rectInv = BASE.replace("%TEXT%", "{\\\\iclip(0,0,100,100)}Hello");
  const mask = BASE.replace("%TEXT%", "{\\\\clip(m 0 0 l 100 0 l 100 100 l 0 100)}Hello");
  const maskInv = BASE.replace("%TEXT%", "{\\\\iclip(m 0 0 l 100 0 l 100 100 l 0 100)}Hello");

  const parsedRect = parseASS(rect, { onError: "collect", strict: false, preserveOrder: true });
  const parsedRectInv = parseASS(rectInv, { onError: "collect", strict: false, preserveOrder: true });
  const parsedMask = parseASS(mask, { onError: "collect", strict: false, preserveOrder: true });
  const parsedMaskInv = parseASS(maskInv, { onError: "collect", strict: false, preserveOrder: true });
  expect(parsedRect.ok).toBe(true);
  expect(parsedRectInv.ok).toBe(true);
  expect(parsedMask.ok).toBe(true);
  expect(parsedMaskInv.ok).toBe(true);

  const rectTrace = await renderFrameWithTrace(parsedRect.document, 500, 320, 200);
  const rectInvTrace = await renderFrameWithTrace(parsedRectInv.document, 500, 320, 200);
  const maskTrace = await renderFrameWithTrace(parsedMask.document, 500, 320, 200);
  const maskInvTrace = await renderFrameWithTrace(parsedMaskInv.document, 500, 320, 200);

  expect(rectTrace.trace.events[0]!.clip).toBe("rect");
  expect(rectTrace.trace.events[0]!.clipInverse).toBe(false);
  expect(rectInvTrace.trace.events[0]!.clip).toBe("rect");
  expect(rectInvTrace.trace.events[0]!.clipInverse).toBe(true);

  expect(maskTrace.trace.events[0]!.clip).toBe("mask");
  expect(maskTrace.trace.events[0]!.clipInverse).toBe(false);
  expect(maskInvTrace.trace.events[0]!.clip).toBe("mask");
  expect(maskInvTrace.trace.events[0]!.clipInverse).toBe(true);
});
