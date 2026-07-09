// Batched WGSL blur kernels: the SAME i32 arithmetic as blur-shaders.ts, but one
// dispatch per pass type processes many bitmaps at once. Each thread maps its
// flat id to (job, x, y) via a per-pass job table (binary search on a pixel
// prefix sum), then reads/writes through absolute buffer offsets carried in the
// job record.
//
// Ping-pong is expressed per bitmap: every bitmap owns two disjoint slots (A/B)
// in a single read_write `work` buffer, and each job carries absolute srcBase
// and dstBase, so bitmaps with different shrink/expand level counts never
// desync onto the "wrong" buffer. Because src and dst slots are disjoint across
// all jobs in a dispatch, there is no read/write aliasing.
//
// Indexing:  read  src[srcBase + row*srcW  + col]   (OOB tap -> 0)
//            write dst[dstBase + y*dstStride + x]
// srcW/srcH/dstW/dstH are pixel EXTENTS (bounds + thread mapping); dstStride is
// the destination row stride (= dstW for linear buffers, = page width when pack
// writes straight into an atlas page).

export const BLUR_BATCH_SHADER_SOURCE = /* wgsl */ `
struct Batch {
  jobOffset: i32,
  jobCount: i32,
  totalPixels: i32,
  _pad: i32,
}

struct Job {
  pixelBase: i32,  // prefix sum of dstW*dstH within this pass
  pixelCount: i32,
  srcBase: i32,
  dstBase: i32,
  srcW: i32,
  srcH: i32,
  dstW: i32,
  dstH: i32,
  radius: i32,
  coeffBase: i32,
  dstStride: i32,
  // punch fields (bPunch): fill slot + its dims, and integer offsets.
  fillBase: i32,
  fillW: i32,
  fillH: i32,
  punchOX: i32,
  punchOY: i32,
  punchFX: i32,
  punchFY: i32,
  _p0: i32,
  _p1: i32,
}

@group(0) @binding(0) var<uniform> U: Batch;
@group(0) @binding(1) var<storage, read> jobs: array<Job>;
@group(0) @binding(2) var<storage, read> coeffs: array<i32>;
@group(0) @binding(3) var<storage, read> inBuf: array<i32>;
@group(0) @binding(4) var<storage, read_write> work: array<i32>;
@group(0) @binding(5) var<storage, read_write> outBuf: array<u32>;

var<private> DITHER: array<i32, 32> = array<i32, 32>(
  8, 40, 8, 40, 8, 40, 8, 40, 8, 40, 8, 40, 8, 40, 8, 40,
  56, 24, 56, 24, 56, 24, 56, 24, 56, 24, 56, 24, 56, 24, 56, 24
);

fn i16(v: i32) -> i32 { return (v << 16u) >> 16u; }

// Largest job index (within this pass) whose pixelBase <= t.
fn findJob(t: i32) -> i32 {
  var lo = 0;
  var hi = U.jobCount - 1;
  loop {
    if (lo >= hi) { break; }
    let mid = (lo + hi + 1) >> 1u;
    if (jobs[U.jobOffset + mid].pixelBase <= t) { lo = mid; } else { hi = mid - 1; }
  }
  return lo;
}

// Source taps read the linear work buffer; OOB -> 0.
fn sH(base: i32, sW: i32, sH_: i32, y: i32, col: i32) -> i32 {
  if (col < 0 || col >= sW) { return 0; }
  return work[base + y * sW + col];
}
fn sV(base: i32, sW: i32, sH_: i32, x: i32, row: i32) -> i32 {
  if (row < 0 || row >= sH_) { return 0; }
  return work[base + row * sW + x];
}

fn shrinkFunc(p1p: i32, p1n: i32, z0p: i32, z0n: i32, n1p: i32, n1n: i32) -> i32 {
  var r = (p1p + p1n + n1p + n1n) >> 1u;
  r = (r + z0p + z0n) >> 1u;
  r = (r + p1n + n1p) >> 1u;
  return (r + z0p + z0n + 2) >> 2u;
}

// Resolve (job, x, y) for a thread; returns false when the thread is padding.
struct Loc { ok: bool, ji: i32, x: i32, y: i32 }
fn locate(gx: u32) -> Loc {
  var L: Loc;
  let t = i32(gx);
  if (t >= U.totalPixels) { L.ok = false; return L; }
  let ji = U.jobOffset + findJob(t);
  let local = t - jobs[ji].pixelBase;
  L.ok = true;
  L.ji = ji;
  L.x = local % jobs[ji].dstW;
  L.y = local / jobs[ji].dstW;
  return L;
}

@compute @workgroup_size(64)
fn bUnpack(@builtin(global_invocation_id) g: vec3<u32>) {
  let L = locate(g.x);
  if (!L.ok) { return; }
  let j = jobs[L.ji];
  let v = inBuf[j.srcBase + L.y * j.srcW + L.x];
  let r = (((v << 7u) | (v >> 1u)) + 1) >> 1u;
  work[j.dstBase + L.y * j.dstStride + L.x] = i16(r);
}

@compute @workgroup_size(64)
fn bShrinkVert(@builtin(global_invocation_id) g: vec3<u32>) {
  let L = locate(g.x);
  if (!L.ok) { return; }
  let j = jobs[L.ji];
  let sy = L.y * 2;
  let o = shrinkFunc(
    sV(j.srcBase, j.srcW, j.srcH, L.x, sy - 4),
    sV(j.srcBase, j.srcW, j.srcH, L.x, sy - 3),
    sV(j.srcBase, j.srcW, j.srcH, L.x, sy - 2),
    sV(j.srcBase, j.srcW, j.srcH, L.x, sy - 1),
    sV(j.srcBase, j.srcW, j.srcH, L.x, sy),
    sV(j.srcBase, j.srcW, j.srcH, L.x, sy + 1),
  );
  work[j.dstBase + L.y * j.dstStride + L.x] = i16(o);
}

@compute @workgroup_size(64)
fn bShrinkHorz(@builtin(global_invocation_id) g: vec3<u32>) {
  let L = locate(g.x);
  if (!L.ok) { return; }
  let j = jobs[L.ji];
  let sx = L.x * 2;
  let o = shrinkFunc(
    sH(j.srcBase, j.srcW, j.srcH, L.y, sx - 4),
    sH(j.srcBase, j.srcW, j.srcH, L.y, sx - 3),
    sH(j.srcBase, j.srcW, j.srcH, L.y, sx - 2),
    sH(j.srcBase, j.srcW, j.srcH, L.y, sx - 1),
    sH(j.srcBase, j.srcW, j.srcH, L.y, sx),
    sH(j.srcBase, j.srcW, j.srcH, L.y, sx + 1),
  );
  work[j.dstBase + L.y * j.dstStride + L.x] = i16(o);
}

@compute @workgroup_size(64)
fn bBlurHorz(@builtin(global_invocation_id) g: vec3<u32>) {
  let L = locate(g.x);
  if (!L.ok) { return; }
  let j = jobs[L.ji];
  let cx = L.x - j.radius;
  let center = sH(j.srcBase, j.srcW, j.srcH, L.y, cx);
  var acc: i32 = 32768;
  for (var i: i32 = j.radius; i > 0; i = i - 1) {
    let left = sH(j.srcBase, j.srcW, j.srcH, L.y, cx - i);
    let right = sH(j.srcBase, j.srcW, j.srcH, L.y, cx + i);
    acc = acc + (left + right - 2 * center) * coeffs[j.coeffBase + i - 1];
  }
  work[j.dstBase + L.y * j.dstStride + L.x] = i16(center + (acc >> 16u));
}

@compute @workgroup_size(64)
fn bBlurVert(@builtin(global_invocation_id) g: vec3<u32>) {
  let L = locate(g.x);
  if (!L.ok) { return; }
  let j = jobs[L.ji];
  let cy = L.y - j.radius;
  let center = sV(j.srcBase, j.srcW, j.srcH, L.x, cy);
  var acc: i32 = 32768;
  for (var i: i32 = j.radius; i > 0; i = i - 1) {
    let top = sV(j.srcBase, j.srcW, j.srcH, L.x, cy - i);
    let bot = sV(j.srcBase, j.srcW, j.srcH, L.x, cy + i);
    acc = acc + (top + bot - 2 * center) * coeffs[j.coeffBase + i - 1];
  }
  work[j.dstBase + L.y * j.dstStride + L.x] = i16(center + (acc >> 16u));
}

@compute @workgroup_size(64)
fn bExpandHorz(@builtin(global_invocation_id) g: vec3<u32>) {
  let L = locate(g.x);
  if (!L.ok) { return; }
  let j = jobs[L.ji];
  let k = L.x >> 1u;
  let p1 = sH(j.srcBase, j.srcW, j.srcH, L.y, k - 2);
  let z0 = sH(j.srcBase, j.srcW, j.srcH, L.y, k - 1);
  let n1 = sH(j.srcBase, j.srcW, j.srcH, L.y, k);
  let r = (((p1 + n1) >> 1u) + z0) >> 1u;
  var o: i32;
  if ((L.x & 1) == 0) { o = (((r + p1) >> 1u) + z0 + 1) >> 1u; }
  else { o = (((r + n1) >> 1u) + z0 + 1) >> 1u; }
  work[j.dstBase + L.y * j.dstStride + L.x] = i16(o);
}

@compute @workgroup_size(64)
fn bExpandVert(@builtin(global_invocation_id) g: vec3<u32>) {
  let L = locate(g.x);
  if (!L.ok) { return; }
  let j = jobs[L.ji];
  let k = L.y >> 1u;
  let p1 = sV(j.srcBase, j.srcW, j.srcH, L.x, k - 2);
  let z0 = sV(j.srcBase, j.srcW, j.srcH, L.x, k - 1);
  let n1 = sV(j.srcBase, j.srcW, j.srcH, L.x, k);
  let r = (((p1 + n1) >> 1u) + z0) >> 1u;
  var o: i32;
  if ((L.y & 1) == 0) { o = (((r + p1) >> 1u) + z0 + 1) >> 1u; }
  else { o = (((r + n1) >> 1u) + z0 + 1) >> 1u; }
  work[j.dstBase + L.y * j.dstStride + L.x] = i16(o);
}

// Pack writes to outBuf (linear output OR an atlas page, via dstBase+dstStride).
@compute @workgroup_size(64)
fn bPack(@builtin(global_invocation_id) g: vec3<u32>) {
  let L = locate(g.x);
  if (!L.ok) { return; }
  let j = jobs[L.ji];
  let ditherRow = (L.y & 1) << 4u;
  let dither = DITHER[ditherRow + (L.x & 15)];
  let v = work[j.srcBase + L.y * j.srcW + L.x];
  var out = (v - (v >> 8u) + dither) >> 6u;
  if (out < 0) { out = 0; } else if (out > 255) { out = 255; }
  outBuf[j.dstBase + L.y * j.dstStride + L.x] = u32(out);
}

// Pack into a work slot (u8 domain) so punch/copy can post-process before emit.
@compute @workgroup_size(64)
fn bPackToWork(@builtin(global_invocation_id) g: vec3<u32>) {
  let L = locate(g.x);
  if (!L.ok) { return; }
  let j = jobs[L.ji];
  let ditherRow = (L.y & 1) << 4u;
  let dither = DITHER[ditherRow + (L.x & 15)];
  let v = work[j.srcBase + L.y * j.srcW + L.x];
  var out = (v - (v >> 8u) + dither) >> 6u;
  if (out < 0) { out = 0; } else if (out > 255) { out = 255; }
  work[j.dstBase + L.y * j.dstStride + L.x] = out;
}

// Copy a work slot (u8 domain) to another work slot.
@compute @workgroup_size(64)
fn bCopy(@builtin(global_invocation_id) g: vec3<u32>) {
  let L = locate(g.x);
  if (!L.ok) { return; }
  let j = jobs[L.ji];
  work[j.dstBase + L.y * j.dstStride + L.x] = work[j.srcBase + L.y * j.srcW + L.x];
}

// Per-layer subpixel shift on a packed u8 work slot: horizontal pass.
// Reads the src slot (original neighbor values), writes the dst slot. The shift
// amount s in [0,63] is carried in j.radius. This is the PARALLEL form proven
// byte-exact vs shiftBitmapSubpixel in shift_emul.ts: every output pixel reads
// only ORIGINAL neighbor values, so out[x] = orig[x] + (orig[x-1]*s>>6) at x>=1
// minus (orig[x]*s>>6) at x<=w-2, wrapped to u8. Boundary drops match the CPU
// right-to-left in-place walk (leftmost has no +, rightmost has no -).
@compute @workgroup_size(64)
fn bShiftH(@builtin(global_invocation_id) g: vec3<u32>) {
  let L = locate(g.x);
  if (!L.ok) { return; }
  let j = jobs[L.ji];
  let s = j.radius;
  let cur = work[j.srcBase + L.y * j.srcW + L.x];
  var v = cur;
  if (L.x <= j.srcW - 2) { v = v - ((cur * s) >> 6u); }
  if (L.x >= 1) { v = v + ((work[j.srcBase + L.y * j.srcW + L.x - 1] * s) >> 6u); }
  work[j.dstBase + L.y * j.dstStride + L.x] = v & 255;
}

// Per-layer subpixel shift: vertical pass. Same parallel form over rows.
@compute @workgroup_size(64)
fn bShiftV(@builtin(global_invocation_id) g: vec3<u32>) {
  let L = locate(g.x);
  if (!L.ok) { return; }
  let j = jobs[L.ji];
  let s = j.radius;
  let cur = work[j.srcBase + L.y * j.srcW + L.x];
  var v = cur;
  if (L.y <= j.srcH - 2) { v = v - ((cur * s) >> 6u); }
  if (L.y >= 1) { v = v + ((work[j.srcBase + (L.y - 1) * j.srcW + L.x] * s) >> 6u); }
  work[j.dstBase + L.y * j.dstStride + L.x] = v & 255;
}

// fixOutlineBitmap punch on packed u8 work slots (in place on the dst slot).
// outline pixel (ox,oy) -> abs (punchOX+ox, punchOY+oy) -> fill (fx,fy).
@compute @workgroup_size(64)
fn bPunch(@builtin(global_invocation_id) g: vec3<u32>) {
  let L = locate(g.x);
  if (!L.ok) { return; }
  let j = jobs[L.ji];
  let ox = L.x;
  let oy = L.y;
  let o = work[j.dstBase + oy * j.dstStride + ox];
  var outv = o;
  let fx = j.punchOX + ox - j.punchFX;
  let fy = j.punchOY + oy - j.punchFY;
  if (fx >= 0 && fx < j.fillW && fy >= 0 && fy < j.fillH) {
    let gg = work[j.fillBase + fy * j.fillW + fx];
    if (o > gg) { outv = o - (gg >> 1u); } else { outv = 0; }
  }
  work[j.dstBase + oy * j.dstStride + ox] = outv;
}

// Emit a u8 work slot into outBuf packed 4 bytes/u32 with a 256-aligned row
// stride, ready for copyBufferToTexture into an r8unorm atlas. Thread extent is
// (ceil(outW/4) = dstW, dstH); srcW = outW (valid-texel bound); dstStride is the
// u32-per-row (= bytesPerRow/4). srcBase reads the u8 work slot at stride srcW.
@compute @workgroup_size(64)
fn bEmitU8(@builtin(global_invocation_id) g: vec3<u32>) {
  let L = locate(g.x);
  if (!L.ok) { return; }
  let j = jobs[L.ji];
  let base = L.x * 4;
  var packed: u32 = 0u;
  for (var i: i32 = 0; i < 4; i = i + 1) {
    let tx = base + i;
    var val: i32 = 0;
    if (tx < j.srcW) { val = work[j.srcBase + L.y * j.srcW + tx] & 255; }
    packed = packed | (u32(val) << u32(i * 8));
  }
  outBuf[j.dstBase + L.y * j.dstStride + L.x] = packed;
}

// Emit with a vector clip mask folded into the pack. The filtered source stays
// in a u8 work slot; clip mask bytes live in inBuf at fillBase. This is exact
// applyClip integer math: inverse uses 255-mask and partial alpha rounds
// (v*alpha)/255 with Math.round semantics.
@compute @workgroup_size(64)
fn bEmitMaskedU8(@builtin(global_invocation_id) g: vec3<u32>) {
  let L = locate(g.x);
  if (!L.ok) { return; }
  let j = jobs[L.ji];
  let base = L.x * 4;
  var packed: u32 = 0u;
  for (var i: i32 = 0; i < 4; i = i + 1) {
    let tx = base + i;
    var val: i32 = 0;
    if (tx < j.srcW) {
      val = work[j.srcBase + L.y * j.srcW + tx] & 255;
      let mx = j.punchOX + tx - j.punchFX;
      let my = j.punchOY + L.y - j.punchFY;
      var maskAlpha: i32 = 0;
      if (mx >= 0 && mx < j.fillW && my >= 0 && my < j.fillH) {
        maskAlpha = inBuf[j.fillBase + my * j.fillW + mx] & 255;
      }
      var alpha = maskAlpha;
      if (j.radius != 0) {
        alpha = 255 - maskAlpha;
      }
      if (alpha == 0) {
        val = 0;
      } else if (alpha < 255) {
        val = (val * alpha + 127) / 255;
      }
    }
    packed = packed | (u32(val) << u32(i * 8));
  }
  outBuf[j.dstBase + L.y * j.dstStride + L.x] = packed;
}
`;
