// GPU filter provider hook (core-owned; NO import of backend code).
//
// The WebGPU backend registers a provider when its GPU-filter flag is on. When
// a provider is active, the raster path may DEFER pixel filtering (gaussian blur
// + outline punch) to the GPU: instead of running the CPU blur/punch, it emits
// the unfiltered source mask(s) plus quantized filter params on the layer's
// `gpuFilter` descriptor, and the backend produces the filtered result on the
// GPU (no readback) and composites it.
//
// With no provider registered (the default, and always for CPU/WebGL/Bun),
// getGpuFilterProvider() returns null and the raster path is byte-for-byte
// unchanged.
import { findBestMethod } from "../libass_blur";

export type GpuBlurDims = {
  outW: number;
  outH: number;
  shiftX: number;
  shiftY: number;
};

export interface GpuFilterProvider {
  // Deterministic output dims + origin shift for a gaussian blur of a WxH mask
  // with the given r2x/r2y. Must match libassGaussianBlur exactly so core can
  // set the deferred layer's geometry without doing the pixel work.
  computeBlurDims(w: number, h: number, r2x: number, r2y: number): GpuBlurDims;
  // True when the backend can multiply vector clip masks into the final
  // filtered pixels in the same batched GPU submit. Without this, mask-clipped
  // layers stay on the CPU path.
  supportsMaskClip?: boolean;
}

export function computeGpuBlurDims(
  w0: number,
  h0: number,
  r2x: number,
  r2y: number,
): GpuBlurDims {
  const bx = findBestMethod(r2x);
  const by = r2x === r2y ? bx : findBestMethod(r2y);
  const offsetX = ((2 * bx.radius + 9) << bx.level) - 5;
  const offsetY = ((2 * by.radius + 9) << by.level) - 5;
  const endW = ((w0 + offsetX) & ~((1 << bx.level) - 1)) - 4;
  const endH = ((h0 + offsetY) & ~((1 << by.level) - 1)) - 4;

  let w = w0;
  let h = h0;
  for (let i = 0; i < by.level; i++) h = (h + 5) >> 1;
  for (let i = 0; i < bx.level; i++) w = (w + 5) >> 1;
  w += 2 * bx.radius;
  h += 2 * by.radius;
  for (let i = 0; i < bx.level; i++) w = 2 * w + 4;
  for (let i = 0; i < by.level; i++) h = 2 * h + 4;

  const outW = w < endW ? w : endW;
  const outH = h < endH ? h : endH;
  const shiftX = ((bx.radius + 4) << bx.level) - 4;
  const shiftY = ((by.radius + 4) << by.level) - 4;
  return { outW, outH, shiftX, shiftY };
}

let activeProvider: GpuFilterProvider | null = null;

export function setGpuFilterProvider(provider: GpuFilterProvider | null): void {
  activeProvider = provider;
}

export function getGpuFilterProvider(): GpuFilterProvider | null {
  return activeProvider;
}

// Master switch for GPU filter deferral, independent of provider registration.
// When false the raster path keeps a registered provider (so computeBlurDims and
// the copy-elimination adopt guard behave exactly as with GPU filters "on") but
// routes NO layer to the GPU — the CPU does the blur. Used to A/B the deferral
// overhead in isolation from the provider's other effects, and as a runtime
// opt-out for workloads where CPU blur + cache beats per-frame GPU dispatch.
let deferEnabled = true;

export function setGpuFilterDeferEnabled(enabled: boolean): void {
  deferEnabled = enabled;
}

export function isGpuFilterDeferEnabled(): boolean {
  return deferEnabled;
}
