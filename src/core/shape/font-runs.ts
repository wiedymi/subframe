import type { getFont } from "../../io/fonts/cache";
import type { Token } from "../layout/line";
import { getFallbackFontForCodepoint } from "../../io/fonts/fallback";
import { getScript, isComplexScript, Tags } from "text-shaper";

type FontHandle = Awaited<ReturnType<typeof getFont>>;

export type FontRun = {
  text: string;
  font: FontHandle;
  isSpace: boolean;
};

const FONT_RUN_CACHE_LIMIT = 4096;
const fontRunCache = new WeakMap<FontHandle, Map<string, FontRun[]>>();

function getFontRunCache(font: FontHandle, key: string): FontRun[] | null {
  const map = fontRunCache.get(font);
  if (!map) return null;
  const cached = map.get(key) ?? null;
  if (cached) {
    map.delete(key);
    map.set(key, cached);
  }
  return cached;
}

function setFontRunCache(font: FontHandle, key: string, value: FontRun[]): void {
  let map = fontRunCache.get(font);
  if (!map) {
    map = new Map();
    fontRunCache.set(font, map);
  }
  map.set(key, value);
  if (map.size > FONT_RUN_CACHE_LIMIT) {
    const first = map.keys().next();
    if (!first.done) map.delete(first.value);
  }
}

export async function splitTokenByFont(
  token: Token,
  baseFont: FontHandle,
  fontName: string,
  boldRequested: boolean,
  italicRequested: boolean,
): Promise<FontRun[]> {
  const cacheKey = `${token.isSpace ? 1 : 0}|${fontName}|${boldRequested ? 1 : 0}|${italicRequested ? 1 : 0}|${token.text}`;
  const cached = getFontRunCache(baseFont, cacheKey);
  if (cached) return cached;

  if (token.isSpace) {
    const runs = [{ text: token.text, font: baseFont, isSpace: true }];
    setFontRunCache(baseFont, cacheKey, runs);
    return runs;
  }
  if (token.text.length === 0) {
    const empty: FontRun[] = [];
    setFontRunCache(baseFont, cacheKey, empty);
    return empty;
  }

  const baseHasGsub = baseFont.hasTable(Tags.GSUB);

  let needsFallback = false;
  for (let cu = 0; cu < token.text.length; ) {
    const cp = token.text.codePointAt(cu) ?? 0;
    const step = cp >= 0x10000 ? 2 : 1;
    if (cp === 0) {
      cu += step;
      continue;
    }
    const script = getScript(cp);
    const complexScript = isComplexScript(script);
    if ((complexScript && !baseHasGsub) || baseFont.glyphId(cp) === 0) {
      needsFallback = true;
      break;
    }
    cu += step;
  }
  if (!needsFallback) {
    const runs = [{ text: token.text, font: baseFont, isSpace: false }];
    setFontRunCache(baseFont, cacheKey, runs);
    return runs;
  }

  const runs: FontRun[] = [];
  let runStart = 0;
  let runFont = baseFont;
  for (let cu = 0; cu < token.text.length; ) {
    const cp = token.text.codePointAt(cu) ?? 0;
    const step = cp >= 0x10000 ? 2 : 1;
    let fontForChar = baseFont;
    const script = cp !== 0 ? getScript(cp) : null;
    const complexScript = script ? isComplexScript(script) : false;
    if (
      cp !== 0 &&
      ((complexScript && !baseHasGsub) || baseFont.glyphId(cp) === 0)
    ) {
      const fallback = await getFallbackFontForCodepoint(
        fontName,
        cp,
        boldRequested,
        italicRequested,
      );
      if (fallback) fontForChar = fallback;
    }
    if (fontForChar !== runFont) {
      if (cu > runStart) {
        runs[runs.length] = {
          text: token.text.slice(runStart, cu),
          font: runFont,
          isSpace: false,
        };
      }
      runStart = cu;
      runFont = fontForChar;
    }
    cu += step;
  }
  if (runStart < token.text.length) {
    runs[runs.length] = {
      text: token.text.slice(runStart),
      font: runFont,
      isSpace: false,
    };
  }

  setFontRunCache(baseFont, cacheKey, runs);
  return runs;
}
