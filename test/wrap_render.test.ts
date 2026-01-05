import { test, expect } from "bun:test";
import { parseASS } from "subforge/ass";
import { renderFrame } from "../src/core/pipeline";

const WRAP_ASS = `[Script Info]\nTitle: wrap\nScriptType: v4.00+\nPlayResX: 200\nPlayResY: 120\n\n[V4+ Styles]\nFormat: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\nStyle: Default,Arial,24,&H00FFFFFF,&H000000FF,&H00000000,&H00000000,-1,0,0,0,100,100,0,0,1,0,0,2,10,10,10,1\n\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\nDialogue: 0,0:00:00.00,0:00:05.00,Default,,0,0,0,,This is a long line that should wrap\n`;

test("renderFrame wraps long lines", async () => {
  const parsed = parseASS(WRAP_ASS, { onError: "collect", strict: false, preserveOrder: true });
  expect(parsed.ok).toBe(true);

  const result = await renderFrame(parsed.document, 1000, 200, 120);
  expect(result.layers.length).toBeGreaterThan(0);

  let minY = Infinity;
  let maxY = -Infinity;
  for (let i = 0; i < result.layers.length; i++) {
    const layer = result.layers[i]!;
    const y0 = Math.floor(layer.originY);
    const y1 = y0 + layer.height;
    if (y0 < minY) minY = y0;
    if (y1 > maxY) maxY = y1;
  }

  const span = maxY - minY;
  expect(span).toBeGreaterThan(24);
});
