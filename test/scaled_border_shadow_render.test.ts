import { test, expect } from "bun:test";
import { parseASS } from "subforge/ass";
import { renderFrame } from "../src/core/pipeline";

const BASE = String.raw`[Script Info]
Title: scaled-border
ScriptType: v4.00+
PlayResX: 320
PlayResY: 200
ScaledBorderAndShadow: %SCALE%

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,Arial,32,&H00FFFFFF,&H000000FF,&H000000FF,&H00000000,-1,0,0,0,100,100,0,0,1,6,0,2,10,10,10,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
Dialogue: 0,0:00:00.00,0:00:05.00,Default,,0,0,0,,SCALE
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

async function renderOutlineBounds(scale: "yes" | "no"): Promise<{ width: number; height: number }> {
  const ass = BASE.replace("%SCALE%", scale);
  const parsed = parseASS(ass, { onError: "collect", strict: false, preserveOrder: true });
  expect(parsed.ok).toBe(true);
  // Ensure the doc flag matches the intended case (parser defaults to true).
  parsed.document.info.scaleBorderAndShadow = scale === "yes";
  const result = await renderFrame(parsed.document, 1000, 640, 400);
  const red = colorBounds(result.layers, [255, 0, 0]);
  return { width: red.maxX - red.minX, height: red.maxY - red.minY };
}

test("ScaledBorderAndShadow scales outline with output size", async () => {
  const scaled = await renderOutlineBounds("yes");
  const unscaled = await renderOutlineBounds("no");

  expect(scaled.width).toBeGreaterThan(unscaled.width + 2);
  expect(scaled.height).toBeGreaterThan(unscaled.height + 2);
});
