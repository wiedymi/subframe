import { test, expect } from "bun:test";
import { parseASS } from "subforge/ass";
import { renderFrame, renderFrameWithTrace } from "../src/core/pipeline";

const ASS = String.raw`[Script Info]
Title: animate
ScriptType: v4.00+
PlayResX: 320
PlayResY: 200

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,Arial,28,&H00FFFFFF,&H000000FF,&H00000000,&H00000000,-1,0,0,0,100,100,0,0,1,0,0,2,10,10,10,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
Dialogue: 0,0:00:00.00,0:00:04.00,Default,,0,0,0,,{\bord0\shad0\t(0,2000,\fscx200)}Hello
`;

const COLOR_ASS = String.raw`[Script Info]
Title: animate-color
ScriptType: v4.00+
PlayResX: 320
PlayResY: 200

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,Arial,28,&H00FFFFFF,&H000000FF,&H00000000,&H00000000,-1,0,0,0,100,100,0,0,1,0,0,2,10,10,10,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
Dialogue: 0,0:00:00.00,0:00:02.00,Default,,0,0,0,,{\bord0\shad0\t(0,1000,\c&H0000FF&)}A
`;

const ALPHA_ASS = String.raw`[Script Info]
Title: animate-alpha
ScriptType: v4.00+
PlayResX: 320
PlayResY: 200

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,Arial,28,&H00FFFFFF,&H000000FF,&H00000000,&H00000000,-1,0,0,0,100,100,0,0,1,0,0,2,10,10,10,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
Dialogue: 0,0:00:00.00,0:00:02.00,Default,,0,0,0,,{\bord0\shad0\t(0,1000,\alpha&HFF&)}A
`;

const SHADOW_AXIS_ASS = String.raw`[Script Info]
Title: animate-shadow-axis
ScriptType: v4.00+
PlayResX: 320
PlayResY: 200

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,Arial,28,&H00FFFFFF,&H000000FF,&H00000000,&H00000000,-1,0,0,0,100,100,0,0,1,0,0,5,10,10,10,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
Dialogue: 0,0:00:00.00,0:00:02.00,Default,,0,0,0,,{\pos(160,100)\bord0\1a&H00&\3a&HFF&\4a&H00&\shad0\t(0,1,\xshad12\yshad0)}A
`;

const ROTATE_ASS = String.raw`[Script Info]
Title: animate-rotate
ScriptType: v4.00+
PlayResX: 320
PlayResY: 200

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,Arial,28,&H00FFFFFF,&H000000FF,&H00000000,&H00000000,-1,0,0,0,100,100,0,0,1,0,0,2,10,10,10,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
Dialogue: 0,0:00:00.00,0:00:02.00,Default,,0,0,0,,{\bord0\shad0\t(0,1000,\fr45)}A
`;

const ROTATE3D_ASS = String.raw`[Script Info]
Title: animate-rotate3d
ScriptType: v4.00+
PlayResX: 320
PlayResY: 200

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,Arial,28,&H00FFFFFF,&H000000FF,&H00000000,&H00000000,-1,0,0,0,100,100,0,0,1,0,0,2,10,10,10,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
Dialogue: 0,0:00:00.00,0:00:02.00,Default,,0,0,0,,{\bord0\shad0\t(0,1000,\frx30\fry20)}A
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

test("\\t animates scale over time", async () => {
  const parsed = parseASS(ASS, { onError: "collect", strict: false, preserveOrder: true });
  expect(parsed.ok).toBe(true);

  const early = await renderFrame(parsed.document, 0, 320, 200);
  const late = await renderFrame(parsed.document, 2000, 320, 200);

  const b0 = boundsFromLayers(early.layers);
  const b1 = boundsFromLayers(late.layers);
  const w0 = b0.maxX - b0.minX;
  const w1 = b1.maxX - b1.minX;

  expect(w1).toBeGreaterThan(w0 * 1.4);
});

test("\\t animates primary color over time", async () => {
  const parsed = parseASS(COLOR_ASS, { onError: "collect", strict: false, preserveOrder: true });
  expect(parsed.ok).toBe(true);

  const early = await renderFrame(parsed.document, 0, 320, 200);
  const late = await renderFrame(parsed.document, 1000, 320, 200);

  const earlyHasWhite = early.layers.some(
    (layer) => layer.color[0] === 255 && layer.color[1] === 255 && layer.color[2] === 255
  );
  const lateHasRed = late.layers.some(
    (layer) => layer.color[0] === 255 && layer.color[1] === 0 && layer.color[2] === 0
  );

  expect(earlyHasWhite).toBe(true);
  expect(lateHasRed).toBe(true);
});

test("\\t animates alpha over time", async () => {
  const parsed = parseASS(ALPHA_ASS, { onError: "collect", strict: false, preserveOrder: true });
  expect(parsed.ok).toBe(true);

  const early = await renderFrame(parsed.document, 0, 320, 200);
  const late = await renderFrame(parsed.document, 1000, 320, 200);

  const earlyAlpha = early.layers.reduce((max, layer) => Math.max(max, layer.color[3]), 0);
  const lateAlpha = late.layers.reduce((max, layer) => Math.max(max, layer.color[3]), 0);

  expect(earlyAlpha).toBeGreaterThan(lateAlpha);
});

test("\\t animated \\xshad persists as an explicit axis shadow after t2", async () => {
  const parsed = parseASS(SHADOW_AXIS_ASS, { onError: "collect", strict: false, preserveOrder: true });
  expect(parsed.ok).toBe(true);

  const late = await renderFrame(parsed.document, 1000, 320, 200);

  const shadowLayers = late.layers.filter(
    (layer) =>
      layer.color[0] === 0 &&
      layer.color[1] === 0 &&
      layer.color[2] === 0 &&
      layer.color[3] > 0,
  );

  expect(shadowLayers.length).toBeGreaterThan(0);
  expect(Math.min(...shadowLayers.map((layer) => layer.originX))).toBeGreaterThan(155);
});

test("\\t animates rotate using \\fr alias", async () => {
  const parsed = parseASS(ROTATE_ASS, { onError: "collect", strict: false, preserveOrder: true });
  expect(parsed.ok).toBe(true);

  const early = await renderFrameWithTrace(parsed.document, 0, 320, 200);
  const late = await renderFrameWithTrace(parsed.document, 1000, 320, 200);

  const maxRotate = (trace: typeof early.trace) => {
    let max = 0;
    for (let e = 0; e < trace.events.length; e++) {
      const ev = trace.events[e]!;
      for (let l = 0; l < ev.lines.length; l++) {
        const line = ev.lines[l]!;
        for (let g = 0; g < line.items.length; g++) {
          const glyph = line.items[g]!;
          if (glyph.rotateZ > max) max = glyph.rotateZ;
        }
      }
    }
    return max;
  };

  expect(maxRotate(late.trace)).toBeGreaterThan(maxRotate(early.trace));
});

test("\\t animates 3D rotate (frx/fry)", async () => {
  const parsed = parseASS(ROTATE3D_ASS, { onError: "collect", strict: false, preserveOrder: true });
  expect(parsed.ok).toBe(true);

  const early = await renderFrameWithTrace(parsed.document, 0, 320, 200);
  const late = await renderFrameWithTrace(parsed.document, 1000, 320, 200);

  const maxRotate = (trace: typeof early.trace) => {
    let maxX = 0;
    let maxY = 0;
    for (let e = 0; e < trace.events.length; e++) {
      const ev = trace.events[e]!;
      for (let l = 0; l < ev.lines.length; l++) {
        const line = ev.lines[l]!;
        for (let g = 0; g < line.items.length; g++) {
          const glyph = line.items[g]!;
          if (glyph.rotateX > maxX) maxX = glyph.rotateX;
          if (glyph.rotateY > maxY) maxY = glyph.rotateY;
        }
      }
    }
    return { maxX, maxY };
  };

  const bounds = (layers: { originX: number; originY: number; width: number; height: number }[]) => {
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
  };

  const b0 = bounds(early.result.layers);
  const b1 = bounds(late.result.layers);
  const h0 = b0.maxY - b0.minY;
  const h1 = b1.maxY - b1.minY;
  const r0 = maxRotate(early.trace);
  const r1 = maxRotate(late.trace);

  expect(r1.maxX).toBeGreaterThan(r0.maxX);
  expect(r1.maxY).toBeGreaterThan(r0.maxY);
  expect(Math.abs(h1 - h0)).toBeGreaterThan(0.5);
});
