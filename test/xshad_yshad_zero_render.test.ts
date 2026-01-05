import { test, expect } from "bun:test";
import { parseASS } from "subforge/ass";
import { renderFrameWithTrace } from "../src/core/pipeline";

const BASE = String.raw`[Script Info]
Title: xshad-yshad-zero
ScriptType: v4.00+
PlayResX: 320
PlayResY: 200

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,Arial,28,&H00FFFFFF,&H000000FF,&H00000000,&H00000000,-1,0,0,0,100,100,0,0,1,0,10,2,10,10,10,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
Dialogue: 0,0:00:00.00,0:00:05.00,Default,,0,0,0,,%TEXT%
`;

function shadowDeltaX(trace: { events: Array<{ layers: Array<{ kind: string; originX: number; text: string }> }> }): number {
  const ev = trace.events[0];
  if (!ev) return 0;
  let minShadow = Infinity;
  let minFill = Infinity;
  for (const layer of ev.layers) {
    if (layer.kind === "shadow") minShadow = Math.min(minShadow, layer.originX);
    if (layer.kind === "fill") minFill = Math.min(minFill, layer.originX);
  }
  if (!Number.isFinite(minShadow) || !Number.isFinite(minFill)) return 0;
  return minShadow - minFill;
}

test("\\xshad0 overrides \\shad X component", async () => {
  const ass = BASE.replace("%TEXT%", "{\\\\shad10}Test");
  const assZero = BASE.replace("%TEXT%", "{\\\\shad10\\\\xshad0}Test");
  const parsed = parseASS(ass, { onError: "collect", strict: false, preserveOrder: true });
  const parsedZero = parseASS(assZero, { onError: "collect", strict: false, preserveOrder: true });
  expect(parsed.ok).toBe(true);
  expect(parsedZero.ok).toBe(true);

  const base = await renderFrameWithTrace(parsed.document, 1000, 320, 200);
  const zero = await renderFrameWithTrace(parsedZero.document, 1000, 320, 200);

  const dxBase = shadowDeltaX(base.trace);
  const dxZero = shadowDeltaX(zero.trace);

  expect(dxBase).toBeGreaterThan(2);
  expect(Math.abs(dxZero)).toBeLessThan(1);
});
