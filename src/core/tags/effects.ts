import type { Effect } from "subforge/core";
import type {
  MoveParams,
  BorderParams,
  ShadowParams,
  DrawingParams,
  DrawingBaselineParams,
  RotateParams,
  ShearParams,
  OriginParams,
} from "./types";

export function findMoveEffect(effects: Effect[]): MoveParams | null {
  for (let i = 0; i < effects.length; i++) {
    const ef = effects[i]!;
    if (ef.type === "move") return ef.params as MoveParams;
  }
  return null;
}

export function findSpacingEffect(effects: Effect[]): number | null {
  for (let i = 0; i < effects.length; i++) {
    const ef = effects[i]!;
    if (ef.type === "spacing") return (ef.params as { value: number }).value;
  }
  return null;
}

export function findScaleEffect(
  effects: Effect[],
): { x: number; y: number } | null {
  for (let i = 0; i < effects.length; i++) {
    const ef = effects[i]!;
    if (ef.type === "scale") return ef.params as { x: number; y: number };
  }
  return null;
}

export function findBorderEffect(effects: Effect[]): BorderParams | null {
  for (let i = 0; i < effects.length; i++) {
    const ef = effects[i]!;
    if (ef.type === "border") return ef.params as BorderParams;
  }
  return null;
}

export function findShadowEffect(effects: Effect[]): ShadowParams | null {
  for (let i = 0; i < effects.length; i++) {
    const ef = effects[i]!;
    if (ef.type === "shadow") return ef.params as ShadowParams;
  }
  return null;
}

export function findBlurEffect(effects: Effect[]): number | null {
  for (let i = 0; i < effects.length; i++) {
    const ef = effects[i]!;
    if (ef.type === "blur") return (ef.params as { strength: number }).strength;
  }
  return null;
}

export function findDrawingEffect(effects: Effect[]): DrawingParams | null {
  for (let i = 0; i < effects.length; i++) {
    const ef = effects[i]!;
    if (ef.type === "drawing") return ef.params as DrawingParams;
  }
  return null;
}

export function findDrawingBaselineEffect(effects: Effect[]): number | null {
  for (let i = 0; i < effects.length; i++) {
    const ef = effects[i]!;
    if (ef.type === "drawingBaseline")
      return (ef.params as DrawingBaselineParams).offset;
  }
  return null;
}

export function findRotateEffect(effects: Effect[]): RotateParams | null {
  for (let i = 0; i < effects.length; i++) {
    const ef = effects[i]!;
    if (ef.type === "rotate") return ef.params as RotateParams;
  }
  return null;
}

export function findShearEffect(effects: Effect[]): ShearParams | null {
  for (let i = 0; i < effects.length; i++) {
    const ef = effects[i]!;
    if (ef.type === "shear") return ef.params as ShearParams;
  }
  return null;
}

export function findOriginEffect(effects: Effect[]): OriginParams | null {
  for (let i = 0; i < effects.length; i++) {
    const ef = effects[i]!;
    if (ef.type === "origin") return ef.params as OriginParams;
  }
  return null;
}

export function findEdgeBlurEffect(effects: Effect[]): number | null {
  for (let i = 0; i < effects.length; i++) {
    const ef = effects[i]!;
    if (ef.type === "unknown") {
      const params = ef.params as { format?: string; raw?: string } | undefined;
      if (params?.format === "ass" && typeof params.raw === "string") {
        const m = params.raw.match(/^\\be(\d+(?:\.\d+)?)$/);
        if (m) return parseFloat(m[1]!);
      }
    }
  }
  return null;
}

export function findKaraokeEffect(
  effects: Effect[],
): { duration: number; mode: "fill" | "fade" | "outline" } | null {
  for (let i = 0; i < effects.length; i++) {
    const ef = effects[i]!;
    if (ef.type === "karaoke")
      return ef.params as {
        duration: number;
        mode: "fill" | "fade" | "outline";
      };
  }
  return null;
}

export function findKaraokeAbsoluteEffect(effects: Effect[]): number | null {
  for (let i = 0; i < effects.length; i++) {
    const ef = effects[i]!;
    if (ef.type === "karaokeAbsolute") {
      const time = (ef.params as { time: number }).time;
      if (Number.isFinite(time)) return time * 10;
      return null;
    }
  }
  return null;
}
