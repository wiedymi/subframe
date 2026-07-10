// Optional WASM-SIMD fast path for the level-0 libass gaussian blur.
//
// The pure-JS blur in ../libass_blur.ts stays the default/baseline. This module
// is used ONLY when: WebAssembly is present, the module compiles (which fails if
// SIMD is unavailable), and the compiled kernel is proven byte-identical to the
// JS level-0 path over a self-verification corpus at init. Any failure leaves
// the JS path in place. The .wasm is base64-embedded (no runtime fetch, CSP-safe
// for the playground) and instantiated per module/worker.
//
// Kernel: freestanding wasm32 + SIMD128 (see blur.c / build.sh). It reproduces
// blurLevel0 -> blurHorz + blurVertPackPadded exactly (integer math, arithmetic
// >>16, i16 truncation, dither/pack), for both axes at level 0, radius 1..8.

import { PixelMode } from "text-shaper";
import { BLUR_WASM_BASE64 } from "./wasm-bytes";

export type BlurMethodLike = { level: number; radius: number; coeff: Int16Array };
type GrayBitmap = {
  buffer: Uint8Array;
  width: number;
  rows: number;
  pitch: number;
  pixelMode: PixelMode;
  numGrays?: number;
};
type BlurResult = { bitmap: GrayBitmap; shiftX: number; shiftY: number };
type JsBlurLevel0 = (bmp: GrayBitmap, blurX: BlurMethodLike, blurY: BlurMethodLike) => BlurResult;
type MakeMethod = (r2: number) => BlurMethodLike;

type Status = "uninit" | "pending" | "ready" | "disabled";

let status: Status = "uninit";
let enabled = false; // only true once compiled + self-verified
let forceDisabled = false; // test/perf override

let instance: WebAssembly.Instance | null = null;
let memory: WebAssembly.Memory | null = null;
let heapBase = 0;
let blurFn: ((...a: number[]) => void) | null = null;
let u8view: Uint8Array | null = null;
let i16view: Int16Array | null = null;

// WebAssembly.Memory cannot shrink. Decline pathological one-off masks before
// they permanently raise the realm's backing-store high-water; the caller falls
// back to the byte-identical JS kernel.
const MAX_BLUR_WASM_WORK_BYTES = 64 * 1024 * 1024;

export function isBlurWasmEnabled(): boolean {
  return enabled && !forceDisabled;
}
export function setBlurWasmEnabled(v: boolean): void {
  forceDisabled = !v;
}
export function blurWasmStatus(): { status: Status; enabled: boolean; forceDisabled: boolean } {
  return { status, enabled, forceDisabled };
}

function b64ToBytes(b64: string): Uint8Array {
  // atob exists in browsers, Bun, and web workers.
  const bin = atob(b64);
  const n = bin.length;
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function refreshViews(): void {
  if (!memory) return;
  u8view = new Uint8Array(memory.buffer);
  i16view = new Int16Array(memory.buffer);
}

function align16(n: number): number {
  return (n + 15) & ~15;
}

function ensureCapacity(bytesFromHeap: number): boolean {
  if (!memory) return false;
  const need = heapBase + bytesFromHeap;
  if (need <= memory.buffer.byteLength) return true;
  const pages = Math.ceil((need - memory.buffer.byteLength) / 65536);
  try {
    if (memory.grow(pages) === -1) return false;
  } catch {
    return false;
  }
  refreshViews();
  return need <= memory.buffer.byteLength;
}

function setupInstance(inst: WebAssembly.Instance): boolean {
  const ex = inst.exports as Record<string, unknown>;
  const mem = ex.memory as WebAssembly.Memory | undefined;
  const fn = ex.blur_level0 as ((...a: number[]) => void) | undefined;
  const hb = ex.__heap_base as WebAssembly.Global | undefined;
  if (!mem || !fn || !hb) return false;
  instance = inst;
  memory = mem;
  blurFn = fn;
  heapBase = align16(Number(hb.value));
  refreshViews();
  return true;
}

// Run the kernel for a level-0 method pair. Returns null if the wasm memory
// cannot be grown to fit (caller then uses the JS path).
function runKernel(bmp: GrayBitmap, blurX: BlurMethodLike, blurY: BlurMethodLike): BlurResult | null {
  const w = bmp.width;
  const h = bmp.rows;
  const pitch = bmp.pitch;
  const rx = blurX.radius;
  const ry = blurY.radius;
  const outW = w + 2 * rx;
  const outH = h + 2 * ry;
  const midRows = h + 4 * ry;

  let p = heapBase;
  const srcOff = p;
  p = align16(p + pitch * h);
  const cxOff = p;
  p = align16(p + 16);
  const cyOff = p;
  p = align16(p + 16);
  const unpackOff = p;
  p = align16(p + w * h * 2);
  const midOff = p;
  p = align16(p + midRows * outW * 2);
  const outOff = p;
  p = align16(p + outW * outH);

  const workBytes = p - heapBase;
  if (workBytes > MAX_BLUR_WASM_WORK_BYTES) return null;
  if (!ensureCapacity(workBytes)) return null;
  const u8 = u8view!;
  const i16 = i16view!;

  u8.set(bmp.buffer.subarray(0, pitch * h), srcOff);
  const cxi = cxOff >> 1;
  const cyi = cyOff >> 1;
  for (let i = 0; i < 8; i++) {
    i16[cxi + i] = blurX.coeff[i] ?? 0;
    i16[cyi + i] = blurY.coeff[i] ?? 0;
  }

  blurFn!(srcOff, w, h, pitch, rx, ry, cxOff, cyOff, unpackOff, midOff, outOff);

  const outLen = outW * outH;
  const outBuffer = new Uint8Array(outLen);
  outBuffer.set(new Uint8Array(memory!.buffer, outOff, outLen));

  return {
    bitmap: {
      buffer: outBuffer,
      width: outW,
      rows: outH,
      pitch: outW,
      pixelMode: PixelMode.Gray,
      numGrays: 256,
    },
    shiftX: rx,
    shiftY: ry,
  };
}

// --- self-verification corpus ---------------------------------------------

function makeVerifyBitmap(w: number, h: number, pitch: number, seed: number, mode: number): GrayBitmap {
  const buf = new Uint8Array(pitch * h);
  let s = seed >>> 0;
  if (mode !== 2) {
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        s = (s * 1103515245 + 12345) & 0x7fffffff;
        if (mode === 1 && (s & 7) !== 0) continue; // sparse
        buf[y * pitch + x] = (s >> 8) & 255;
      }
    }
  }
  return { buffer: buf, width: w, rows: h, pitch, pixelMode: PixelMode.Gray, numGrays: 256 };
}

function sameResult(a: BlurResult, b: BlurResult): boolean {
  if (a.shiftX !== b.shiftX || a.shiftY !== b.shiftY) return false;
  if (a.bitmap.width !== b.bitmap.width || a.bitmap.rows !== b.bitmap.rows) return false;
  const x = a.bitmap.buffer;
  const y = b.bitmap.buffer;
  if (x.length !== y.length) return false;
  for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return false;
  return true;
}

// r2 values chosen to exercise level-0 radii 4,5,6,7,8 and both axes.
const VERIFY_R2 = [0.2, 1.7, 4.4, 4.9, 5.5, 6.8];

function selfVerify(jsRef: JsBlurLevel0, makeMethod: MakeMethod): boolean {
  const sizes: Array<[number, number, number]> = [
    [1, 1, 1],
    [3, 5, 3],
    [8, 8, 8],
    [17, 9, 17],
    [16, 16, 19],
    [40, 30, 40],
    [65, 33, 68],
    [130, 55, 130],
    [200, 80, 200],
  ];
  let seed = 987654321;
  for (const [w, h, pitch] of sizes) {
    for (let mode = 0; mode < 3; mode++) {
      const bmp = makeVerifyBitmap(w, h, pitch, seed++, mode);
      for (let ai = 0; ai < VERIFY_R2.length; ai++) {
        const r2x = VERIFY_R2[ai]!;
        const r2y = VERIFY_R2[VERIFY_R2.length - 1 - ai]!; // mix axes
        const bx = makeMethod(r2x);
        const by = makeMethod(r2y);
        if (bx.level !== 0 || by.level !== 0) continue;
        let got: BlurResult | null;
        try {
          got = runKernel(bmp, bx, by);
        } catch {
          return false;
        }
        if (!got) continue; // memory could not grow here; not a correctness fail
        const want = jsRef(
          { ...bmp, buffer: bmp.buffer.slice() },
          bx,
          by,
        );
        if (!sameResult(got, want)) return false;
      }
    }
  }
  return true;
}

function tryInstantiateSync(bytes: Uint8Array): boolean {
  try {
    const mod = new WebAssembly.Module(bytes.slice());
    const inst = new WebAssembly.Instance(mod, {});
    return setupInstance(inst);
  } catch {
    return false; // e.g. main-thread >4KB sync limit, or SIMD unsupported
  }
}

let asyncStarted = false;
function startAsyncInstantiate(bytes: Uint8Array, jsRef: JsBlurLevel0, makeMethod: MakeMethod): void {
  if (asyncStarted) return;
  asyncStarted = true;
  status = "pending";
  WebAssembly.instantiate(bytes.buffer as ArrayBuffer, {})
    .then((res) => {
      if (!setupInstance(res.instance)) {
        status = "disabled";
        return;
      }
      try {
        if (selfVerify(jsRef, makeMethod)) {
          enabled = true;
          status = "ready";
        } else {
          instance = null;
          status = "disabled";
        }
      } catch {
        instance = null;
        status = "disabled";
      }
    })
    .catch(() => {
      status = "disabled";
    });
}

// Idempotent: compiles + self-verifies once. On the browser main thread the
// module exceeds the 4KB sync-compile limit, so this kicks off async compilation
// and the JS path is used until it resolves. In workers/Bun the sync path
// succeeds immediately.
export function ensureBlurWasmReady(jsRef: JsBlurLevel0, makeMethod: MakeMethod): void {
  if (status !== "uninit") return;
  if (typeof WebAssembly === "undefined") {
    status = "disabled";
    return;
  }
  let bytes: Uint8Array;
  try {
    bytes = b64ToBytes(BLUR_WASM_BASE64);
  } catch {
    status = "disabled";
    return;
  }
  if (tryInstantiateSync(bytes)) {
    try {
      if (selfVerify(jsRef, makeMethod)) {
        enabled = true;
        status = "ready";
      } else {
        instance = null;
        status = "disabled";
      }
    } catch {
      instance = null;
      status = "disabled";
    }
    return;
  }
  // Sync failed (large module on main thread, or transient) -> async.
  startAsyncInstantiate(bytes, jsRef, makeMethod);
}

// Level-0 blur via the verified WASM kernel. Returns null (caller uses JS) when
// the kernel is not enabled, the case is out of range, or memory can't grow.
export function wasmBlurLevel0(
  bmp: GrayBitmap,
  blurX: BlurMethodLike,
  blurY: BlurMethodLike,
): BlurResult | null {
  if (!enabled || forceDisabled || !blurFn) return null;
  if (blurX.level !== 0 || blurY.level !== 0) return null;
  const rx = blurX.radius;
  const ry = blurY.radius;
  if (rx < 1 || rx > 8 || ry < 1 || ry > 8) return null;
  if (bmp.width <= 0 || bmp.rows <= 0) return null;
  try {
    return runKernel(bmp, blurX, blurY);
  } catch {
    return null;
  }
}
