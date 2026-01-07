import type { Style, InlineStyle } from "subforge/core";
import type { GlyphBuffer } from "text-shaper";
import type { getFont } from "../../io/fonts/cache";
import type { ColorRGBA } from "../data/types";
import type { AnimateParams, OriginParams } from "../tags/types";
import {
  analyzeLineBreaksFromCodepoints,
  BreakOpportunity,
  LineBreakClass,
  getLineBreakClass,
  calculateLineWidth,
} from "text-shaper";
import { quantSubpixel } from "../math/fixed";

type FontHandle = Awaited<ReturnType<typeof getFont>>;

export type LineItem = {
  font: FontHandle;
  fontSize: number;
  color: ColorRGBA;
  primaryColor: ColorRGBA;
  secondaryColor: ColorRGBA;
  outlineColor: ColorRGBA;
  shadowColor: ColorRGBA;
  shaped: GlyphBuffer | null;
  width: number;
  spacing: number;
  spacingAfter: number;
  baseStyle: Style;
  inlineStyle: InlineStyle | null;
  animates: AnimateParams[];
  scaleX: number;
  scaleY: number;
  scaleXFactor: number;
  scaleYFactor: number;
  rotateZ: number;
  rotateX: number;
  rotateY: number;
  shearX: number;
  shearY: number;
  originOverride: OriginParams | null;
  drawingPath?: { commands: Array<any>; bounds: any };
  drawingBaseline: number;
  border: number;
  borderX: number;
  borderY: number;
  borderStyle: 1 | 3;
  shadow: number;
  shadowX: number;
  shadowY: number;
  shadowXExplicit: boolean;
  shadowYExplicit: boolean;
  shadowScaleX: number;
  shadowScaleY: number;
  blur: number;
  blurSigmaX: number;
  blurSigmaY: number;
  edgeBlur: number;
  shadowMaskX: number;
  shadowMaskY: number;
  ascent: number;
  descent: number;
  underline: boolean;
  strikeout: boolean;
  underlinePos: number;
  underlineThickness: number;
  strikeoutPos: number;
  strikeoutThickness: number;
  syntheticBold: boolean;
  syntheticItalic: boolean;
  fontHintingSupported: boolean;
  isWhitespace: boolean;
  text: string;
  segmentIndex: number;
  karaokeStart: number | null;
  karaokeEnd: number | null;
  karaokeMode: "fill" | "fade" | "outline" | null;
  fadeFactor: number;
};

export type Line = {
  items: LineItem[];
  width: number;
  ascent: number;
  descent: number;
  height: number;
};

export type Token = { text: string; isSpace: boolean; start: number; end: number };

export function recomputeLineMetrics(line: Line): void {
  let width = 0;
  let ascent = 0;
  let descent = 0;
  for (let i = 0; i < line.items.length; i++) {
    const item = line.items[i]!;
    width += item.width + item.spacingAfter;
    if (item.ascent > ascent) ascent = item.ascent;
    if (item.descent > descent) descent = item.descent;
  }
  line.width = quantSubpixel(width);
  line.ascent = quantSubpixel(ascent);
  line.descent = quantSubpixel(descent);
  line.height = quantSubpixel(line.ascent + line.descent);
}

export function finalizeLineMetrics(line: Line): void {
  line.width = quantSubpixel(line.width);
  line.ascent = quantSubpixel(line.ascent);
  line.descent = quantSubpixel(line.descent);
  line.height = quantSubpixel(line.ascent + line.descent);
}

export function trimTrailingWhitespace(line: Line): void {
  let end = line.items.length - 1;
  while (end >= 0 && line.items[end]!.isWhitespace) {
    line.items.pop();
    end--;
  }
  recomputeLineMetrics(line);
}

export function computeLineWidth(
  shaped: GlyphBuffer,
  scale: number,
  spacing: number,
): number {
  const spacingQ = spacing !== 0 ? quantSubpixel(spacing) : 0;
  const baseWidth = calculateLineWidth(shaped) * scale;
  let width = quantSubpixel(baseWidth);
  if (spacingQ !== 0 && shaped.positions.length > 0) {
    width = quantSubpixel(width + spacingQ * shaped.positions.length);
  }
  return quantSubpixel(width);
}

export function splitByNewline(text: string): string[] {
  const parts: string[] = [];
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c === 10) {
      parts[parts.length] = text.slice(start, i);
      start = i + 1;
    }
  }
  parts[parts.length] = text.slice(start);
  return parts;
}


function isTrimWhitespaceCodepoint(
  codepoint: number,
  cls: LineBreakClass,
): boolean {
  if (cls === LineBreakClass.SP) return true;
  if (codepoint === 0x0009) return true;
  if (codepoint === 0x200b) return true;
  if (codepoint >= 0x2000 && codepoint <= 0x200a) return true;
  if (codepoint === 0x205f) return true;
  if (codepoint === 0x3000) return true;
  return false;
}

export function tokenize(text: string): Token[] {
  const tokens: Token[] = [];
  if (text.length === 0) return tokens;

  const codepoints: number[] = [];
  const starts: number[] = [];
  for (let i = 0; i < text.length; ) {
    const cp = text.codePointAt(i) ?? 0;
    codepoints[codepoints.length] = cp;
    starts[starts.length] = i;
    i += cp >= 0x10000 ? 2 : 1;
  }
  const analysis = analyzeLineBreaksFromCodepoints(codepoints);

  let i = 0;
  while (i < codepoints.length) {
    const cp = codepoints[i] ?? 0;
    const cls = analysis.classes[i] ?? getLineBreakClass(cp);

    if (isTrimWhitespaceCodepoint(cp, cls)) {
      const startCp = i;
      const startCU = starts[i] ?? 0;
      i++;
      while (i < codepoints.length) {
        const cpNext = codepoints[i] ?? 0;
        const clsNext = analysis.classes[i] ?? getLineBreakClass(cpNext);
        if (!isTrimWhitespaceCodepoint(cpNext, clsNext)) break;
        i++;
      }
      const endCU = i < starts.length ? (starts[i] ?? text.length) : text.length;
      tokens[tokens.length] = {
        text: text.slice(startCU, endCU),
        isSpace: true,
        start: startCU,
        end: endCU,
      };
      continue;
    }

    let startCp = i;
    let startCU = starts[i] ?? 0;
    i++;
    while (i < codepoints.length) {
      const cpNext = codepoints[i] ?? 0;
      const clsNext = analysis.classes[i] ?? getLineBreakClass(cpNext);
      if (isTrimWhitespaceCodepoint(cpNext, clsNext)) break;
      if (
        analysis.breaks[i] !== undefined &&
        analysis.breaks[i] !== BreakOpportunity.NoBreak &&
        i > startCp
      ) {
        const endCU = starts[i] ?? text.length;
        tokens[tokens.length] = {
          text: text.slice(startCU, endCU),
          isSpace: false,
          start: startCU,
          end: endCU,
        };
        startCp = i;
        startCU = starts[i] ?? text.length;
      }
      i++;
    }
    if (startCp < i) {
      const endCU = i < starts.length ? (starts[i] ?? text.length) : text.length;
      tokens[tokens.length] = {
        text: text.slice(startCU, endCU),
        isSpace: false,
        start: startCU,
        end: endCU,
      };
    }
  }

  return tokens;
}
