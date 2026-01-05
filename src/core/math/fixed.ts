// Fixed-point helpers for 26.6 (1/64px) math.

export type Fixed26_6 = number;

export const SUBPIXEL_SHIFT = 6;
export const SUBPIXEL_SCALE = 1 << SUBPIXEL_SHIFT;
export const SUBPIXEL_MASK = SUBPIXEL_SCALE - 1;

export function toFixed26_6(px: number): Fixed26_6 {
  return Math.round(px * SUBPIXEL_SCALE);
}

export function fromFixed26_6(v: Fixed26_6): number {
  return v / SUBPIXEL_SCALE;
}

export function quantSubpixel(value: number): number {
  return fromFixed26_6(toFixed26_6(value));
}

export function fixedMul(a: Fixed26_6, b: Fixed26_6): Fixed26_6 {
  return (a * b) >> SUBPIXEL_SHIFT;
}

export function fixedDiv(a: Fixed26_6, b: Fixed26_6): Fixed26_6 {
  return Math.trunc((a << SUBPIXEL_SHIFT) / b);
}
