import { PixelMode } from "text-shaper";

type GrayBitmap = {
  buffer: Uint8Array;
  width: number;
  rows: number;
  pitch: number;
  pixelMode: PixelMode;
  numGrays?: number;
};

type BlurMethod = {
  level: number;
  radius: number;
  coeff: Int16Array;
};

const blurMethodCache = new Map<number, BlurMethod>();
let blurScratchA = new Int16Array(0);
let blurScratchB = new Int16Array(0);

const DITHER_LINE = new Int16Array([
  8, 40, 8, 40, 8, 40, 8, 40, 8, 40, 8, 40, 8, 40, 8, 40,
  56, 24, 56, 24, 56, 24, 56, 24, 56, 24, 56, 24, 56, 24, 56, 24,
]);

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
      (coeff[i] ?? 0) * kernel[0] +
      (prev1 + (coeff[i + 1] ?? 0)) * kernel[1] +
      (prev2 + (coeff[i + 2] ?? 0)) * kernel[2] +
      (prev3 + (coeff[i + 3] ?? 0)) * kernel[3];
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
      mat[j]![i] = mat[i]![j];
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

function findBestMethod(r2: number): BlurMethod {
  const cached = blurMethodCache.get(r2);
  if (cached) return cached;
  const mu = new Float64Array(8);
  let level = 0;
  let radius = 4;

  if (r2 < 0.5) {
    level = 0;
    radius = 4;
    mu[1] = 0.085 * r2 * r2 * r2;
    mu[0] = 0.5 * r2 - 4 * mu[1];
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

function shrinkFunc(p1p: number, p1n: number, z0p: number, z0n: number, n1p: number, n1n: number): number {
  let r = ((p1p + p1n + n1p + n1n) >> 1) | 0;
  r = ((r + z0p + z0n) >> 1) | 0;
  r = ((r + p1n + n1p) >> 1) | 0;
  return ((r + z0p + z0n + 2) >> 2) | 0;
}

function expandFunc(p1: number, z0: number, n1: number): [number, number] {
  const r = ((((p1 + n1) >> 1) + z0) >> 1) | 0;
  const rp = ((((r + p1) >> 1) + z0 + 1) >> 1) | 0;
  const rn = ((((r + n1) >> 1) + z0 + 1) >> 1) | 0;
  return [rp, rn];
}

function unpackToInt16(src: Uint8Array, width: number, height: number, stride: number, dst: Int16Array): void {
  let di = 0;
  for (let y = 0; y < height; y++) {
    const row = y * stride;
    for (let x = 0; x < width; x++) {
      const v = src[row + x] ?? 0;
      dst[di++] = (((v << 7) | (v >> 1)) + 1) >> 1;
    }
  }
}

function packFromInt16(src: Int16Array, width: number, height: number, dst: Uint8Array): void {
  let si = 0;
  for (let y = 0; y < height; y++) {
    const ditherRow = (y & 1) << 4;
    for (let x = 0; x < width; x++) {
      const dither = DITHER_LINE[ditherRow + (x & 15)] ?? 0;
      const v = src[si++] ?? 0;
      let out = (v - (v >> 8) + dither) >> 6;
      if (out < 0) out = 0;
      else if (out > 255) out = 255;
      dst[y * width + x] = out;
    }
  }
}

function shrinkHorz(dst: Int16Array, src: Int16Array, w: number, h: number): number {
  const dstW = (w + 5) >> 1;
  for (let y = 0; y < h; y++) {
    const srcRow = y * w;
    const dstRow = y * dstW;
    for (let x = 0; x < dstW; x++) {
      const sx = x * 2;
      const p1p = sx - 4 >= 0 && sx - 4 < w ? src[srcRow + sx - 4]! : 0;
      const p1n = sx - 3 >= 0 && sx - 3 < w ? src[srcRow + sx - 3]! : 0;
      const z0p = sx - 2 >= 0 && sx - 2 < w ? src[srcRow + sx - 2]! : 0;
      const z0n = sx - 1 >= 0 && sx - 1 < w ? src[srcRow + sx - 1]! : 0;
      const n1p = sx >= 0 && sx < w ? src[srcRow + sx]! : 0;
      const n1n = sx + 1 >= 0 && sx + 1 < w ? src[srcRow + sx + 1]! : 0;
      dst[dstRow + x] = shrinkFunc(p1p, p1n, z0p, z0n, n1p, n1n);
    }
  }
  return dstW;
}

function shrinkVert(dst: Int16Array, src: Int16Array, w: number, h: number): number {
  const dstH = (h + 5) >> 1;
  for (let x = 0; x < w; x++) {
    for (let y = 0; y < dstH; y++) {
      const sy = y * 2;
      const p1p = sy - 4 >= 0 && sy - 4 < h ? src[(sy - 4) * w + x]! : 0;
      const p1n = sy - 3 >= 0 && sy - 3 < h ? src[(sy - 3) * w + x]! : 0;
      const z0p = sy - 2 >= 0 && sy - 2 < h ? src[(sy - 2) * w + x]! : 0;
      const z0n = sy - 1 >= 0 && sy - 1 < h ? src[(sy - 1) * w + x]! : 0;
      const n1p = sy >= 0 && sy < h ? src[sy * w + x]! : 0;
      const n1n = sy + 1 >= 0 && sy + 1 < h ? src[(sy + 1) * w + x]! : 0;
      dst[y * w + x] = shrinkFunc(p1p, p1n, z0p, z0n, n1p, n1n);
    }
  }
  return dstH;
}

function expandHorz(dst: Int16Array, src: Int16Array, w: number, h: number): number {
  const dstW = w * 2 + 4;
  for (let y = 0; y < h; y++) {
    const srcRow = y * w;
    const dstRow = y * dstW;
    for (let x = 0; x < dstW; x++) {
      const k = x >> 1;
      const p1 = k - 2 >= 0 && k - 2 < w ? src[srcRow + k - 2]! : 0;
      const z0 = k - 1 >= 0 && k - 1 < w ? src[srcRow + k - 1]! : 0;
      const n1 = k >= 0 && k < w ? src[srcRow + k]! : 0;
      const [rp, rn] = expandFunc(p1, z0, n1);
      dst[dstRow + x] = (x & 1) === 0 ? rp : rn;
    }
  }
  return dstW;
}

function expandVert(dst: Int16Array, src: Int16Array, w: number, h: number): number {
  const dstH = h * 2 + 4;
  for (let x = 0; x < w; x++) {
    for (let y = 0; y < dstH; y++) {
      const k = y >> 1;
      const p1 = k - 2 >= 0 && k - 2 < h ? src[(k - 2) * w + x]! : 0;
      const z0 = k - 1 >= 0 && k - 1 < h ? src[(k - 1) * w + x]! : 0;
      const n1 = k >= 0 && k < h ? src[k * w + x]! : 0;
      const [rp, rn] = expandFunc(p1, z0, n1);
      dst[y * w + x] = (y & 1) === 0 ? rp : rn;
    }
  }
  return dstH;
}

function blurHorz(dst: Int16Array, src: Int16Array, w: number, h: number, radius: number, coeff: Int16Array): number {
  const dstW = w + 2 * radius;
  for (let y = 0; y < h; y++) {
    const srcRow = y * w;
    const dstRow = y * dstW;
    for (let x = 0; x < dstW; x++) {
      const cx = x - radius;
      const center = cx >= 0 && cx < w ? src[srcRow + cx]! : 0;
      let acc = 0x8000;
      for (let i = radius; i > 0; i--) {
        const leftIdx = cx - i;
        const rightIdx = cx + i;
        const left = leftIdx >= 0 && leftIdx < w ? src[srcRow + leftIdx]! : 0;
        const right = rightIdx >= 0 && rightIdx < w ? src[srcRow + rightIdx]! : 0;
        const c = coeff[i - 1]!;
        acc += (left - center) * c + (right - center) * c;
      }
      dst[dstRow + x] = (center + (acc >> 16)) | 0;
    }
  }
  return dstW;
}

function blurVert(dst: Int16Array, src: Int16Array, w: number, h: number, radius: number, coeff: Int16Array): number {
  const dstH = h + 2 * radius;
  for (let x = 0; x < w; x++) {
    for (let y = 0; y < dstH; y++) {
      const cy = y - radius;
      const center = cy >= 0 && cy < h ? src[cy * w + x]! : 0;
      let acc = 0x8000;
      for (let i = radius; i > 0; i--) {
        const topIdx = cy - i;
        const botIdx = cy + i;
        const top = topIdx >= 0 && topIdx < h ? src[topIdx * w + x]! : 0;
        const bot = botIdx >= 0 && botIdx < h ? src[botIdx * w + x]! : 0;
        const c = coeff[i - 1]!;
        acc += (top - center) * c + (bot - center) * c;
      }
      dst[y * w + x] = (center + (acc >> 16)) | 0;
    }
  }
  return dstH;
}

export function libassGaussianBlur(
  bitmap: GrayBitmap,
  r2x: number,
  r2y: number,
): { bitmap: GrayBitmap; shiftX: number; shiftY: number } {
  if (bitmap.width <= 0 || bitmap.rows <= 0) {
    return { bitmap, shiftX: 0, shiftY: 0 };
  }
  if (bitmap.pixelMode !== PixelMode.Gray) {
    return { bitmap, shiftX: 0, shiftY: 0 };
  }
  if (!(r2x > 0.001 || r2y > 0.001)) {
    return { bitmap, shiftX: 0, shiftY: 0 };
  }

  const blurX = findBestMethod(r2x);
  const blurY = r2y === r2x ? blurX : findBestMethod(r2y);

  let w = bitmap.width;
  let h = bitmap.rows;
  const offsetX = ((2 * blurX.radius + 9) << blurX.level) - 5;
  const offsetY = ((2 * blurY.radius + 9) << blurY.level) - 5;
  const endW = ((w + offsetX) & ~((1 << blurX.level) - 1)) - 4;
  const endH = ((h + offsetY) & ~((1 << blurY.level) - 1)) - 4;

  const maxSize = Math.max(w * h, endW * endH);
  if (blurScratchA.length < maxSize) {
    blurScratchA = new Int16Array(maxSize);
    blurScratchB = new Int16Array(maxSize);
  }
  let src = blurScratchA;
  let dst = blurScratchB;

  unpackToInt16(bitmap.buffer, w, h, bitmap.pitch, src);

  for (let i = 0; i < blurY.level; i++) {
    h = shrinkVert(dst, src, w, h);
    const tmp = src;
    src = dst;
    dst = tmp;
  }

  for (let i = 0; i < blurX.level; i++) {
    w = shrinkHorz(dst, src, w, h);
    const tmp = src;
    src = dst;
    dst = tmp;
  }

  w = blurHorz(dst, src, w, h, blurX.radius, blurX.coeff);
  {
    const tmp = src;
    src = dst;
    dst = tmp;
  }

  h = blurVert(dst, src, w, h, blurY.radius, blurY.coeff);
  {
    const tmp = src;
    src = dst;
    dst = tmp;
  }

  for (let i = 0; i < blurX.level; i++) {
    w = expandHorz(dst, src, w, h);
    const tmp = src;
    src = dst;
    dst = tmp;
  }

  for (let i = 0; i < blurY.level; i++) {
    h = expandVert(dst, src, w, h);
    const tmp = src;
    src = dst;
    dst = tmp;
  }

  const outW = w < endW ? w : endW;
  const outH = h < endH ? h : endH;
  const outBuffer = new Uint8Array(outW * outH);

  for (let y = 0; y < outH; y++) {
    const srcRow = y * w;
    const dstRow = y * outW;
    const ditherRow = (y & 1) << 4;
    for (let x = 0; x < outW; x++) {
      const v = src[srcRow + x] ?? 0;
      const dither = DITHER_LINE[ditherRow + (x & 15)] ?? 0;
      let out = (v - (v >> 8) + dither) >> 6;
      if (out < 0) out = 0;
      else if (out > 255) out = 255;
      outBuffer[dstRow + x] = out;
    }
  }

  const shiftX = ((blurX.radius + 4) << blurX.level) - 4;
  const shiftY = ((blurY.radius + 4) << blurY.level) - 4;

  const outBitmap = {
    buffer: outBuffer,
    width: outW,
    rows: outH,
    pitch: outW,
    pixelMode: PixelMode.Gray,
    numGrays: 256,
  };

  return { bitmap: outBitmap, shiftX, shiftY };
}
