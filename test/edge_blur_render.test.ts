import { test, expect } from "bun:test";
import { parseASS } from "subforge/ass";
import { renderFrame } from "../src/core/pipeline";

const BASE = String.raw`[Script Info]
Title: edge blur
ScriptType: v4.00+
PlayResX: 320
PlayResY: 200

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,Arial,28,&H00FFFFFF,&H000000FF,&H00000000,&H00000000,-1,0,0,0,100,100,0,0,1,0,0,2,10,10,10,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
Dialogue: 0,0:00:00.00,0:00:01.00,Default,,0,0,0,,%TEXT%
`;

function coverage(layers: { bitmap: Uint8Array }[]): number {
  let count = 0;
  for (let i = 0; i < layers.length; i++) {
    const bmp = layers[i]!.bitmap;
    for (let j = 0; j < bmp.length; j++) {
      if (bmp[j] > 0) count++;
    }
  }
  return count;
}

test("\\be increases coverage vs no edge blur", async () => {
  const plain = BASE.replace("%TEXT%", "{\\\\bord0\\\\shad0}Hello");
  const blurred = BASE.replace("%TEXT%", "{\\\\bord0\\\\shad0\\\\be3}Hello");

  const parsedPlain = parseASS(plain, { onError: "collect", strict: false, preserveOrder: true });
  const parsedBlur = parseASS(blurred, { onError: "collect", strict: false, preserveOrder: true });
  expect(parsedPlain.ok).toBe(true);
  expect(parsedBlur.ok).toBe(true);

  const base = await renderFrame(parsedPlain.document, 500, 320, 200);
  const blur = await renderFrame(parsedBlur.document, 500, 320, 200);

  const c0 = coverage(base.layers);
  const c1 = coverage(blur.layers);

  expect(c1).toBeGreaterThan(c0);
});

test("\\blur and \\be stack to increase coverage", async () => {
  const blurOnly = BASE.replace("%TEXT%", "{\\\\bord0\\\\shad0\\\\blur2}Hello");
  const beOnly = BASE.replace("%TEXT%", "{\\\\bord0\\\\shad0\\\\be3}Hello");
  const both = BASE.replace("%TEXT%", "{\\\\bord0\\\\shad0\\\\blur2\\\\be3}Hello");

  const parsedBlur = parseASS(blurOnly, { onError: "collect", strict: false, preserveOrder: true });
  const parsedBe = parseASS(beOnly, { onError: "collect", strict: false, preserveOrder: true });
  const parsedBoth = parseASS(both, { onError: "collect", strict: false, preserveOrder: true });
  expect(parsedBlur.ok).toBe(true);
  expect(parsedBe.ok).toBe(true);
  expect(parsedBoth.ok).toBe(true);

  const blur = await renderFrame(parsedBlur.document, 500, 320, 200);
  const be = await renderFrame(parsedBe.document, 500, 320, 200);
  const combo = await renderFrame(parsedBoth.document, 500, 320, 200);

  const cBlur = coverage(blur.layers);
  const cBe = coverage(be.layers);
  const cBoth = coverage(combo.layers);

  expect(cBoth).toBeGreaterThan(cBlur);
  expect(cBoth).toBeGreaterThan(cBe);
});
