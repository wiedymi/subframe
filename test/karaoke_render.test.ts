import { test, expect } from "bun:test";
import { parseASS } from "subforge/ass";
import { renderFrame } from "../src/core/pipeline";

const KARA_ASS = String.raw`[Script Info]
Title: karaoke
ScriptType: v4.00+
PlayResX: 320
PlayResY: 200

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,Arial,28,&H000000FF,&H00FF0000,&H00000000,&H00000000,-1,0,0,0,100,100,0,0,1,0,0,2,10,10,10,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
Dialogue: 0,0:00:00.00,0:00:05.00,Default,,0,0,0,,{\\bord0\\shad0\\k50}Hello
`;

const KARA_OUTLINE_ASS = String.raw`[Script Info]
Title: karaoke-outline
ScriptType: v4.00+
PlayResX: 320
PlayResY: 200

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,Arial,28,&H000000FF,&H00FF0000,&H00000000,&H00000000,-1,0,0,0,100,100,0,0,1,4,0,2,10,10,10,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
Dialogue: 0,0:00:00.00,0:00:05.00,Default,,0,0,0,,{\\bord4\\shad0\\ko50}Hello
`;

const KARA_KF_ASS = String.raw`[Script Info]
Title: karaoke-kf
ScriptType: v4.00+
PlayResX: 320
PlayResY: 200

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,Arial,28,&H000000FF,&H00FF0000,&H00000000,&H00000000,-1,0,0,0,100,100,0,0,1,0,0,2,10,10,10,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
Dialogue: 0,0:00:00.00,0:00:05.00,Default,,0,0,0,,{\\bord0\\shad0\\kf50}Hello
`;

function distinctColors(layers: { color: [number, number, number, number] }[]): string[] {
  const set = new Set<string>();
  for (let i = 0; i < layers.length; i++) {
    const c = layers[i]!.color;
    set.add(`${c[0]},${c[1]},${c[2]},${c[3]}`);
  }
  return Array.from(set);
}

test("karaoke switches from secondary to primary over time", async () => {
  const parsed = parseASS(KARA_ASS, { onError: "collect", strict: false, preserveOrder: true });
  expect(parsed.ok).toBe(true);

  const early = await renderFrame(parsed.document, 0, 320, 200);
  const late = await renderFrame(parsed.document, 2000, 320, 200);

  const earlyColors = distinctColors(early.layers);
  const lateColors = distinctColors(late.layers);

  // Secondary color is blue (0,0,255), primary is red (255,0,0)
  const hasBlueEarly = earlyColors.some((c) => c.startsWith("0,0,255"));
  const hasRedLate = lateColors.some((c) => c.startsWith("255,0,0"));

  expect(hasBlueEarly).toBe(true);
  expect(hasRedLate).toBe(true);
});

test("\\ko applies karaoke color to outline", async () => {
  const parsed = parseASS(KARA_OUTLINE_ASS, { onError: "collect", strict: false, preserveOrder: true });
  expect(parsed.ok).toBe(true);

  const early = await renderFrame(parsed.document, 0, 320, 200);
  const outlineLayers = early.layers.filter((layer) => layer.z === 0);
  const outlineColors = distinctColors(outlineLayers);

  const hasBlueOutline = outlineColors.some((c) => c.startsWith("0,0,255"));
  const hasBlackOutline = outlineColors.some((c) => c.startsWith("0,0,0"));

  expect(hasBlueOutline).toBe(true);
  expect(hasBlackOutline).toBe(false);
});

test("\\kf progresses fill over time", async () => {
  const parsed = parseASS(KARA_KF_ASS, { onError: "collect", strict: false, preserveOrder: true });
  expect(parsed.ok).toBe(true);

  const early = await renderFrame(parsed.document, 0, 320, 200);
  const late = await renderFrame(parsed.document, 2000, 320, 200);

  const earlyColors = distinctColors(early.layers);
  const lateColors = distinctColors(late.layers);

  const hasBlueEarly = earlyColors.some((c) => c.startsWith("0,0,255"));
  const hasRedLate = lateColors.some((c) => c.startsWith("255,0,0"));

  expect(hasBlueEarly).toBe(true);
  expect(hasRedLate).toBe(true);
});
