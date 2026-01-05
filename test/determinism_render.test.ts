import { test, expect } from "bun:test";
import { parseASS } from "subforge/ass";
import { renderFrame } from "../src/core/pipeline";

const ASS = String.raw`[Script Info]
Title: deterministic
ScriptType: v4.00+
PlayResX: 320
PlayResY: 200

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,Arial,28,&H00FFFFFF,&H000000FF,&H00000000,&H00000000,-1,0,0,0,100,100,0,0,1,2,2,2,10,10,10,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
Dialogue: 0,0:00:00.00,0:00:02.00,Default,,0,0,0,,{\\bord2\\shad1}Determinism
`;

function hashBytes(bytes: Uint8Array): number {
  let h = 2166136261;
  for (let i = 0; i < bytes.length; i++) {
    h ^= bytes[i]!;
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

test("render output is deterministic for identical inputs", async () => {
  const parsed = parseASS(ASS, { onError: "collect", strict: false, preserveOrder: true });
  expect(parsed.ok).toBe(true);

  const a = await renderFrame(parsed.document, 500, 320, 200);
  const b = await renderFrame(parsed.document, 500, 320, 200);

  expect(b.layers.length).toBe(a.layers.length);
  for (let i = 0; i < a.layers.length; i++) {
    const l0 = a.layers[i]!;
    const l1 = b.layers[i]!;
    expect(l1.width).toBe(l0.width);
    expect(l1.height).toBe(l0.height);
    expect(l1.originX).toBe(l0.originX);
    expect(l1.originY).toBe(l0.originY);
    expect(l1.z).toBe(l0.z);
    expect(l1.color[0]).toBe(l0.color[0]);
    expect(l1.color[1]).toBe(l0.color[1]);
    expect(l1.color[2]).toBe(l0.color[2]);
    expect(l1.color[3]).toBe(l0.color[3]);
    expect(hashBytes(l1.bitmap)).toBe(hashBytes(l0.bitmap));
  }
});
