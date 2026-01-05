import { test, expect } from "bun:test";
import { parseASS } from "subforge/ass";
import { renderFrame } from "../src/core/pipeline";

const ASS = String.raw`[Script Info]
Title: reset
ScriptType: v4.00+
PlayResX: 320
PlayResY: 200

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,Arial,28,&H00FFFFFF,&H000000FF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,0,0,2,10,10,10,1
Style: Alt,Arial,28,&H000000FF,&H000000FF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,0,0,2,10,10,10,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
Dialogue: 0,0:00:00.00,0:00:02.00,Default,,0,0,0,,{\\c&H0000FF00&}A{\\rAlt}B
`;

test("\\r<Style> switches base style for subsequent text", async () => {
  const parsed = parseASS(ASS, { onError: "collect", strict: false, preserveOrder: true });
  expect(parsed.ok).toBe(true);
  const result = await renderFrame(parsed.document, 500, 320, 200);
  const hasGreen = result.layers.some((layer) => layer.color[0] === 0 && layer.color[1] === 255 && layer.color[2] === 0);
  const hasRed = result.layers.some((layer) => layer.color[0] === 255 && layer.color[1] === 0 && layer.color[2] === 0);
  expect(hasGreen).toBe(true);
  expect(hasRed).toBe(true);
});
