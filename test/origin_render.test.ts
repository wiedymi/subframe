import { test, expect } from "bun:test";
import { parseASS } from "subforge/ass";
import { renderFrame } from "../src/core/pipeline";

const BASE = String.raw`[Script Info]
Title: origin
ScriptType: v4.00+
PlayResX: 320
PlayResY: 200

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,Arial,28,&H00FFFFFF,&H000000FF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,0,0,2,10,10,10,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
Dialogue: 0,0:00:00.00,0:00:02.00,Default,,0,0,0,,%TEXT%
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

function centerOf(b: Bounds): { x: number; y: number } {
  return { x: (b.minX + b.maxX) / 2, y: (b.minY + b.maxY) / 2 };
}

test("\\org changes rotation pivot", async () => {
  const noOrg = BASE.replace("%TEXT%", "{\\\\bord0\\\\shad0\\\\pos(160,100)\\\\frz45}Pivot");
  const withOrg = BASE.replace("%TEXT%", "{\\\\bord0\\\\shad0\\\\pos(160,100)\\\\org(0,0)\\\\frz45}Pivot");

  const parsedNoOrg = parseASS(noOrg, { onError: "collect", strict: false, preserveOrder: true });
  const parsedWithOrg = parseASS(withOrg, { onError: "collect", strict: false, preserveOrder: true });
  expect(parsedNoOrg.ok).toBe(true);
  expect(parsedWithOrg.ok).toBe(true);

  const base = await renderFrame(parsedNoOrg.document, 500, 320, 200);
  const shifted = await renderFrame(parsedWithOrg.document, 500, 320, 200);

  const c0 = centerOf(boundsFromLayers(base.layers));
  const c1 = centerOf(boundsFromLayers(shifted.layers));

  const dx = Math.abs(c1.x - c0.x);
  const dy = Math.abs(c1.y - c0.y);

  expect(dx + dy).toBeGreaterThan(5);
});
