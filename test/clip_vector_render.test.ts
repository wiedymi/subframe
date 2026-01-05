import { test, expect } from "bun:test";
import { parseASS } from "subforge/ass";
import { renderFrame } from "../src/core/pipeline";

const BASE = String.raw`[Script Info]
Title: clip vector
ScriptType: v4.00+
PlayResX: 320
PlayResY: 200

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,Arial,28,&H00FFFFFF,&H000000FF,&H00000000,&H00000000,-1,0,0,0,100,100,0,0,1,0,0,2,10,10,10,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
Dialogue: 0,0:00:00.00,0:00:02.00,Default,,0,0,0,,%TEXT%
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

test("vector \\clip reduces coverage", async () => {
  const plain = BASE.replace("%TEXT%", "{\\\\bord0\\\\shad0\\\\pos(60,120)}MMMMMM");
  const clipped = BASE.replace(
    "%TEXT%",
    "{\\\\bord0\\\\shad0\\\\pos(60,120)\\\\clip(1,m 0 0 l 160 0 l 160 200 l 0 200)}MMMMMM"
  );

  const parsedPlain = parseASS(plain, { onError: "collect", strict: false, preserveOrder: true });
  const parsedClip = parseASS(clipped, { onError: "collect", strict: false, preserveOrder: true });
  expect(parsedPlain.ok).toBe(true);
  expect(parsedClip.ok).toBe(true);

  const base = await renderFrame(parsedPlain.document, 500, 320, 200);
  const clip = await renderFrame(parsedClip.document, 500, 320, 200);

  const c0 = coverage(base.layers);
  const c1 = coverage(clip.layers);

  expect(c1).toBeLessThan(c0);
});
