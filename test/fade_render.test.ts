import { test, expect } from "bun:test";
import { parseASS } from "subforge/ass";
import { renderFrame } from "../src/core/pipeline";

const BASE = String.raw`[Script Info]
Title: fade
ScriptType: v4.00+
PlayResX: 320
PlayResY: 200

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,Arial,28,&H00FFFFFF,&H000000FF,&H00000000,&H00000000,-1,0,0,0,100,100,0,0,1,0,0,2,10,10,10,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
Dialogue: 0,0:00:00.00,0:00:05.00,Default,,0,0,0,,%TEXT%
`;

const FADE_MOVE_ASS = String.raw`[Script Info]
Title: fade-move
ScriptType: v4.00+
PlayResX: 320
PlayResY: 200

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,Arial,28,&H00FFFFFF,&H000000FF,&H00000000,&H00000000,-1,0,0,0,100,100,0,0,1,0,0,7,10,10,10,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
Dialogue: 0,0:00:00.00,0:00:05.00,Default,,0,0,0,,{\\bord0\\shad0\\fad(500,0)\\move(20,40,200,40)}Hello
`;

async function maxAlpha(text: string, timeMs: number): Promise<number> {
  const ass = BASE.replace("%TEXT%", text);
  const parsed = parseASS(ass, { onError: "collect", strict: false, preserveOrder: true });
  expect(parsed.ok).toBe(true);
  const result = await renderFrame(parsed.document, timeMs, 320, 200);
  let max = 0;
  for (let i = 0; i < result.layers.length; i++) {
    const a = result.layers[i]!.color[3];
    if (a > max) max = a;
  }
  return max;
}

test("\\fad ramps alpha during fade-in", async () => {
  const text = "{\\\\bord0\\\\shad0\\\\fad(500,0)}Hello";
  const a0 = await maxAlpha(text, 0);
  const a250 = await maxAlpha(text, 250);
  const a600 = await maxAlpha(text, 600);

  expect(a0).toBe(0);
  expect(a250).toBeGreaterThan(0);
  expect(a250).toBeLessThan(255);
  expect(a600).toBeGreaterThanOrEqual(250);
});

test("\\fade complex stages alpha", async () => {
  const text = "{\\\\bord0\\\\shad0\\\\fade(255,0,255,0,250,750,1000)}Hello";
  const a0 = await maxAlpha(text, 0);
  const a500 = await maxAlpha(text, 500);
  const a900 = await maxAlpha(text, 900);

  expect(a0).toBe(0);
  expect(a500).toBeGreaterThanOrEqual(250);
  expect(a900).toBeGreaterThan(0);
  expect(a900).toBeLessThan(a500);
});

test("\\fad does not block \\move", async () => {
  const parsed = parseASS(FADE_MOVE_ASS, { onError: "collect", strict: false, preserveOrder: true });
  expect(parsed.ok).toBe(true);

  const early = await renderFrame(parsed.document, 0, 320, 200);
  const mid = await renderFrame(parsed.document, 2500, 320, 200);

  const minX = (layers: { originX: number }[]) => {
    let min = Infinity;
    for (let i = 0; i < layers.length; i++) {
      const x = layers[i]!.originX;
      if (x < min) min = x;
    }
    return min;
  };

  expect(minX(mid.layers)).toBeGreaterThan(minX(early.layers));
});
