import { test, expect } from "bun:test";
import { parseASS } from "subforge/ass";
import { renderFrame } from "../src/core/pipeline";

const BASE = String.raw`[Script Info]
Title: outline
ScriptType: v4.00+
PlayResX: 320
PlayResY: 200

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,Arial,28,&H00FFFFFF,&H000000FF,&H00000000,&H00000000,-1,0,0,0,100,100,0,0,1,2,2,2,10,10,10,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
Dialogue: 0,0:00:00.00,0:00:05.00,Default,,0,0,0,,%TEXT%
`;

async function renderLayerCount(text: string): Promise<number> {
  const ass = BASE.replace("%TEXT%", text);
  const parsed = parseASS(ass, { onError: "collect", strict: false, preserveOrder: true });
  if (!parsed.ok) throw new Error("parse failed");
  const result = await renderFrame(parsed.document, 1000, 320, 200);
  return result.layers.length;
}

// The style must carry nonzero Outline/Shadow (2,2 above) for the base render
// to actually have outline/shadow layers; libass treats {\bord0\shad0} on a
// 0,0 style as a no-op (ass_parse.c tag("bord")/tag("shad")).
test("\\bord0 \\shad0 can disable outline/shadow", async () => {
  const base = await renderLayerCount("Hello");
  const disabled = await renderLayerCount("{\\\\bord0\\\\shad0}Hello");
  expect(disabled).toBeLessThan(base);
});

test("\\bord adds outline layers vs disabled", async () => {
  const disabled = await renderLayerCount("{\\\\bord0\\\\shad0}Hello");
  const outlined = await renderLayerCount("{\\\\bord3\\\\shad0}Hello");
  expect(outlined).toBeGreaterThan(disabled);
});

test("\\shad adds shadow layers vs disabled", async () => {
  const disabled = await renderLayerCount("{\\\\bord0\\\\shad0}Hello");
  const shadowed = await renderLayerCount("{\\\\bord0\\\\shad5}Hello");
  expect(shadowed).toBeGreaterThan(disabled);
});
