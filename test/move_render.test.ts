import { test, expect } from "bun:test";
import { parseASS } from "subforge/ass";
import { renderFrame } from "../src/core/pipeline";

const MOVE_ASS = String.raw`[Script Info]
Title: move
ScriptType: v4.00+
PlayResX: 300
PlayResY: 200

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,Arial,28,&H00FFFFFF,&H000000FF,&H00000000,&H00000000,-1,0,0,0,100,100,0,0,1,0,0,7,10,10,10,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
Dialogue: 0,0:00:00.00,0:00:10.00,Default,,0,0,0,,{\move(20,40,200,40)}Hello
`;

const MOVE_ANIM_ASS = String.raw`[Script Info]
Title: move-anim
ScriptType: v4.00+
PlayResX: 300
PlayResY: 200

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,Arial,28,&H00FFFFFF,&H000000FF,&H00000000,&H00000000,-1,0,0,0,100,100,0,0,1,0,0,7,10,10,10,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
Dialogue: 0,0:00:00.00,0:00:10.00,Default,,0,0,0,,{\move(20,40,200,40)\t(0,5000,\frz90)}Hello
`;

async function renderMinX(timeMs: number): Promise<number> {
  const parsed = parseASS(MOVE_ASS, { onError: "collect", strict: false, preserveOrder: true });
  if (!parsed.ok) throw new Error("parse failed");
  const result = await renderFrame(parsed.document, timeMs, 300, 200);
  let minX = Infinity;
  for (let i = 0; i < result.layers.length; i++) {
    const layer = result.layers[i]!;
    const x0 = Math.floor(layer.originX);
    if (x0 < minX) minX = x0;
  }
  return minX;
}

async function renderBoundsFromAss(ass: string, timeMs: number): Promise<{ minX: number; maxX: number; minY: number; maxY: number }> {
  const parsed = parseASS(ass, { onError: "collect", strict: false, preserveOrder: true });
  if (!parsed.ok) throw new Error("parse failed");
  const result = await renderFrame(parsed.document, timeMs, 300, 200);
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (let i = 0; i < result.layers.length; i++) {
    const l = result.layers[i]!;
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

test("\\move interpolates position over time", async () => {
  const xStart = await renderMinX(0);
  const xMid = await renderMinX(5000);
  const xEnd = await renderMinX(10000);
  expect(xMid).toBeGreaterThan(xStart);
  expect(xEnd).toBeGreaterThan(xMid);
});

test("\\move still moves while \\t animates rotation", async () => {
  const early = await renderBoundsFromAss(MOVE_ANIM_ASS, 0);
  const mid = await renderBoundsFromAss(MOVE_ANIM_ASS, 5000);

  expect(mid.minX).toBeGreaterThan(early.minX);
});
