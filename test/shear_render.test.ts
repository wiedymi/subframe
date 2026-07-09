import { test, expect } from "bun:test";
import { parseASS } from "subforge/ass";
import { renderFrame } from "../src/core/pipeline";

const BASE = String.raw`[Script Info]
Title: shear
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

test("\\fax shears and displaces horizontal bounds", async () => {
  const plain = BASE.replace("%TEXT%", "{\\\\bord0\\\\shad0}Shear");
  const sheared = BASE.replace("%TEXT%", "{\\\\bord0\\\\shad0\\\\fax0.5}Shear");

  const parsedPlain = parseASS(plain, { onError: "collect", strict: false, preserveOrder: true });
  const parsedShear = parseASS(sheared, { onError: "collect", strict: false, preserveOrder: true });
  expect(parsedPlain.ok).toBe(true);
  expect(parsedShear.ok).toBe(true);

  const base = await renderFrame(parsedPlain.document, 500, 320, 200);
  const skew = await renderFrame(parsedShear.document, 500, 320, 200);

  const b0 = boundsFromLayers(base.layers);
  const b1 = boundsFromLayers(skew.layers);
  const w0 = b0.maxX - b0.minX;
  const w1 = b1.maxX - b1.minX;

  // libass shears around the ascent line (calc_transform_matrix,
  // ass_render.c:1518-1519 adds asc*fax to the x shift), so \fax mostly
  // TRANSLATES the ink rightward: libass ink moves x [127,193] -> [132,199]
  // with width growing only ~1.5%. Assert displacement, not widening.
  expect(b1.maxX).toBeGreaterThan(b0.maxX);
  expect(b1.minX).toBeGreaterThan(b0.minX);
  expect(w1).toBeGreaterThanOrEqual(w0);
});

test("\\fay shears and increases vertical bounds", async () => {
  const plain = BASE.replace("%TEXT%", "{\\\\bord0\\\\shad0}Shear");
  const sheared = BASE.replace("%TEXT%", "{\\\\bord0\\\\shad0\\\\fay0.5}Shear");

  const parsedPlain = parseASS(plain, { onError: "collect", strict: false, preserveOrder: true });
  const parsedShear = parseASS(sheared, { onError: "collect", strict: false, preserveOrder: true });
  expect(parsedPlain.ok).toBe(true);
  expect(parsedShear.ok).toBe(true);

  const base = await renderFrame(parsedPlain.document, 500, 320, 200);
  const skew = await renderFrame(parsedShear.document, 500, 320, 200);

  const b0 = boundsFromLayers(base.layers);
  const b1 = boundsFromLayers(skew.layers);
  const h0 = b0.maxY - b0.minY;
  const h1 = b1.maxY - b1.minY;

  expect(h1).toBeGreaterThan(h0 * 1.05);
});
