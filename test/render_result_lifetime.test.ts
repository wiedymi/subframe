import { test, expect } from "bun:test";
import { parseASS } from "subforge/ass";
import {
  getFramePipelineStats,
  releaseRenderResult,
  renderFrame,
  resetFramePipeline,
  setFramePipeline,
  setWorkerCount,
  setWorkerPool,
} from "../src/core/pipeline";

const DRAWING_ASS = String.raw`[Script Info]
Title: render-result-lifetime
ScriptType: v4.00+
PlayResX: 320
PlayResY: 200

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,Arial,28,&H00FFFFFF,&H000000FF,&H00000000,&H00000000,-1,0,0,0,100,100,0,0,1,0,0,2,10,10,10,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
Dialogue: 0,0:00:00.00,0:00:10.00,Default,,0,0,0,,{\bord0\shad0\pos(70,120)\p1}m 0 0 l 90 0 l 90 64 l 0 64{\p0}
`;

type HeldResult = {
  result: Awaited<ReturnType<typeof renderFrame>>;
  signature: string;
};

function readBitmapSignature(bitmap: Uint8Array): string {
  // Constructing a fresh view mirrors backend upload paths and throws on a
  // detached ArrayBuffer; iterating the full logical view catches SAB slot reuse
  // that silently overwrote a still-held public result.
  const view = new Uint8Array(bitmap.buffer, bitmap.byteOffset, bitmap.byteLength);
  let sum = 0;
  let mix = 2166136261 >>> 0;
  for (let i = 0; i < view.length; i++) {
    const v = view[i]!;
    sum += v;
    mix ^= v;
    mix = Math.imul(mix, 16777619) >>> 0;
  }
  return `${view.length}:${sum}:${mix}`;
}

function readResultSignature(result: Awaited<ReturnType<typeof renderFrame>>): string {
  const parts: string[] = [];
  for (let i = 0; i < result.layers.length; i++) {
    const layer = result.layers[i]!;
    parts[parts.length] = readBitmapSignature(layer.bitmap);
    const clip = layer.clip;
    if (clip?.type === "mask") parts[parts.length] = readBitmapSignature(clip.bitmap);
    const gpu = layer.gpuFilter;
    if (gpu) {
      parts[parts.length] = readBitmapSignature(gpu.fillMask);
      if (gpu.outlineMask) parts[parts.length] = readBitmapSignature(gpu.outlineMask);
    }
  }
  return parts.join("|");
}

async function exerciseBufferedPublicResults(sab: boolean): Promise<void> {
  const oldReturn = process.env.SUBFRAME_BUN_ARENA_RETURN;
  const oldSab = process.env.SUBFRAME_SAB_ARENAS;
  const held: HeldResult[] = [];
  try {
    process.env.SUBFRAME_BUN_ARENA_RETURN = "1";
    process.env.SUBFRAME_SAB_ARENAS = sab ? "1" : "0";
    setWorkerPool(false);
    resetFramePipeline();
    setWorkerCount(1);
    setWorkerPool(true);
    setFramePipeline(true);

    const parsed = parseASS(DRAWING_ASS, {
      onError: "collect",
      strict: false,
      preserveOrder: true,
    });
    expect(parsed.ok).toBe(true);

    for (let i = 0; i < 10; i++) {
      const result = await renderFrame(parsed.document, i * (1000 / 60), 320, 200);
      expect(result.layers.length).toBeGreaterThan(0);
      held[held.length] = { result, signature: readResultSignature(result) };
      for (let j = 0; j < held.length; j++) {
        expect(readResultSignature(held[j]!.result)).toBe(held[j]!.signature);
      }
    }

    expect(getFramePipelineStats().scatterFrames).toBeGreaterThan(0);
  } finally {
    for (let i = 0; i < held.length; i++) releaseRenderResult(held[i]!.result);
    setWorkerPool(false);
    setWorkerCount(null);
    resetFramePipeline();
    if (oldReturn === undefined) delete process.env.SUBFRAME_BUN_ARENA_RETURN;
    else process.env.SUBFRAME_BUN_ARENA_RETURN = oldReturn;
    if (oldSab === undefined) delete process.env.SUBFRAME_SAB_ARENAS;
    else process.env.SUBFRAME_SAB_ARENAS = oldSab;
  }
}

test("returned worker RenderResults remain readable while a buffering consumer holds them", async () => {
  await exerciseBufferedPublicResults(false);
});

test("returned SAB-backed RenderResults are not overwritten while held", async () => {
  await exerciseBufferedPublicResults(true);
});
