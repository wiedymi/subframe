export type MoveParams = {
  from: [number, number];
  to: [number, number];
  t1?: number;
  t2?: number;
};

export type BorderParams = { size: number; x?: number; y?: number };
export type ShadowParams = { depth: number; x?: number; y?: number };

export type ClipRect = {
  type: "rect";
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  inverse: boolean;
};

export type ClipMaskBoxes = {
  hasNz: boolean;
  nzX0: number;
  nzY0: number;
  nzX1: number;
  nzY1: number;
  hasOpaque: boolean;
  opX0: number;
  opY0: number;
  opX1: number;
  opY1: number;
};

export type ClipMask = {
  type: "mask";
  bitmap: Uint8Array;
  width: number;
  height: number;
  stride: number;
  originX: number;
  originY: number;
  inverse: boolean;
  boxes?: ClipMaskBoxes;
};

export type ClipShape = ClipRect | ClipMask;

export type DrawingParams = { scale: number; commands: string };
export type DrawingBaselineParams = { offset: number };
export type ResetParams = { style?: string };
export type RotateParams = { x?: number; y?: number; z?: number };
export type ShearParams = { x?: number; y?: number };
export type OriginParams = { x: number; y: number };

export type AnimateTarget = {
  fontSize?: number;
  scaleX?: number;
  scaleY?: number;
  rotateZ?: number;
  rotateX?: number;
  rotateY?: number;
  shearX?: number;
  shearY?: number;
  spacing?: number;
  border?: number;
  shadow?: number;
  shadowX?: number;
  shadowY?: number;
  blur?: number;
  edgeBlur?: number;
  primaryColor?: number;
  secondaryColor?: number;
  outlineColor?: number;
  backColor?: number;
  alpha?: number;
  primaryAlpha?: number;
  secondaryAlpha?: number;
  outlineAlpha?: number;
  backAlpha?: number;
};

export type AnimateParams = {
  start: number;
  end: number;
  accel: number;
  target: AnimateTarget;
};
