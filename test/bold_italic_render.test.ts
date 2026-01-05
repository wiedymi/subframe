import { test, expect } from "bun:test";
import { parseASS } from "subforge/ass";
import { renderFrame } from "../src/core/pipeline";

const BASE = String.raw`[Script Info]
Title: bold-italic
ScriptType: v4.00+
PlayResX: 320
PlayResY: 200

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,Arial,32,&H00FFFFFF,&H000000FF,&H00000000,&H00000000,%BOLD%,%ITALIC%,0,0,100,100,0,0,1,0,0,2,10,10,10,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
Dialogue: 0,0:00:00.00,0:00:05.00,Default,,0,0,0,,%TEXT%
`;

function countPixels(layers: Array<{ bitmap: Uint8Array }>): number {
  let count = 0;
  for (const layer of layers) {
    const buf = layer.bitmap;
    for (let i = 0; i < buf.length; i++) {
      if (buf[i] !== 0) count++;
    }
  }
  return count;
}

function bounds(layers: Array<{ originX: number; originY: number; width: number; height: number; bitmap: Uint8Array; stride: number }>) {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const layer of layers) {
    const { bitmap, stride, width, height } = layer;
    for (let y = 0; y < height; y++) {
      const row = y * stride;
      for (let x = 0; x < width; x++) {
        if (bitmap[row + x] === 0) continue;
        const gx = layer.originX + x;
        const gy = layer.originY + y;
        if (gx < minX) minX = gx;
        if (gy < minY) minY = gy;
        if (gx > maxX) maxX = gx;
        if (gy > maxY) maxY = gy;
      }
    }
  }
  if (!Number.isFinite(minX)) return { w: 0, h: 0 };
  return { w: maxX - minX, h: maxY - minY };
}

test("base style bold increases pixel coverage", async () => {
  const assBold = BASE.replace("%BOLD%", "-1").replace("%ITALIC%", "0").replace("%TEXT%", "Bold");
  const assNormal = BASE.replace("%BOLD%", "0").replace("%ITALIC%", "0").replace("%TEXT%", "Bold");
  const parsedBold = parseASS(assBold, { onError: "collect", strict: false, preserveOrder: true });
  const parsedNormal = parseASS(assNormal, { onError: "collect", strict: false, preserveOrder: true });
  expect(parsedBold.ok).toBe(true);
  expect(parsedNormal.ok).toBe(true);

  const bold = await renderFrame(parsedBold.document, 1000, 320, 200);
  const normal = await renderFrame(parsedNormal.document, 1000, 320, 200);

  expect(countPixels(bold.layers)).toBeGreaterThan(countPixels(normal.layers));
});

test("\\b0 disables bold from base style", async () => {
  const assBold = BASE.replace("%BOLD%", "-1").replace("%ITALIC%", "0").replace("%TEXT%", "Bold");
  const assInlineOff = BASE.replace("%BOLD%", "-1").replace("%ITALIC%", "0").replace("%TEXT%", "{\\\\b0}Bold");
  const parsedBold = parseASS(assBold, { onError: "collect", strict: false, preserveOrder: true });
  const parsedInline = parseASS(assInlineOff, { onError: "collect", strict: false, preserveOrder: true });
  expect(parsedBold.ok).toBe(true);
  expect(parsedInline.ok).toBe(true);

  const bold = await renderFrame(parsedBold.document, 1000, 320, 200);
  const inlineOff = await renderFrame(parsedInline.document, 1000, 320, 200);

  expect(countPixels(inlineOff.layers)).toBeLessThan(countPixels(bold.layers));
});

test("italic style changes bounds", async () => {
  const assItalic = BASE.replace("%BOLD%", "0").replace("%ITALIC%", "-1").replace("%TEXT%", "Italic");
  const assNormal = BASE.replace("%BOLD%", "0").replace("%ITALIC%", "0").replace("%TEXT%", "Italic");
  const parsedItalic = parseASS(assItalic, { onError: "collect", strict: false, preserveOrder: true });
  const parsedNormal = parseASS(assNormal, { onError: "collect", strict: false, preserveOrder: true });
  expect(parsedItalic.ok).toBe(true);
  expect(parsedNormal.ok).toBe(true);

  const italic = await renderFrame(parsedItalic.document, 1000, 320, 200);
  const normal = await renderFrame(parsedNormal.document, 1000, 320, 200);

  const bi = bounds(italic.layers);
  const bn = bounds(normal.layers);
  expect(Math.abs(bi.w - bn.w)).toBeGreaterThan(0.5);
});
