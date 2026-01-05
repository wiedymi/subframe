import type { Effect, SubtitleEvent } from "subforge/core";
import type { ColorRGBA } from "../data/types";
import type { AnimateParams } from "../tags/types";
import { abgrToRgba } from "../style/color";

export function findAnimateEffects(effects: Effect[]): AnimateParams[] {
  const out: AnimateParams[] = [];
  for (let i = 0; i < effects.length; i++) {
    const ef = effects[i]!;
    if (ef.type === "animate") {
      const params = ef.params as AnimateParams;
      if (params && params.target && Object.keys(params.target).length > 0)
        out[out.length] = params;
    }
  }
  return out;
}

function animateProgress(
  timeMs: number,
  ev: SubtitleEvent,
  anim: AnimateParams,
): number {
  const local = timeMs - ev.start;
  const duration = ev.end - ev.start;
  let start = anim.start;
  let end = anim.end;
  if (start === 0 && end === 0) end = duration;
  if (end <= start) return local >= end ? 1 : 0;
  if (local <= start) return 0;
  if (local >= end) return 1;
  let t = (local - start) / (end - start);
  const accel = anim.accel ?? 1;
  if (accel !== 1) t = Math.pow(t, accel);
  return t;
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function lerpInt(a: number, b: number, t: number): number {
  return Math.round(a + (b - a) * t);
}

export function applyAnimateNumeric(
  state: {
    fontSize: number;
    scaleX: number;
    scaleY: number;
    rotateZ: number;
    rotateX: number;
    rotateY: number;
    shearX: number;
    shearY: number;
    spacing: number;
    border: number;
    shadow: number;
    shadowX: number;
    shadowY: number;
    blur: number;
    edgeBlur: number;
  },
  anims: AnimateParams[],
  timeMs: number,
  ev: SubtitleEvent,
): void {
  for (let i = 0; i < anims.length; i++) {
    const anim = anims[i]!;
    const t = animateProgress(timeMs, ev, anim);
    if (t <= 0) continue;
    const target = anim.target;
    if (target.fontSize !== undefined)
      state.fontSize = lerp(state.fontSize, target.fontSize, t);
    if (target.scaleX !== undefined)
      state.scaleX = lerp(state.scaleX, target.scaleX, t);
    if (target.scaleY !== undefined)
      state.scaleY = lerp(state.scaleY, target.scaleY, t);
    if (target.rotateZ !== undefined)
      state.rotateZ = lerp(state.rotateZ, target.rotateZ, t);
    if (target.rotateX !== undefined)
      state.rotateX = lerp(state.rotateX, target.rotateX, t);
    if (target.rotateY !== undefined)
      state.rotateY = lerp(state.rotateY, target.rotateY, t);
    if (target.shearX !== undefined)
      state.shearX = lerp(state.shearX, target.shearX, t);
    if (target.shearY !== undefined)
      state.shearY = lerp(state.shearY, target.shearY, t);
    if (target.spacing !== undefined)
      state.spacing = lerp(state.spacing, target.spacing, t);
    if (target.border !== undefined)
      state.border = lerp(state.border, target.border, t);
    if (target.shadow !== undefined)
      state.shadow = lerp(state.shadow, target.shadow, t);
    if (target.shadowX !== undefined)
      state.shadowX = lerp(state.shadowX, target.shadowX, t);
    if (target.shadowY !== undefined)
      state.shadowY = lerp(state.shadowY, target.shadowY, t);
    if (target.blur !== undefined)
      state.blur = lerp(state.blur, target.blur, t);
    if (target.edgeBlur !== undefined)
      state.edgeBlur = lerp(state.edgeBlur, target.edgeBlur, t);
  }
}

export function applyAnimateColors(
  colors: {
    primary: ColorRGBA;
    secondary: ColorRGBA;
    outline: ColorRGBA;
    shadow: ColorRGBA;
  },
  anims: AnimateParams[],
  timeMs: number,
  ev: SubtitleEvent,
): void {
  for (let i = 0; i < anims.length; i++) {
    const anim = anims[i]!;
    const t = animateProgress(timeMs, ev, anim);
    if (t <= 0) continue;
    const target = anim.target;
    if (target.primaryColor !== undefined) {
      const c = abgrToRgba(target.primaryColor);
      colors.primary = [
        lerpInt(colors.primary[0], c[0], t),
        lerpInt(colors.primary[1], c[1], t),
        lerpInt(colors.primary[2], c[2], t),
        lerpInt(colors.primary[3], c[3], t),
      ];
    }
    if (target.secondaryColor !== undefined) {
      const c = abgrToRgba(target.secondaryColor);
      colors.secondary = [
        lerpInt(colors.secondary[0], c[0], t),
        lerpInt(colors.secondary[1], c[1], t),
        lerpInt(colors.secondary[2], c[2], t),
        lerpInt(colors.secondary[3], c[3], t),
      ];
    }
    if (target.outlineColor !== undefined) {
      const c = abgrToRgba(target.outlineColor);
      colors.outline = [
        lerpInt(colors.outline[0], c[0], t),
        lerpInt(colors.outline[1], c[1], t),
        lerpInt(colors.outline[2], c[2], t),
        lerpInt(colors.outline[3], c[3], t),
      ];
    }
    if (target.backColor !== undefined) {
      const c = abgrToRgba(target.backColor);
      colors.shadow = [
        lerpInt(colors.shadow[0], c[0], t),
        lerpInt(colors.shadow[1], c[1], t),
        lerpInt(colors.shadow[2], c[2], t),
        lerpInt(colors.shadow[3], c[3], t),
      ];
    }
    if (target.alpha !== undefined) {
      const a = 255 - (target.alpha & 0xff);
      colors.primary[3] = lerpInt(colors.primary[3], a, t);
      colors.secondary[3] = lerpInt(colors.secondary[3], a, t);
      colors.outline[3] = lerpInt(colors.outline[3], a, t);
      colors.shadow[3] = lerpInt(colors.shadow[3], a, t);
    }
    if (target.primaryAlpha !== undefined) {
      const a = 255 - (target.primaryAlpha & 0xff);
      colors.primary[3] = lerpInt(colors.primary[3], a, t);
    }
    if (target.secondaryAlpha !== undefined) {
      const a = 255 - (target.secondaryAlpha & 0xff);
      colors.secondary[3] = lerpInt(colors.secondary[3], a, t);
    }
    if (target.outlineAlpha !== undefined) {
      const a = 255 - (target.outlineAlpha & 0xff);
      colors.outline[3] = lerpInt(colors.outline[3], a, t);
    }
    if (target.backAlpha !== undefined) {
      const a = 255 - (target.backAlpha & 0xff);
      colors.shadow[3] = lerpInt(colors.shadow[3], a, t);
    }
  }
}
