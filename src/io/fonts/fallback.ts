import { getFont } from "./cache";
import { resolveFontPathsForCodepoint } from "./resolve";
import { getScript, isComplexScript, Tags } from "text-shaper";

const codepointCache = new Map<string, string | null>();

function cacheKey(
  fontName: string | null,
  codepoint: number,
  bold: boolean,
  italic: boolean,
): string {
  return `${fontName ?? ""}|${bold ? 1 : 0}|${italic ? 1 : 0}|${codepoint}`;
}

export async function getFallbackFontForCodepoint(
  fontName: string | null,
  codepoint: number,
  bold: boolean,
  italic: boolean,
): Promise<Awaited<ReturnType<typeof getFont>> | null> {
  if (typeof Bun === "undefined") return null;
  const key = cacheKey(fontName, codepoint, bold, italic);
  if (codepointCache.has(key)) {
    const cached = codepointCache.get(key);
    if (!cached) return null;
    return await getFont(cached);
  }

  const script = getScript(codepoint);
  const preferComplex = isComplexScript(script);
  let path: string | null = null;
  let candidates: string[] | null = null;
  if (preferComplex) {
    candidates = resolveFontPathsForCodepoint(fontName, codepoint, bold, italic);
  } else {
    const { resolveFontPathForCodepoint } = await import("./resolve");
    path = resolveFontPathForCodepoint(fontName, codepoint, bold, italic);
  }

  if (preferComplex && candidates && candidates.length > 0) {
    for (let i = 0; i < candidates.length; i++) {
      const candidate = candidates[i]!;
      try {
        const font = await getFont(candidate);
        if (font.glyphId(codepoint) === 0) continue;
        if (font.hasTable(Tags.GSUB) || font.hasTable(Tags.morx)) {
          path = candidate;
          break;
        }
      } catch {
        continue;
      }
    }
    if (!path) path = candidates[0] ?? null;
  }
  if (!path && fontName) {
    path = resolveFontPathForCodepoint(null, codepoint, bold, italic);
  }
  if (!path) {
    codepointCache.set(key, null);
    return null;
  }

  try {
    const font = await getFont(path);
    codepointCache.set(key, path);
    return font;
  } catch {
    codepointCache.set(key, null);
    return null;
  }
}
