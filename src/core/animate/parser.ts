import type { Effect, TextSegment } from "subforge/core";
import type { AnimateParams, AnimateTarget } from "../tags/types";

export function parseAssColorHex(raw: string): number | null {
  const m = raw.match(/&H([0-9A-Fa-f]+)&/);
  if (!m) return null;
  const hex = m[1]!.padStart(8, "0");
  const num = parseInt(hex, 16);
  if (!Number.isFinite(num)) return null;
  return num >>> 0;
}

export function parseAssAlphaHex(raw: string): number | null {
  const m = raw.match(/&H([0-9A-Fa-f]{1,2})&/);
  if (!m) return null;
  const num = parseInt(m[1]!, 16);
  if (!Number.isFinite(num)) return null;
  return num & 0xff;
}

export function parseAnimateTargets(tagBlock: string): AnimateTarget {
  const target: AnimateTarget = {};
  const parts = tagBlock.split("\\").filter((t) => t.length > 0);
  for (let i = 0; i < parts.length; i++) {
    const tag = parts[i]!.trim();
    let m: RegExpMatchArray | null = null;
    if ((m = tag.match(/^fs(\d+(?:\.\d+)?)$/))) {
      target.fontSize = parseFloat(m[1]!);
      continue;
    }
    if ((m = tag.match(/^fscx(-?\d+(?:\.\d+)?)$/))) {
      target.scaleX = parseFloat(m[1]!);
      continue;
    }
    if ((m = tag.match(/^fscy(-?\d+(?:\.\d+)?)$/))) {
      target.scaleY = parseFloat(m[1]!);
      continue;
    }
    if ((m = tag.match(/^(?:frz|fr)(-?\d+(?:\.\d+)?)$/))) {
      target.rotateZ = parseFloat(m[1]!);
      continue;
    }
    if ((m = tag.match(/^frx(-?\d+(?:\.\d+)?)$/))) {
      target.rotateX = parseFloat(m[1]!);
      continue;
    }
    if ((m = tag.match(/^fry(-?\d+(?:\.\d+)?)$/))) {
      target.rotateY = parseFloat(m[1]!);
      continue;
    }
    if ((m = tag.match(/^fax(-?\d+(?:\.\d+)?)$/))) {
      target.shearX = parseFloat(m[1]!);
      continue;
    }
    if ((m = tag.match(/^fay(-?\d+(?:\.\d+)?)$/))) {
      target.shearY = parseFloat(m[1]!);
      continue;
    }
    if ((m = tag.match(/^fsp(-?\d+(?:\.\d+)?)$/))) {
      target.spacing = parseFloat(m[1]!);
      continue;
    }
    if ((m = tag.match(/^bord(-?\d+(?:\.\d+)?)$/))) {
      target.border = parseFloat(m[1]!);
      continue;
    }
    if ((m = tag.match(/^shad(-?\d+(?:\.\d+)?)$/))) {
      target.shadow = parseFloat(m[1]!);
      continue;
    }
    if ((m = tag.match(/^xshad(-?\d+(?:\.\d+)?)$/))) {
      target.shadowX = parseFloat(m[1]!);
      continue;
    }
    if ((m = tag.match(/^yshad(-?\d+(?:\.\d+)?)$/))) {
      target.shadowY = parseFloat(m[1]!);
      continue;
    }
    if ((m = tag.match(/^blur(-?\d+(?:\.\d+)?)$/))) {
      target.blur = parseFloat(m[1]!);
      continue;
    }
    if ((m = tag.match(/^be(-?\d+(?:\.\d+)?)$/))) {
      target.edgeBlur = parseFloat(m[1]!);
      continue;
    }
    if ((m = tag.match(/^([1234]?c)(&H[0-9A-Fa-f]+&)$/))) {
      const color = parseAssColorHex(m[2]!);
      if (color !== null) {
        if (m[1] === "2c") target.secondaryColor = color;
        else if (m[1] === "3c") target.outlineColor = color;
        else if (m[1] === "4c") target.backColor = color;
        else target.primaryColor = color;
      }
      continue;
    }
    if ((m = tag.match(/^(alpha|1a|2a|3a|4a)(&H[0-9A-Fa-f]{1,2}&)$/))) {
      const alpha = parseAssAlphaHex(m[2]!);
      if (alpha !== null) {
        if (m[1] === "1a") target.primaryAlpha = alpha;
        else if (m[1] === "2a") target.secondaryAlpha = alpha;
        else if (m[1] === "3a") target.outlineAlpha = alpha;
        else if (m[1] === "4a") target.backAlpha = alpha;
        else target.alpha = alpha;
      }
      continue;
    }
  }
  return target;
}

export function parseAnimateTag(raw: string): AnimateParams | null {
  const m = raw.match(/^(?:(\d+),(\d+),)?(?:(\d+(?:\.\d+)?),)?(.+)$/);
  if (!m) return null;
  const start = m[1] ? parseInt(m[1], 10) : 0;
  const end = m[2] ? parseInt(m[2], 10) : 0;
  const accel = m[3] ? parseFloat(m[3]) : 1;
  const target = parseAnimateTargets(m[4]!);
  if (Object.keys(target).length === 0) return null;
  return { start, end, accel, target };
}

export function processEscapesForMatch(text: string): string {
  return text
    .replace(/\\N/g, "\n")
    .replace(/\\n/g, "\n")
    .replace(/\\h/g, "\u00A0");
}

export function extractAnimateSpans(
  raw: string,
): Array<{ text: string; animates: AnimateParams[] }> {
  const spans: Array<{ text: string; animates: AnimateParams[] }> = [];
  let i = 0;
  let pending: AnimateParams[] = [];
  let textStart = 0;

  while (i < raw.length) {
    if (raw[i] === "{") {
      const closeIdx = raw.indexOf("}", i);
      if (closeIdx === -1) {
        i++;
        continue;
      }
      if (i > textStart) {
        const text = processEscapesForMatch(raw.slice(textStart, i));
        if (text.length > 0)
          spans[spans.length] = { text, animates: pending.slice() };
      }
      const tagBlock = raw.slice(i + 1, closeIdx);
      const tags = splitTagBlock(tagBlock);
      for (let t = 0; t < tags.length; t++) {
        const tag = tags[t]!;
        if (tag.startsWith("t(") && tag.endsWith(")")) {
          const inner = tag.slice(2, -1);
          const anim = parseAnimateTag(inner);
          if (anim) pending[pending.length] = anim;
        }
      }
      i = closeIdx + 1;
      textStart = i;
    } else {
      i++;
    }
  }

  if (textStart < raw.length) {
    const text = processEscapesForMatch(raw.slice(textStart));
    if (text.length > 0)
      spans[spans.length] = { text, animates: pending.slice() };
  }

  return spans;
}

export function splitTagBlock(block: string): string[] {
  const tags: string[] = [];
  let i = 0;
  while (i < block.length) {
    if (block[i] === "\\") i++;
    if (i >= block.length) break;
    const start = i;
    if (block.startsWith("t(", i)) {
      i += 2;
      let depth = 1;
      while (i < block.length && depth > 0) {
        const c = block[i]!;
        if (c === "(") depth++;
        else if (c === ")") depth--;
        i++;
      }
      tags[tags.length] = block.slice(start, i);
      continue;
    }
    while (i < block.length && block[i] !== "\\") i++;
    tags[tags.length] = block.slice(start, i);
  }
  return tags.filter((t) => t.length > 0);
}

export function extractDrawingSpans(
  raw: string,
): Array<{ text: string; scale: number; baseline: number }> {
  const spans: Array<{ text: string; scale: number; baseline: number }> = [];
  let i = 0;
  let textStart = 0;
  let drawingScale = 0;
  let drawingBaseline = 0;

  while (i < raw.length) {
    if (raw[i] === "{") {
      const closeIdx = raw.indexOf("}", i);
      if (closeIdx === -1) {
        i++;
        continue;
      }
      if (i > textStart) {
        const text = processEscapesForMatch(raw.slice(textStart, i));
        if (text.length > 0 && drawingScale > 0) {
          spans[spans.length] = {
            text,
            scale: drawingScale,
            baseline: drawingBaseline,
          };
        }
      }
      const tagBlock = raw.slice(i + 1, closeIdx);
      const tags = splitTagBlock(tagBlock);
      for (let t = 0; t < tags.length; t++) {
        const tag = tags[t]!.trim();
        let m: RegExpMatchArray | null = null;
        if ((m = tag.match(/^p(\d+)$/))) {
          const val = parseInt(m[1]!, 10);
          drawingScale = val > 0 ? val : 0;
        } else if ((m = tag.match(/^pbo(-?\d+(?:\.\d+)?)$/))) {
          drawingBaseline = parseFloat(m[1]!);
        }
      }
      i = closeIdx + 1;
      textStart = i;
    } else {
      i++;
    }
  }

  if (textStart < raw.length && drawingScale > 0) {
    const text = processEscapesForMatch(raw.slice(textStart));
    if (text.length > 0) {
      spans[spans.length] = {
        text,
        scale: drawingScale,
        baseline: drawingBaseline,
      };
    }
  }

  return spans;
}

export function extractBlurStateSpans(
  raw: string,
): Array<{ text: string; blur: number | null; edgeBlur: number | null }> {
  const spans: Array<{
    text: string;
    blur: number | null;
    edgeBlur: number | null;
  }> = [];
  let i = 0;
  let textStart = 0;
  let blurValue: number | null = null;
  let edgeBlurValue: number | null = null;

  while (i < raw.length) {
    if (raw[i] === "{") {
      const closeIdx = raw.indexOf("}", i);
      if (closeIdx === -1) {
        i++;
        continue;
      }
      if (i > textStart) {
        const text = processEscapesForMatch(raw.slice(textStart, i));
        if (text.length > 0) {
          spans[spans.length] = {
            text,
            blur: blurValue,
            edgeBlur: edgeBlurValue,
          };
        }
      }
      const tagBlock = raw.slice(i + 1, closeIdx);
      const tags = splitTagBlock(tagBlock);
      for (let t = 0; t < tags.length; t++) {
        const tag = tags[t]!.trim();
        let m: RegExpMatchArray | null = null;
        if ((m = tag.match(/^be(\d+(?:\.\d+)?)$/))) {
          edgeBlurValue = parseFloat(m[1]!);
        } else if ((m = tag.match(/^blur(\d+(?:\.\d+)?)$/))) {
          blurValue = parseFloat(m[1]!);
        }
      }
      i = closeIdx + 1;
      textStart = i;
    } else {
      i++;
    }
  }

  if (textStart < raw.length) {
    const text = processEscapesForMatch(raw.slice(textStart));
    if (text.length > 0) {
      spans[spans.length] = {
        text,
        blur: blurValue,
        edgeBlur: edgeBlurValue,
      };
    }
  }

  return spans;
}

export function extractKaraokeAbsoluteSpans(
  raw: string,
): Array<{ text: string; kt: number | null }> {
  const spans: Array<{ text: string; kt: number | null }> = [];
  let i = 0;
  let textStart = 0;
  let ktValue: number | null = null;

  while (i < raw.length) {
    if (raw[i] === "{") {
      const closeIdx = raw.indexOf("}", i);
      if (closeIdx === -1) {
        i++;
        continue;
      }
      if (i > textStart) {
        const text = processEscapesForMatch(raw.slice(textStart, i));
        if (text.length > 0) {
          spans[spans.length] = { text, kt: ktValue };
        }
        ktValue = null;
      }
      const tagBlock = raw.slice(i + 1, closeIdx);
      const tags = splitTagBlock(tagBlock);
      for (let t = 0; t < tags.length; t++) {
        const tag = tags[t]!.trim();
        const m = tag.match(/^kt(\d+)$/);
        if (m) ktValue = parseInt(m[1]!, 10) * 10;
      }
      i = closeIdx + 1;
      textStart = i;
    } else {
      i++;
    }
  }

  if (textStart < raw.length) {
    const text = processEscapesForMatch(raw.slice(textStart));
    if (text.length > 0) {
      spans[spans.length] = { text, kt: ktValue };
    }
  }

  return spans;
}

export function injectAnimateEffects(raw: string, segments: TextSegment[]): void {
  const spans = extractAnimateSpans(raw);
  let segIndex = 0;
  for (let i = 0; i < spans.length; i++) {
    const span = spans[i]!;
    while (
      segIndex < segments.length &&
      (!segments[segIndex]!.text || segments[segIndex]!.text.length === 0)
    ) {
      segIndex++;
    }
    if (segIndex >= segments.length) break;
    const seg = segments[segIndex]!;
    if (!seg.effects) seg.effects = [];
    for (let a = 0; a < span.animates.length; a++) {
      const anim = span.animates[a]!;
      seg.effects[seg.effects.length] = {
        type: "animate",
        params: anim,
      } as Effect;
    }
    segIndex++;
  }
}

export function injectBlurEffects(raw: string, segments: TextSegment[]): void {
  const spans = extractBlurStateSpans(raw);
  let segIndex = 0;
  for (let i = 0; i < spans.length; i++) {
    const span = spans[i]!;
    while (
      segIndex < segments.length &&
      (!segments[segIndex]!.text || segments[segIndex]!.text.length === 0)
    ) {
      segIndex++;
    }
    if (segIndex >= segments.length) break;
    const seg = segments[segIndex]!;
    if (!seg.effects) seg.effects = [];
    seg.effects = seg.effects.filter((ef) => {
      if (ef.type === "blur") return false;
      if (ef.type === "unknown") {
        const params = ef.params as
          | { format?: string; raw?: string }
          | undefined;
        if (
          params?.format === "ass" &&
          typeof params.raw === "string" &&
          params.raw.startsWith("\\be")
        )
          return false;
      }
      return true;
    });
    if (span.blur !== null) {
      seg.effects[seg.effects.length] = {
        type: "blur",
        params: { strength: span.blur },
      } as Effect;
    }
    if (span.edgeBlur !== null) {
      seg.effects[seg.effects.length] = {
        type: "unknown",
        params: { format: "ass", raw: `\\be${span.edgeBlur}` },
      } as Effect;
    }
    segIndex++;
  }
}

export function injectKaraokeAbsoluteEffects(
  raw: string,
  segments: TextSegment[],
): void {
  const spans = extractKaraokeAbsoluteSpans(raw);
  let segIndex = 0;
  for (let i = 0; i < spans.length; i++) {
    const span = spans[i]!;
    while (
      segIndex < segments.length &&
      (!segments[segIndex]!.text || segments[segIndex]!.text.length === 0)
    ) {
      segIndex++;
    }
    if (segIndex >= segments.length) break;
    const seg = segments[segIndex]!;
    if (!seg.effects) seg.effects = [];
    seg.effects = seg.effects.filter((ef) => ef.type !== "karaokeAbsolute");
    if (span.kt !== null) {
      seg.effects[seg.effects.length] = {
        type: "karaokeAbsolute",
        params: { time: span.kt / 10 },
      } as Effect;
    }
    segIndex++;
  }
}

export function injectDrawingEffects(raw: string, segments: TextSegment[]): void {
  const spans = extractDrawingSpans(raw);
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i]!;
    if (seg.effects && seg.effects.length > 0) {
      const filtered = seg.effects.filter(
        (ef) => ef.type !== "drawing" && ef.type !== "drawingBaseline",
      );
      seg.effects = filtered.length > 0 ? filtered : [];
    }
  }
  let segIndex = 0;
  for (let i = 0; i < spans.length; i++) {
    const span = spans[i]!;
    while (
      segIndex < segments.length &&
      (!segments[segIndex]!.text || segments[segIndex]!.text.length === 0)
    ) {
      segIndex++;
    }
    if (segIndex >= segments.length) break;
    const seg = segments[segIndex]!;
    if (!seg.effects) seg.effects = [];
    const drawingIdx = seg.effects.findIndex((ef) => ef.type === "drawing");
    if (drawingIdx !== -1) {
      seg.effects[drawingIdx] = {
        type: "drawing",
        params: { scale: span.scale, commands: span.text },
      } as Effect;
    } else {
      seg.effects[seg.effects.length] = {
        type: "drawing",
        params: { scale: span.scale, commands: span.text },
      } as Effect;
    }
    const baselineIdx = seg.effects.findIndex(
      (ef) => ef.type === "drawingBaseline",
    );
    if (baselineIdx !== -1) {
      seg.effects[baselineIdx] = {
        type: "drawingBaseline",
        params: { offset: span.baseline },
      } as Effect;
    } else if (span.baseline !== 0) {
      seg.effects[seg.effects.length] = {
        type: "drawingBaseline",
        params: { offset: span.baseline },
      } as Effect;
    }
    segIndex++;
  }
}
