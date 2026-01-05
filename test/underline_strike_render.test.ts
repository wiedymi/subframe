import { test, expect } from "bun:test";
import { parseASS } from "subforge/ass";
import { renderFrame } from "../src/core/pipeline";

const BASE = String.raw`[Script Info]
Title: underline-strike
ScriptType: v4.00+
PlayResX: 320
PlayResY: 200

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,Arial,28,&H00FFFFFF,&H000000FF,&H00000000,&H00000000,-1,0,0,0,100,100,0,0,1,0,0,2,10,10,10,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
Dialogue: 0,0:00:00.00,0:00:05.00,Default,,0,0,0,,%TEXT%
`;

function hasPixels(layers: Array<{ bitmap: Uint8Array }>): boolean {
  for (const layer of layers) {
    const buf = layer.bitmap;
    for (let i = 0; i < buf.length; i++) {
      if (buf[i] !== 0) return true;
    }
  }
  return false;
}

test("\\u1 adds underline pixels", async () => {
  const parsed = parseASS(BASE.replace("%TEXT%", "{\\\\u1}Test"), { onError: "collect", strict: false, preserveOrder: true });
  expect(parsed.ok).toBe(true);
  const result = await renderFrame(parsed.document, 1000, 320, 200);
  const underline = result.layers.filter((l) => l.color[0] === 255 && l.color[1] === 255 && l.color[2] === 255);
  expect(hasPixels(underline)).toBe(true);
});

test("\\s1 adds strikeout pixels", async () => {
  const parsed = parseASS(BASE.replace("%TEXT%", "{\\\\s1}Test"), { onError: "collect", strict: false, preserveOrder: true });
  expect(parsed.ok).toBe(true);
  const result = await renderFrame(parsed.document, 1000, 320, 200);
  const strike = result.layers.filter((l) => l.color[0] === 255 && l.color[1] === 255 && l.color[2] === 255);
  expect(hasPixels(strike)).toBe(true);
});
