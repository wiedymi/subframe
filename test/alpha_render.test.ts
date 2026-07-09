import { test, expect } from "bun:test";
import { parseASS } from "subforge/ass";
import { renderFrame } from "../src/core/pipeline";

const BASE = String.raw`[Script Info]
Title: alpha
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

type Layer = { color: [number, number, number, number] };

// Layer roles are identified by tint color (z no longer encodes fill/outline/shadow):
// fill = PrimaryColour white, outline/shadow = OutlineColour/BackColour black,
// karaoke secondary = SecondaryColour red.
const isWhite = (l: Layer) => l.color[0] === 255 && l.color[1] === 255 && l.color[2] === 255;
const isBlack = (l: Layer) => l.color[0] === 0 && l.color[1] === 0 && l.color[2] === 0;
const isRed = (l: Layer) => l.color[0] === 255 && l.color[1] === 0 && l.color[2] === 0;

function maxAlphaWhere(layers: Layer[], pred: (l: Layer) => boolean): number {
  let max = 0;
  for (let i = 0; i < layers.length; i++) {
    const l = layers[i]!;
    if (pred(l) && l.color[3] > max) max = l.color[3];
  }
  return max;
}

function maxAlpha(layers: Layer[]): number {
  return maxAlphaWhere(layers, () => true);
}

test("\\alpha reduces opacity", async () => {
  const opaque = BASE.replace("%TEXT%", "{\\\\bord0\\\\shad0}Alpha");
  const transparent = BASE.replace("%TEXT%", "{\\\\bord0\\\\shad0\\\\alpha&H80&}Alpha");

  const parsedOpaque = parseASS(opaque, { onError: "collect", strict: false, preserveOrder: true });
  const parsedTrans = parseASS(transparent, { onError: "collect", strict: false, preserveOrder: true });
  expect(parsedOpaque.ok).toBe(true);
  expect(parsedTrans.ok).toBe(true);

  const base = await renderFrame(parsedOpaque.document, 500, 320, 200);
  const trans = await renderFrame(parsedTrans.document, 500, 320, 200);

  expect(maxAlpha(base.layers)).toBeGreaterThan(maxAlpha(trans.layers));
});

// libass ass_parse.c tag("1a"): \1a&HFF& zeroes the fill (primary) alpha only;
// the outline stays fully opaque.
test("\\1a reduces primary opacity only", async () => {
  const opaque = BASE.replace("%TEXT%", "{\\\\bord4\\\\shad0}Alpha");
  const primaryTransparent = BASE.replace("%TEXT%", "{\\\\bord4\\\\shad0\\\\1a&HFF&}Alpha");

  const parsedOpaque = parseASS(opaque, { onError: "collect", strict: false, preserveOrder: true });
  const parsedPrimary = parseASS(primaryTransparent, { onError: "collect", strict: false, preserveOrder: true });
  expect(parsedOpaque.ok).toBe(true);
  expect(parsedPrimary.ok).toBe(true);

  const base = await renderFrame(parsedOpaque.document, 500, 320, 200);
  const primary = await renderFrame(parsedPrimary.document, 500, 320, 200);

  const baseFillAlpha = maxAlphaWhere(base.layers, isWhite);
  const primaryFillAlpha = maxAlphaWhere(primary.layers, isWhite);
  const baseOutlineAlpha = maxAlphaWhere(base.layers, isBlack);
  const primaryOutlineAlpha = maxAlphaWhere(primary.layers, isBlack);

  expect(baseFillAlpha).toBe(255);
  expect(primaryFillAlpha).toBe(0);
  expect(baseOutlineAlpha).toBe(255);
  expect(primaryOutlineAlpha).toBe(255);
});

// libass ass_parse.c tag("3a"): \3a&HFF& zeroes the outline alpha only;
// the fill stays fully opaque.
test("\\3a reduces outline opacity only", async () => {
  const opaque = BASE.replace("%TEXT%", "{\\\\bord4\\\\shad0}Alpha");
  const outlineTransparent = BASE.replace("%TEXT%", "{\\\\bord4\\\\shad0\\\\3a&HFF&}Alpha");

  const parsedOpaque = parseASS(opaque, { onError: "collect", strict: false, preserveOrder: true });
  const parsedOutline = parseASS(outlineTransparent, { onError: "collect", strict: false, preserveOrder: true });
  expect(parsedOpaque.ok).toBe(true);
  expect(parsedOutline.ok).toBe(true);

  const base = await renderFrame(parsedOpaque.document, 500, 320, 200);
  const outline = await renderFrame(parsedOutline.document, 500, 320, 200);

  const baseFillAlpha = maxAlphaWhere(base.layers, isWhite);
  const outlineFillAlpha = maxAlphaWhere(outline.layers, isWhite);
  const baseOutlineAlpha = maxAlphaWhere(base.layers, isBlack);
  const outlineAlpha = maxAlphaWhere(outline.layers, isBlack);

  expect(baseOutlineAlpha).toBe(255);
  expect(outlineAlpha).toBe(0);
  expect(baseFillAlpha).toBe(255);
  expect(outlineFillAlpha).toBe(255);
});

// libass ass_parse.c:1065-1078: a \k syllable turns primary at its START, so a
// single-syllable line never shows the secondary color. A pending second
// syllable is needed for \2a to be observable; at t=250 with {\k50}Al{\k50}pha
// the "pha" syllable is still secondary (red) and \2a&HFF& removes it.
test("\\2a reduces secondary opacity in karaoke fill", async () => {
  const opaque = BASE.replace("%TEXT%", "{\\\\bord0\\\\shad0\\\\k50}Al{\\\\k50}pha");
  const secondaryTransparent = BASE.replace("%TEXT%", "{\\\\bord0\\\\shad0\\\\2a&HFF&\\\\k50}Al{\\\\k50}pha");

  const parsedOpaque = parseASS(opaque, { onError: "collect", strict: false, preserveOrder: true });
  const parsedSecondary = parseASS(secondaryTransparent, { onError: "collect", strict: false, preserveOrder: true });
  expect(parsedOpaque.ok).toBe(true);
  expect(parsedSecondary.ok).toBe(true);

  const base = await renderFrame(parsedOpaque.document, 250, 320, 200);
  const secondary = await renderFrame(parsedSecondary.document, 250, 320, 200);

  const baseSecondaryAlpha = maxAlphaWhere(base.layers, isRed);
  const secondaryAlpha = maxAlphaWhere(secondary.layers, isRed);
  const baseFillAlpha = maxAlphaWhere(base.layers, isWhite);
  const fillAlpha = maxAlphaWhere(secondary.layers, isWhite);

  expect(baseSecondaryAlpha).toBe(255);
  expect(secondaryAlpha).toBe(0);
  // The highlighted (primary) syllable is unaffected by \2a.
  expect(baseFillAlpha).toBe(255);
  expect(fillAlpha).toBe(255);
});

// libass ass_parse.c tag("4a"): \4a&HFF& zeroes the shadow alpha only; with
// \bord0 the shadow is the sole black layer, and the fill stays opaque.
test("\\4a reduces shadow opacity only", async () => {
  const opaque = BASE.replace("%TEXT%", "{\\\\bord0\\\\shad4}Alpha");
  const shadowTransparent = BASE.replace("%TEXT%", "{\\\\bord0\\\\shad4\\\\4a&HFF&}Alpha");

  const parsedOpaque = parseASS(opaque, { onError: "collect", strict: false, preserveOrder: true });
  const parsedShadow = parseASS(shadowTransparent, { onError: "collect", strict: false, preserveOrder: true });
  expect(parsedOpaque.ok).toBe(true);
  expect(parsedShadow.ok).toBe(true);

  const base = await renderFrame(parsedOpaque.document, 500, 320, 200);
  const shadow = await renderFrame(parsedShadow.document, 500, 320, 200);

  const baseShadowAlpha = maxAlphaWhere(base.layers, isBlack);
  const shadowAlpha = maxAlphaWhere(shadow.layers, isBlack);
  const baseFillAlpha = maxAlphaWhere(base.layers, isWhite);
  const fillAlpha = maxAlphaWhere(shadow.layers, isWhite);

  expect(baseShadowAlpha).toBe(255);
  expect(shadowAlpha).toBe(0);
  expect(baseFillAlpha).toBe(255);
  expect(fillAlpha).toBe(255);
});
