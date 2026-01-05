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

export async function splitTokenByFont(
  token: Token,
  baseFont: FontHandle,
  fontName: string,
  boldRequested: boolean,
  italicRequested: boolean,
): Promise<FontRun[]> {
  if (token.isSpace) {
    return [{ text: token.text, font: baseFont, isSpace: true }];
  }
  const chars = [...token.text];
  if (chars.length === 0) return [];

  const baseHasGsub = baseFont.hasTable(Tags.GSUB);

  let needsFallback = false;
  for (let i = 0; i < chars.length; i++) {
    const cp = chars[i]!.codePointAt(0) ?? 0;
    if (cp === 0) continue;
    const script = getScript(cp);
    const complexScript = isComplexScript(script);
    if ((complexScript && !baseHasGsub) || baseFont.glyphId(cp) === 0) {
      needsFallback = true;
      break;
    }
  }
  if (!needsFallback) {
    return [{ text: token.text, font: baseFont, isSpace: false }];
  }

  const runs: FontRun[] = [];
  let runStart = 0;
  let runFont = baseFont;
  for (let i = 0; i < chars.length; i++) {
    const cp = chars[i]!.codePointAt(0) ?? 0;
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
      if (i > runStart) {
        runs[runs.length] = {
          text: chars.slice(runStart, i).join(""),
          font: runFont,
          isSpace: false,
        };
      }
      runStart = i;
      runFont = fontForChar;
    }
  }
  if (runStart < chars.length) {
    runs[runs.length] = {
      text: chars.slice(runStart).join(""),
      font: runFont,
      isSpace: false,
    };
  }

  return runs;
}
