export function itemRotateOrShear(
  rotateZ: number,
  rotateX: number,
  rotateY: number,
  shearX: number,
  shearY: number,
): boolean {
  return (
    rotateZ !== 0 ||
    rotateX !== 0 ||
    rotateY !== 0 ||
    shearX !== 0 ||
    shearY !== 0
  );
}
