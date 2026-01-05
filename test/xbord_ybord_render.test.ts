import { test, expect } from "bun:test";
import { parseASS } from "subforge/ass";
import { renderFrame } from "../src/core/pipeline";

const BASE = String.raw`[Script Info]
Title: xbord-ybord
ScriptType: v4.00+
PlayResX: 320
PlayResY: 200

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,Arial,36,&H00FFFFFF,&H000000FF,&H000000FF,&H00000000,-1,0,0,0,100,100,0,0,1,0,0,2,10,10,10,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
Dialogue: 0,0:00:00.00,0:00:05.00,Default,,0,0,0,,%TEXT%
`;

type Bounds = { minX: number; minY: number; maxX: number; maxY: number };

function outlineBounds(layers: Array<{
  originX: number;
  originY: number;
  width: number;
  height: number;
  stride: number;
  bitmap: Uint8Array;
  color: [number, number, number, number];
}>): Bounds {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (let i = 0; i < layers.length; i++) {
    const layer = layers[i]!;
    const isOutline = layer.color[0] === 255 && layer.color[1] === 0 && layer.color[2] === 0 && layer.color[3] > 0;
    if (!isOutline) continue;
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

async function renderBounds(tag: string): Promise<{ width: number; height: number }> {
  const ass = BASE.replace("%TEXT%", `{${tag}}TEST`);
  const parsed = parseASS(ass, { onError: "collect", strict: false, preserveOrder: true });
  expect(parsed.ok).toBe(true);
  const result = await renderFrame(parsed.document, 1000, 320, 200);
  const b = outlineBounds(result.layers);
  return { width: b.maxX - b.minX, height: b.maxY - b.minY };
}

test("\\xbord and \\ybord affect outline dimensions independently", async () => {
  const wide = await renderBounds("\\xbord12\\ybord2");
  const tall = await renderBounds("\\xbord2\\ybord12");

  expect(wide.width).toBeGreaterThan(tall.width + 4);
  expect(tall.height).toBeGreaterThan(wide.height + 4);
});
