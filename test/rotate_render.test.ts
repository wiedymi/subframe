import { test, expect } from "bun:test";
import { parseASS } from "subforge/ass";
import { renderFrame } from "../src/core/pipeline";

const ASS = String.raw`[Script Info]
Title: rotate
ScriptType: v4.00+
PlayResX: 320
PlayResY: 200

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,Arial,28,&H00FFFFFF,&H000000FF,&H00000000,&H00000000,-1,0,0,0,100,100,0,0,1,0,0,2,10,10,10,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
Dialogue: 0,0:00:00.00,0:00:01.00,Default,,0,0,0,,{\\bord0\\shad0\\pos(160,100)\\org(160,100)}Hello
Dialogue: 0,0:00:01.00,0:00:02.00,Default,,0,0,0,,{\\bord0\\shad0\\pos(160,100)\\org(160,100)\\frz45}Hello
`;

type Bounds = { minX: number; maxX: number; minY: number; maxY: number };

function boundsFromLayers(layers: { originX: number; originY: number; width: number; height: number }[]): Bounds {
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  for (let i = 0; i < layers.length; i++) {
    const l = layers[i]!;
    const x0 = l.originX;
    const y0 = l.originY;
    const x1 = l.originX + l.width;
    const y1 = l.originY + l.height;
    if (x0 < minX) minX = x0;
    if (y0 < minY) minY = y0;
    if (x1 > maxX) maxX = x1;
    if (y1 > maxY) maxY = y1;
  }
  if (!Number.isFinite(minX)) return { minX: 0, maxX: 0, minY: 0, maxY: 0 };
  return { minX, maxX, minY, maxY };
}

test("\\frz rotates glyphs around origin", async () => {
  const parsed = parseASS(ASS, { onError: "collect", strict: false, preserveOrder: true });
  expect(parsed.ok).toBe(true);

  const normal = await renderFrame(parsed.document, 500, 320, 200);
  const rotated = await renderFrame(parsed.document, 1500, 320, 200);

  const b0 = boundsFromLayers(normal.layers);
  const b1 = boundsFromLayers(rotated.layers);
  const w0 = b0.maxX - b0.minX;
  const w1 = b1.maxX - b1.minX;

  // libass's own \frz45 ink ratio is 0.881 (w 59 -> 52), so demand > 0.8, and
  // the strong rotation signal is vertical growth: ink height 19 -> 49 (>2x).
  expect(w1).toBeGreaterThan(w0 * 0.8);
  expect(w1).not.toBeCloseTo(w0, 1);
  expect(b1.maxY - b1.minY).toBeGreaterThan((b0.maxY - b0.minY) * 2);
});
