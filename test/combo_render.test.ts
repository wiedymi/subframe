import { test, expect } from "bun:test";
import { parseASS } from "subforge/ass";
import { renderFrame } from "../src/core/pipeline";

const COMBO_ASS = String.raw`[Script Info]
Title: combo
ScriptType: v4.00+
PlayResX: 320
PlayResY: 200

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,Arial,28,&H00FFFFFF,&H000000FF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,0,0,7,10,10,10,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
Dialogue: 0,0:00:00.00,0:00:05.00,Default,,0,0,0,,{\\bord0\\shad0\\fad(500,0)\\move(20,40,200,40)\\t(0,2000,\\frz45)\\clip(0,0,150,100)}Hello
`;

function minX(layers: { originX: number }[]): number {
  let min = Infinity;
  for (let i = 0; i < layers.length; i++) {
    const x = layers[i]!.originX;
    if (x < min) min = x;
  }
  return Number.isFinite(min) ? min : 0;
}

function maxAlpha(layers: { color: [number, number, number, number] }[]): number {
  let max = 0;
  for (let i = 0; i < layers.length; i++) {
    const a = layers[i]!.color[3];
    if (a > max) max = a;
  }
  return max;
}

test("combo: move + fade + t + clip stays coherent", async () => {
  const parsed = parseASS(COMBO_ASS, { onError: "collect", strict: false, preserveOrder: true });
  expect(parsed.ok).toBe(true);

  // At t=0 \fad(500,0) gives fade alpha 0: libass renders a fully transparent
  // frame, so no visible layer may exist.
  const faded = await renderFrame(parsed.document, 0, 320, 200);
  expect(faded.layers.every((layer) => layer.color[3] === 0)).toBe(true);

  // t=250 is mid-fade (factor 0.5): visible, partially transparent, and still
  // left of the t=1500 position on the \move path.
  const early = await renderFrame(parsed.document, 250, 320, 200);
  const mid = await renderFrame(parsed.document, 1500, 320, 200);

  expect(early.layers.length).toBeGreaterThan(0);
  expect(mid.layers.length).toBeGreaterThan(0);

  expect(minX(mid.layers)).toBeGreaterThan(minX(early.layers));
  expect(maxAlpha(mid.layers)).toBeGreaterThan(maxAlpha(early.layers));
});
