import { test, expect } from "bun:test";
import { parseASS } from "subforge/ass";
import { renderFrame } from "../src/core/pipeline";

const ASS_BASE = (text: string) => String.raw`[Script Info]
Title: trim
ScriptType: v4.00+
PlayResX: 240
PlayResY: 120

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,Arial,24,&H00FFFFFF,&H000000FF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,0,0,3,10,10,10,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
Dialogue: 0,0:00:00.00,0:00:02.00,Default,,0,0,0,,${text}
`;

function minXFromLayers(layers: { originX: number }[]): number {
  let minX = Number.POSITIVE_INFINITY;
  for (let i = 0; i < layers.length; i++) {
    const x = layers[i]!.originX;
    if (x < minX) minX = x;
  }
  return Number.isFinite(minX) ? minX : 0;
}

test("trailing spaces do not shift right-aligned text", async () => {
  const parsedPlain = parseASS(ASS_BASE("Hello"), { onError: "collect", strict: false, preserveOrder: true });
  const parsedSpaces = parseASS(ASS_BASE("Hello   "), { onError: "collect", strict: false, preserveOrder: true });
  expect(parsedPlain.ok).toBe(true);
  expect(parsedSpaces.ok).toBe(true);

  const plain = await renderFrame(parsedPlain.document, 500, 240, 120);
  const spaced = await renderFrame(parsedSpaces.document, 500, 240, 120);

  const minPlain = minXFromLayers(plain.layers);
  const minSpaced = minXFromLayers(spaced.layers);
  expect(Math.abs(minPlain - minSpaced)).toBeLessThan(1);
});
