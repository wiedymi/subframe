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

function maxAlpha(layers: { color: [number, number, number, number] }[]): number {
  let max = 0;
  for (let i = 0; i < layers.length; i++) {
    const a = layers[i]!.color[3];
    if (a > max) max = a;
  }
  return max;
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

test("\\1a reduces primary opacity only", async () => {
  const opaque = BASE.replace("%TEXT%", "{\\\\bord4\\\\shad0}Alpha");
  const primaryTransparent = BASE.replace("%TEXT%", "{\\\\bord4\\\\shad0\\\\1a&HFF&}Alpha");

  const parsedOpaque = parseASS(opaque, { onError: "collect", strict: false, preserveOrder: true });
  const parsedPrimary = parseASS(primaryTransparent, { onError: "collect", strict: false, preserveOrder: true });
  expect(parsedOpaque.ok).toBe(true);
  expect(parsedPrimary.ok).toBe(true);

  const base = await renderFrame(parsedOpaque.document, 500, 320, 200);
  const primary = await renderFrame(parsedPrimary.document, 500, 320, 200);

  const basePrimaryAlpha = base.layers
    .filter((layer) => layer.z === 1)
    .reduce((max, layer) => Math.max(max, layer.color[3]), 0);
  const primaryAlpha = primary.layers
    .filter((layer) => layer.z === 1)
    .reduce((max, layer) => Math.max(max, layer.color[3]), 0);
  const baseOutlineAlpha = base.layers
    .filter((layer) => layer.z === 0)
    .reduce((max, layer) => Math.max(max, layer.color[3]), 0);
  const primaryOutlineAlpha = primary.layers
    .filter((layer) => layer.z === 0)
    .reduce((max, layer) => Math.max(max, layer.color[3]), 0);

  expect(primaryAlpha).toBeLessThan(basePrimaryAlpha);
  expect(primaryOutlineAlpha).toBeCloseTo(baseOutlineAlpha, 0);
});

test("\\3a reduces outline opacity only", async () => {
  const opaque = BASE.replace("%TEXT%", "{\\\\bord4\\\\shad0}Alpha");
  const outlineTransparent = BASE.replace("%TEXT%", "{\\\\bord4\\\\shad0\\\\3a&HFF&}Alpha");

  const parsedOpaque = parseASS(opaque, { onError: "collect", strict: false, preserveOrder: true });
  const parsedOutline = parseASS(outlineTransparent, { onError: "collect", strict: false, preserveOrder: true });
  expect(parsedOpaque.ok).toBe(true);
  expect(parsedOutline.ok).toBe(true);

  const base = await renderFrame(parsedOpaque.document, 500, 320, 200);
  const outline = await renderFrame(parsedOutline.document, 500, 320, 200);

  const basePrimaryAlpha = base.layers
    .filter((layer) => layer.z === 1)
    .reduce((max, layer) => Math.max(max, layer.color[3]), 0);
  const outlinePrimaryAlpha = outline.layers
    .filter((layer) => layer.z === 1)
    .reduce((max, layer) => Math.max(max, layer.color[3]), 0);
  const baseOutlineAlpha = base.layers
    .filter((layer) => layer.z === 0)
    .reduce((max, layer) => Math.max(max, layer.color[3]), 0);
  const outlineAlpha = outline.layers
    .filter((layer) => layer.z === 0)
    .reduce((max, layer) => Math.max(max, layer.color[3]), 0);

  expect(outlineAlpha).toBeLessThan(baseOutlineAlpha);
  expect(outlinePrimaryAlpha).toBeCloseTo(basePrimaryAlpha, 0);
});

test("\\2a reduces secondary opacity in karaoke fill", async () => {
  const opaque = BASE.replace("%TEXT%", "{\\\\bord0\\\\shad0\\\\k20}Alpha");
  const secondaryTransparent = BASE.replace("%TEXT%", "{\\\\bord0\\\\shad0\\\\k20\\\\2a&HFF&}Alpha");

  const parsedOpaque = parseASS(opaque, { onError: "collect", strict: false, preserveOrder: true });
  const parsedSecondary = parseASS(secondaryTransparent, { onError: "collect", strict: false, preserveOrder: true });
  expect(parsedOpaque.ok).toBe(true);
  expect(parsedSecondary.ok).toBe(true);

  const base = await renderFrame(parsedOpaque.document, 0, 320, 200);
  const secondary = await renderFrame(parsedSecondary.document, 0, 320, 200);

  const basePrimaryAlpha = base.layers
    .filter((layer) => layer.z === 1)
    .reduce((max, layer) => Math.max(max, layer.color[3]), 0);
  const secondaryPrimaryAlpha = secondary.layers
    .filter((layer) => layer.z === 1)
    .reduce((max, layer) => Math.max(max, layer.color[3]), 0);

  expect(secondaryPrimaryAlpha).toBeLessThan(basePrimaryAlpha);
});

test("\\4a reduces shadow opacity only", async () => {
  const opaque = BASE.replace("%TEXT%", "{\\\\bord0\\\\shad4}Alpha");
  const shadowTransparent = BASE.replace("%TEXT%", "{\\\\bord0\\\\shad4\\\\4a&HFF&}Alpha");

  const parsedOpaque = parseASS(opaque, { onError: "collect", strict: false, preserveOrder: true });
  const parsedShadow = parseASS(shadowTransparent, { onError: "collect", strict: false, preserveOrder: true });
  expect(parsedOpaque.ok).toBe(true);
  expect(parsedShadow.ok).toBe(true);

  const base = await renderFrame(parsedOpaque.document, 500, 320, 200);
  const shadow = await renderFrame(parsedShadow.document, 500, 320, 200);

  const baseShadowAlpha = base.layers
    .filter((layer) => layer.z === -1)
    .reduce((max, layer) => Math.max(max, layer.color[3]), 0);
  const shadowAlpha = shadow.layers
    .filter((layer) => layer.z === -1)
    .reduce((max, layer) => Math.max(max, layer.color[3]), 0);

  expect(shadowAlpha).toBeLessThan(baseShadowAlpha);
});
