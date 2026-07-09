// WGSL integer-compute port of the libass gaussian blur pipeline.
//
// Every kernel here replicates src/core/libass_blur.ts *exactly* using i32
// arithmetic. The correspondence is intentional and load-bearing:
//   - JS `>>` is a 32-bit arithmetic shift; WGSL `>>` on i32 is also arithmetic.
//   - JS bitwise ops coerce operands via ToInt32 (mod 2^32); WGSL i32 +,-,*
//     wrap mod 2^32 (two's complement), so a running i32 accumulator matches
//     JS's "accumulate in a double, then ToInt32 at the `>>`" behavior bit for
//     bit as long as no single value exceeds 2^53 (it never does here).
//   - The TS working buffers are Int16Array, so every store truncates to a
//     signed 16-bit value. We emulate that with i16() on every write.
//
// The working buffers are i32 storage arrays holding already-truncated int16
// values (so reads need no re-truncation). Bindings are uniform across all
// entry points: binding 1 is the source, binding 2 is the destination.

export const BLUR_SHADER_SOURCE = /* wgsl */ `
struct Params {
  srcW: i32,   // source row stride (pitch) in elements
  srcH: i32,   // source rows
  dstW: i32,   // destination row stride in elements
  dstH: i32,   // destination rows
  radius: i32, // blur radius (blurHorz/blurVert only)
  pad0: i32,
  pad1: i32,
  pad2: i32,
  coeff: array<vec4<i32>, 2>, // 8 Int16 coefficients, sign-extended into i32
}

@group(0) @binding(0) var<uniform> P: Params;
@group(0) @binding(1) var<storage, read> src: array<i32>;
@group(0) @binding(2) var<storage, read_write> dst: array<i32>;

// DITHER_LINE from libass_blur.ts (two 16-entry rows).
var<private> DITHER: array<i32, 32> = array<i32, 32>(
  8, 40, 8, 40, 8, 40, 8, 40, 8, 40, 8, 40, 8, 40, 8, 40,
  56, 24, 56, 24, 56, 24, 56, 24, 56, 24, 56, 24, 56, 24, 56, 24
);

// Emulate Int16Array store: keep the low 16 bits, sign-extended.
fn i16(v: i32) -> i32 {
  return (v << 16u) >> 16u;
}

fn coeffAt(i: i32) -> i32 {
  let v = P.coeff[i >> 2u];
  let m = i & 3;
  if (m == 0) { return v.x; }
  if (m == 1) { return v.y; }
  if (m == 2) { return v.z; }
  return v.w;
}

// Read src[row][col] with out-of-bounds taps treated as 0.
fn sampleH(y: i32, col: i32) -> i32 {
  if (col < 0 || col >= P.srcW) { return 0; }
  return src[y * P.srcW + col];
}
fn sampleV(x: i32, row: i32) -> i32 {
  if (row < 0 || row >= P.srcH) { return 0; }
  return src[row * P.srcW + x];
}

// libass_blur.ts shrinkFunc.
fn shrinkFunc(p1p: i32, p1n: i32, z0p: i32, z0n: i32, n1p: i32, n1n: i32) -> i32 {
  var r = (p1p + p1n + n1p + n1n) >> 1u;
  r = (r + z0p + z0n) >> 1u;
  r = (r + p1n + n1p) >> 1u;
  return (r + z0p + z0n + 2) >> 2u;
}

// unpackToInt16: v in 0..255 -> (((v<<7)|(v>>1))+1)>>1
@compute @workgroup_size(8, 8)
fn unpack(@builtin(global_invocation_id) gid: vec3<u32>) {
  let x = i32(gid.x);
  let y = i32(gid.y);
  if (x >= P.dstW || y >= P.dstH) { return; }
  let v = src[y * P.srcW + x];
  let r = (((v << 7u) | (v >> 1u)) + 1) >> 1u;
  dst[y * P.dstW + x] = i16(r);
}

// shrinkVert: dstH = (srcH+5)>>1, stride unchanged. Taps sy-4..sy+1, sy=2y.
@compute @workgroup_size(8, 8)
fn shrinkVert(@builtin(global_invocation_id) gid: vec3<u32>) {
  let x = i32(gid.x);
  let y = i32(gid.y);
  if (x >= P.dstW || y >= P.dstH) { return; }
  let sy = y * 2;
  let p1p = sampleV(x, sy - 4);
  let p1n = sampleV(x, sy - 3);
  let z0p = sampleV(x, sy - 2);
  let z0n = sampleV(x, sy - 1);
  let n1p = sampleV(x, sy);
  let n1n = sampleV(x, sy + 1);
  dst[y * P.dstW + x] = i16(shrinkFunc(p1p, p1n, z0p, z0n, n1p, n1n));
}

// shrinkHorz: dstW = (srcW+5)>>1. Taps sx-4..sx+1, sx=2x.
@compute @workgroup_size(8, 8)
fn shrinkHorz(@builtin(global_invocation_id) gid: vec3<u32>) {
  let x = i32(gid.x);
  let y = i32(gid.y);
  if (x >= P.dstW || y >= P.dstH) { return; }
  let sx = x * 2;
  let p1p = sampleH(y, sx - 4);
  let p1n = sampleH(y, sx - 3);
  let z0p = sampleH(y, sx - 2);
  let z0n = sampleH(y, sx - 1);
  let n1p = sampleH(y, sx);
  let n1n = sampleH(y, sx + 1);
  dst[y * P.dstW + x] = i16(shrinkFunc(p1p, p1n, z0p, z0n, n1p, n1n));
}

// blurHorz: dstW = srcW + 2*radius. Per-pixel form of the libass_blur.ts kernel:
//   acc = 0x8000 + sum_i (left_i + right_i - 2*center) * coeff[i-1]
//   out = center + (acc >> 16)
@compute @workgroup_size(8, 8)
fn blurHorz(@builtin(global_invocation_id) gid: vec3<u32>) {
  let x = i32(gid.x);
  let y = i32(gid.y);
  if (x >= P.dstW || y >= P.dstH) { return; }
  let cx = x - P.radius;
  let center = sampleH(y, cx);
  var acc: i32 = 32768;
  for (var i: i32 = P.radius; i > 0; i = i - 1) {
    let left = sampleH(y, cx - i);
    let right = sampleH(y, cx + i);
    acc = acc + (left + right - 2 * center) * coeffAt(i - 1);
  }
  dst[y * P.dstW + x] = i16(center + (acc >> 16u));
}

// blurVert: dstH = srcH + 2*radius, stride unchanged. Per-pixel form. This is
// bit-identical to the accumulator variant in libass_blur.ts (the reordered
// sum is exact over integers).
@compute @workgroup_size(8, 8)
fn blurVert(@builtin(global_invocation_id) gid: vec3<u32>) {
  let x = i32(gid.x);
  let y = i32(gid.y);
  if (x >= P.dstW || y >= P.dstH) { return; }
  let cy = y - P.radius;
  let center = sampleV(x, cy);
  var acc: i32 = 32768;
  for (var i: i32 = P.radius; i > 0; i = i - 1) {
    let top = sampleV(x, cy - i);
    let bot = sampleV(x, cy + i);
    acc = acc + (top + bot - 2 * center) * coeffAt(i - 1);
  }
  dst[y * P.dstW + x] = i16(center + (acc >> 16u));
}

// expandHorz: dstW = 2*srcW + 4. Column X maps to k = X>>1, even/odd by X&1.
@compute @workgroup_size(8, 8)
fn expandHorz(@builtin(global_invocation_id) gid: vec3<u32>) {
  let x = i32(gid.x);
  let y = i32(gid.y);
  if (x >= P.dstW || y >= P.dstH) { return; }
  let k = x >> 1u;
  let p1 = sampleH(y, k - 2);
  let z0 = sampleH(y, k - 1);
  let n1 = sampleH(y, k);
  let r = (((p1 + n1) >> 1u) + z0) >> 1u;
  var outv: i32;
  if ((x & 1) == 0) {
    outv = (((r + p1) >> 1u) + z0 + 1) >> 1u;
  } else {
    outv = (((r + n1) >> 1u) + z0 + 1) >> 1u;
  }
  dst[y * P.dstW + x] = i16(outv);
}

// expandVert: dstH = 2*srcH + 4, stride unchanged. Row Y maps to k = Y>>1.
@compute @workgroup_size(8, 8)
fn expandVert(@builtin(global_invocation_id) gid: vec3<u32>) {
  let x = i32(gid.x);
  let y = i32(gid.y);
  if (x >= P.dstW || y >= P.dstH) { return; }
  let k = y >> 1u;
  let p1 = sampleV(x, k - 2);
  let z0 = sampleV(x, k - 1);
  let n1 = sampleV(x, k);
  let r = (((p1 + n1) >> 1u) + z0) >> 1u;
  var outv: i32;
  if ((y & 1) == 0) {
    outv = (((r + p1) >> 1u) + z0 + 1) >> 1u;
  } else {
    outv = (((r + n1) >> 1u) + z0 + 1) >> 1u;
  }
  dst[y * P.dstW + x] = i16(outv);
}

// Dither pack: out = clamp((v - (v>>8) + dither) >> 6, 0, 255).
// srcW is the final buffer stride; dstW is the (cropped) output width.
@compute @workgroup_size(8, 8)
fn pack(@builtin(global_invocation_id) gid: vec3<u32>) {
  let x = i32(gid.x);
  let y = i32(gid.y);
  if (x >= P.dstW || y >= P.dstH) { return; }
  let ditherRow = (y & 1) << 4u;
  let dither = DITHER[ditherRow + (x & 15)];
  let v = src[y * P.srcW + x];
  var out = (v - (v >> 8u) + dither) >> 6u;
  if (out < 0) { out = 0; } else if (out > 255) { out = 255; }
  dst[y * P.dstW + x] = out;
}
`;
