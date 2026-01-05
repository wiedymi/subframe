import { test, expect } from "bun:test";
import { parseASS } from "subforge/ass";
import { renderFrameWithTrace } from "../src/core/pipeline";

const ASS = String.raw`[Script Info]
Title: trace-filters
ScriptType: v4.00+
PlayResX: 320
PlayResY: 200

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,Arial,28,&H00FFFFFF,&H000000FF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,0,0,2,10,10,10,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
Dialogue: 0,0:00:00.00,0:00:02.00,Default,,0,0,0,,{\\bord3\\shad4\\blur2\\be1}Hello
`;

test("trace captures filter parameters and padding", async () => {
  const parsed = parseASS(ASS, { onError: "collect", strict: false, preserveOrder: true });
  expect(parsed.ok).toBe(true);

  const rendered = await renderFrameWithTrace(parsed.document, 500, 320, 200);
  const event = rendered.trace.events[0];
  expect(event).toBeDefined();
  expect(event!.layers.length).toBeGreaterThan(0);

  const expectedPad = 4;
  for (const layer of event!.layers) {
    expect(layer.outline).toBe(3);
    expect(layer.shadow).toBe(4);
    expect(layer.blur).toBe(2);
    expect(layer.edgeBlur).toBe(1);
    expect(layer.padding).toBe(expectedPad);
  }
});
