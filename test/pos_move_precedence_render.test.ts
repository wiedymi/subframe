import { test, expect } from "bun:test";
import { parseASS } from "subforge/ass";
import { renderFrameWithTrace } from "../src/core/pipeline";

const BASE = String.raw`[Script Info]
Title: pos-move-precedence
ScriptType: v4.00+
PlayResX: 320
PlayResY: 200

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,Arial,28,&H00FFFFFF,&H000000FF,&H00000000,&H00000000,-1,0,0,0,100,100,0,0,1,0,0,2,10,10,10,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
Dialogue: 0,0:00:00.00,0:00:05.00,Default,,0,0,0,,%TEXT%
`;

test("last \\pos wins over earlier \\pos", async () => {
  const ass = BASE.replace("%TEXT%", "{\\pos(10,10)}A{\\pos(100,50)}B");
  const parsed = parseASS(ass, { onError: "collect", strict: false, preserveOrder: true });
  expect(parsed.ok).toBe(true);

  const rendered = await renderFrameWithTrace(parsed.document, 1000, 320, 200);
  const pos = rendered.trace.events[0]?.pos;
  expect(pos).toEqual([100, 50]);
});

test("later \\move overrides earlier \\pos", async () => {
  const ass = BASE.replace("%TEXT%", "{\\pos(10,10)}A{\\move(0,0,200,0,0,1000)}B");
  const parsed = parseASS(ass, { onError: "collect", strict: false, preserveOrder: true });
  expect(parsed.ok).toBe(true);

  const rendered = await renderFrameWithTrace(parsed.document, 500, 320, 200);
  const pos = rendered.trace.events[0]?.pos;
  expect(pos && Math.round(pos[0]!)).toBe(100);
});
