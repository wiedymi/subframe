import { test, expect } from "bun:test";
import { parseASS } from "subforge/ass";
import { renderFrame } from "../src/core/pipeline";

const CLIP_ASS = String.raw`[Script Info]
Title: clip
ScriptType: v4.00+
PlayResX: 200
PlayResY: 100

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,Arial,28,&H00FFFFFF,&H000000FF,&H00000000,&H00000000,-1,0,0,0,100,100,0,0,1,0,0,2,10,10,10,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
Dialogue: 0,0:00:00.00,0:00:05.00,Default,,0,0,0,,%TEXT%
`;

const CLIP_TRANSFORM_ASS = String.raw`[Script Info]
Title: clip-transform
ScriptType: v4.00+
PlayResX: 320
PlayResY: 200

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,Arial,28,&H00FFFFFF,&H000000FF,&H00000000,&H00000000,-1,0,0,0,100,100,0,0,1,0,0,2,10,10,10,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
Dialogue: 0,0:00:00.00,0:00:05.00,Default,,0,0,0,,{\\bord0\\shad0\\clip(140,80,220,160)\\pos(160,100)\\frz45}Hello
`;

// Rect clips narrow a layer via subarray + reduced width with unchanged stride
// (same technique as libass render_glyph, ass_render.c:654-668), so ink must be
// summed within the layer's width/height geometry, not over the raw buffer.
function countInk(layers: { bitmap: Uint8Array; width: number; height: number; stride: number }[]): number {
  let sum = 0;
  for (let i = 0; i < layers.length; i++) {
    const l = layers[i]!;
    const b = l.bitmap;
    for (let y = 0; y < l.height; y++) {
      const row = y * l.stride;
      for (let x = 0; x < l.width; x++) sum += b[row + x]!;
    }
  }
  return sum;
}

test("\\clip reduces visible pixels", async () => {
  const parsedBase = parseASS(CLIP_ASS.replace("%TEXT%", "Hello"), { onError: "collect", strict: false, preserveOrder: true });
  const parsedClip = parseASS(CLIP_ASS.replace("%TEXT%", "{\\\\clip(0,0,50,100)}Hello"), { onError: "collect", strict: false, preserveOrder: true });

  const base = await renderFrame(parsedBase.document, 1000, 200, 100);
  const clipped = await renderFrame(parsedClip.document, 1000, 200, 100);

  const baseInk = countInk(base.layers);
  const clippedInk = countInk(clipped.layers);

  expect(clippedInk).toBeLessThan(baseInk);
});

test("\\iclip inverts clip region", async () => {
  const baseParsed = parseASS(CLIP_ASS.replace("%TEXT%", "{\\\\pos(100,50)}HelloWorld"), {
    onError: "collect",
    strict: false,
    preserveOrder: true,
  });
  const clipParsed = parseASS(
    CLIP_ASS.replace("%TEXT%", "{\\\\pos(100,50)\\\\clip(0,0,100,100)}HelloWorld"),
    { onError: "collect", strict: false, preserveOrder: true }
  );
  const iclipParsed = parseASS(
    CLIP_ASS.replace("%TEXT%", "{\\\\pos(100,50)\\\\iclip(0,0,100,100)}HelloWorld"),
    { onError: "collect", strict: false, preserveOrder: true }
  );
  expect(baseParsed.ok).toBe(true);
  expect(clipParsed.ok).toBe(true);
  expect(iclipParsed.ok).toBe(true);

  const base = await renderFrame(baseParsed.document, 1000, 200, 100);
  const clip = await renderFrame(clipParsed.document, 1000, 200, 100);
  const iclip = await renderFrame(iclipParsed.document, 1000, 200, 100);

  const baseInk = countInk(base.layers);
  const clipInk = countInk(clip.layers);
  const iclipInk = countInk(iclip.layers);

  expect(clipInk).toBeLessThan(baseInk);
  expect(iclipInk).toBeLessThan(baseInk);
  expect(clipInk).not.toBe(iclipInk);
});

test("last clip tag wins", async () => {
  const baseText = "HelloWorld";
  const clipOnly = CLIP_ASS.replace("%TEXT%", `{\\\\pos(100,50)\\\\clip(0,0,100,100)}${baseText}`);
  const iclipOnly = CLIP_ASS.replace("%TEXT%", `{\\\\pos(100,50)\\\\iclip(0,0,100,100)}${baseText}`);
  const both = CLIP_ASS.replace(
    "%TEXT%",
    `{\\\\pos(100,50)\\\\clip(0,0,100,100)\\\\iclip(0,0,100,100)}${baseText}`
  );

  const parsedClip = parseASS(clipOnly, { onError: "collect", strict: false, preserveOrder: true });
  const parsedIclip = parseASS(iclipOnly, { onError: "collect", strict: false, preserveOrder: true });
  const parsedBoth = parseASS(both, { onError: "collect", strict: false, preserveOrder: true });
  expect(parsedClip.ok).toBe(true);
  expect(parsedIclip.ok).toBe(true);
  expect(parsedBoth.ok).toBe(true);

  const clip = await renderFrame(parsedClip.document, 1000, 200, 100);
  const iclip = await renderFrame(parsedIclip.document, 1000, 200, 100);
  const bothRender = await renderFrame(parsedBoth.document, 1000, 200, 100);

  const clipInk = countInk(clip.layers);
  const iclipInk = countInk(iclip.layers);
  const bothInk = countInk(bothRender.layers);

  expect(bothInk).toBe(iclipInk);
  expect(bothInk).not.toBe(clipInk);
});

// The clip rect (140,80,220,160) intersects the frz45-rotated text in screen
// space (libass: ink 510255 -> 257040 at 4x scale); a rect that fully contains
// the transformed bbox would remove zero pixels per libass.
test("\\clip is applied after transforms", async () => {
  const clippedParsed = parseASS(CLIP_TRANSFORM_ASS, { onError: "collect", strict: false, preserveOrder: true });
  const noClipParsed = parseASS(
    CLIP_TRANSFORM_ASS.replace("\\\\clip(140,80,220,160)", ""),
    { onError: "collect", strict: false, preserveOrder: true }
  );
  expect(clippedParsed.ok).toBe(true);
  expect(noClipParsed.ok).toBe(true);

  const clipped = await renderFrame(clippedParsed.document, 1000, 320, 200);
  const unclipped = await renderFrame(noClipParsed.document, 1000, 320, 200);

  const clipInk = countInk(clipped.layers);
  const baseInk = countInk(unclipped.layers);

  expect(clipInk).toBeGreaterThan(0);
  expect(clipInk).toBeLessThan(baseInk);
});
