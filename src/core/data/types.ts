import type { Fixed26_6 } from "../math/fixed";

export type ColorRGBA = [number, number, number, number];

export type FrameContext = {
  timeMs: number;
  width: number;
  height: number;
  marginL: number;
  marginR: number;
  marginV: number;
  wrapStyle: number;
};

export type GlyphRun = {
  fontName: string;
  fontSizePx: number;
  glyphIds: number[];
  advances: Fixed26_6[];
  offsets: Array<{ x: Fixed26_6; y: Fixed26_6 }>;
};

export type LayoutLine = {
  glyphs: GlyphRun[];
  x: Fixed26_6;
  y: Fixed26_6;
  width: Fixed26_6;
  height: Fixed26_6;
};

export type BitmapLayer = {
  bitmap: Uint8Array;
  width: number;
  height: number;
  stride: number;
  originX: Fixed26_6;
  originY: Fixed26_6;
  color: ColorRGBA;
  z: number;
  clip?:
    | { type: "rect"; x0: number; y0: number; x1: number; y1: number; inverse: boolean }
    | {
        type: "mask";
        bitmap: Uint8Array;
        width: number;
        height: number;
        stride: number;
        originX: number;
        originY: number;
        inverse: boolean;
      };
};

export type RenderItem = {
  textureId: number;
  x: Fixed26_6;
  y: Fixed26_6;
  width: Fixed26_6;
  height: Fixed26_6;
  color: ColorRGBA;
};
