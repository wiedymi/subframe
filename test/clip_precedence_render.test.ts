import { test, expect } from "bun:test";
import { parseASS } from "subforge/ass";
import { renderFrame } from "../src/core/pipeline";

const BASE = String.raw`[Script Info]
Title: clip precedence
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

function ink(layers: { bitmap: Uint8Array }[]): number {
  let sum = 0;
  for (let i = 0; i < layers.length; i++) {
    const b = layers[i]!.bitmap;
    for (let j = 0; j < b.length; j++) sum += b[j];
  }
  return sum;
}

test("last clip (rect vs vector) wins", async () => {
  const rectFirst = BASE.replace(
    "%TEXT%",
    "{\\\\pos(160,100)\\\\clip(100,60,220,140)\\\\clip(m 100 60 l 220 60 l 220 140 l 100 140)}Hello"
  );
  const vectorOnly = BASE.replace(
    "%TEXT%",
    "{\\\\pos(160,100)\\\\clip(m 100 60 l 220 60 l 220 140 l 100 140)}Hello"
  );
  const rectOnly = BASE.replace(
    "%TEXT%",
    "{\\\\pos(160,100)\\\\clip(100,60,220,140)}Hello"
  );

  const parsedRectFirst = parseASS(rectFirst, { onError: "collect", strict: false, preserveOrder: true });
  const parsedVectorOnly = parseASS(vectorOnly, { onError: "collect", strict: false, preserveOrder: true });
  const parsedRectOnly = parseASS(rectOnly, { onError: "collect", strict: false, preserveOrder: true });
  expect(parsedRectFirst.ok).toBe(true);
  expect(parsedVectorOnly.ok).toBe(true);
  expect(parsedRectOnly.ok).toBe(true);

  const rectFirstRender = await renderFrame(parsedRectFirst.document, 500, 320, 200);
  const vectorOnlyRender = await renderFrame(parsedVectorOnly.document, 500, 320, 200);
  const rectOnlyRender = await renderFrame(parsedRectOnly.document, 500, 320, 200);

  const inkRectFirst = ink(rectFirstRender.layers);
  const inkVectorOnly = ink(vectorOnlyRender.layers);
  const inkRectOnly = ink(rectOnlyRender.layers);

  expect(inkRectFirst).toBe(inkVectorOnly);
  expect(inkRectFirst).not.toBe(inkRectOnly);
});
