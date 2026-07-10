import { expect, test } from "bun:test";

test("disposing the default Bun facade releases every event-loop resource", async () => {
  const ass = `[Script Info]
ScriptType: v4.00+
PlayResX: 320
PlayResY: 180
[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,Arial,28,&H00FFFFFF,&H000000FF,&H00000000,&H00000000,-1,0,0,0,100,100,0,0,1,0,0,2,10,10,10,1
[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
Dialogue: 0,0:00:00.00,0:00:05.00,Default,,0,0,0,,Hello`;
  const script = `
    import { parseASS } from "subforge/ass";
    import { Subframe } from "./src/index.ts";
    const ass = ${JSON.stringify(ass)};
    const parsed = parseASS(ass, { onError: "collect", strict: false, preserveOrder: true });
    const sf = new Subframe();
    await sf.ready;
    sf.resize(320, 180);
    sf.setDocument(parsed.document);
    const frame = await sf.frame(1000);
    frame.release();
    sf.dispose();
  `;
  const child = Bun.spawn([process.execPath, "-e", script], {
    cwd: process.cwd(),
    stdout: "pipe",
    stderr: "pipe",
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const outcome = await Promise.race([
    child.exited.then((code) => ({ code, timedOut: false })),
    new Promise<{ code: number; timedOut: true }>((resolve) => {
      timer = setTimeout(() => resolve({ code: -1, timedOut: true }), 5000);
    }),
  ]);
  if (timer) clearTimeout(timer);
  if (outcome.timedOut) child.kill();
  expect(outcome.timedOut).toBe(false);
  expect(outcome.code).toBe(0);
}, 10_000);
