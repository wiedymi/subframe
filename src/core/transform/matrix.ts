import { SUBPIXEL_SCALE, toFixed26_6 } from "../math/fixed";

export function transformPoint(
  x: number,
  y: number,
  originX: number,
  originY: number,
  rotateDeg: number,
  shearX: number,
  shearY: number,
  rotateXDeg: number,
  rotateYDeg: number,
  asc: number,
  parScaleX: number,
  blurScaleY: number,
): { x: number; y: number } {
  if (
    rotateDeg !== 0 ||
    rotateXDeg !== 0 ||
    rotateYDeg !== 0 ||
    shearX !== 0 ||
    shearY !== 0
  ) {
    const matrix = buildTransformMatrix(
      x,
      y,
      originX,
      originY,
      rotateDeg,
      rotateXDeg,
      rotateYDeg,
      shearX,
      shearY,
      asc,
      parScaleX,
      blurScaleY,
    );
    return applyMatrix3x3(x, y, matrix);
  }

  return { x, y };
}

export function mulMat3(a: number[][], b: number[][]): number[][] {
  const out = [
    [0, 0, 0],
    [0, 0, 0],
    [0, 0, 0],
  ];
  for (let i = 0; i < 3; i++) {
    const ai0 = a[i]![0]!;
    const ai1 = a[i]![1]!;
    const ai2 = a[i]![2]!;
    out[i]![0] = ai0 * b[0]![0]! + ai1 * b[1]![0]! + ai2 * b[2]![0]!;
    out[i]![1] = ai0 * b[0]![1]! + ai1 * b[1]![1]! + ai2 * b[2]![1]!;
    out[i]![2] = ai0 * b[0]![2]! + ai1 * b[1]![2]! + ai2 * b[2]![2]!;
  }
  return out;
}

export function applyMatrix3x3(
  x: number,
  y: number,
  m: number[][],
): { x: number; y: number } {
  const w = m[2]![0]! * x + m[2]![1]! * y + m[2]![2]!;
  const minW = 0.01;
  const denom = w < minW ? minW : w;
  return {
    x: (m[0]![0]! * x + m[0]![1]! * y + m[0]![2]!) / denom,
    y: (m[1]![0]! * x + m[1]![1]! * y + m[1]![2]!) / denom,
  };
}

// Reused output for buildTransformMatrix. The returned matrix is consumed
// synchronously (quantize/restore/perspective/cache-key) within the same glyph
// iteration and never retained across another buildTransformMatrix call, so a
// single module-scratch 3x3 avoids allocating ~16 short-lived arrays per glyph.
// The math below is the scalar unroll of the former array pipeline: identical
// operations, identical order, so the bits are unchanged.
const btmOut: number[][] = [
  [0, 0, 0],
  [0, 0, 0],
  [0, 0, 0],
];

export function buildTransformMatrix(
  gx: number,
  gy: number,
  originX: number,
  originY: number,
  rotateZDeg: number,
  rotateXDeg: number,
  rotateYDeg: number,
  shearX: number,
  shearY: number,
  asc: number,
  parScaleX: number,
  blurScaleY: number,
): number[][] {
  const gxFixed = toFixed26_6(gx);
  const gyFixed = toFixed26_6(gy);
  const originXFixed = toFixed26_6(originX);
  const originYFixed = toFixed26_6(originY);
  const ascFixed = toFixed26_6(asc);
  const frx = (rotateXDeg * Math.PI) / 180;
  const fry = (rotateYDeg * Math.PI) / 180;
  const frz = (rotateZDeg * Math.PI) / 180;
  const sx = -Math.sin(frx);
  const cx = Math.cos(frx);
  const sy = Math.sin(fry);
  const cy = Math.cos(fry);
  const sz = -Math.sin(frz);
  const cz = Math.cos(frz);

  const shiftX = gxFixed - originXFixed;
  const shiftY = gyFixed - originYFixed;

  // x1 = [1, shearX, shiftX + ascFixed*shearX]; y1 = [shearY, 1, shiftY]
  const x1_0 = 1;
  const x1_1 = shearX;
  const x1_2 = shiftX + ascFixed * shearX;
  const y1_0 = shearY;
  const y1_1 = 1;
  const y1_2 = shiftY;

  // x2 = x1*cz - y1*sz; y2 = x1*sz + y1*cz
  const x2_0 = x1_0 * cz - y1_0 * sz;
  const x2_1 = x1_1 * cz - y1_1 * sz;
  const x2_2 = x1_2 * cz - y1_2 * sz;
  const y2_0 = x1_0 * sz + y1_0 * cz;
  const y2_1 = x1_1 * sz + y1_1 * cz;
  const y2_2 = x1_2 * sz + y1_2 * cz;

  // y3 = y2*cx; z3 = y2*sx
  const y3_0 = y2_0 * cx;
  const y3_1 = y2_1 * cx;
  const y3_2 = y2_2 * cx;
  const z3_0 = y2_0 * sx;
  const z3_1 = y2_1 * sx;
  const z3_2 = y2_2 * sx;

  // x4 = x2*cy - z3*sy; z4 = x2*sy + z3*cy
  const x4_0 = x2_0 * cy - z3_0 * sy;
  const x4_1 = x2_1 * cy - z3_1 * sy;
  const x4_2 = x2_2 * cy - z3_2 * sy;
  const z4_0 = x2_0 * sy + z3_0 * cy;
  const z4_1 = x2_1 * sy + z3_1 * cy;
  const dist = 20000 * blurScaleY;
  const z4_2 = x2_2 * sy + z3_2 * cy + dist; // z4[2] += dist

  const scaleX = dist * parScaleX;
  const offsX = gxFixed - shiftX * parScaleX;
  const offsY = gyFixed - shiftY;

  // mFixed[0][i] = z4[i]*offsX + x4[i]*scaleX
  // mFixed[1][i] = z4[i]*offsY + y3[i]*dist
  // mFixed[2][i] = z4[i]
  const m00 = z4_0 * offsX + x4_0 * scaleX;
  const m01 = z4_1 * offsX + x4_1 * scaleX;
  const m02 = z4_2 * offsX + x4_2 * scaleX;
  const m10 = z4_0 * offsY + y3_0 * dist;
  const m11 = z4_1 * offsY + y3_1 * dist;
  const m12 = z4_2 * offsY + y3_2 * dist;
  const m20 = z4_0;
  const m21 = z4_1;
  const m22 = z4_2;

  const scale = SUBPIXEL_SCALE;
  const scale2 = scale * scale;
  const r0 = btmOut[0]!;
  const r1 = btmOut[1]!;
  const r2 = btmOut[2]!;
  r0[0] = m00 / scale;
  r0[1] = m01 / scale;
  r0[2] = m02 / scale2;
  r1[0] = m10 / scale;
  r1[1] = m11 / scale;
  r1[2] = m12 / scale2;
  r2[0] = m20;
  r2[1] = m21;
  r2[2] = m22 / scale;
  return btmOut;
}

export function flipYMatrix3(m: number[][]): number[][] {
  return [
    [m[0]![0]!, -m[0]![1]!, m[0]![2]!],
    [-m[1]![0]!, m[1]![1]!, -m[1]![2]!],
    [m[2]![0]!, -m[2]![1]!, m[2]![2]!],
  ];
}

// Port of libass quantize_transform()/restore_transform()
// (refs/libass/libass/ass_render.c:676-828 and 829-866), reformulated in
// pixel units: libass works on 26.6 outline coords with
// POSITION_PRECISION = 8.0 (1/64 px units) and pads the bbox half-size by
// 64 outline units; expressing lengths in pixels keeps the quantized
// integers (qm, qr) bit-comparable as long as the caller passes the pad
// (64 outline units) converted to pixels for the glyph's outline scale
// (= fontSize * axis scale / 256, the libass ft_size master size from
// fix_glyph_scaling, ass_render.c:2185-2206).
const QT_POSITION_PRECISION = 8.0 / 64; // px
const QT_MAX_PERSP_SCALE = 16.0;
const QT_SUBPIXEL_SCALE = 8; // 1 << SUBPIXEL_ORDER (ass_render.c:225)
const QT_MAX_VAL = 1000000;

// ass_lrint rounds half-to-even (C99 default rounding mode); Math.round
// rounds half up, which would diverge on exact .5 ties.
function lrint(v: number): number {
  // Math.round rounds ties toward +inf, so a tie always lands on k + 1 for
  // v = k + 0.5; stepping down by one restores the even neighbor.
  const r = Math.round(v);
  if (Math.abs(v % 1) === 0.5 && r % 2 !== 0) return r - 1;
  return r;
}

export type PathCbox = {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
};

export type QuantizedTransform = {
  // Integer device position of the glyph (px); the restored matrix maps the
  // source path to coordinates relative to this point.
  posX: number;
  posY: number;
  // Subpixel offset in 1/8 px units (0..7), baked into the restored matrix.
  offsetX: number;
  offsetY: number;
  // Quantized matrix coefficients (libass BitmapHashKey matrix_x/y/z).
  qm: [number, number, number, number, number, number];
};

// ass_render.c:676-828 quantize_transform(). `m` is the libass-convention
// device matrix in pixel units (buildTransformMatrix output, pre-flip),
// `cbox` the untransformed path control box in the same y-down space the
// matrix consumes. `delta` chains rounding residuals across the glyphs of a
// run (ass_render.c:2749: first = !current_info->bitmap_count): pass null
// for the first pass of a run; subsequent passes reuse the returned residual.
// Reused output for quantizeTransform. The result (and its nested q/qm) is
// consumed synchronously by quantizeDeviceMatrix — restore_transform reads the
// coefficients, then posX/posY/residual are read — before the next
// quantizeTransform call, and it never escapes further, so a module-scratch
// result avoids ~9 short-lived arrays plus two objects per call. The scalar
// unroll below performs the identical operations in the identical order as the
// former array pipeline, so the quantized integers and residual bits match.
const qtQm: [number, number, number, number, number, number] = [
  0, 0, 0, 0, 0, 0,
];
const qtQ: QuantizedTransform = {
  posX: 0,
  posY: 0,
  offsetX: 0,
  offsetY: 0,
  qm: qtQm,
};
const qtResult: {
  q: QuantizedTransform;
  residualX: number;
  residualY: number;
} = { q: qtQ, residualX: 0, residualY: 0 };

export function quantizeTransform(
  m: number[][],
  cbox: PathCbox,
  delta: { x: number; y: number } | null,
  padX: number,
  padY: number,
): { q: QuantizedTransform; residualX: number; residualY: number } | null {
  const x0 = (cbox.minX + cbox.maxX) / 2;
  const y0 = (cbox.minY + cbox.maxY) / 2;
  const dx = (cbox.maxX - cbox.minX) / 2 + padX;
  const dy = (cbox.maxY - cbox.minY) / 2 + padY;

  const m0 = m[0]!;
  const m1 = m[1]!;
  const m2 = m[2]!;
  const m00 = m0[0]!;
  const m01 = m0[1]!;
  const m02 = m0[2]!;
  const m10 = m1[0]!;
  const m11 = m1[1]!;
  const m12 = m1[2]!;
  const m20 = m2[0]!;
  const m21 = m2[1]!;
  const m22 = m2[2]!;

  // Change input origin to the bbox center (ass_render.c:696-697).
  const t0 = m02 + m00 * x0 + m01 * y0;
  const t1 = m12 + m10 * x0 + m11 * y0;
  const t2 = m22 + m20 * x0 + m21 * y0;
  if (t2 <= 0) return null;

  let w = 1 / t2;
  const center0 = t0 * w;
  const center1 = t1 * w;
  // Change output origin to the transformed center (ass_render.c:705-708).
  const mm00 = m00 - m20 * center0;
  const mm01 = m01 - m21 * center0;
  const mm10 = m10 - m20 * center1;
  const mm11 = m11 - m21 * center1;
  const mm20 = m20;
  const mm21 = m21;

  // Quantize the center position to 1/8 px (ass_render.c:716-723).
  let cx = center0 * QT_SUBPIXEL_SCALE;
  if (delta) cx -= delta.x;
  if (!(Math.abs(cx) < QT_MAX_VAL)) return null;
  const qr0 = lrint(cx);
  const residual0 = cx - qr0;
  let cy = center1 * QT_SUBPIXEL_SCALE;
  if (delta) cy -= delta.y;
  if (!(Math.abs(cy) < QT_MAX_VAL)) return null;
  const qr1 = lrint(cy);
  const residual1 = cy - qr1;

  // Quantize matrix coefficients (ass_render.c:726-786).
  const z0 = t2 - Math.abs(mm20) * dx - Math.abs(mm21) * dy;
  w = 1 / QT_POSITION_PRECISION / Math.max(z0, t2 / QT_MAX_PERSP_SCALE);
  const mul0 = dx * w;
  const mul1 = dy * w;

  let val = mm00 * mul0;
  if (!(Math.abs(val) < QT_MAX_VAL)) return null;
  const qm0 = lrint(val);
  val = mm01 * mul1;
  if (!(Math.abs(val) < QT_MAX_VAL)) return null;
  const qm1 = lrint(val);
  val = mm10 * mul0;
  if (!(Math.abs(val) < QT_MAX_VAL)) return null;
  const qm2 = lrint(val);
  val = mm11 * mul1;
  if (!(Math.abs(val) < QT_MAX_VAL)) return null;
  const qm3 = lrint(val);

  const qmx = Math.abs(qm0) + Math.abs(qm1);
  const qmy = Math.abs(qm2) + Math.abs(qm3);
  const w2 = QT_POSITION_PRECISION * Math.max(qmx, qmy);
  val = mm20 * mul0 * w2;
  if (!(Math.abs(val) < QT_MAX_VAL)) return null;
  const qm4 = lrint(val);
  val = mm21 * mul1 * w2;
  if (!(Math.abs(val) < QT_MAX_VAL)) return null;
  const qm5 = lrint(val);

  qtQm[0] = qm0;
  qtQm[1] = qm1;
  qtQm[2] = qm2;
  qtQm[3] = qm3;
  qtQm[4] = qm4;
  qtQm[5] = qm5;
  qtQ.posX = qr0 >> 3;
  qtQ.posY = qr1 >> 3;
  qtQ.offsetX = qr0 & 7;
  qtQ.offsetY = qr1 & 7;
  qtResult.residualX = residual0;
  qtResult.residualY = residual1;
  return qtResult;
}

// ass_render.c:829-866 restore_transform(). Returns the matrix that maps the
// original (uncentered) path coords to device pixels relative to (posX, posY).
export function restoreTransform(
  q: QuantizedTransform,
  cbox: PathCbox,
  padX: number,
  padY: number,
): number[][] {
  const x0 = (cbox.minX + cbox.maxX) / 2;
  const y0 = (cbox.minY + cbox.maxY) / 2;
  const dx = (cbox.maxX - cbox.minX) / 2 + padX;
  const dy = (cbox.maxY - cbox.minY) / 2 + padY;

  const qx = QT_POSITION_PRECISION / dx;
  const qy = QT_POSITION_PRECISION / dy;
  const m = [
    [q.qm[0] * qx, q.qm[1] * qy, 0],
    [q.qm[2] * qx, q.qm[3] * qy, 0],
    [0, 0, 1],
  ];

  const qmx = Math.abs(q.qm[0]) + Math.abs(q.qm[1]);
  const qmy = Math.abs(q.qm[2]) + Math.abs(q.qm[3]);
  const scaleZ = 1 / QT_POSITION_PRECISION / Math.max(qmx, qmy);
  m[2]![0] = q.qm[4] * qx * scaleZ;
  m[2]![1] = q.qm[5] * qy * scaleZ;

  let m22 = 1 + Math.abs(m[2]![0]!) * dx + Math.abs(m[2]![1]!) * dy;
  m22 = Math.min(m22, QT_MAX_PERSP_SCALE);
  m[2]![2] = m22;

  const cx = q.offsetX / QT_SUBPIXEL_SCALE;
  const cy = q.offsetY / QT_SUBPIXEL_SCALE;
  for (let j = 0; j < 3; j++) {
    m[0]![j]! += m[2]![j]! * cx;
    m[1]![j]! += m[2]![j]! * cy;
  }
  for (let i = 0; i < 3; i++)
    m[i]![2]! -= m[i]![0]! * x0 + m[i]![1]! * y0;
  return m;
}

// Translate the projected output of a homogeneous matrix by an integer pixel
// offset (the quantized position), producing a full device-space matrix.
export function translateProjective(
  m: number[][],
  tx: number,
  ty: number,
): number[][] {
  return [
    [
      m[0]![0]! + m[2]![0]! * tx,
      m[0]![1]! + m[2]![1]! * tx,
      m[0]![2]! + m[2]![2]! * tx,
    ],
    [
      m[1]![0]! + m[2]![0]! * ty,
      m[1]![1]! + m[2]![1]! * ty,
      m[1]![2]! + m[2]![2]! * ty,
    ],
    [m[2]![0]!, m[2]![1]!, m[2]![2]!],
  ];
}
