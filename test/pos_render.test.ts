import { test, expect } from "bun:test";
import { parseASS } from "subforge/ass";
import { renderFrame } from "../src/core/pipeline";

const BASE = String.raw`[Script Info]
Title: pos
ScriptType: v4.00+
PlayResX: 300
PlayResY: 200

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,Arial,28,&H00FFFFFF,&H000000FF,&H00000000,&H00000000,-1,0,0,0,100,100,0,0,1,0,0,7,10,10,10,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
Dialogue: 0,0:00:00.00,0:00:05.00,Default,,0,0,0,,{\pos(%X%,50)\an7}Hello
`;

async function renderMinX(posX: number): Promise<number> {
  const ass = BASE.replace("%X%", String(posX));
  const parsed = parseASS(ass, { onError: "collect", strict: false, preserveOrder: true });
  if (!parsed.ok) throw new Error("parse failed");
  const result = await renderFrame(parsed.document, 1000, 300, 200);
  let minX = Infinity;
  for (let i = 0; i < result.layers.length; i++) {
    const layer = result.layers[i]!;
    const x0 = Math.floor(layer.originX);
    if (x0 < minX) minX = x0;
  }
  return minX;
}

test("\\pos shifts rendered line", async () => {
  const x1 = await renderMinX(50);
  const x2 = await renderMinX(150);
  expect(x2 - x1).toBeGreaterThan(60);
});
