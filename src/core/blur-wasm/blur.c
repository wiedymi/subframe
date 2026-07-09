// Freestanding wasm32 + SIMD128 port of the level-0 libass gaussian blur.
// Bit-exact with src/core/libass_blur.ts (blurLevel0 -> blurHorz +
// blurVertPackPadded). Integer-only: unpack to i16, separable accumulate in
// i32 (wrapping mod 2^32 == JS ToInt32 at `>>16`), arithmetic >>16, i16
// truncation, dither/pack.
//
// Build (see build.sh):
//   clang --target=wasm32 -O3 -msimd128 -nostdlib -Wl,--no-entry \
//         -Wl,--export-dynamic -o blur.wasm blur.c
//
// All pointer args are byte offsets into linear memory (wasm addr == offset).

#include <wasm_simd128.h>
#include <stdint.h>

typedef int16_t  i16;
typedef int32_t  i32;
typedef uint8_t  u8;

// --- scalar helpers (bit-exact with the JS expressions) --------------------

static inline i16 unpack1(u8 v) {
  i32 x = ((((i32)v << 7) | ((i32)v >> 1)) + 1) >> 1;
  return (i16)x; // fits, 0..16384
}

static inline i32 clamp255(i32 o) {
  if (o < 0) return 0;
  if (o > 255) return 255;
  return o;
}

// One horizontal output pixel (bounds-checked). center index cx in src-row.
static inline i16 hpx(const i16 *row, i32 cx, i32 w, const i16 *c, i32 radius) {
  i32 center = (cx >= 0 && cx < w) ? row[cx] : 0;
  i32 acc = 0x8000;
  for (i32 i = radius; i > 0; i--) {
    i32 li = cx - i, ri = cx + i;
    i32 l = (li >= 0 && li < w) ? row[li] : 0;
    i32 r = (ri >= 0 && ri < w) ? row[ri] : 0;
    acc += (l + r - 2 * center) * c[i - 1];
  }
  return (i16)(center + (acc >> 16));
}

// --- SIMD constants --------------------------------------------------------

static inline v128_t splat_i32(i32 v) { return wasm_i32x4_splat(v); }

// Truncate two i32x4 (lo,hi) to i16x8 keeping low 16 bits (wrapping, not
// saturating -- matches Int16Array storage).
static inline v128_t trunc_i32x4_to_i16x8(v128_t lo, v128_t hi) {
  return wasm_i8x16_shuffle(lo, hi,
      0, 1, 4, 5, 8, 9, 12, 13, 16, 17, 20, 21, 24, 25, 28, 29);
}

// --- main kernel -----------------------------------------------------------

__attribute__((export_name("blur_level0")))
void blur_level0(
    i32 srcOff, i32 w, i32 h, i32 pitch,
    i32 rx, i32 ry,
    i32 coeffXOff, i32 coeffYOff,
    i32 unpackOff, i32 midOff, i32 outOff) {
  u8  *src    = (u8  *)(uintptr_t)srcOff;
  i16 *cx     = (i16 *)(uintptr_t)coeffXOff;
  i16 *cy     = (i16 *)(uintptr_t)coeffYOff;
  i16 *unpack = (i16 *)(uintptr_t)unpackOff;
  i16 *mid    = (i16 *)(uintptr_t)midOff;
  u8  *out    = (u8  *)(uintptr_t)outOff;

  const i32 outW = w + 2 * rx;
  const i32 outH = h + 2 * ry;
  const i32 padTop = 2 * ry * outW;      // rows [0,2ry) zero
  const i32 midRows = h + 4 * ry;

  // ---- unpack: src[pitch] -> unpack[w] (row-major, w-wide) ----
  for (i32 y = 0; y < h; y++) {
    const u8 *srow = src + (i32)y * pitch;
    i16 *drow = unpack + (i32)y * w;
    i32 x = 0;
    for (; x + 8 <= w; x += 8) {
      v128_t b = wasm_v128_load64_zero(srow + x);       // 8 u8 in low half
      v128_t v = wasm_u16x8_extend_low_u8x16(b);        // -> 8 u16
      v128_t sh7 = wasm_i16x8_shl(v, 7);
      v128_t sh1 = wasm_u16x8_shr(v, 1);
      v128_t orr = wasm_v128_or(sh7, sh1);
      v128_t plus1 = wasm_i16x8_add(orr, wasm_i16x8_splat(1));
      v128_t res = wasm_u16x8_shr(plus1, 1);
      wasm_v128_store(drow + x, res);
    }
    for (; x < w; x++) drow[x] = unpack1(srow[x]);
  }

  // ---- zero mid padding rows (top [0,padTop) and bottom) ----
  for (i32 i = 0; i < padTop; i++) mid[i] = 0;
  for (i32 i = padTop + h * outW; i < midRows * outW; i++) mid[i] = 0;

  // ---- horizontal blur: unpack[w] rows -> mid real rows [2ry,2ry+h) ----
  // Each output row is outW wide; center index cx = x - rx.
  const i32 coreStart = (2 * rx < outW) ? 2 * rx : outW;
  i32 ce = (w < outW) ? w : outW;
  const i32 coreEnd = (ce > coreStart) ? ce : coreStart;

  for (i32 y = 0; y < h; y++) {
    const i16 *urow = unpack + (i32)y * w;
    i16 *drow = mid + padTop + (i32)y * outW;

    i32 x = 0;
    for (; x < coreStart; x++) drow[x] = hpx(urow, x - rx, w, cx, rx);

    // SIMD core: process 8 output px; only where all 8 tap-loads stay in row.
    i32 xs = x;
    // guard: last read index for chunk at x is (x + 7) (rightmost tap+lane);
    // require x + 7 < w  i.e. x <= w - 8. Also x < coreEnd.
    for (; xs + 8 <= coreEnd && xs + 8 <= w; xs += 8) {
      const i16 *base = urow + (xs - rx);              // center element for lane0
      v128_t cv = wasm_v128_load(base);                // 8 centers
      v128_t clo = wasm_i32x4_extend_low_i16x8(cv);
      v128_t chi = wasm_i32x4_extend_high_i16x8(cv);
      v128_t two_clo = wasm_i32x4_shl(clo, 1);
      v128_t two_chi = wasm_i32x4_shl(chi, 1);
      v128_t acc_lo = splat_i32(0x8000);
      v128_t acc_hi = splat_i32(0x8000);
      for (i32 i = 1; i <= rx; i++) {
        v128_t lv = wasm_v128_load(base - i);
        v128_t rv = wasm_v128_load(base + i);
        v128_t llo = wasm_i32x4_extend_low_i16x8(lv);
        v128_t lhi = wasm_i32x4_extend_high_i16x8(lv);
        v128_t rlo = wasm_i32x4_extend_low_i16x8(rv);
        v128_t rhi = wasm_i32x4_extend_high_i16x8(rv);
        v128_t d_lo = wasm_i32x4_sub(wasm_i32x4_add(llo, rlo), two_clo);
        v128_t d_hi = wasm_i32x4_sub(wasm_i32x4_add(lhi, rhi), two_chi);
        v128_t ci = splat_i32(cx[i - 1]);
        acc_lo = wasm_i32x4_add(acc_lo, wasm_i32x4_mul(d_lo, ci));
        acc_hi = wasm_i32x4_add(acc_hi, wasm_i32x4_mul(d_hi, ci));
      }
      v128_t rlo = wasm_i32x4_add(clo, wasm_i32x4_shr(acc_lo, 16));
      v128_t rhi = wasm_i32x4_add(chi, wasm_i32x4_shr(acc_hi, 16));
      wasm_v128_store(drow + xs, trunc_i32x4_to_i16x8(rlo, rhi));
    }
    x = xs;
    for (; x < coreEnd; x++) {
      const i16 *base = urow + (x - rx);
      i32 center = base[0];
      i32 acc = 0x8000;
      for (i32 i = 1; i <= rx; i++)
        acc += (base[-i] + base[i] - 2 * center) * cx[i - 1];
      drow[x] = (i16)(center + (acc >> 16));
    }
    for (; x < outW; x++) drow[x] = hpx(urow, x - rx, w, cx, rx);
  }

  // ---- vertical blur + dither/pack: mid -> out (u8) ----
  i32 totalC = 0;
  for (i32 i = 0; i < ry; i++) totalC += 2 * cy[i];
  const v128_t vTotalC = splat_i32(totalC);
  const v128_t v0 = wasm_i32x4_splat(0);
  const v128_t v255 = wasm_i32x4_splat(255);

  for (i32 y = 0; y < outH; y++) {
    const i16 *cbRow = mid + (i32)(y + ry) * outW;
    u8 *orow = out + (i32)y * outW;

    // dither depends only on (y&1) and (x&1)
    i32 dEven = (y & 1) ? 56 : 8;   // x even
    i32 dOdd  = (y & 1) ? 24 : 40;  // x odd
    // i16x8 dither for lanes starting at an even column: [dEven,dOdd,...]
    v128_t dvEvenStart = wasm_i16x8_make(dEven, dOdd, dEven, dOdd, dEven, dOdd, dEven, dOdd);
    v128_t dvOddStart  = wasm_i16x8_make(dOdd, dEven, dOdd, dEven, dOdd, dEven, dOdd, dEven);

    i32 x = 0;
    for (; x + 8 <= outW; x += 8) {
      const i16 *base = cbRow + x;
      v128_t cv = wasm_v128_load(base);
      v128_t clo = wasm_i32x4_extend_low_i16x8(cv);
      v128_t chi = wasm_i32x4_extend_high_i16x8(cv);
      v128_t acc_lo = splat_i32(0x8000);
      v128_t acc_hi = splat_i32(0x8000);
      for (i32 i = 1; i <= ry; i++) {
        v128_t tv = wasm_v128_load(base - i * outW);
        v128_t bv = wasm_v128_load(base + i * outW);
        v128_t tlo = wasm_i32x4_extend_low_i16x8(tv);
        v128_t thi = wasm_i32x4_extend_high_i16x8(tv);
        v128_t blo = wasm_i32x4_extend_low_i16x8(bv);
        v128_t bhi = wasm_i32x4_extend_high_i16x8(bv);
        v128_t ci = splat_i32(cy[i - 1]);
        acc_lo = wasm_i32x4_add(acc_lo, wasm_i32x4_mul(wasm_i32x4_add(tlo, blo), ci));
        acc_hi = wasm_i32x4_add(acc_hi, wasm_i32x4_mul(wasm_i32x4_add(thi, bhi), ci));
      }
      // v = center + ((acc - center*totalC) >> 16)
      v128_t vlo = wasm_i32x4_add(clo,
          wasm_i32x4_shr(wasm_i32x4_sub(acc_lo, wasm_i32x4_mul(clo, vTotalC)), 16));
      v128_t vhi = wasm_i32x4_add(chi,
          wasm_i32x4_shr(wasm_i32x4_sub(acc_hi, wasm_i32x4_mul(chi, vTotalC)), 16));
      // v = (v<<16)>>16  (sign-extend to int16)
      vlo = wasm_i32x4_shr(wasm_i32x4_shl(vlo, 16), 16);
      vhi = wasm_i32x4_shr(wasm_i32x4_shl(vhi, 16), 16);
      // o = (v - (v>>8) + dither) >> 6
      v128_t dlo, dhi;
      if (x & 1) { // chunk starts at odd column
        dlo = wasm_i32x4_extend_low_i16x8(dvOddStart);
        dhi = wasm_i32x4_extend_high_i16x8(dvOddStart);
      } else {
        dlo = wasm_i32x4_extend_low_i16x8(dvEvenStart);
        dhi = wasm_i32x4_extend_high_i16x8(dvEvenStart);
      }
      v128_t olo = wasm_i32x4_shr(
          wasm_i32x4_add(wasm_i32x4_sub(vlo, wasm_i32x4_shr(vlo, 8)), dlo), 6);
      v128_t ohi = wasm_i32x4_shr(
          wasm_i32x4_add(wasm_i32x4_sub(vhi, wasm_i32x4_shr(vhi, 8)), dhi), 6);
      olo = wasm_i32x4_min(wasm_i32x4_max(olo, v0), v255);
      ohi = wasm_i32x4_min(wasm_i32x4_max(ohi, v0), v255);
      // pack 8 low bytes: byte 0 of each i32 lane
      v128_t packed = wasm_i8x16_shuffle(olo, ohi,
          0, 4, 8, 12, 16, 20, 24, 28, 0, 0, 0, 0, 0, 0, 0, 0);
      wasm_v128_store64_lane(orow + x, packed, 0);
    }
    for (; x < outW; x++) {
      i32 center = cbRow[x];
      i32 acc = 0x8000;
      for (i32 i = 1; i <= ry; i++)
        acc += (cbRow[x - i * outW] + cbRow[x + i * outW]) * cy[i - 1];
      i32 v = center + ((acc - center * totalC) >> 16);
      v = (v << 16) >> 16;
      i32 dither = (x & 1) ? dOdd : dEven;
      i32 o = (v - (v >> 8) + dither) >> 6;
      orow[x] = (u8)clamp255(o);
    }
  }
}
