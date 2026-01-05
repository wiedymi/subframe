import { test, expect } from "bun:test";
import { parseASS } from "subforge/ass";
import { renderFrameWithTrace } from "../src/core/pipeline";

const ASS = String.raw`[Script Info]
Title: layer-order
ScriptType: v4.00+
PlayResX: 320
PlayResY: 200

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,Arial,28,&H00FFFFFF,&H000000FF,&H00000000,&H00000000,-1,0,0,0,100,100,0,0,1,0,0,2,10,10,10,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
Dialogue: 1,0:00:00.00,0:00:05.00,Default,,0,0,0,,A
Dialogue: 0,0:00:00.00,0:00:05.00,Default,,0,0,0,,B
Dialogue: 1,0:00:00.00,0:00:05.00,Default,,0,0,0,,C
`;

function firstEventText(ev: { lines: Array<{ items: Array<{ text: string }> }> }): string {
  for (let i = 0; i < ev.lines.length; i++) {
    const line = ev.lines[i]!;
    for (let j = 0; j < line.items.length; j++) {
      const text = line.items[j]!.text;
      if (text.length > 0) return text;
    }
  }
  return "";
}

test("events are ordered by layer then read order", async () => {
  const parsed = parseASS(ASS, { onError: "collect", strict: false, preserveOrder: true });
  expect(parsed.ok).toBe(true);

  const rendered = await renderFrameWithTrace(parsed.document, 1000, 320, 200);
  const order = rendered.trace.events.map(firstEventText);

  expect(order).toEqual(["B", "A", "C"]);
});
