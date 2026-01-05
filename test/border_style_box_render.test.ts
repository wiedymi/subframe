import { test, expect } from "bun:test";
import { parseASS } from "subforge/ass";
import { renderFrame } from "../src/core/pipeline";

const ASS = String.raw`[Script Info]
Title: borderstyle-box
ScriptType: v4.00+
PlayResX: 320
PlayResY: 200

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,Arial,32,&H00FFFFFF,&H000000FF,&H000000FF,&H00000000,-1,0,0,0,100,100,0,0,3,8,0,2,10,10,10,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
Dialogue: 0,0:00:00.00,0:00:05.00,Default,,0,0,0,,BOX
`;

type Bounds = { minX: number; minY: number; maxX: number; maxY: number };

function colorBounds(
  layers: Array<{
    originX: number;
    originY: number;
    width: number;
    height: number;
    stride: number;
    bitmap: Uint8Array;
    color: [number, number, number, number];
  }>,
  color: [number, number, number]
): Bounds {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (let i = 0; i < layers.length; i++) {
    const layer = layers[i]!;
    if (layer.color[0] !== color[0] || layer.color[1] !== color[1] || layer.color[2] !== color[2]) continue;
    const { bitmap, stride, width, height } = layer;
    for (let y = 0; y < height; y++) {
      const row = y * stride;
      for (let x = 0; x < width; x++) {
        if (bitmap[row + x] === 0) continue;
        const gx = layer.originX + x;
        const gy = layer.originY + y;
        if (gx < minX) minX = gx;
        if (gy < minY) minY = gy;
        if (gx > maxX) maxX = gx;
        if (gy > maxY) maxY = gy;
      }
    }
  }
  if (!Number.isFinite(minX)) return { minX: 0, minY: 0, maxX: 0, maxY: 0 };
  return { minX, minY, maxX, maxY };
}

test("BorderStyle=3 draws an opaque box behind text", async () => {
  const parsed = parseASS(ASS, { onError: "collect", strict: false, preserveOrder: true });
  expect(parsed.ok).toBe(true);

  const result = await renderFrame(parsed.document, 1000, 320, 200);
  const red = colorBounds(result.layers, [255, 0, 0]);
  const white = colorBounds(result.layers, [255, 255, 255]);

  const redW = red.maxX - red.minX;
  const redH = red.maxY - red.minY;
  const whiteW = white.maxX - white.minX;
  const whiteH = white.maxY - white.minY;

  expect(redW).toBeGreaterThan(whiteW + 4);
  expect(redH).toBeGreaterThan(whiteH + 4);
});
