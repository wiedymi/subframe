import type { SubtitleEvent, Effect } from "subforge/core";
import type { ColorRGBA } from "../data/types";

export function findFadeEffect(
  effects: Effect[],
): { in: number; out: number } | null {
  for (let i = 0; i < effects.length; i++) {
    const ef = effects[i]!;
    if (ef.type === "fade") return ef.params as { in: number; out: number };
  }
  return null;
}

export function findFadeComplexEffect(
  effects: Effect[],
): {
  alphas: [number, number, number];
  times: [number, number, number, number];
} | null {
  for (let i = 0; i < effects.length; i++) {
    const ef = effects[i]!;
    if (ef.type === "fadeComplex")
      return ef.params as {
        alphas: [number, number, number];
        times: [number, number, number, number];
      };
  }
  return null;
}

export function fadeFactorSimple(
  timeMs: number,
  ev: SubtitleEvent,
  fadeIn: number,
  fadeOut: number,
): number {
  const start = ev.start;
  const end = ev.end;
  if (timeMs < start) return 0;
  if (timeMs >= end) return 0;

  if (fadeIn > 0 && timeMs < start + fadeIn) {
    return (timeMs - start) / fadeIn;
  }
  if (fadeOut > 0 && timeMs > end - fadeOut) {
    return (end - timeMs) / fadeOut;
  }
  return 1;
}

export function fadeFactorComplex(
  timeMs: number,
  ev: SubtitleEvent,
  params: {
    alphas: [number, number, number];
    times: [number, number, number, number];
  },
): number {
  const t = timeMs - ev.start;
  const [a1, a2, a3] = params.alphas;
  const [t1, t2, t3, t4] = params.times;

  let alpha = a3;
  if (t <= t1) {
    alpha = a1;
  } else if (t <= t2) {
    const dt = (t - t1) / Math.max(1, t2 - t1);
    alpha = a1 + (a2 - a1) * dt;
  } else if (t <= t3) {
    alpha = a2;
  } else if (t <= t4) {
    const dt = (t - t3) / Math.max(1, t4 - t3);
    alpha = a2 + (a3 - a2) * dt;
  } else {
    alpha = a3;
  }

  const opacity = 1 - Math.min(255, Math.max(0, alpha)) / 255;
  return opacity;
}

export function applyFade(color: ColorRGBA, factor: number): ColorRGBA {
  if (factor >= 1) return color;
  const a = Math.max(0, Math.min(255, Math.round(color[3] * factor)));
  return [color[0], color[1], color[2], a];
}
