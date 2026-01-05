import { test, expect } from "bun:test";
import { parseASS } from "subforge/ass";
import { renderFrame } from "../src/core/pipeline";

const BASE = String.raw`[Script Info]
Title: drawing-clip
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

test("\\p drawings respect clip", async () => {
  const drawing = "{\\\\bord0\\\\shad0\\\\pos(50,50)\\\\p1}m 0 0 l 100 0 l 100 100 l 0 100{\\\\p0}";
  const unclipped = BASE.replace("%TEXT%", drawing);
  const clipped = BASE.replace(
    "%TEXT%",
    "{\\\\clip(0,0,80,80)}" + drawing
  );

  const parsedUnclip = parseASS(unclipped, { onError: "collect", strict: false, preserveOrder: true });
  const parsedClip = parseASS(clipped, { onError: "collect", strict: false, preserveOrder: true });
  expect(parsedUnclip.ok).toBe(true);
  expect(parsedClip.ok).toBe(true);

  const base = await renderFrame(parsedUnclip.document, 500, 320, 200);
  const clippedResult = await renderFrame(parsedClip.document, 500, 320, 200);

  const baseInk = ink(base.layers);
  const clipInk = ink(clippedResult.layers);

  expect(clipInk).toBeLessThan(baseInk);
});
