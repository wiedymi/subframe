import { test, expect } from "bun:test";
import { parseASS } from "subforge/ass";
import { renderFrameWithTrace } from "../src/core/pipeline";

const BASE = String.raw`[Script Info]
Title: wrapstyle-rebalance
ScriptType: v4.00+
PlayResX: 260
PlayResY: 120
WrapStyle: %WRAP%

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,Arial,24,&H00FFFFFF,&H000000FF,&H00000000,&H00000000,-1,0,0,0,100,100,0,0,1,0,0,2,10,10,10,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
Dialogue: 0,0:00:00.00,0:00:05.00,Default,,0,0,0,,One two three four five six
`;

async function lineWidths(wrap: "0" | "1"): Promise<number[]> {
  const ass = BASE.replace("%WRAP%", wrap);
  const parsed = parseASS(ass, { onError: "collect", strict: false, preserveOrder: true });
  expect(parsed.ok).toBe(true);
  const rendered = await renderFrameWithTrace(parsed.document, 1000, 260, 120);
  const lines = rendered.trace.events[0]?.lines ?? [];
  return lines.map((l) => l.width);
}

test("wrapStyle 1 keeps naive breaks (less rebalance)", async () => {
  const w0 = await lineWidths("0");
  const w1 = await lineWidths("1");

  expect(w0.length).toBeGreaterThan(1);
  expect(w1.length).toBeGreaterThan(1);

  const diff0 = Math.abs(w0[0]! - w0[1]!);
  const diff1 = Math.abs(w1[0]! - w1[1]!);

  expect(diff1).toBeGreaterThan(diff0);
});
