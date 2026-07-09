// Headless hardware self-test entry. Bundled with `bun build` and loaded by
// selftest.html; run under headless Chrome (WebGPU) by run-headless.ts. It runs
// the stage-1, batched, and filtered-cache self-tests, plus a per-pass debug
// comparison of the GPU batched engine against the JS emulator (the spec), and
// POSTs a JSON result to /result. All comparison happens in-browser so the bun
// side only needs to read the verdict.

import { parseASS } from "subforge/ass";
import {
  renderFrame,
  createWebGPUBackend,
  registerFontSource,
  setFontResolver,
  clearEventLayerCache,
  clearRasterCaches,
  resetFramePipeline,
  setGpuFilterProvider,
  getGpuFilterProvider,
  setFramePipeline,
  setWorkerPool,
  setWorkerSource,
} from "../../src";
import { libassGaussianBlur } from "../../src/core/libass_blur";
import { GpuBlurEngine, findBestMethod } from "../../src/backend/webgpu/blur";
import {
  BatchedGpuBlurEngine,
  GpuFilteredCache,
  computeOutDims,
  hashMask,
  type BatchMask,
} from "../../src/backend/webgpu/blur-batch";
import { BLUR_BATCH_SHADER_SOURCE } from "../../src/backend/webgpu/blur-batch-shaders";
import { PixelMode } from "text-shaper";

type Log = (msg: string) => void;

const SIZES: Array<[number, number]> = [
  [1, 1], [5, 2], [17, 9], [40, 40], [200, 60], [500, 200], [2, 500],
];
const R2 = [0.3, 1.7, 5.5, 45.568, 120];

function makeTestBitmap(w: number, h: number, seed = 12345): Uint8Array {
  const a = new Uint8Array(w * h);
  let s = seed;
  for (let i = 0; i < w * h; i++) {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    a[i] = (s >> 8) & 255;
  }
  return a;
}

function makeBeastarsFrame(count: number): BatchMask[] {
  const masks: BatchMask[] = [];
  let s = 7919;
  const rnd = () => { s = (s * 1103515245 + 12345) & 0x7fffffff; return (s >>> 8) / 0x7fffff; };
  for (let i = 0; i < count; i++) {
    const w = 30 + Math.floor(rnd() * 170);
    const h = 30 + Math.floor(rnd() * 50);
    const r2 = 1.7 + rnd() * 10.3;
    masks.push({ bitmap: makeTestBitmap(w, h, 1000 + i * 13), width: w, height: h, r2x: r2, r2y: r2 });
  }
  return masks;
}

// ---------------------------------------------------------------------------
// JS emulator of the batched pipeline (the spec), instrumented to capture the
// whole `work` buffer after each round so we can diff it against the GPU.
// Mirrors blur-batch.ts plan() and blur-batch-shaders.ts kernels.
// ---------------------------------------------------------------------------
const i16 = (v: number) => (v << 16) >> 16;
const DITHER = [8,40,8,40,8,40,8,40,8,40,8,40,8,40,8,40,56,24,56,24,56,24,56,24,56,24,56,24,56,24,56,24];

function emulateBatch(masks: BatchMask[]) {
  type Plan = any;
  const plans: Plan[] = [];
  let inputCursor = 0, workCursor = 0, coeffCursor = 0, outputCursor = 0;
  for (const m of masks) {
    const d = computeOutDims(m.width, m.height, m.r2x, m.r2y);
    plans.push({
      bx: d.bx, by: d.by, w0: m.width, h0: m.height, maxSize: d.maxSize,
      outW: d.outW, outH: d.outH, inputBase: inputCursor, slotA: workCursor, slotB: workCursor + d.maxSize,
      xCoeffBase: coeffCursor, yCoeffBase: coeffCursor + 8, outputBase: outputCursor,
      curBase: workCursor, curW: m.width, curH: m.height, bitmap: m.bitmap, stride: m.stride ?? m.width,
    });
    inputCursor += m.width * m.height; workCursor += 2 * d.maxSize; coeffCursor += 16; outputCursor += d.outW * d.outH;
  }
  const rounds: any[] = [];
  const other = (p: Plan) => (p.curBase === p.slotA ? p.slotB : p.slotA);
  const emit = (entry: string, participants: Plan[], step: (p: Plan) => any) => {
    if (!participants.length) return;
    const jobs: number[][] = []; let pb = 0;
    for (const p of participants) {
      const s = step(p); const dstBase = other(p); const count = s.dstW * s.dstH;
      jobs.push([pb, count, p.curBase, dstBase, p.curW, p.curH, s.dstW, s.dstH, s.radius, s.coeffBase, s.dstW, 0]);
      pb += count; p.curBase = dstBase; p.curW = s.dstW; p.curH = s.dstH;
    }
    rounds.push({ entry, jobs });
  };
  { const jobs: number[][] = []; let pb = 0; for (const p of plans) { jobs.push([pb, p.w0 * p.h0, p.inputBase, p.slotA, p.w0, p.h0, p.w0, p.h0, 0, 0, p.w0, 0]); pb += p.w0 * p.h0; p.curBase = p.slotA; p.curW = p.w0; p.curH = p.h0; } rounds.push({ entry: "unpack", jobs }); }
  const maxLY = plans.reduce((a, p) => Math.max(a, p.by.level), 0);
  const maxLX = plans.reduce((a, p) => Math.max(a, p.bx.level), 0);
  for (let k = 0; k < maxLY; k++) emit("shrinkVert", plans.filter((p) => p.by.level > k), (p) => ({ dstW: p.curW, dstH: (p.curH + 5) >> 1, radius: 0, coeffBase: 0 }));
  for (let k = 0; k < maxLX; k++) emit("shrinkHorz", plans.filter((p) => p.bx.level > k), (p) => ({ dstW: (p.curW + 5) >> 1, dstH: p.curH, radius: 0, coeffBase: 0 }));
  emit("blurHorz", plans, (p) => ({ dstW: p.curW + 2 * p.bx.radius, dstH: p.curH, radius: p.bx.radius, coeffBase: p.xCoeffBase }));
  emit("blurVert", plans, (p) => ({ dstW: p.curW, dstH: p.curH + 2 * p.by.radius, radius: p.by.radius, coeffBase: p.yCoeffBase }));
  for (let k = 0; k < maxLX; k++) emit("expandHorz", plans.filter((p) => p.bx.level > k), (p) => ({ dstW: 2 * p.curW + 4, dstH: p.curH, radius: 0, coeffBase: 0 }));
  for (let k = 0; k < maxLY; k++) emit("expandVert", plans.filter((p) => p.by.level > k), (p) => ({ dstW: p.curW, dstH: 2 * p.curH + 4, radius: 0, coeffBase: 0 }));
  { const jobs: number[][] = []; let pb = 0; for (const p of plans) { jobs.push([pb, p.outW * p.outH, p.curBase, p.outputBase, p.curW, p.curH, p.outW, p.outH, 0, 0, p.outW, 0]); pb += p.outW * p.outH; } rounds.push({ entry: "pack", jobs }); }

  const input = new Int32Array(inputCursor);
  for (const p of plans) { let di = p.inputBase; for (let y = 0; y < p.h0; y++) for (let x = 0; x < p.w0; x++) input[di++] = p.bitmap[y * p.stride + x]!; }
  const coeff = new Int32Array(coeffCursor);
  for (const p of plans) { for (let c = 0; c < 8; c++) coeff[p.xCoeffBase + c] = p.bx.coeff[c]!; for (let c = 0; c < 8; c++) coeff[p.yCoeffBase + c] = p.by.coeff[c]!; }
  const work = new Int32Array(workCursor);
  const output = new Int32Array(outputCursor);

  const sH = (base: number, sW: number, sHh: number, y: number, col: number) => (col < 0 || col >= sW ? 0 : work[base + y * sW + col]!);
  const sV = (base: number, sW: number, sHh: number, x: number, row: number) => (row < 0 || row >= sHh ? 0 : work[base + row * sW + x]!);
  const shrinkFunc = (a: number, b: number, c: number, d: number, e: number, f: number) => { let r = (a + b + e + f) >> 1; r = (r + c + d) >> 1; r = (r + b + e) >> 1; return (r + c + d + 2) >> 2; };

  const snapshots: { entry: string; work: Int32Array }[] = [];
  for (const r of rounds) {
    for (const j of r.jobs) {
      const [, , srcBase, dstBase, srcW, srcH, dstW, dstH, radius, coeffBase, dstStride] = j;
      for (let y = 0; y < dstH; y++) for (let x = 0; x < dstW; x++) {
        let o = 0;
        if (r.entry === "unpack") { const v = input[srcBase + y * srcW + x]!; o = i16((((v << 7) | (v >> 1)) + 1) >> 1); work[dstBase + y * dstStride + x] = o; continue; }
        else if (r.entry === "shrinkVert") { const sy = y * 2; o = i16(shrinkFunc(sV(srcBase, srcW, srcH, x, sy - 4), sV(srcBase, srcW, srcH, x, sy - 3), sV(srcBase, srcW, srcH, x, sy - 2), sV(srcBase, srcW, srcH, x, sy - 1), sV(srcBase, srcW, srcH, x, sy), sV(srcBase, srcW, srcH, x, sy + 1))); }
        else if (r.entry === "shrinkHorz") { const sx = x * 2; o = i16(shrinkFunc(sH(srcBase, srcW, srcH, y, sx - 4), sH(srcBase, srcW, srcH, y, sx - 3), sH(srcBase, srcW, srcH, y, sx - 2), sH(srcBase, srcW, srcH, y, sx - 1), sH(srcBase, srcW, srcH, y, sx), sH(srcBase, srcW, srcH, y, sx + 1))); }
        else if (r.entry === "blurHorz") { const cx = x - radius; const c = sH(srcBase, srcW, srcH, y, cx); let acc = 0x8000; for (let i = radius; i > 0; i--) acc = (acc + Math.imul(sH(srcBase, srcW, srcH, y, cx - i) + sH(srcBase, srcW, srcH, y, cx + i) - 2 * c, coeff[coeffBase + i - 1]!)) | 0; o = i16(c + (acc >> 16)); }
        else if (r.entry === "blurVert") { const cy = y - radius; const c = sV(srcBase, srcW, srcH, x, cy); let acc = 0x8000; for (let i = radius; i > 0; i--) acc = (acc + Math.imul(sV(srcBase, srcW, srcH, x, cy - i) + sV(srcBase, srcW, srcH, x, cy + i) - 2 * c, coeff[coeffBase + i - 1]!)) | 0; o = i16(c + (acc >> 16)); }
        else if (r.entry === "expandHorz") { const k = x >> 1; const p1 = sH(srcBase, srcW, srcH, y, k - 2), z0 = sH(srcBase, srcW, srcH, y, k - 1), n1 = sH(srcBase, srcW, srcH, y, k); const rr = (((p1 + n1) >> 1) + z0) >> 1; o = i16((x & 1) === 0 ? (((rr + p1) >> 1) + z0 + 1) >> 1 : (((rr + n1) >> 1) + z0 + 1) >> 1); }
        else if (r.entry === "expandVert") { const k = y >> 1; const p1 = sV(srcBase, srcW, srcH, x, k - 2), z0 = sV(srcBase, srcW, srcH, x, k - 1), n1 = sV(srcBase, srcW, srcH, x, k); const rr = (((p1 + n1) >> 1) + z0) >> 1; o = i16((y & 1) === 0 ? (((rr + p1) >> 1) + z0 + 1) >> 1 : (((rr + n1) >> 1) + z0 + 1) >> 1); }
        else if (r.entry === "pack") { const v = work[srcBase + y * srcW + x]!; let ov = (v - (v >> 8) + DITHER[((y & 1) << 4) + (x & 15)]!) >> 6; if (ov < 0) ov = 0; else if (ov > 255) ov = 255; output[dstBase + y * dstStride + x] = ov; continue; }
        work[dstBase + y * dstStride + x] = o;
      }
    }
    snapshots.push({ entry: r.entry, work: work.slice() });
  }
  return { plans, snapshots, output };
}

// Map a GPU pass entry name (bUnpack) to the emulator's (unpack).
const entryToEmul = (e: string) => e.replace(/^b/, "").replace(/^([A-Z])/, (m) => m.toLowerCase());

async function runDebugCompare(device: any, masks: BatchMask[], log: Log) {
  // Fresh engine so bufWork is a newly-created (zero-initialized) buffer; this
  // matches the emulator's zeroed work array so slots outside the region a pass
  // has written so far compare equal instead of showing stale reuse data.
  const engine = new BatchedGpuBlurEngine();
  engine.init(device);
  const gpu = await engine.blurBatchDebug(masks);
  const emu = emulateBatch(masks);
  // Rounds line up (same plan); compare per round.
  const n = Math.min(gpu.rounds.length, emu.snapshots.length);
  let firstDivergentRound = -1;
  const detail: any = { rounds: gpu.rounds.map((r) => ({ entry: r.entry, jobCount: r.jobCount, totalPixels: r.totalPixels })) };
  for (let ri = 0; ri < n; ri++) {
    const g = gpu.rounds[ri]!;
    const e = emu.snapshots[ri]!;
    const len = Math.min(g.work.length, e.work.length);
    let firstIdx = -1;
    let diffCount = 0;
    for (let k = 0; k < len; k++) {
      if (g.work[k] !== e.work[k]) { diffCount++; if (firstIdx < 0) firstIdx = k; }
    }
    if (diffCount > 0 && firstDivergentRound < 0) {
      firstDivergentRound = ri;
      // Locate which mask/slot the first divergent index belongs to.
      let owner = -1, kind = "?", rel = -1;
      for (let pi = 0; pi < gpu.plans.length; pi++) {
        const p = gpu.plans[pi]!;
        if (firstIdx >= p.slotA && firstIdx < p.slotA + p.maxSize) { owner = pi; kind = "A"; rel = firstIdx - p.slotA; break; }
        if (firstIdx >= p.slotB && firstIdx < p.slotB + p.maxSize) { owner = pi; kind = "B"; rel = firstIdx - p.slotB; break; }
      }
      detail.firstDivergentRound = ri;
      detail.entry = g.entry;
      detail.jobOffset = g.jobOffset;
      detail.jobCount = g.jobCount;
      detail.totalPixels = g.totalPixels;
      detail.firstIdx = firstIdx;
      detail.diffCount = diffCount;
      detail.gpuVal = g.work[firstIdx];
      detail.emuVal = e.work[firstIdx];
      detail.owner = { mask: owner, slot: kind, rel };
      // A few surrounding samples.
      const samples: any[] = [];
      for (let k = firstIdx; k < Math.min(len, firstIdx + 8); k++) samples.push({ k, gpu: g.work[k], emu: e.work[k] });
      detail.samples = samples;
      log(`DEBUG first divergence: round ${ri} entry=${g.entry} jobs=${g.jobCount} totalPixels=${g.totalPixels} idx=${firstIdx} gpu=${g.work[firstIdx]} emu=${e.work[firstIdx]} diffCount=${diffCount} owner=mask${owner}/${kind}+${rel}`);
    }
  }
  // Final output comparison.
  let outDiff = 0, outFirst = -1;
  const ol = Math.min(gpu.output.length, emu.output.length);
  for (let k = 0; k < ol; k++) { if ((gpu.output[k]! & 0xff) !== (emu.output[k]! & 0xff)) { outDiff++; if (outFirst < 0) outFirst = k; } }
  detail.output = { diffCount: outDiff, firstIdx: outFirst, len: ol };
  if (firstDivergentRound < 0) log(`DEBUG: all ${n} rounds match emulator; output diff=${outDiff}`);
  engine.dispose();
  return detail;
}

// Full-frame OFF==ON test: render the same frame twice through one filter-enabled
// WebGPU backend -- once with the GPU filter provider ON (backend produces
// blur/outline/shift on the GPU via filterGroups) and once OFF (core CPU blur,
// backend uploads finished masks) -- and byte-compare. A bit-exact GPU path
// yields an identical frame. Both cases must route layers to the GPU (gpuRouted>0).
const GPU_FRZ_CASE = `[Script Info]
PlayResX: 1920
PlayResY: 1080
[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Def,Arial,72,&H00FFFFFF,&H000000FF,&H0000CC00,&H00000000,0,0,0,0,100,100,0,0,1,4,3,5,10,10,10,1
[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
Dialogue: 0,0:00:00.00,0:00:10.00,Def,,0,0,0,,{\\blur5\\an5\\pos(960,300)}Bordered control (CPU)
Dialogue: 0,0:00:00.00,0:00:10.00,Def,,0,0,0,,{\\blur2\\bord0\\shad0\\an5\\pos(960,540)}No border blurred (GPU)
Dialogue: 0,0:00:00.00,0:00:10.00,Def,,0,0,0,,{\\blur3\\bord0\\shad0\\an5\\pos(960,760)\\t(0,4000,\\frz360)}Rotating no-border blur (GPU)
`;

async function installFontResolver(log: Log): Promise<void> {
  const fontBuf = await (await fetch("/arial.ttf")).arrayBuffer();
  registerFontSource("Arial", fontBuf);
  setFontResolver(async (name: string) => {
    if (name === "Arial") return fontBuf;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const res = await fetch(`/font?name=${encodeURIComponent(name)}`);
        if (!res.ok) return null;
        const buf = await res.arrayBuffer();
        registerFontSource(name, buf);
        return buf;
      } catch (err) {
        log(`font fetch failed attempt=${attempt} name=${name}: ${String(err)}`);
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    }
    return null;
  });
}

async function runFullFrame(log: Log, mode = "default"): Promise<any> {
  const width = 1920, height = 1080;
  await installFontResolver(log);
  setWorkerSource("/worker-entry.js");
  // Full-frame ON/OFF equality is a GPU filter/composite gate. Keep it out of
  // the boundary/worker scheduler so heavy fixture cases report pixel results
  // instead of timing out inside unrelated prewarm machinery; the Chrome bench
  // exercises the real worker transport path.
  setWorkerPool(false);
  setFramePipeline(false);

  const canvas = document.createElement("canvas");
  canvas.width = width; canvas.height = height;
  const backend = await createWebGPUBackend({ canvas, enableGpuFilters: true } as any);
  const onProvider = getGpuFilterProvider();
  if (!backend || !onProvider) { log("fullframe: GPU filter provider unavailable"); return { available: false }; }
  backend.resize(width, height);

  const rbCanvas = document.createElement("canvas");
  rbCanvas.width = width; rbCanvas.height = height;
  const rbCtx = rbCanvas.getContext("2d", { willReadFrequently: true })!;
  const readCanvas = (): Uint8ClampedArray => { rbCtx.clearRect(0, 0, width, height); rbCtx.drawImage(canvas, 0, 0); return rbCtx.getImageData(0, 0, width, height).data; };

  const syntheticDoc = parseASS(GPU_FRZ_CASE, { onError: "collect", strict: false, preserveOrder: true }).document;
  const fgobdAss = await (await fetch("/ass/FGOBD.ass")).text();
  const fgobdDoc = parseASS(fgobdAss, { onError: "collect", strict: false, preserveOrder: true }).document;
  const beastarsAss = await (await fetch("/ass/beastars.ass")).text();
  const beastarsDoc = parseASS(beastarsAss, { onError: "collect", strict: false, preserveOrder: true }).document;
  const defaultCases = [
    { name: "synthetic static @0ms", doc: syntheticDoc, timeMs: 0 },
    { name: "synthetic \\t\\frz rotation @2000ms", doc: syntheticDoc, timeMs: 2000 },
    { name: "FGOBD ROM kfx reveal @27700ms", doc: fgobdDoc, timeMs: 27700 },
    { name: "FGOBD ROM kfx line @29600ms", doc: fgobdDoc, timeMs: 29600 },
    { name: "FGOBD reported playground @34000ms", doc: fgobdDoc, timeMs: 34000 },
    { name: "FGOBD reported playground @35000ms", doc: fgobdDoc, timeMs: 35000 },
  ];
  const beastarsCases = [
    { name: "beastars heavy clip @248850ms", doc: beastarsDoc, timeMs: 248850 },
    { name: "beastars heavy clip @250350ms", doc: beastarsDoc, timeMs: 250350 },
  ];
  const cases =
    mode === "beastars"
      ? beastarsCases
      : mode === "all"
        ? defaultCases.concat(beastarsCases)
        : defaultCases;
  const out: any = { available: true, cases: [] as any[] };
  let allPass = true;
  for (const c of cases) {
    clearEventLayerCache(); clearRasterCaches(); resetFramePipeline();
    setGpuFilterProvider(onProvider);
    const rOn = await renderFrame(c.doc, c.timeMs, width, height);
    backend.render(rOn.layers, rOn.frame);
    const onData = readCanvas();
    const routed = rOn.layers.reduce((n: number, l: any) => n + (l.gpuFilter ? 1 : 0), 0);

    clearEventLayerCache(); clearRasterCaches(); resetFramePipeline();
    setGpuFilterProvider(null);
    const rOff = await renderFrame(c.doc, c.timeMs, width, height);
    backend.render(rOff.layers, rOff.frame);
    const offData = readCanvas();
    const routedOff = rOff.layers.reduce((n: number, l: any) => n + (l.gpuFilter ? 1 : 0), 0);

    let maxDiff = 0, diffPx = 0;
    for (let p = 0; p < offData.length; p += 4) {
      const d = Math.max(Math.abs(offData[p]! - onData[p]!), Math.abs(offData[p + 1]! - onData[p + 1]!), Math.abs(offData[p + 2]! - onData[p + 2]!), Math.abs(offData[p + 3]! - onData[p + 3]!));
      if (d > maxDiff) maxDiff = d;
      if (d > 0) diffPx++;
    }
    const pass = maxDiff === 0 && rOn.layers.length === rOff.layers.length && routed > 0;
    if (!pass) allPass = false;
    out.cases.push({ name: c.name, pass, maxDiff, diffPx, gpuRouted: routed, gpuRoutedOff: routedOff, layersOn: rOn.layers.length, layersOff: rOff.layers.length });
    log(`fullframe ${c.name}: ${pass ? "PASS" : "FAIL"} maxDiff=${maxDiff} diffPx=${diffPx} gpuRouted=${routed} gpuRoutedOff=${routedOff} layers ON=${rOn.layers.length} OFF=${rOff.layers.length}`);
  }
  out.pass = allPass;
  backend.dispose?.();
  setGpuFilterProvider(null);
  return out;
}

async function main() {
  const results: any = { ok: false, groups: {}, logs: [] };
  const log: Log = (m) => { results.logs.push(m); try { (globalThis as any).console.log(m); } catch {} };
  try {
    if (!("gpu" in navigator)) { results.error = "navigator.gpu unavailable"; return post(results); }
    const adapter = await (navigator as any).gpu.requestAdapter();
    if (!adapter) { results.error = "adapter request failed"; return post(results); }
    const hasTs = !!adapter.features?.has?.("timestamp-query");
    const device = await adapter.requestDevice(hasTs ? { requiredFeatures: ["timestamp-query"] } : {});
    results.timestampQuery = hasTs;
    results.adapterInfo = adapter.info ? { vendor: adapter.info.vendor, architecture: adapter.info.architecture, description: adapter.info.description } : null;

    // Compile the batched shader module directly and capture any diagnostics.
    try {
      device.pushErrorScope("validation");
      const mod = device.createShaderModule({ code: BLUR_BATCH_SHADER_SOURCE });
      const info = await mod.getCompilationInfo?.();
      results.shaderCompile = { messages: (info?.messages ?? []).map((m: any) => ({ type: m.type, lineNum: m.lineNum, linePos: m.linePos, message: m.message })) };
      const err = await device.popErrorScope();
      if (err) results.shaderCompile.validationError = String(err.message);
      log(`shaderCompile: ${results.shaderCompile.messages.length} messages${results.shaderCompile.validationError ? " validationError=" + results.shaderCompile.validationError : ""}`);
      for (const m of results.shaderCompile.messages) log(`  [${m.type}] ${m.lineNum}:${m.linePos} ${m.message}`);
    } catch (e) { results.shaderCompile = { thrown: String(e) }; log(`shaderCompile threw: ${e}`); }

    // Stage 1
    const engine = new GpuBlurEngine();
    engine.init(device);
    let s1p = 0, s1f = 0;
    for (const [w, h] of SIZES) {
      const bmp = makeTestBitmap(w, h);
      for (const r2 of R2) {
        const cpu = libassGaussianBlur({ buffer: bmp, width: w, rows: h, pitch: w, pixelMode: PixelMode.Gray, numGrays: 256 }, r2, r2);
        const g = await engine.blur(bmp, w, h, r2, r2);
        let ok = cpu.bitmap.width === g.width && cpu.bitmap.rows === g.rows;
        if (ok) for (let i = 0; i < g.buffer.length; i++) if (cpu.bitmap.buffer[i] !== g.buffer[i]) { ok = false; break; }
        if (ok) s1p++; else s1f++;
      }
    }
    results.groups.stage1 = { pass: s1p, fail: s1f };
    log(`stage1: ${s1p} PASS ${s1f} FAIL`);

    // Batched
    const batch = new BatchedGpuBlurEngine();
    batch.init(device);
    batch.setTiming(hasTs);
    const batchMasks: BatchMask[] = [];
    const meta: Array<{ w: number; h: number; r2: number }> = [];
    for (const [w, h] of SIZES) { const bmp = makeTestBitmap(w, h); for (const r2 of R2) { batchMasks.push({ bitmap: bmp, width: w, height: h, r2x: r2, r2y: r2 }); meta.push({ w, h, r2 }); } }
    const bres = await batch.blurBatch(batchMasks);
    let bp = 0, bf = 0; const bfail: string[] = [];
    for (let i = 0; i < batchMasks.length; i++) {
      const mt = meta[i]!;
      const cpu = libassGaussianBlur({ buffer: batchMasks[i]!.bitmap, width: mt.w, rows: mt.h, pitch: mt.w, pixelMode: PixelMode.Gray, numGrays: 256 }, mt.r2, mt.r2);
      const bat = bres[i]!;
      let ok = bat.width === cpu.bitmap.width && bat.rows === cpu.bitmap.rows;
      if (ok) for (let k = 0; k < bat.buffer.length; k++) if (bat.buffer[k] !== cpu.bitmap.buffer[k]) { ok = false; break; }
      if (ok) bp++; else { bf++; bfail.push(`${mt.w}x${mt.h} r2=${mt.r2}`); }
    }
    results.groups.batched = { pass: bp, fail: bf, fails: bfail };
    log(`batched: ${bp} PASS ${bf} FAIL`);

    // Filtered cache
    const cache = new GpuFilteredCache(device, batch, { pageSize: 2048 });
    const frame = makeBeastarsFrame(40);
    const reqs = frame.map((m) => ({ bitmap: m.bitmap, width: m.width, height: m.height, r2x: m.r2x, r2y: m.r2y, key: hashMask(m.bitmap, m.r2x, m.r2y) }));
    const h1 = await cache.request(reqs, 0);
    let cp = 0, cf = 0;
    for (let i = 0; i < frame.length; i++) {
      const h = h1[i]!; const m = frame[i]!;
      const cpu = libassGaussianBlur({ buffer: m.bitmap, width: m.width, rows: m.height, pitch: m.width, pixelMode: PixelMode.Gray, numGrays: 256 }, m.r2x, m.r2y);
      const slot = await cache.readSlot(h.pageIndex, h.x, h.y, h.outW, h.outH);
      let ok = h.outW === cpu.bitmap.width && h.outH === cpu.bitmap.rows;
      if (ok) for (let k = 0; k < slot.length; k++) if (slot[k] !== cpu.bitmap.buffer[k]) { ok = false; break; }
      if (ok) cp++; else cf++;
    }
    const h2 = await cache.request(reqs, 1);
    const hits2 = h2.filter((h) => h.hit).length;
    results.groups.cache = { pass: cp, fail: cf, total: frame.length, frame2Hits: hits2 };
    log(`cache: ${cp} PASS ${cf} FAIL, frame2 hits ${hits2}/${frame.length}`);

    // Debug: per-pass compare, singleton then mixed batch.
    results.debug = {};
    results.debug.singleton = await runDebugCompare(device, [{ bitmap: makeTestBitmap(5, 2), width: 5, height: 2, r2x: 0.3, r2y: 0.3 }], log);
    const mixed: BatchMask[] = [
      { bitmap: makeTestBitmap(5, 2), width: 5, height: 2, r2x: 0.3, r2y: 0.3 },
      { bitmap: makeTestBitmap(5, 2), width: 5, height: 2, r2x: 1.7, r2y: 1.7 },
      { bitmap: makeTestBitmap(17, 9), width: 17, height: 9, r2x: 5.5, r2y: 5.5 },
      { bitmap: makeTestBitmap(40, 40), width: 40, height: 40, r2x: 45.568, r2y: 45.568 },
    ];
    results.debug.mixed = await runDebugCompare(device, mixed, log);

    results.gpuTimeMs = batch.lastGpuTimeMs;
    cache.dispose(); batch.dispose(); engine.dispose();

    // Full-frame OFF==ON (exercises the filterGroups GPU path end-to-end).
    let ffPass = true;
    try {
      const fullframeMode = new URLSearchParams(location.search).get("fullframe") ?? "default";
      results.fullframe = await runFullFrame(log, fullframeMode);
      ffPass = results.fullframe.available ? !!results.fullframe.pass : true;
    } catch (e) { results.fullframe = { error: String(e) }; ffPass = false; log(`fullframe error: ${e}`); }
    results.ok = s1f === 0 && bf === 0 && cf === 0 && hits2 === frame.length && ffPass;
    device.destroy?.();
  } catch (err) {
    results.error = String(err && (err as any).stack || err);
    log(`ERROR ${results.error}`);
  }
  return post(results);
}

async function post(results: any) {
  try {
    await fetch("/result", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(results) });
  } catch (e) {
    try { (globalThis as any).console.log("POST failed: " + e); } catch {}
  }
  try { (document.getElementById("status") as HTMLElement).textContent = results.ok ? "PASS" : "DONE (see result)"; } catch {}
}

main();
