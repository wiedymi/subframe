// Atlas-batched GPU blur. BatchedGpuBlurEngine.filterGroups IS the render
// path's filter engine (webgpu/index.ts runGpuFilters records it into the
// frame's command encoder — one dispatch per pass type over many bitmaps, see
// blur-batch-shaders.ts). GpuFilteredCache (content-keyed, GPU-resident,
// readback-verified) remains selftest/offline-only and ships for the hardware
// gate.

import { BLUR_BATCH_SHADER_SOURCE } from "./blur-batch-shaders";
import { findBestMethod, type BlurMethod } from "./blur";
import { AtlasAllocator, type AtlasSlot } from "../atlas-allocator";

// GPU types are ambient globals in the browser (no @webgpu/types installed).
type GPUDeviceT = any;
type GPUBufferT = any;

export type BatchMask = {
  bitmap: Uint8Array;
  width: number;
  height: number;
  r2x: number;
  r2y: number;
  stride?: number;
};

export type BatchResult = {
  buffer: Uint8Array;
  width: number;
  rows: number;
  shiftX: number;
  shiftY: number;
};

// --- Per-layer executor (option B + per-layer subpixel shift), no readback ---
// A GROUP holds the shared masks + blur params for one glyph's fill/outline. Its
// fill and outline are blurred once and (when a layer needs it) copy+punched into
// an outlinePunched slot. A LAYER selects one produced source (fill/outlineRaw/
// outlinePunched) and carries its own quantized subpixel shift (sx,sy in 1/64ths,
// each in [0,63]); the executor copies the source, applies bShiftH/bShiftV, and
// emits that layer's own region. Two layers sharing a source but with different
// shifts get distinct, correct regions.
export type GpuFilterSourceKind = "fill" | "outlineRaw" | "outlinePunched";

export type FilterGroupInput = {
  groupId: number;
  fillMask: Uint8Array;
  fillW: number;
  fillH: number;
  fillStride: number;
  outlineMask?: Uint8Array;
  outlineW?: number;
  outlineH?: number;
  outlineStride?: number;
  r2x: number;
  r2y: number;
  // Integer punch offsets (fixOutlineBitmap alignment).
  punchOX?: number;
  punchOY?: number;
  punchFX?: number;
  punchFY?: number;
};

export type FilterLayerRequest = {
  groupId: number;
  source: GpuFilterSourceKind;
  // Per-layer subpixel shift (quantized 1/64ths, each in [0,63]); baked in by the
  // shift kernels exactly as normalizeLayerOrigin's shiftBitmapSubpixel would.
  sx: number;
  sy: number;
  // Optional vector clip mask applied during the final u8 emit. Coordinates are
  // integer screen pixels and match src/core/clip/apply.ts.
  clipMask?: Uint8Array;
  clipW?: number;
  clipH?: number;
  clipStride?: number;
  clipOriginX?: number;
  clipOriginY?: number;
  clipInverse?: boolean;
  layerOriginX?: number;
  layerOriginY?: number;
};

// A region inside the emit buffer, ready for copyBufferToTexture into r8unorm.
export type FilterRegion = { byteOffset: number; bytesPerRow: number; w: number; h: number };
export type FilterGroupRunStats = {
  submitted: boolean;
  rounds: number;
  jobs: number;
  pixels: number;
  outputBytes: number;
  maskUploads?: number;
  maskPixels?: number;
};

const JOB_FIELDS = 20; // must match struct Job in blur-batch-shaders.ts
const PASS_ENTRIES = [
  "bUnpack",
  "bShrinkVert",
  "bShrinkHorz",
  "bBlurHorz",
  "bBlurVert",
  "bExpandHorz",
  "bExpandVert",
  "bPack",
  "bPackToWork",
  "bCopy",
  "bPunch",
  "bShiftH",
  "bShiftV",
  "bEmitMaskedU8",
  "bEmitU8",
] as const;
type Entry = (typeof PASS_ENTRIES)[number];

// Output dims/shift for one bitmap, identical to libassGaussianBlur().
export function computeOutDims(
  w0: number,
  h0: number,
  r2x: number,
  r2y: number,
): {
  bx: BlurMethod;
  by: BlurMethod;
  outW: number;
  outH: number;
  shiftX: number;
  shiftY: number;
  maxSize: number;
} {
  const bx = findBestMethod(r2x);
  const by = r2x === r2y ? bx : findBestMethod(r2y);
  const offsetX = ((2 * bx.radius + 9) << bx.level) - 5;
  const offsetY = ((2 * by.radius + 9) << by.level) - 5;
  const endW = ((w0 + offsetX) & ~((1 << bx.level) - 1)) - 4;
  const endH = ((h0 + offsetY) & ~((1 << by.level) - 1)) - 4;

  let w = w0;
  let h = h0;
  let maxSize = w0 * h0;
  for (let i = 0; i < by.level; i++) { h = (h + 5) >> 1; maxSize = Math.max(maxSize, w * h); }
  for (let i = 0; i < bx.level; i++) { w = (w + 5) >> 1; maxSize = Math.max(maxSize, w * h); }
  w = w + 2 * bx.radius; maxSize = Math.max(maxSize, w * h);
  h = h + 2 * by.radius; maxSize = Math.max(maxSize, w * h);
  for (let i = 0; i < bx.level; i++) { w = 2 * w + 4; maxSize = Math.max(maxSize, w * h); }
  for (let i = 0; i < by.level; i++) { h = 2 * h + 4; maxSize = Math.max(maxSize, w * h); }

  const outW = w < endW ? w : endW;
  const outH = h < endH ? h : endH;
  const shiftX = ((bx.radius + 4) << bx.level) - 4;
  const shiftY = ((by.radius + 4) << by.level) - 4;
  return { bx, by, outW, outH, shiftX, shiftY, maxSize };
}

// FNV-1a-ish content key over the mask bytes + blur radii. Two 32-bit lanes to
// keep collisions negligible for cache keying.
export function hashMask(bitmap: Uint8Array, r2x: number, r2y: number): string {
  let h1 = 0x811c9dc5 | 0;
  let h2 = 0x01000193 | 0;
  for (let i = 0; i < bitmap.length; i++) {
    const b = bitmap[i]!;
    h1 = Math.imul(h1 ^ b, 0x01000193);
    h2 = Math.imul(h2 + b, 0x85ebca6b) ^ (h2 >>> 13);
  }
  const rx = Math.round(r2x * 4096);
  const ry = Math.round(r2y * 4096);
  return `${(h1 >>> 0).toString(36)}_${(h2 >>> 0).toString(36)}_${bitmap.length}_${rx}_${ry}`;
}

type PackTarget = { buffer: GPUBufferT; dstBase: number; dstStride: number };

type MaskPlan = {
  bx: BlurMethod;
  by: BlurMethod;
  w0: number;
  h0: number;
  stride: number;
  maxSize: number;
  outW: number;
  outH: number;
  shiftX: number;
  shiftY: number;
  inputBase: number;
  slotA: number;
  slotB: number;
  xCoeffBase: number;
  yCoeffBase: number;
  outputBase: number;
  // running state during round construction
  curBase: number;
  curW: number;
  curH: number;
};

type Round = { entry: Entry; jobs: number[][]; totalPixels: number; jobOffset: number; packBuffer: GPUBufferT | null };

export class BatchedGpuBlurEngine {
  private device: GPUDeviceT | null = null;
  private layout: any = null;
  private pipelineLayout: any = null;
  private pipelines: Partial<Record<Entry, any>> = {};

  private bufInput: GPUBufferT | null = null; private bufInputBytes = 0;
  private bufCoeff: GPUBufferT | null = null; private bufCoeffBytes = 0;
  private bufJobs: GPUBufferT | null = null; private bufJobsBytes = 0;
  private bufWork: GPUBufferT | null = null; private bufWorkBytes = 0;
  private bufOut: GPUBufferT | null = null; private bufOutBytes = 0;
  private bufRead: GPUBufferT | null = null; private bufReadBytes = 0;
  private bufDummy: GPUBufferT | null = null;
  private uniforms: GPUBufferT[] = [];

  // Optional GPU-side timing via timestamp-query (feature-detected).
  private timingEnabled = false;
  private querySet: any = null;
  private tsResolve: GPUBufferT | null = null;
  private tsRead: GPUBufferT | null = null;
  lastGpuTimeMs: number | null = null;

  init(device: GPUDeviceT): void {
    this.device = device;
    const module = device.createShaderModule({ code: BLUR_BATCH_SHADER_SOURCE });
    this.layout = device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: "uniform" } },
        { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: "read-only-storage" } },
        { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: "read-only-storage" } },
        { binding: 3, visibility: GPUShaderStage.COMPUTE, buffer: { type: "read-only-storage" } },
        { binding: 4, visibility: GPUShaderStage.COMPUTE, buffer: { type: "storage" } },
        { binding: 5, visibility: GPUShaderStage.COMPUTE, buffer: { type: "storage" } },
      ],
    });
    this.pipelineLayout = device.createPipelineLayout({ bindGroupLayouts: [this.layout] });
    for (const e of PASS_ENTRIES) {
      this.pipelines[e] = device.createComputePipeline({
        layout: this.pipelineLayout,
        compute: { module, entryPoint: e },
      });
    }
    this.bufDummy = device.createBuffer({ size: 4, usage: GPUBufferUsage.STORAGE });
  }

  setTiming(enabled: boolean): void {
    const device = this.device;
    this.timingEnabled = enabled && !!device?.features?.has?.("timestamp-query");
    if (this.timingEnabled && !this.querySet) {
      this.querySet = device.createQuerySet({ type: "timestamp", count: 2 });
      this.tsResolve = device.createBuffer({ size: 16, usage: GPUBufferUsage.QUERY_RESOLVE | GPUBufferUsage.COPY_SRC });
      this.tsRead = device.createBuffer({ size: 16, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
    }
  }

  private growBuffer(cur: GPUBufferT | null, curBytes: number, needBytes: number, usage: number): { buf: GPUBufferT; bytes: number } {
    if (cur && curBytes >= needBytes) return { buf: cur, bytes: curBytes };
    cur?.destroy?.();
    const bytes = Math.max(4, needBytes);
    return { buf: this.device.createBuffer({ size: bytes, usage }), bytes };
  }

  private uniform(i: number): GPUBufferT {
    let b = this.uniforms[i];
    if (!b) {
      b = this.device.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
      this.uniforms[i] = b;
    }
    return b;
  }

  // Build the per-mask plan (bases, dims) and the round schedule (job records).
  private plan(masks: BatchMask[], packTargets: PackTarget[] | null): {
    plans: MaskPlan[];
    rounds: Round[];
    inputTotal: number;
    coeffTotal: number;
    workTotal: number;
    outputTotal: number;
    jobsFlat: Int32Array;
  } {
    const plans: MaskPlan[] = [];
    let inputCursor = 0;
    let workCursor = 0;
    let coeffCursor = 0;
    let outputCursor = 0;
    for (let i = 0; i < masks.length; i++) {
      const m = masks[i]!;
      const d = computeOutDims(m.width, m.height, m.r2x, m.r2y);
      const p: MaskPlan = {
        bx: d.bx, by: d.by,
        w0: m.width, h0: m.height, stride: m.stride ?? m.width,
        maxSize: d.maxSize, outW: d.outW, outH: d.outH, shiftX: d.shiftX, shiftY: d.shiftY,
        inputBase: inputCursor,
        slotA: workCursor, slotB: workCursor + d.maxSize,
        xCoeffBase: coeffCursor, yCoeffBase: coeffCursor + 8,
        outputBase: outputCursor,
        curBase: workCursor, curW: m.width, curH: m.height,
      };
      plans.push(p);
      inputCursor += m.width * m.height;
      workCursor += 2 * d.maxSize;
      coeffCursor += 16;
      outputCursor += d.outW * d.outH;
    }

    const rounds: Round[] = [];
    const other = (p: MaskPlan) => (p.curBase === p.slotA ? p.slotB : p.slotA);

    // Emit one round for `entry` over the given participants, applying `step`
    // to compute each job's dst dims and advancing that mask's slot/dims.
    const emit = (
      entry: Entry,
      participants: MaskPlan[],
      step: (p: MaskPlan) => { dstW: number; dstH: number; radius: number; coeffBase: number },
    ) => {
      if (participants.length === 0) return;
      const jobs: number[][] = [];
      let pixelBase = 0;
      for (let k = 0; k < participants.length; k++) {
        const p = participants[k]!;
        const s = step(p);
        const dstBase = other(p);
        const count = s.dstW * s.dstH;
        jobs.push([
          pixelBase, count,
          p.curBase, dstBase,
          p.curW, p.curH, s.dstW, s.dstH,
          s.radius, s.coeffBase, s.dstW, 0,
        ]);
        pixelBase += count;
        p.curBase = dstBase;
        p.curW = s.dstW;
        p.curH = s.dstH;
      }
      rounds.push({ entry, jobs, totalPixels: pixelBase, jobOffset: 0, packBuffer: null });
    };

    // unpack: input -> slotA (curBase stays slotA; srcBase is inputBase).
    {
      const jobs: number[][] = [];
      let pixelBase = 0;
      for (let k = 0; k < plans.length; k++) {
        const p = plans[k]!;
        const count = p.w0 * p.h0;
        jobs.push([pixelBase, count, p.inputBase, p.slotA, p.w0, p.h0, p.w0, p.h0, 0, 0, p.w0, 0]);
        pixelBase += count;
        p.curBase = p.slotA;
        p.curW = p.w0;
        p.curH = p.h0;
      }
      rounds.push({ entry: "bUnpack", jobs, totalPixels: pixelBase, jobOffset: 0, packBuffer: null });
    }

    const maxLevelY = plans.reduce((a, p) => Math.max(a, p.by.level), 0);
    const maxLevelX = plans.reduce((a, p) => Math.max(a, p.bx.level), 0);

    for (let kk = 0; kk < maxLevelY; kk++) {
      emit("bShrinkVert", plans.filter((p) => p.by.level > kk), (p) => ({ dstW: p.curW, dstH: (p.curH + 5) >> 1, radius: 0, coeffBase: 0 }));
    }
    for (let kk = 0; kk < maxLevelX; kk++) {
      emit("bShrinkHorz", plans.filter((p) => p.bx.level > kk), (p) => ({ dstW: (p.curW + 5) >> 1, dstH: p.curH, radius: 0, coeffBase: 0 }));
    }
    emit("bBlurHorz", plans, (p) => ({ dstW: p.curW + 2 * p.bx.radius, dstH: p.curH, radius: p.bx.radius, coeffBase: p.xCoeffBase }));
    emit("bBlurVert", plans, (p) => ({ dstW: p.curW, dstH: p.curH + 2 * p.by.radius, radius: p.by.radius, coeffBase: p.yCoeffBase }));
    for (let kk = 0; kk < maxLevelX; kk++) {
      emit("bExpandHorz", plans.filter((p) => p.bx.level > kk), (p) => ({ dstW: 2 * p.curW + 4, dstH: p.curH, radius: 0, coeffBase: 0 }));
    }
    for (let kk = 0; kk < maxLevelY; kk++) {
      emit("bExpandVert", plans.filter((p) => p.by.level > kk), (p) => ({ dstW: p.curW, dstH: 2 * p.curH + 4, radius: 0, coeffBase: 0 }));
    }

    // pack: group by target buffer. Linear mode = one group into bufOut.
    if (packTargets) {
      const groups = new Map<GPUBufferT, MaskPlan[]>();
      const order: GPUBufferT[] = [];
      for (let i = 0; i < plans.length; i++) {
        const t = packTargets[i]!;
        if (!groups.has(t.buffer)) { groups.set(t.buffer, []); order.push(t.buffer); }
        groups.get(t.buffer)!.push(plans[i]!);
        (plans[i] as any).__target = t;
      }
      for (const buf of order) {
        const parts = groups.get(buf)!;
        const jobs: number[][] = [];
        let pixelBase = 0;
        for (const p of parts) {
          const t = (p as any).__target as PackTarget;
          const count = p.outW * p.outH;
          jobs.push([pixelBase, count, p.curBase, t.dstBase, p.curW, p.curH, p.outW, p.outH, 0, 0, t.dstStride, 0]);
          pixelBase += count;
        }
        rounds.push({ entry: "bPack", jobs, totalPixels: pixelBase, jobOffset: 0, packBuffer: buf });
      }
    } else {
      const jobs: number[][] = [];
      let pixelBase = 0;
      for (const p of plans) {
        const count = p.outW * p.outH;
        jobs.push([pixelBase, count, p.curBase, p.outputBase, p.curW, p.curH, p.outW, p.outH, 0, 0, p.outW, 0]);
        pixelBase += count;
      }
      rounds.push({ entry: "bPack", jobs, totalPixels: pixelBase, jobOffset: 0, packBuffer: null });
    }

    // Flatten jobs and assign per-round jobOffset (in job units).
    let totalJobs = 0;
    for (const r of rounds) totalJobs += r.jobs.length;
    const jobsFlat = new Int32Array(totalJobs * JOB_FIELDS);
    let ji = 0;
    for (const r of rounds) {
      r.jobOffset = ji;
      for (const rec of r.jobs) {
        jobsFlat.set(rec, ji * JOB_FIELDS);
        ji++;
      }
    }

    return {
      plans, rounds,
      inputTotal: inputCursor,
      coeffTotal: coeffCursor,
      workTotal: workCursor,
      outputTotal: outputCursor,
      jobsFlat,
    };
  }

  private record(masks: BatchMask[], packTargets: PackTarget[] | null) {
    const device = this.device;
    const { plans, rounds, inputTotal, coeffTotal, workTotal, outputTotal, jobsFlat } = this.plan(masks, packTargets);

    // Buffers.
    const inRes = this.growBuffer(this.bufInput, this.bufInputBytes, inputTotal * 4, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST);
    this.bufInput = inRes.buf; this.bufInputBytes = inRes.bytes;
    const coRes = this.growBuffer(this.bufCoeff, this.bufCoeffBytes, coeffTotal * 4, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST);
    this.bufCoeff = coRes.buf; this.bufCoeffBytes = coRes.bytes;
    const joRes = this.growBuffer(this.bufJobs, this.bufJobsBytes, jobsFlat.byteLength, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST);
    this.bufJobs = joRes.buf; this.bufJobsBytes = joRes.bytes;
    const woRes = this.growBuffer(this.bufWork, this.bufWorkBytes, workTotal * 4, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST);
    this.bufWork = woRes.buf; this.bufWorkBytes = woRes.bytes;
    if (!packTargets) {
      const ouRes = this.growBuffer(this.bufOut, this.bufOutBytes, outputTotal * 4, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC);
      this.bufOut = ouRes.buf; this.bufOutBytes = ouRes.bytes;
    }

    // Upload input pixels (respecting per-mask stride) and coeffs.
    const inStaging = new Int32Array(inputTotal);
    for (let i = 0; i < plans.length; i++) {
      const p = plans[i]!; const m = masks[i]!;
      let di = p.inputBase;
      for (let y = 0; y < p.h0; y++) {
        const srcRow = y * p.stride;
        for (let x = 0; x < p.w0; x++) inStaging[di++] = m.bitmap[srcRow + x]!;
      }
    }
    device.queue.writeBuffer(this.bufInput, 0, inStaging.buffer, 0, inputTotal * 4);

    const coStaging = new Int32Array(coeffTotal);
    for (let i = 0; i < plans.length; i++) {
      const p = plans[i]!;
      for (let c = 0; c < 8; c++) coStaging[p.xCoeffBase + c] = p.bx.coeff[c]!;
      for (let c = 0; c < 8; c++) coStaging[p.yCoeffBase + c] = p.by.coeff[c]!;
    }
    if (coeffTotal > 0) device.queue.writeBuffer(this.bufCoeff, 0, coStaging.buffer, 0, coeffTotal * 4);
    device.queue.writeBuffer(this.bufJobs, 0, jobsFlat.buffer, 0, jobsFlat.byteLength);

    // Record rounds.
    const encoder = device.createCommandEncoder();
    const uni = new Int32Array(4);
    const useTiming = this.timingEnabled && this.querySet;
    const lastRound = rounds.length - 1;
    for (let ri = 0; ri < rounds.length; ri++) {
      const r = rounds[ri]!;
      if (r.totalPixels <= 0) continue;
      const ubo = this.uniform(ri);
      uni[0] = r.jobOffset; uni[1] = r.jobs.length; uni[2] = r.totalPixels; uni[3] = 0;
      device.queue.writeBuffer(ubo, 0, uni.buffer, 0, 16);
      const outBinding = r.entry === "bPack" && r.packBuffer ? r.packBuffer : (r.entry === "bPack" ? this.bufOut : this.bufDummy);
      const bindGroup = device.createBindGroup({
        layout: this.layout,
        entries: [
          { binding: 0, resource: { buffer: ubo } },
          { binding: 1, resource: { buffer: this.bufJobs } },
          { binding: 2, resource: { buffer: this.bufCoeff } },
          { binding: 3, resource: { buffer: this.bufInput } },
          { binding: 4, resource: { buffer: this.bufWork } },
          { binding: 5, resource: { buffer: outBinding } },
        ],
      });
      const desc: any = {};
      if (useTiming && ri === 0) desc.timestampWrites = { querySet: this.querySet, beginningOfPassWriteIndex: 0 };
      if (useTiming && ri === lastRound) {
        desc.timestampWrites = desc.timestampWrites
          ? { ...desc.timestampWrites, endOfPassWriteIndex: 1 }
          : { querySet: this.querySet, endOfPassWriteIndex: 1 };
      }
      const pass = encoder.beginComputePass(desc);
      pass.setPipeline(this.pipelines[r.entry]);
      pass.setBindGroup(0, bindGroup);
      pass.dispatchWorkgroups(Math.ceil(r.totalPixels / 64), 1, 1);
      pass.end();
    }

    if (useTiming) {
      encoder.resolveQuerySet(this.querySet, 0, 2, this.tsResolve, 0);
      encoder.copyBufferToBuffer(this.tsResolve, 0, this.tsRead, 0, 16);
    }

    return { encoder, plans, outputTotal, useTiming };
  }

  private async readTiming(useTiming: boolean): Promise<void> {
    this.lastGpuTimeMs = null;
    if (!useTiming) return;
    try {
      await this.tsRead.mapAsync(GPUMapMode.READ, 0, 16);
      const ts = new BigInt64Array(this.tsRead.getMappedRange(0, 16));
      const delta = ts[1]! - ts[0]!;
      this.lastGpuTimeMs = Number(delta) / 1e6;
      this.tsRead.unmap();
    } catch {
      this.lastGpuTimeMs = null;
    }
  }

  // Linear batched blur with readback. Byte-identical to the stage-1 engine and
  // the CPU libassGaussianBlur.
  async blurBatch(masks: BatchMask[]): Promise<BatchResult[]> {
    if (!this.device) throw new Error("BatchedGpuBlurEngine: init(device) not called");
    if (masks.length === 0) return [];
    const device = this.device;
    const { encoder, plans, outputTotal, useTiming } = this.record(masks, null);

    const rdRes = this.growBuffer(this.bufRead, this.bufReadBytes, outputTotal * 4, GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST);
    this.bufRead = rdRes.buf; this.bufReadBytes = rdRes.bytes;
    encoder.copyBufferToBuffer(this.bufOut, 0, this.bufRead, 0, outputTotal * 4);
    device.queue.submit([encoder.finish()]);

    await this.bufRead.mapAsync(GPUMapMode.READ, 0, outputTotal * 4);
    const mapped = new Int32Array(this.bufRead.getMappedRange(0, outputTotal * 4));
    const results: BatchResult[] = [];
    for (let i = 0; i < plans.length; i++) {
      const p = plans[i]!;
      const out = new Uint8Array(p.outW * p.outH);
      for (let k = 0; k < out.length; k++) out[k] = mapped[p.outputBase + k]! & 0xff;
      results.push({ buffer: out, width: p.outW, rows: p.outH, shiftX: p.shiftX, shiftY: p.shiftY });
    }
    this.bufRead.unmap();
    await this.readTiming(useTiming);
    return results;
  }

  // DEBUG ONLY: run the linear batched blur round-by-round, reading back the
  // whole `work` buffer after each round so a caller can diff it against the JS
  // emulator's per-round work state and locate the first divergent pass. Returns
  // one snapshot per non-empty round plus the final packed output. Not on the hot
  // path; used by tools/gpu-headless.
  async blurBatchDebug(masks: BatchMask[]): Promise<{
    rounds: { entry: Entry; jobOffset: number; jobCount: number; totalPixels: number; work: Int32Array }[];
    output: Int32Array;
    plans: MaskPlan[];
    workTotal: number;
  }> {
    if (!this.device) throw new Error("BatchedGpuBlurEngine: init(device) not called");
    const device = this.device;
    const { plans, rounds, inputTotal, coeffTotal, workTotal, outputTotal, jobsFlat } = this.plan(masks, null);

    const inRes = this.growBuffer(this.bufInput, this.bufInputBytes, inputTotal * 4, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST);
    this.bufInput = inRes.buf; this.bufInputBytes = inRes.bytes;
    const coRes = this.growBuffer(this.bufCoeff, this.bufCoeffBytes, Math.max(4, coeffTotal * 4), GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST);
    this.bufCoeff = coRes.buf; this.bufCoeffBytes = coRes.bytes;
    const joRes = this.growBuffer(this.bufJobs, this.bufJobsBytes, jobsFlat.byteLength, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST);
    this.bufJobs = joRes.buf; this.bufJobsBytes = joRes.bytes;
    const woRes = this.growBuffer(this.bufWork, this.bufWorkBytes, workTotal * 4, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST);
    this.bufWork = woRes.buf; this.bufWorkBytes = woRes.bytes;
    const ouRes = this.growBuffer(this.bufOut, this.bufOutBytes, outputTotal * 4, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC);
    this.bufOut = ouRes.buf; this.bufOutBytes = ouRes.bytes;

    const inStaging = new Int32Array(inputTotal);
    for (let i = 0; i < plans.length; i++) {
      const p = plans[i]!; const m = masks[i]!;
      let di = p.inputBase;
      for (let y = 0; y < p.h0; y++) { const srcRow = y * p.stride; for (let x = 0; x < p.w0; x++) inStaging[di++] = m.bitmap[srcRow + x]!; }
    }
    device.queue.writeBuffer(this.bufInput, 0, inStaging.buffer, 0, inputTotal * 4);
    const coStaging = new Int32Array(Math.max(1, coeffTotal));
    for (let i = 0; i < plans.length; i++) {
      const p = plans[i]!;
      for (let c = 0; c < 8; c++) coStaging[p.xCoeffBase + c] = p.bx.coeff[c]!;
      for (let c = 0; c < 8; c++) coStaging[p.yCoeffBase + c] = p.by.coeff[c]!;
    }
    if (coeffTotal > 0) device.queue.writeBuffer(this.bufCoeff, 0, coStaging.buffer, 0, coeffTotal * 4);
    device.queue.writeBuffer(this.bufJobs, 0, jobsFlat.buffer, 0, jobsFlat.byteLength);

    const readWork = device.createBuffer({ size: Math.max(4, workTotal * 4), usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
    const snapshots: { entry: Entry; jobOffset: number; jobCount: number; totalPixels: number; work: Int32Array }[] = [];
    const uni = new Int32Array(4);
    for (let ri = 0; ri < rounds.length; ri++) {
      const r = rounds[ri]!;
      if (r.totalPixels <= 0) continue;
      const ubo = this.uniform(ri);
      uni[0] = r.jobOffset; uni[1] = r.jobs.length; uni[2] = r.totalPixels; uni[3] = 0;
      device.queue.writeBuffer(ubo, 0, uni.buffer, 0, 16);
      const outBinding = r.entry === "bPack" ? this.bufOut : this.bufDummy;
      const bindGroup = device.createBindGroup({
        layout: this.layout,
        entries: [
          { binding: 0, resource: { buffer: ubo } },
          { binding: 1, resource: { buffer: this.bufJobs } },
          { binding: 2, resource: { buffer: this.bufCoeff } },
          { binding: 3, resource: { buffer: this.bufInput } },
          { binding: 4, resource: { buffer: this.bufWork } },
          { binding: 5, resource: { buffer: outBinding } },
        ],
      });
      const encoder = device.createCommandEncoder();
      const pass = encoder.beginComputePass();
      pass.setPipeline(this.pipelines[r.entry]);
      pass.setBindGroup(0, bindGroup);
      pass.dispatchWorkgroups(Math.ceil(r.totalPixels / 64), 1, 1);
      pass.end();
      encoder.copyBufferToBuffer(this.bufWork, 0, readWork, 0, workTotal * 4);
      device.queue.submit([encoder.finish()]);
      await readWork.mapAsync(GPUMapMode.READ, 0, workTotal * 4);
      const snap = new Int32Array(readWork.getMappedRange(0, workTotal * 4)).slice();
      readWork.unmap();
      snapshots.push({ entry: r.entry, jobOffset: r.jobOffset, jobCount: r.jobs.length, totalPixels: r.totalPixels, work: snap });
    }
    readWork.destroy?.();

    const readOut = device.createBuffer({ size: Math.max(4, outputTotal * 4), usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
    const enc2 = device.createCommandEncoder();
    enc2.copyBufferToBuffer(this.bufOut, 0, readOut, 0, outputTotal * 4);
    device.queue.submit([enc2.finish()]);
    await readOut.mapAsync(GPUMapMode.READ, 0, outputTotal * 4);
    const output = new Int32Array(readOut.getMappedRange(0, outputTotal * 4)).slice();
    readOut.unmap();
    readOut.destroy?.();

    return { rounds: snapshots, output, plans, workTotal };
  }

  // Batched blur that writes packed results straight into caller-provided atlas
  // page buffers (no readback). Used by GpuFilteredCache.
  async blurBatchToAtlas(masks: BatchMask[], targets: PackTarget[]): Promise<void> {
    if (!this.device) throw new Error("BatchedGpuBlurEngine: init(device) not called");
    if (masks.length === 0) return;
    const { encoder, useTiming } = this.record(masks, targets);
    this.device.queue.submit([encoder.finish()]);
    // No readback: results stay resident in the page buffers.
    await this.device.queue.onSubmittedWorkDone?.();
    await this.readTiming(useTiming);
  }

  // Per-layer executor (option B + per-layer subpixel shift): GPU-blur each
  // group's fill/outline once, pack to u8, copy+punch where a layer needs the
  // punched outline, then for EACH layer copy its selected source, apply the
  // horizontal/vertical subpixel shift, and emit that layer's own region into
  // `this.bufOut` as 256-aligned u8 rows (ready for copyBufferToTexture). No
  // readback. `layers` map 1:1 to the returned `regions`; a layer whose group or
  // source is unavailable yields null. Correctness of every step is proven by the
  // Bun emulators (blur pyramid, punch, 3-variant group model, shift chain).
  filterGroups(
    groups: FilterGroupInput[],
    layers: FilterLayerRequest[],
    encoder?: GPUCommandEncoder,
  ): { buffer: GPUBufferT; regions: (FilterRegion | null)[]; stats: FilterGroupRunStats } {
    if (!this.device) throw new Error("BatchedGpuBlurEngine: init(device) not called");
    const device = this.device;
    const regions: (FilterRegion | null)[] = layers.map(() => null);
    const emptyStats = { submitted: false, rounds: 0, jobs: 0, pixels: 0, outputBytes: 0, maskUploads: 0, maskPixels: 0 };
    if (groups.length === 0 || layers.length === 0) return { buffer: this.bufOut, regions, stats: emptyStats };

    const ALIGN = 256;
    const alignUp = (v: number, a: number) => Math.ceil(v / a) * a;
    const J = (...v: number[]): number[] => {
      const a = new Array(JOB_FIELDS).fill(0);
      for (let i = 0; i < v.length; i++) a[i] = v[i]!;
      return a;
    };

    // Which sources each group must produce, derived from its layers.
    const idToGi = new Map<number, number>();
    for (let gi = 0; gi < groups.length; gi++) idToGi.set(groups[gi]!.groupId, gi);
    const need = groups.map(() => ({ fill: false, raw: false, punched: false }));
    for (const l of layers) {
      const gi = idToGi.get(l.groupId);
      if (gi === undefined) continue;
      const n = need[gi]!;
      if (l.source === "fill") n.fill = true;
      else if (l.source === "outlineRaw") n.raw = true;
      else if (l.source === "outlinePunched") n.punched = true;
    }

    type Task = {
      mask: Uint8Array; stride: number; w0: number; h0: number;
      bx: BlurMethod; by: BlurMethod; maxSize: number; outW: number; outH: number;
      inputBase: number; slotA: number; slotB: number; packedBase: number;
      xCoeffBase: number; yCoeffBase: number;
      curBase: number; curW: number; curH: number;
    };
    const tasks: Task[] = [];
    let inputCursor = 0, workCursor = 0, coeffCursor = 0;
    const mkTask = (mask: Uint8Array, stride: number, w0: number, h0: number, r2x: number, r2y: number): Task => {
      const d = computeOutDims(w0, h0, r2x, r2y);
      const t: Task = {
        mask, stride, w0, h0, bx: d.bx, by: d.by, maxSize: d.maxSize, outW: d.outW, outH: d.outH,
        inputBase: inputCursor, slotA: workCursor, slotB: workCursor + d.maxSize, packedBase: workCursor + 2 * d.maxSize,
        xCoeffBase: coeffCursor, yCoeffBase: coeffCursor + 8, curBase: workCursor, curW: w0, curH: h0,
      };
      inputCursor += w0 * h0;
      workCursor += 2 * d.maxSize + d.outW * d.outH;
      coeffCursor += 16;
      tasks.push(t);
      return t;
    };

    // The fill used to PUNCH the outline is the UNBLURRED fill mask: libass
    // (ass_render.c) blurs the fill only when there is no border (or box style),
    // and punch (ass_fix_outline) only runs when a border exists — so its fill
    // input is always the sharp, unblurred mask. The blurred fill is produced
    // separately (via a blur task) only when a layer composites the "fill"
    // source, which is the no-border case where no punch happens. Both can be
    // requested; they never overlap for a real event but are handled independently.
    type GroupPlan = { fillTask: Task | null; outlineTask: Task | null; punchBase: number | null; unblurredFillBase: number | null };
    const fillPreloads: { base: number; mask: Uint8Array; w: number; h: number; stride: number }[] = [];
    const gplans: GroupPlan[] = [];
    for (let gi = 0; gi < groups.length; gi++) {
      const g = groups[gi]!; const n = need[gi]!;
      const fillTask = n.fill
        ? mkTask(g.fillMask, g.fillStride, g.fillW, g.fillH, g.r2x, g.r2y)
        : null;
      const outlineTask = (g.outlineMask && (n.raw || n.punched))
        ? mkTask(g.outlineMask, g.outlineStride!, g.outlineW!, g.outlineH!, g.r2x, g.r2y)
        : null;
      let punchBase: number | null = null;
      let unblurredFillBase: number | null = null;
      if (n.punched && outlineTask) {
        punchBase = workCursor;
        workCursor += outlineTask.outW * outlineTask.outH;
        unblurredFillBase = workCursor;
        workCursor += g.fillW * g.fillH;
        fillPreloads.push({ base: unblurredFillBase, mask: g.fillMask, w: g.fillW, h: g.fillH, stride: g.fillStride });
      }
      gplans.push({ fillTask, outlineTask, punchBase, unblurredFillBase });
    }

    const clipUploads: { base: number; mask: Uint8Array; w: number; h: number; stride: number }[] = [];
    const clipSlotsByBuffer = new WeakMap<object, Map<string, { base: number; w: number; h: number; stride: number }>>();
    const clipSlotFor = (mask: Uint8Array, w: number, h: number, stride: number): { base: number; w: number; h: number; stride: number } => {
      const owner = mask.buffer as object;
      let slots = clipSlotsByBuffer.get(owner);
      if (!slots) {
        slots = new Map();
        clipSlotsByBuffer.set(owner, slots);
      }
      const key = `${mask.byteOffset}|${w}|${h}|${stride}`;
      let slot = slots.get(key);
      if (!slot) {
        slot = { base: inputCursor, w, h, stride };
        inputCursor += w * h;
        slots.set(key, slot);
        clipUploads.push({ base: slot.base, mask, w, h, stride });
      }
      return slot;
    };

    // Resolve each layer's source slot + dims, and reserve two shift scratch
    // slots per layer (ping-pong for the H/V passes).
    type LayerPlan = {
      srcBase: number;
      sw: number;
      sh: number;
      sx: number;
      sy: number;
      shiftA: number;
      shiftB: number;
      curBase: number;
      clipInputBase: number;
      clipW: number;
      clipH: number;
      clipOriginX: number;
      clipOriginY: number;
      clipInverse: boolean;
      layerOriginX: number;
      layerOriginY: number;
    } | null;
    const lplans: LayerPlan[] = layers.map(() => null);
    for (let li = 0; li < layers.length; li++) {
      const l = layers[li]!;
      const gi = idToGi.get(l.groupId);
      if (gi === undefined) continue;
      const gp = gplans[gi]!;
      let srcBase: number | null = null, sw = 0, sh = 0;
      if (l.source === "fill" && gp.fillTask) { srcBase = gp.fillTask.packedBase; sw = gp.fillTask.outW; sh = gp.fillTask.outH; }
      else if (l.source === "outlineRaw" && gp.outlineTask) { srcBase = gp.outlineTask.packedBase; sw = gp.outlineTask.outW; sh = gp.outlineTask.outH; }
      else if (l.source === "outlinePunched" && gp.punchBase != null && gp.outlineTask) { srcBase = gp.punchBase; sw = gp.outlineTask.outW; sh = gp.outlineTask.outH; }
      if (srcBase == null) continue;
      const sx = l.sx & 63;
      const sy = l.sy & 63;
      let shiftA = -1;
      let shiftB = -1;
      if (sx || sy) {
        shiftA = workCursor;
        workCursor += sw * sh;
        if (sx && sy) {
          shiftB = workCursor;
          workCursor += sw * sh;
        }
      }
      let clipInputBase = -1;
      let clipW = 0;
      let clipH = 0;
      let clipOriginX = 0;
      let clipOriginY = 0;
      let clipInverse = false;
      if (l.clipMask && l.clipW && l.clipH) {
        clipW = l.clipW;
        clipH = l.clipH;
        const clipStride = l.clipStride ?? clipW;
        const slot = clipSlotFor(l.clipMask, clipW, clipH, clipStride);
        clipInputBase = slot.base;
        clipOriginX = l.clipOriginX ?? 0;
        clipOriginY = l.clipOriginY ?? 0;
        clipInverse = !!l.clipInverse;
      }
      lplans[li] = {
        srcBase,
        sw,
        sh,
        sx,
        sy,
        shiftA,
        shiftB,
        curBase: srcBase,
        clipInputBase,
        clipW,
        clipH,
        clipOriginX,
        clipOriginY,
        clipInverse,
        layerOriginX: l.layerOriginX ?? 0,
        layerOriginY: l.layerOriginY ?? 0,
      };
    }

    const rounds: { entry: Entry; jobs: number[][] }[] = [];
    const other = (t: Task) => (t.curBase === t.slotA ? t.slotB : t.slotA);
    const blurEmit = (entry: Entry, parts: Task[], step: (t: Task) => { dstW: number; dstH: number; radius: number; coeffBase: number }) => {
      if (parts.length === 0) return;
      const jobs: number[][] = [];
      let pb = 0;
      for (const t of parts) {
        const s = step(t); const dstBase = other(t); const cnt = s.dstW * s.dstH;
        jobs.push(J(pb, cnt, t.curBase, dstBase, t.curW, t.curH, s.dstW, s.dstH, s.radius, s.coeffBase, s.dstW));
        pb += cnt; t.curBase = dstBase; t.curW = s.dstW; t.curH = s.dstH;
      }
      rounds.push({ entry, jobs });
    };

    // unpack
    {
      const jobs: number[][] = []; let pb = 0;
      for (const t of tasks) { const cnt = t.w0 * t.h0; jobs.push(J(pb, cnt, t.inputBase, t.slotA, t.w0, t.h0, t.w0, t.h0, 0, 0, t.w0)); pb += cnt; t.curBase = t.slotA; t.curW = t.w0; t.curH = t.h0; }
      rounds.push({ entry: "bUnpack", jobs });
    }
    const maxLY = tasks.reduce((a, t) => Math.max(a, t.by.level), 0);
    const maxLX = tasks.reduce((a, t) => Math.max(a, t.bx.level), 0);
    for (let k = 0; k < maxLY; k++) blurEmit("bShrinkVert", tasks.filter((t) => t.by.level > k), (t) => ({ dstW: t.curW, dstH: (t.curH + 5) >> 1, radius: 0, coeffBase: 0 }));
    for (let k = 0; k < maxLX; k++) blurEmit("bShrinkHorz", tasks.filter((t) => t.bx.level > k), (t) => ({ dstW: (t.curW + 5) >> 1, dstH: t.curH, radius: 0, coeffBase: 0 }));
    blurEmit("bBlurHorz", tasks, (t) => ({ dstW: t.curW + 2 * t.bx.radius, dstH: t.curH, radius: t.bx.radius, coeffBase: t.xCoeffBase }));
    blurEmit("bBlurVert", tasks, (t) => ({ dstW: t.curW, dstH: t.curH + 2 * t.by.radius, radius: t.by.radius, coeffBase: t.yCoeffBase }));
    for (let k = 0; k < maxLX; k++) blurEmit("bExpandHorz", tasks.filter((t) => t.bx.level > k), (t) => ({ dstW: 2 * t.curW + 4, dstH: t.curH, radius: 0, coeffBase: 0 }));
    for (let k = 0; k < maxLY; k++) blurEmit("bExpandVert", tasks.filter((t) => t.by.level > k), (t) => ({ dstW: t.curW, dstH: 2 * t.curH + 4, radius: 0, coeffBase: 0 }));
    // pack each task's final blur slot into its packed u8 slot (crop to outW/outH)
    {
      const jobs: number[][] = []; let pb = 0;
      for (const t of tasks) { const cnt = t.outW * t.outH; jobs.push(J(pb, cnt, t.curBase, t.packedBase, t.curW, t.curH, t.outW, t.outH, 0, 0, t.outW)); pb += cnt; }
      rounds.push({ entry: "bPackToWork", jobs });
    }
    // copy outlineRaw -> punch slot, then punch it with the fill
    {
      const jobs: number[][] = []; let pb = 0;
      for (const gp of gplans) { if (gp.punchBase == null || !gp.outlineTask) continue; const ot = gp.outlineTask; const cnt = ot.outW * ot.outH; jobs.push(J(pb, cnt, ot.packedBase, gp.punchBase, ot.outW, ot.outH, ot.outW, ot.outH, 0, 0, ot.outW)); pb += cnt; }
      if (jobs.length) rounds.push({ entry: "bCopy", jobs });
    }
    {
      const jobs: number[][] = []; let pb = 0;
      for (let gi = 0; gi < groups.length; gi++) {
        const gp = gplans[gi]!; const g = groups[gi]!;
        if (gp.punchBase == null || !gp.outlineTask || gp.unblurredFillBase == null) continue;
        const ot = gp.outlineTask; const cnt = ot.outW * ot.outH;
        jobs.push(J(pb, cnt, 0, gp.punchBase, ot.outW, ot.outH, ot.outW, ot.outH, 0, 0, ot.outW, gp.unblurredFillBase, g.fillW, g.fillH, g.punchOX ?? 0, g.punchOY ?? 0, g.punchFX ?? 0, g.punchFY ?? 0));
        pb += cnt;
      }
      if (jobs.length) rounds.push({ entry: "bPunch", jobs });
    }
    // Per-layer subpixel shift. Zero-shift layers emit directly from the shared
    // filtered source. One-axis shifts need one scratch slot; two-axis shifts
    // ping-pong through two slots. This is byte-identical to the old copy-first
    // path because the shift kernels read from an immutable source slot and
    // write to a distinct destination slot.
    {
      const jobs: number[][] = []; let pb = 0;
      for (const lp of lplans) { if (!lp || !lp.sx) continue; const dst = lp.shiftA; const cnt = lp.sw * lp.sh; jobs.push(J(pb, cnt, lp.curBase, dst, lp.sw, lp.sh, lp.sw, lp.sh, lp.sx, 0, lp.sw)); pb += cnt; lp.curBase = dst; }
      if (jobs.length) rounds.push({ entry: "bShiftH", jobs });
    }
    {
      const jobs: number[][] = []; let pb = 0;
      for (const lp of lplans) { if (!lp || !lp.sy) continue; const dst = lp.sx ? lp.shiftB : lp.shiftA; const cnt = lp.sw * lp.sh; jobs.push(J(pb, cnt, lp.curBase, dst, lp.sw, lp.sh, lp.sw, lp.sh, lp.sy, 0, lp.sw)); pb += cnt; lp.curBase = dst; }
      if (jobs.length) rounds.push({ entry: "bShiftV", jobs });
    }
    // emit each layer's shifted result into the output buffer (256-aligned rows).
    // Masked layers use a separate batched pass that folds applyClip's integer
    // multiply into the pack, avoiding the reverted extra full-size mask pass.
    let outByteCursor = 0;
    {
      const jobs: number[][] = []; let pb = 0;
      const maskedJobs: number[][] = []; let mpb = 0;
      for (let li = 0; li < lplans.length; li++) {
        const lp = lplans[li]; if (!lp) continue;
        const w = lp.sw, h = lp.sh;
        const bytesPerRow = alignUp(w, ALIGN);
        const byteOffset = alignUp(outByteCursor, ALIGN);
        outByteCursor = byteOffset + bytesPerRow * h;
        regions[li] = { byteOffset, bytesPerRow, w, h };
        const dstW = Math.ceil(w / 4); const cnt = dstW * h;
        if (lp.clipInputBase >= 0) {
          maskedJobs.push(J(
            mpb,
            cnt,
            lp.curBase,
            byteOffset / 4,
            w,
            h,
            dstW,
            h,
            lp.clipInverse ? 1 : 0,
            0,
            bytesPerRow / 4,
            lp.clipInputBase,
            lp.clipW,
            lp.clipH,
            lp.layerOriginX,
            lp.layerOriginY,
            lp.clipOriginX,
            lp.clipOriginY,
          ));
          mpb += cnt;
        } else {
          jobs.push(J(pb, cnt, lp.curBase, byteOffset / 4, w, h, dstW, h, 0, 0, bytesPerRow / 4));
          pb += cnt;
        }
      }
      if (jobs.length) rounds.push({ entry: "bEmitU8", jobs });
      if (maskedJobs.length) rounds.push({ entry: "bEmitMaskedU8", jobs: maskedJobs });
    }

    // Allocate + upload.
    const inRes = this.growBuffer(this.bufInput, this.bufInputBytes, Math.max(4, inputCursor * 4), GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST);
    this.bufInput = inRes.buf; this.bufInputBytes = inRes.bytes;
    const coRes = this.growBuffer(this.bufCoeff, this.bufCoeffBytes, Math.max(4, coeffCursor * 4), GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST);
    this.bufCoeff = coRes.buf; this.bufCoeffBytes = coRes.bytes;
    const woRes = this.growBuffer(this.bufWork, this.bufWorkBytes, Math.max(4, workCursor * 4), GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST);
    this.bufWork = woRes.buf; this.bufWorkBytes = woRes.bytes;
    const ouRes = this.growBuffer(this.bufOut, this.bufOutBytes, Math.max(4, alignUp(outByteCursor, ALIGN)), GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC);
    this.bufOut = ouRes.buf; this.bufOutBytes = ouRes.bytes;

    let totalJobs = 0; for (const r of rounds) totalJobs += r.jobs.length;
    const jobsFlat = new Int32Array(Math.max(JOB_FIELDS, totalJobs * JOB_FIELDS));
    const roundMeta: { entry: Entry; jobOffset: number; jobCount: number; totalPixels: number }[] = [];
    let ji = 0;
    let totalPixels = 0;
    for (const r of rounds) {
      const jobOffset = ji; let tp = 0;
      for (const rec of r.jobs) { jobsFlat.set(rec, ji * JOB_FIELDS); tp += rec[1]!; ji++; }
      roundMeta.push({ entry: r.entry, jobOffset, jobCount: r.jobs.length, totalPixels: tp });
      totalPixels += tp;
    }
    const joRes = this.growBuffer(this.bufJobs, this.bufJobsBytes, Math.max(4, jobsFlat.byteLength), GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST);
    this.bufJobs = joRes.buf; this.bufJobsBytes = joRes.bytes;

    const inStaging = new Int32Array(Math.max(1, inputCursor));
    for (const t of tasks) { let di = t.inputBase; for (let y = 0; y < t.h0; y++) { const srcRow = y * t.stride; for (let x = 0; x < t.w0; x++) inStaging[di++] = t.mask[srcRow + x]!; } }
    for (const c of clipUploads) { let di = c.base; for (let y = 0; y < c.h; y++) { const srcRow = y * c.stride; for (let x = 0; x < c.w; x++) inStaging[di++] = c.mask[srcRow + x]!; } }
    if (inputCursor > 0) device.queue.writeBuffer(this.bufInput, 0, inStaging.buffer, 0, inputCursor * 4);
    const coStaging = new Int32Array(Math.max(1, coeffCursor));
    for (const t of tasks) { for (let c = 0; c < 8; c++) coStaging[t.xCoeffBase + c] = t.bx.coeff[c]!; for (let c = 0; c < 8; c++) coStaging[t.yCoeffBase + c] = t.by.coeff[c]!; }
    if (coeffCursor > 0) device.queue.writeBuffer(this.bufCoeff, 0, coStaging.buffer, 0, coeffCursor * 4);
    device.queue.writeBuffer(this.bufJobs, 0, jobsFlat.buffer, 0, jobsFlat.byteLength);

    // Preload the UNBLURRED fill masks straight into their work slots (contiguous
    // u8 domain, stride = fillW). No compute pass writes these slots, and
    // writeBuffer is queue-ordered before the submit below, so bPunch sees them.
    for (const fp of fillPreloads) {
      const staging = new Int32Array(fp.w * fp.h);
      let di = 0;
      for (let y = 0; y < fp.h; y++) { const srcRow = y * fp.stride; for (let x = 0; x < fp.w; x++) staging[di++] = fp.mask[srcRow + x]!; }
      device.queue.writeBuffer(this.bufWork, fp.base * 4, staging.buffer, 0, fp.w * fp.h * 4);
    }
    const ownEncoder = encoder ?? device.createCommandEncoder();
    const uni = new Int32Array(4);
    for (let ri = 0; ri < roundMeta.length; ri++) {
      const r = roundMeta[ri]!;
      if (r.totalPixels <= 0) continue;
      const ubo = this.uniform(ri);
      uni[0] = r.jobOffset; uni[1] = r.jobCount; uni[2] = r.totalPixels; uni[3] = 0;
      device.queue.writeBuffer(ubo, 0, uni.buffer, 0, 16);
      const outBinding = (r.entry === "bEmitU8" || r.entry === "bEmitMaskedU8") ? this.bufOut : this.bufDummy;
      const bindGroup = device.createBindGroup({
        layout: this.layout,
        entries: [
          { binding: 0, resource: { buffer: ubo } },
          { binding: 1, resource: { buffer: this.bufJobs } },
          { binding: 2, resource: { buffer: this.bufCoeff } },
          { binding: 3, resource: { buffer: this.bufInput } },
          { binding: 4, resource: { buffer: this.bufWork } },
          { binding: 5, resource: { buffer: outBinding } },
        ],
      });
      const pass = ownEncoder.beginComputePass();
      pass.setPipeline(this.pipelines[r.entry]);
      pass.setBindGroup(0, bindGroup);
      pass.dispatchWorkgroups(Math.ceil(r.totalPixels / 64), 1, 1);
      pass.end();
    }
    if (!encoder) device.queue.submit([ownEncoder.finish()]);
    return {
      buffer: this.bufOut,
      regions,
      stats: {
        submitted: !encoder,
        rounds: roundMeta.length,
        jobs: totalJobs,
        pixels: totalPixels,
        outputBytes: outByteCursor,
        maskUploads: clipUploads.length,
        maskPixels: clipUploads.reduce((sum, c) => sum + c.w * c.h, 0),
      },
    };
  }

  dispose(): void {
    for (const b of [this.bufInput, this.bufCoeff, this.bufJobs, this.bufWork, this.bufOut, this.bufRead, this.bufDummy, this.tsResolve, this.tsRead]) b?.destroy?.();
    for (const u of this.uniforms) u?.destroy?.();
    this.querySet?.destroy?.();
    this.uniforms = [];
    this.bufInput = this.bufCoeff = this.bufJobs = this.bufWork = this.bufOut = this.bufRead = null;
  }
}

// ---------------------------------------------------------------------------
// GPU-resident, content-keyed filtered-bitmap cache.
// ---------------------------------------------------------------------------

export type FilterRequest = {
  bitmap: Uint8Array;
  width: number;
  height: number;
  r2x: number;
  r2y: number;
  stride?: number;
  key?: string; // content key; computed from bytes+r2 when omitted
};

export type FilterHandle = {
  pageIndex: number;
  x: number;
  y: number;
  outW: number;
  outH: number;
  shiftX: number;
  shiftY: number;
  hit: boolean;
};

type CacheEntry = { slot: AtlasSlot; gen: number; outW: number; outH: number; shiftX: number; shiftY: number };

export class GpuFilteredCache {
  private device: GPUDeviceT;
  private engine: BatchedGpuBlurEngine;
  private allocator: AtlasAllocator;
  private pageBuffers: GPUBufferT[] = [];
  private map = new Map<string, CacheEntry>();
  hits = 0;
  misses = 0;

  constructor(device: GPUDeviceT, engine: BatchedGpuBlurEngine, opts?: { pageSize?: number; padding?: number }) {
    this.device = device;
    this.engine = engine;
    this.allocator = new AtlasAllocator({ pageSize: Math.max(256, opts?.pageSize ?? 1024), padding: opts?.padding ?? 1 });
  }

  get pageCount(): number { return this.allocator.pageCount; }

  private ensurePageBuffers(): void {
    for (let i = this.pageBuffers.length; i < this.allocator.pages.length; i++) {
      const pg = this.allocator.pages[i]!;
      this.pageBuffers.push(this.device.createBuffer({
        size: pg.width * pg.height * 4,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST,
      }));
    }
  }

  // Resolve a batch of requests: cached content is returned as a hit (no
  // filtering); misses are filtered in one batched dispatch into atlas pages.
  async request(reqs: FilterRequest[], frame: number): Promise<FilterHandle[]> {
    const handles: FilterHandle[] = new Array(reqs.length);
    const missMasks: BatchMask[] = [];
    const missTargets: PackTarget[] = [];
    const missIdx: number[] = [];
    const missKeys: string[] = [];

    for (let i = 0; i < reqs.length; i++) {
      const r = reqs[i]!;
      const key = r.key ?? hashMask(r.bitmap, r.r2x, r.r2y);
      const cached = this.map.get(key);
      if (cached && !cached.slot.free && cached.slot.gen === cached.gen) {
        this.allocator.touch(cached.slot, frame);
        this.hits++;
        handles[i] = { pageIndex: cached.slot.pageIndex, x: cached.slot.x, y: cached.slot.y, outW: cached.outW, outH: cached.outH, shiftX: cached.shiftX, shiftY: cached.shiftY, hit: true };
        continue;
      }
      this.misses++;
      const d = computeOutDims(r.width, r.height, r.r2x, r.r2y);
      const slot = this.allocator.allocate(d.outW, d.outH, frame);
      this.ensurePageBuffers();
      const pageBuf = this.pageBuffers[slot.pageIndex]!;
      const pageW = this.allocator.pages[slot.pageIndex]!.width;
      missMasks.push({ bitmap: r.bitmap, width: r.width, height: r.height, r2x: r.r2x, r2y: r.r2y, stride: r.stride });
      missTargets.push({ buffer: pageBuf, dstBase: slot.y * pageW + slot.x, dstStride: pageW });
      missIdx.push(i);
      missKeys.push(key);
      this.map.set(key, { slot, gen: slot.gen, outW: d.outW, outH: d.outH, shiftX: d.shiftX, shiftY: d.shiftY });
      handles[i] = { pageIndex: slot.pageIndex, x: slot.x, y: slot.y, outW: d.outW, outH: d.outH, shiftX: d.shiftX, shiftY: d.shiftY, hit: false };
    }

    if (missMasks.length > 0) {
      await this.engine.blurBatchToAtlas(missMasks, missTargets);
    }
    return handles;
  }

  // Read a slot's packed bytes back (self-test/verification only).
  async readSlot(pageIndex: number, x: number, y: number, w: number, h: number): Promise<Uint8Array> {
    const pageBuf = this.pageBuffers[pageIndex]!;
    const pageW = this.allocator.pages[pageIndex]!.width;
    const pageH = this.allocator.pages[pageIndex]!.height;
    const bytes = pageW * pageH * 4;
    const read = this.device.createBuffer({ size: bytes, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
    const enc = this.device.createCommandEncoder();
    enc.copyBufferToBuffer(pageBuf, 0, read, 0, bytes);
    this.device.queue.submit([enc.finish()]);
    await read.mapAsync(GPUMapMode.READ, 0, bytes);
    const mapped = new Int32Array(read.getMappedRange(0, bytes));
    const out = new Uint8Array(w * h);
    for (let yy = 0; yy < h; yy++) {
      for (let xx = 0; xx < w; xx++) {
        out[yy * w + xx] = mapped[(y + yy) * pageW + (x + xx)]! & 0xff;
      }
    }
    read.unmap();
    read.destroy?.();
    return out;
  }

  dispose(): void {
    for (const b of this.pageBuffers) b?.destroy?.();
    this.pageBuffers = [];
    this.map.clear();
  }
}
