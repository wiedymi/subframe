import { test, expect } from "bun:test";
import { parseASS } from "subforge/ass";
import { renderFrame } from "../src/core/pipeline";

// Two syllables: libass (ass_parse.c:1065-1078) flips \k syllables to primary
// at syllable START, so the first syllable is primary already at t=0; only a
// pending later syllable shows the secondary color.
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
Dialogue: 0,0:00:00.00,0:00:05.00,Default,,0,0,0,,{\\bord0\\shad0\\k100}He{\\k100}llo
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
Dialogue: 0,0:00:00.00,0:00:05.00,Default,,0,0,0,,{\\bord4\\shad0\\ko100}He{\\ko100}llo
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

type Layer = {
  color: [number, number, number, number];
  bitmap: Uint8Array;
  width: number;
  height: number;
  stride: number;
  originX: number;
};

function distinctColors(layers: Layer[]): string[] {
  const set = new Set<string>();
  for (let i = 0; i < layers.length; i++) {
    const c = layers[i]!.color;
    set.add(`${c[0]},${c[1]},${c[2]},${c[3]}`);
  }
  return Array.from(set);
}

const isBlack = (l: Layer) =>
  l.color[0] === 0 && l.color[1] === 0 && l.color[2] === 0 && l.color[3] > 0;

function inkWhere(layers: Layer[], pred: (l: Layer) => boolean): number {
  let sum = 0;
  for (let i = 0; i < layers.length; i++) {
    const l = layers[i]!;
    if (!pred(l)) continue;
    for (let y = 0; y < l.height; y++) {
      const row = y * l.stride;
      for (let x = 0; x < l.width; x++) sum += l.bitmap[row + x]!;
    }
  }
  return sum;
}

function rightEdgeWhere(layers: Layer[], pred: (l: Layer) => boolean): number {
  let max = -Infinity;
  for (let i = 0; i < layers.length; i++) {
    const l = layers[i]!;
    if (!pred(l)) continue;
    const edge = l.originX + l.width;
    if (edge > max) max = edge;
  }
  return max;
}

test("karaoke switches from secondary to primary over time", async () => {
  const parsed = parseASS(KARA_ASS, { onError: "collect", strict: false, preserveOrder: true });
  expect(parsed.ok).toBe(true);

  const early = await renderFrame(parsed.document, 0, 320, 200);
  const late = await renderFrame(parsed.document, 2000, 320, 200);

  const earlyColors = distinctColors(early.layers);
  const lateColors = distinctColors(late.layers);

  // Secondary color is blue (0,0,255), primary is red (255,0,0). At t=0 the
  // pending "llo" syllable is still secondary; by t=2000 everything is primary.
  const hasBlueEarly = earlyColors.some((c) => c.startsWith("0,0,255"));
  const hasRedLate = lateColors.some((c) => c.startsWith("255,0,0"));
  const hasBlueLate = lateColors.some((c) => c.startsWith("0,0,255"));

  expect(hasBlueEarly).toBe(true);
  expect(hasRedLate).toBe(true);
  expect(hasBlueLate).toBe(false);
});

// libass ass_render.c:1020-1027: \ko never recolors the outline; it SKIPS the
// outline bitmap for syllables that are not yet highlighted and otherwise
// draws it in the normal outline color (black here).
test("\\ko hides outline until the syllable highlights", async () => {
  const parsed = parseASS(KARA_OUTLINE_ASS, { onError: "collect", strict: false, preserveOrder: true });
  expect(parsed.ok).toBe(true);

  const early = await renderFrame(parsed.document, 0, 320, 200);
  const mid = await renderFrame(parsed.document, 500, 320, 200);
  const late = await renderFrame(parsed.document, 2000, 320, 200);

  // The highlighted first syllable's outline is drawn in the style outline
  // color (black), never in the karaoke secondary color.
  expect(inkWhere(early.layers, isBlack)).toBeGreaterThan(0);

  // At t=500 only "He" is highlighted: the pending "llo" outline is hidden, so
  // outline coverage is smaller and ends further left than at t=2000 when both
  // syllables are highlighted.
  const midBlackInk = inkWhere(mid.layers, isBlack);
  const lateBlackInk = inkWhere(late.layers, isBlack);
  expect(midBlackInk).toBeGreaterThan(0);
  expect(lateBlackInk).toBeGreaterThan(midBlackInk);
  expect(rightEdgeWhere(late.layers, isBlack)).toBeGreaterThan(rightEdgeWhere(mid.layers, isBlack));
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
