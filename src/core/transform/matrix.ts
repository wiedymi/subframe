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

  const x1 = [1, shearX, shiftX + ascFixed * shearX];
  const y1 = [shearY, 1, shiftY];

  const x2 = [0, 0, 0];
  const y2 = [0, 0, 0];
  for (let i = 0; i < 3; i++) {
    x2[i] = x1[i]! * cz - y1[i]! * sz;
    y2[i] = x1[i]! * sz + y1[i]! * cz;
  }

  const y3 = [0, 0, 0];
  const z3 = [0, 0, 0];
  for (let i = 0; i < 3; i++) {
    y3[i] = y2[i]! * cx;
    z3[i] = y2[i]! * sx;
  }

  const x4 = [0, 0, 0];
  const z4 = [0, 0, 0];
  for (let i = 0; i < 3; i++) {
    x4[i] = x2[i]! * cy - z3[i]! * sy;
    z4[i] = x2[i]! * sy + z3[i]! * cy;
  }

  const dist = 20000 * blurScaleY;
  z4[2] += dist;

  const scaleX = dist * parScaleX;
  const offsX = gxFixed - shiftX * parScaleX;
  const offsY = gyFixed - shiftY;

  const mFixed = [
    [0, 0, 0],
    [0, 0, 0],
    [0, 0, 0],
  ];
  for (let i = 0; i < 3; i++) {
    mFixed[0]![i] = z4[i]! * offsX + x4[i]! * scaleX;
    mFixed[1]![i] = z4[i]! * offsY + y3[i]! * dist;
    mFixed[2]![i] = z4[i]!;
  }
  const scale = SUBPIXEL_SCALE;
  const scale2 = scale * scale;
  return [
    [mFixed[0]![0]! / scale, mFixed[0]![1]! / scale, mFixed[0]![2]! / scale2],
    [mFixed[1]![0]! / scale, mFixed[1]![1]! / scale, mFixed[1]![2]! / scale2],
    [mFixed[2]![0]!, mFixed[2]![1]!, mFixed[2]![2]! / scale],
  ];
}

export function flipYMatrix3(m: number[][]): number[][] {
  return [
    [m[0]![0]!, -m[0]![1]!, m[0]![2]!],
    [-m[1]![0]!, m[1]![1]!, -m[1]![2]!],
    [m[2]![0]!, -m[2]![1]!, m[2]![2]!],
  ];
}
