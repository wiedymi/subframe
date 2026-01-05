import { test, expect } from "bun:test";
import { parseASS } from "subforge/ass";
import { renderFrameWithTrace } from "../src/core/pipeline";

const BASE = String.raw`[Script Info]
Title: escape-newline
ScriptType: v4.00+
PlayResX: 260
PlayResY: 120
WrapStyle: %WRAP%

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,Arial,24,&H00FFFFFF,&H000000FF,&H00000000,&H00000000,-1,0,0,0,100,100,0,0,1,0,0,2,10,10,10,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
Dialogue: 0,0:00:00.00,0:00:05.00,Default,,0,0,0,,%TEXT%
`;

async function lineCount(wrap: "0" | "2", text: string): Promise<number> {
  const ass = BASE.replace("%WRAP%", wrap).replace("%TEXT%", text);
  const parsed = parseASS(ass, { onError: "collect", strict: false, preserveOrder: true });
  expect(parsed.ok).toBe(true);
  const rendered = await renderFrameWithTrace(parsed.document, 1000, 260, 120);
  return rendered.trace.events[0]?.lines.length ?? 0;
}

test("\\n is a space unless wrapStyle=2", async () => {
  const linesWrap0 = await lineCount("0", "A\\\\nB");
  const linesWrap2 = await lineCount("2", "A\\\\nB");

  expect(linesWrap0).toBe(1);
  expect(linesWrap2).toBe(2);
});

test("\\N is always a hard line break", async () => {
  const linesWrap0 = await lineCount("0", "A\\\\NB");
  const linesWrap2 = await lineCount("2", "A\\\\NB");

  expect(linesWrap0).toBe(2);
  expect(linesWrap2).toBe(2);
});

test("\\q2 makes \\n a hard break inside the override", async () => {
  const lines = await lineCount("0", "{\\\\q2}A\\\\nB");
  expect(lines).toBe(2);
});
