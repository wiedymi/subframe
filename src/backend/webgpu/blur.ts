// GPU-resident libass gaussian blur (stage 1: validation / offline path).
//
// This mirrors libassGaussianBlur() from src/core/libass_blur.ts, but runs the
// unpack -> shrink -> blur -> expand -> pack pipeline as WGSL compute passes.
// A readback (mapAsync) is used to return the result: acceptable HERE because
// this is a self-test/validation path, not the frame loop.
//
// The coefficient/level/radius search (findBestMethod) is done on the CPU
// exactly as in core, then handed to the shaders as uniforms. Because
// src/core/** must stay untouched, that math is duplicated below rather than
// imported.

import { BLUR_SHADER_SOURCE } from "./blur-shaders";

// GPU types are ambient globals in the browser; @webgpu/types is not installed,
// so we use the same bare-name approach as ./index.ts.
type GPUDeviceT = any;
type GPUBufferT = any;
type GPUComputePipelineT = any;
type GPUBindGroupLayoutT = any;
type GPUPipelineLayoutT = any;
type GPUShaderModuleT = any;

export type BlurMethod = {
  level: number;
  radius: number;
  coeff: Int16Array;
};

export type GpuBlurResult = {
  buffer: Uint8Array;
  width: number;
  rows: number;
  shiftX: number;
  shiftY: number;
};

// ---------------------------------------------------------------------------
// CPU method-finding math (ported verbatim from src/core/libass_blur.ts).
// ---------------------------------------------------------------------------

const blurMethodCache = new Map<number, BlurMethod>();

function calcGauss(res: Float64Array, n: number, r2: number): void {
  const alpha = 0.5 / r2;
  let mul = Math.exp(-alpha);
  const mul2 = mul * mul;
  let cur = Math.sqrt(alpha / Math.PI);
  res[0] = cur;
  cur *= mul;
  res[1] = cur;
  for (let i = 2; i < n; i++) {
    mul *= mul2;
    cur *= mul;
    res[i] = cur;
  }
}

function coeffFilter(coeff: Float64Array, n: number, kernel: number[]): void {
  let prev1 = coeff[1] ?? 0;
  let prev2 = coeff[2] ?? 0;
  let prev3 = coeff[3] ?? 0;
  for (let i = 0; i < n; i++) {
    const res =
      (coeff[i] ?? 0) * kernel[0]! +
      (prev1 + (coeff[i + 1] ?? 0)) * kernel[1]! +
      (prev2 + (coeff[i + 2] ?? 0)) * kernel[2]! +
      (prev3 + (coeff[i + 3] ?? 0)) * kernel[3]!;
    prev3 = prev2;
    prev2 = prev1;
    prev1 = coeff[i] ?? 0;
    coeff[i] = res;
  }
}

function calcMatrix(mat: Array<Float64Array>, matFreq: Float64Array, n: number): void {
  for (let i = 0; i < n; i++) {
    mat[i]![i] = (matFreq[2 * i + 2] ?? 0) + 3 * (matFreq[0] ?? 0) - 4 * (matFreq[i + 1] ?? 0);
    for (let j = i + 1; j < n; j++) {
      mat[i]![j] =
        (matFreq[i + j + 2] ?? 0) +
        (matFreq[j - i] ?? 0) +
        2 * ((matFreq[0] ?? 0) - (matFreq[i + 1] ?? 0) - (matFreq[j + 1] ?? 0));
      mat[j]![i] = mat[i]![j]!;
    }
  }
  for (let k = 0; k < n; k++) {
    const z = 1 / mat[k]![k]!;
    mat[k]![k] = 1;
    for (let i = 0; i < n; i++) {
      if (i === k) continue;
      const mul = mat[i]![k]! * z;
      mat[i]![k] = 0;
      for (let j = 0; j < n; j++) {
        mat[i]![j]! -= mat[k]![j]! * mul;
      }
    }
    for (let j = 0; j < n; j++) {
      mat[k]![j]! *= z;
    }
  }
}

function calcCoeff(mu: Float64Array, n: number, r2: number, mul: number): void {
  const w = 12096;
  const kernel = [
    ((((+3280 / w) * mul + 1092 / w) * mul + 2520 / w) * mul + 5204 / w),
    ((((-2460 / w) * mul - 273 / w) * mul - 210 / w) * mul + 2943 / w),
    ((((+984 / w) * mul - 546 / w) * mul - 924 / w) * mul + 486 / w),
    ((((-164 / w) * mul + 273 / w) * mul - 126 / w) * mul + 17 / w),
  ];
  const matFreq = new Float64Array(17);
  matFreq[0] = kernel[0]!;
  matFreq[1] = kernel[1]!;
  matFreq[2] = kernel[2]!;
  matFreq[3] = kernel[3]!;
  coeffFilter(matFreq, 7, kernel);

  const vecFreq = new Float64Array(12);
  calcGauss(vecFreq, n + 4, r2 * mul);
  coeffFilter(vecFreq, n + 1, kernel);

  const mat = new Array<Float64Array>(8);
  for (let i = 0; i < 8; i++) mat[i] = new Float64Array(8);
  calcMatrix(mat, matFreq, n);

  const vec = new Float64Array(8);
  for (let i = 0; i < n; i++) {
    vec[i] = (matFreq[0] ?? 0) - (matFreq[i + 1] ?? 0) - (vecFreq[0] ?? 0) + (vecFreq[i + 1] ?? 0);
  }
  for (let i = 0; i < n; i++) {
    let res = 0;
    for (let j = 0; j < n; j++) {
      res += mat[i]![j]! * vec[j]!;
    }
    mu[i] = Math.max(0, res);
  }
}

export function findBestMethod(r2: number): BlurMethod {
  const cached = blurMethodCache.get(r2);
  if (cached) return cached;
  const mu = new Float64Array(8);
  let level = 0;
  let radius = 4;

  if (r2 < 0.5) {
    level = 0;
    radius = 4;
    mu[1] = 0.085 * r2 * r2 * r2;
    mu[0] = 0.5 * r2 - 4 * mu[1]!;
    mu[2] = 0;
    mu[3] = 0;
  } else {
    const sqrtVal = Math.sqrt(0.11569 * r2 + 0.20591047);
    level = Math.floor(Math.log2(sqrtVal)) + 1;
    const frac = sqrtVal / 2 ** (level - 1) - 1;
    const mul = 0.25 ** level;
    radius = 8 - Math.floor((10.1525 + 0.8335 * mul) * (1 - frac));
    if (radius < 4) radius = 4;
    calcCoeff(mu, radius, r2, mul);
  }

  const coeff = new Int16Array(8);
  for (let i = 0; i < radius; i++) {
    coeff[i] = (0x10000 * mu[i]! + 0.5) | 0;
  }

  const method = { level, radius, coeff };
  blurMethodCache.set(r2, method);
  return method;
}

// ---------------------------------------------------------------------------
// GPU engine
// ---------------------------------------------------------------------------

const PASS_NAMES = [
  "unpack",
  "shrinkVert",
  "shrinkHorz",
  "blurHorz",
  "blurVert",
  "expandHorz",
  "expandVert",
  "pack",
] as const;
type PassName = (typeof PASS_NAMES)[number];

const PARAMS_BYTES = 64; // 8 i32 + 8 i32 coeff

type PassSpec = {
  name: PassName;
  srcW: number;
  srcH: number;
  dstW: number;
  dstH: number;
  radius: number;
  coeff: Int16Array | null;
  src: GPUBufferT;
  dst: GPUBufferT;
};

export class GpuBlurEngine {
  private device: GPUDeviceT | null = null;
  private module: GPUShaderModuleT | null = null;
  private layout: GPUBindGroupLayoutT | null = null;
  private pipelineLayout: GPUPipelineLayoutT | null = null;
  private pipelines: Partial<Record<PassName, GPUComputePipelineT>> = {};

  private bufInput: GPUBufferT | null = null;
  private bufInputSize = 0;
  private bufA: GPUBufferT | null = null;
  private bufB: GPUBufferT | null = null;
  private bufWork = 0;
  private bufOut: GPUBufferT | null = null;
  private bufOutSize = 0;
  private bufRead: GPUBufferT | null = null;
  private bufReadSize = 0;

  private uniforms: GPUBufferT[] = [];
  private inputStaging = new Int32Array(0);

  init(device: GPUDeviceT): void {
    this.device = device;
    this.module = device.createShaderModule({ code: BLUR_SHADER_SOURCE });
    this.layout = device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: "uniform" } },
        { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: "read-only-storage" } },
        { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: "storage" } },
      ],
    });
    this.pipelineLayout = device.createPipelineLayout({ bindGroupLayouts: [this.layout] });
    for (const name of PASS_NAMES) {
      this.pipelines[name] = device.createComputePipeline({
        layout: this.pipelineLayout,
        compute: { module: this.module, entryPoint: name },
      });
    }
  }

  private ensureStorage(size: number): void {
    const device = this.device;
    const bytes = Math.max(4, size * 4);
    if (this.bufWork >= bytes && this.bufA && this.bufB) return;
    this.bufA?.destroy?.();
    this.bufB?.destroy?.();
    const usage = GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST;
    this.bufA = device.createBuffer({ size: bytes, usage });
    this.bufB = device.createBuffer({ size: bytes, usage });
    this.bufWork = bytes;
  }

  private ensureInput(pixels: number): Int32Array {
    const device = this.device;
    const bytes = Math.max(4, pixels * 4);
    if (this.bufInputSize < bytes || !this.bufInput) {
      this.bufInput?.destroy?.();
      this.bufInput = device.createBuffer({
        size: bytes,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
      });
      this.bufInputSize = bytes;
    }
    if (this.inputStaging.length < pixels) {
      this.inputStaging = new Int32Array(pixels);
    }
    return this.inputStaging;
  }

  private ensureOutput(pixels: number): void {
    const device = this.device;
    const bytes = Math.max(4, pixels * 4);
    if (this.bufOutSize < bytes || !this.bufOut) {
      this.bufOut?.destroy?.();
      this.bufOut = device.createBuffer({
        size: bytes,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
      });
      this.bufOutSize = bytes;
    }
    if (this.bufReadSize < bytes || !this.bufRead) {
      this.bufRead?.destroy?.();
      this.bufRead = device.createBuffer({
        size: bytes,
        usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
      });
      this.bufReadSize = bytes;
    }
  }

  private uniformBuffer(index: number): GPUBufferT {
    const device = this.device;
    let buf = this.uniforms[index];
    if (!buf) {
      buf = device.createBuffer({
        size: PARAMS_BYTES,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      });
      this.uniforms[index] = buf;
    }
    return buf;
  }

  async blur(
    bitmap: Uint8Array,
    width: number,
    height: number,
    r2x: number,
    r2y: number,
    stride: number = width,
  ): Promise<GpuBlurResult> {
    if (!this.device) throw new Error("GpuBlurEngine: init(device) not called");
    const device = this.device;

    const blurX = findBestMethod(r2x);
    const blurY = r2y === r2x ? blurX : findBestMethod(r2y);

    // Output dimensions exactly like libassGaussianBlur().
    const w0 = width;
    const h0 = height;
    const offsetX = ((2 * blurX.radius + 9) << blurX.level) - 5;
    const offsetY = ((2 * blurY.radius + 9) << blurY.level) - 5;
    const endW = ((w0 + offsetX) & ~((1 << blurX.level) - 1)) - 4;
    const endH = ((h0 + offsetY) & ~((1 << blurY.level) - 1)) - 4;

    // Phase 1: plan the passes as dims only (no buffers yet), tracking the peak
    // intermediate size and the final running dimensions.
    type Plan = {
      name: PassName;
      srcW: number; srcH: number; dstW: number; dstH: number;
      radius: number; coeff: Int16Array | null;
    };
    const plan: Plan[] = [];
    let w = w0;
    let h = h0;
    let maxSize = w0 * h0;

    plan.push({ name: "unpack", srcW: w0, srcH: h0, dstW: w0, dstH: h0, radius: 0, coeff: null });
    for (let i = 0; i < blurY.level; i++) {
      const dstH = (h + 5) >> 1;
      plan.push({ name: "shrinkVert", srcW: w, srcH: h, dstW: w, dstH, radius: 0, coeff: null });
      h = dstH;
      maxSize = Math.max(maxSize, w * h);
    }
    for (let i = 0; i < blurX.level; i++) {
      const dstW = (w + 5) >> 1;
      plan.push({ name: "shrinkHorz", srcW: w, srcH: h, dstW, dstH: h, radius: 0, coeff: null });
      w = dstW;
      maxSize = Math.max(maxSize, w * h);
    }
    {
      const dstW = w + 2 * blurX.radius;
      plan.push({ name: "blurHorz", srcW: w, srcH: h, dstW, dstH: h, radius: blurX.radius, coeff: blurX.coeff });
      w = dstW;
      maxSize = Math.max(maxSize, w * h);
    }
    {
      const dstH = h + 2 * blurY.radius;
      plan.push({ name: "blurVert", srcW: w, srcH: h, dstW: w, dstH, radius: blurY.radius, coeff: blurY.coeff });
      h = dstH;
      maxSize = Math.max(maxSize, w * h);
    }
    for (let i = 0; i < blurX.level; i++) {
      const dstW = 2 * w + 4;
      plan.push({ name: "expandHorz", srcW: w, srcH: h, dstW, dstH: h, radius: 0, coeff: null });
      w = dstW;
      maxSize = Math.max(maxSize, w * h);
    }
    for (let i = 0; i < blurY.level; i++) {
      const dstH = 2 * h + 4;
      plan.push({ name: "expandVert", srcW: w, srcH: h, dstW: w, dstH, radius: 0, coeff: null });
      h = dstH;
      maxSize = Math.max(maxSize, w * h);
    }

    const outW = w < endW ? w : endW;
    const outH = h < endH ? h : endH;

    // Phase 2: allocate buffers, then bind them to the plan. unpack reads the
    // input buffer and writes bufA; from there it is a strict A/B ping-pong.
    const staging = this.ensureInput(w0 * h0);
    this.ensureStorage(maxSize);
    this.ensureOutput(outW * outH);
    const bufA = this.bufA!;
    const bufB = this.bufB!;

    const passes: PassSpec[] = [];
    let src = this.bufInput!;
    let dst = bufA;
    for (let i = 0; i < plan.length; i++) {
      const q = plan[i]!;
      passes.push({ ...q, src, dst });
      const t = src;
      src = dst;
      dst = i === 0 ? bufB : t; // after unpack, ping-pong strictly between A and B
    }
    // `src` now holds the buffer with the final expanded result.
    passes.push({
      name: "pack",
      srcW: w, srcH: h, dstW: outW, dstH: outH,
      radius: 0, coeff: null,
      src, dst: this.bufOut!,
    });

    // Fill the input staging buffer (respecting the caller's stride) and upload.
    for (let y = 0; y < h0; y++) {
      const srcRow = y * stride;
      const dstRow = y * w0;
      for (let x = 0; x < w0; x++) {
        staging[dstRow + x] = bitmap[srcRow + x]!;
      }
    }
    device.queue.writeBuffer(this.bufInput!, 0, staging.buffer, 0, w0 * h0 * 4);

    // Record all passes into one encoder. Each pass gets its own uniform buffer
    // so a single submit does not clobber earlier passes' params.
    const encoder = device.createCommandEncoder();
    const paramScratch = new Int32Array(PARAMS_BYTES / 4);
    for (let p = 0; p < passes.length; p++) {
      const spec = passes[p]!;
      const ubo = this.uniformBuffer(p);
      paramScratch.fill(0);
      paramScratch[0] = spec.srcW;
      paramScratch[1] = spec.srcH;
      paramScratch[2] = spec.dstW;
      paramScratch[3] = spec.dstH;
      paramScratch[4] = spec.radius;
      if (spec.coeff) {
        for (let i = 0; i < 8; i++) paramScratch[8 + i] = spec.coeff[i]!;
      }
      device.queue.writeBuffer(ubo, 0, paramScratch.buffer, 0, PARAMS_BYTES);

      const bindGroup = device.createBindGroup({
        layout: this.layout,
        entries: [
          { binding: 0, resource: { buffer: ubo } },
          { binding: 1, resource: { buffer: spec.src } },
          { binding: 2, resource: { buffer: spec.dst } },
        ],
      });
      const pass = encoder.beginComputePass();
      pass.setPipeline(this.pipelines[spec.name]);
      pass.setBindGroup(0, bindGroup);
      const gx = Math.ceil(spec.dstW / 8);
      const gy = Math.ceil(spec.dstH / 8);
      pass.dispatchWorkgroups(Math.max(1, gx), Math.max(1, gy), 1);
      pass.end();
    }

    const readBytes = outW * outH * 4;
    encoder.copyBufferToBuffer(this.bufOut!, 0, this.bufRead!, 0, readBytes);
    device.queue.submit([encoder.finish()]);

    await this.bufRead!.mapAsync(GPUMapMode.READ, 0, readBytes);
    const mapped = new Int32Array(this.bufRead!.getMappedRange(0, readBytes));
    const out = new Uint8Array(outW * outH);
    for (let i = 0; i < out.length; i++) out[i] = mapped[i]! & 0xff;
    this.bufRead!.unmap();

    const shiftX = ((blurX.radius + 4) << blurX.level) - 4;
    const shiftY = ((blurY.radius + 4) << blurY.level) - 4;

    return { buffer: out, width: outW, rows: outH, shiftX, shiftY };
  }

  dispose(): void {
    this.bufInput?.destroy?.();
    this.bufA?.destroy?.();
    this.bufB?.destroy?.();
    this.bufOut?.destroy?.();
    this.bufRead?.destroy?.();
    for (const u of this.uniforms) u?.destroy?.();
    this.uniforms = [];
    this.bufInput = null;
    this.bufA = null;
    this.bufB = null;
    this.bufOut = null;
    this.bufRead = null;
  }
}
