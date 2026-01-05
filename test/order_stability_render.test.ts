import { test, expect } from "bun:test";
import { parseASS } from "subforge/ass";
import { renderFrame } from "../src/core/pipeline";

const ASS = String.raw`[Script Info]
Title: order-stability
ScriptType: v4.00+
PlayResX: 320
PlayResY: 200

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,Arial,28,&H00FFFFFF,&H000000FF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,0,0,5,10,10,10,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
Dialogue: 0,0:00:00.00,0:00:02.00,Default,,0,0,0,,{\\pos(160,100)\\bord0\\shad0\\c&H0000FF&}Red
Dialogue: 5,0:00:00.00,0:00:02.00,Default,,0,0,0,,{\\pos(160,100)\\bord0\\shad0\\c&H00FF00&}Green
`;

function isRed(color: [number, number, number, number]) {
  return color[0] > 200 && color[1] < 50 && color[2] < 50;
}

function isGreen(color: [number, number, number, number]) {
  return color[1] > 200 && color[0] < 50 && color[2] < 50;
}

test("layers remain in stable event order across renders", async () => {
  const parsed = parseASS(ASS, { onError: "collect", strict: false, preserveOrder: true });
  expect(parsed.ok).toBe(true);

  const a = await renderFrame(parsed.document, 500, 320, 200);
  const b = await renderFrame(parsed.document, 500, 320, 200);

  const aColors = a.layers.map((l) => l.color);
  const bColors = b.layers.map((l) => l.color);
  expect(bColors.length).toBe(aColors.length);
  for (let i = 0; i < aColors.length; i++) {
    expect(bColors[i]![0]).toBe(aColors[i]![0]);
    expect(bColors[i]![1]).toBe(aColors[i]![1]);
    expect(bColors[i]![2]).toBe(aColors[i]![2]);
    expect(bColors[i]![3]).toBe(aColors[i]![3]);
  }

  let lastRed = -1;
  let firstGreen = -1;
  for (let i = 0; i < a.layers.length; i++) {
    const c = a.layers[i]!.color;
    if (isRed(c)) lastRed = i;
    if (firstGreen === -1 && isGreen(c)) firstGreen = i;
  }

  expect(lastRed).toBeGreaterThanOrEqual(0);
  expect(firstGreen).toBeGreaterThanOrEqual(0);
  expect(firstGreen).toBeGreaterThan(lastRed);
});
