import type { SubtitleEvent, TextSegment } from "subforge/core";
import { parseTags } from "subforge/ass";
import { injectAnimateEffects, injectBlurEffects, injectDrawingEffects, injectKaraokeAbsoluteEffects, splitTagBlock } from "../animate/parser";

function hasTagsOrEscapes(text: string): boolean {
  const idxBrace = text.indexOf("{");
  if (idxBrace !== -1) return true;
  const idxSlash = text.indexOf("\\");
  return idxSlash !== -1;
}

function normalizeAssNewlines(raw: string, initialWrapStyle: number): string {
  let wrapStyle = initialWrapStyle;
  let out = "";
  let i = 0;
  while (i < raw.length) {
    const c = raw[i]!;
    if (c === "{") {
      const closeIdx = raw.indexOf("}", i);
      if (closeIdx === -1) {
        out += raw.slice(i);
        break;
      }
      const tagBlock = raw.slice(i + 1, closeIdx);
      const tags = splitTagBlock(tagBlock);
      for (let t = 0; t < tags.length; t++) {
        const tag = tags[t]!.trim();
        let m: RegExpMatchArray | null = null;
        if ((m = tag.match(/^q([0-3])$/))) {
          wrapStyle = parseInt(m[1]!, 10);
        } else if (tag.startsWith("r")) {
          wrapStyle = initialWrapStyle;
        }
      }
      out += raw.slice(i, closeIdx + 1);
      i = closeIdx + 1;
      continue;
    }
    if (c === "\\") {
      const next = raw[i + 1];
      if (next === "n") {
        out += wrapStyle === 2 ? "\\n" : " ";
        i += 2;
        continue;
      }
      if (next === "N") {
        out += "\\N";
        i += 2;
        continue;
      }
    }
    out += c;
    i++;
  }
  return out;
}

const ANIMATE_BACKSLASH_SENTINEL = "\x1f";

function sanitizeAnimateTagsForParse(raw: string): string {
  if (!raw.includes("\\t(")) return raw;
  let out = "";
  let i = 0;
  while (i < raw.length) {
    if (raw[i] === "{") {
      const closeIdx = raw.indexOf("}", i);
      if (closeIdx === -1) {
        out += raw.slice(i);
        break;
      }
      const tagBlock = raw.slice(i + 1, closeIdx);
      const tags = splitTagBlock(tagBlock);
      let rebuilt = "";
      for (let t = 0; t < tags.length; t++) {
        let tag = tags[t]!;
        if (tag.startsWith("t(") && tag.endsWith(")")) {
          const inner = tag.slice(2, -1);
          const sanitized = inner.replace(/\\/g, ANIMATE_BACKSLASH_SENTINEL);
          tag = `t(${sanitized})`;
        }
        rebuilt += `\\${tag}`;
      }
      out += `{${rebuilt}}`;
      i = closeIdx + 1;
      continue;
    }
    out += raw[i]!;
    i++;
  }
  return out;
}

export function resolveSegments(
  ev: SubtitleEvent,
  initialWrapStyle: number,
): TextSegment[] {
  if (ev.segments && ev.segments.length > 0 && !ev.dirty) return ev.segments;
  if (!ev.text) return [];
  if (hasTagsOrEscapes(ev.text)) {
    let normalized = normalizeAssNewlines(ev.text, initialWrapStyle);
    if (normalized.includes("\\K"))
      normalized = normalized.replace(/\\K(\d+)/g, "\\kf$1");
    if (normalized.includes("\\t("))
      normalized = sanitizeAnimateTagsForParse(normalized);
    const segments = parseTags(normalized);
    if (ev.text.includes("\\t(")) injectAnimateEffects(ev.text, segments);
    if (ev.text.includes("\\be") || ev.text.includes("\\blur"))
      injectBlurEffects(ev.text, segments);
    if (ev.text.includes("\\kt"))
      injectKaraokeAbsoluteEffects(ev.text, segments);
    if (ev.text.includes("\\p")) injectDrawingEffects(ev.text, segments);
    return segments;
  }
  return [{ text: ev.text, style: null, effects: [] }];
}
