import type { InlineStyle, Style } from "subforge/core";
import type { ColorRGBA } from "../data/types";

export function abgrToRgba(color: number, alphaOverride?: number): ColorRGBA {
  const r = color & 0xff;
  const g = (color >> 8) & 0xff;
  const b = (color >> 16) & 0xff;
  let a = (color >> 24) & 0xff;
  if (alphaOverride !== undefined) a = alphaOverride & 0xff;
  // ASS alpha is inverted: 00 = opaque, FF = transparent
  const alpha = 255 - a;
  return [r, g, b, alpha];
}

export function resolvePrimaryColor(
  base: Style,
  inline?: InlineStyle | null,
): ColorRGBA {
  const color = inline?.primaryColor ?? base.primaryColor;
  const alpha =
    inline?.primaryAlpha !== undefined
      ? inline.primaryAlpha
      : inline?.alpha !== undefined
        ? inline.alpha
        : undefined;
  return abgrToRgba(color, alpha);
}

export function resolveSecondaryColor(
  base: Style,
  inline?: InlineStyle | null,
): ColorRGBA {
  const color = inline?.secondaryColor ?? base.secondaryColor;
  const alpha =
    inline?.secondaryAlpha !== undefined
      ? inline.secondaryAlpha
      : inline?.alpha !== undefined
        ? inline.alpha
        : undefined;
  return abgrToRgba(color, alpha);
}

export function resolveOutlineColor(
  base: Style,
  inline?: InlineStyle | null,
): ColorRGBA {
  const color = inline?.outlineColor ?? base.outlineColor;
  const alpha =
    inline?.outlineAlpha !== undefined
      ? inline.outlineAlpha
      : inline?.alpha !== undefined
        ? inline.alpha
        : undefined;
  return abgrToRgba(color, alpha);
}

export function resolveShadowColor(
  base: Style,
  inline?: InlineStyle | null,
): ColorRGBA {
  const color = inline?.backColor ?? base.backColor;
  const alpha =
    inline?.backAlpha !== undefined
      ? inline.backAlpha
      : inline?.alpha !== undefined
        ? inline.alpha
        : undefined;
  return abgrToRgba(color, alpha);
}
