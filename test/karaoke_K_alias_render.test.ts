import { test, expect } from "bun:test";
import { parseASS } from "subforge/ass";
import { renderFrameWithTrace } from "../src/core/pipeline";

const ASS = String.raw`[Script Info]
Title: karaoke-K-alias
ScriptType: v4.00+
PlayResX: 320
PlayResY: 200

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,Arial,28,&H00FFFFFF,&H000000FF,&H00000000,&H00000000,-1,0,0,0,100,100,0,0,1,0,0,2,10,10,10,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
Dialogue: 0,0:00:00.00,0:00:05.00,Default,,0,0,0,,{\\K10}A{\\K20}B
`;

test("\\K behaves like \\kf for karaoke timing", async () => {
  const parsed = parseASS(ASS, { onError: "collect", strict: false, preserveOrder: true });
  expect(parsed.ok).toBe(true);

  const rendered = await renderFrameWithTrace(parsed.document, 0, 320, 200);
  const event = rendered.trace.events[0];
  expect(event).toBeDefined();

  const startsBySegment = new Map<number, number>();
  for (const line of event!.lines) {
    for (const glyph of line.items) {
      if (glyph.karaokeStart === null) continue;
      const prev = startsBySegment.get(glyph.segmentIndex);
      if (prev === undefined || glyph.karaokeStart < prev) {
        startsBySegment.set(glyph.segmentIndex, glyph.karaokeStart);
      }
    }
  }

  expect(startsBySegment.get(0)).toBe(0);
  expect(startsBySegment.get(1)).toBe(100);
});
