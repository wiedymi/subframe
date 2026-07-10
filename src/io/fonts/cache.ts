import { Font } from "text-shaper";

const cache = new Map<string, Promise<Font>>();
const sourceMap = new Map<string, FontSource>();
let fontResolver: FontResolver | null = null;
let fontResolverBeforeRegistered = false;
const styleCachePrefix = "__style__:";
const styleBasePrefix = "__style_base__:";

export type FontSource = string | ArrayBuffer | Uint8Array | Font;
export type FontResolver = (
  fontName: string,
) => FontSource | Promise<FontSource | null> | null;

function isURLLike(value: string): boolean {
  return (
    value.startsWith("http://") ||
    value.startsWith("https://") ||
    value.startsWith("data:") ||
    value.startsWith("blob:")
  );
}

function splitFontRef(value: string): { path: string; collectionIndex: number | null } {
  const hash = value.lastIndexOf("#");
  if (hash <= 0) return { path: value, collectionIndex: null };
  const idx = Number(value.slice(hash + 1));
  if (!Number.isFinite(idx) || idx < 0) return { path: value, collectionIndex: null };
  return { path: value.slice(0, hash), collectionIndex: idx };
}

export function getFont(fontName: string): Promise<Font> {
  let cached = cache.get(fontName);
  if (!cached) {
    cached = loadFont(fontName);
    cache.set(fontName, cached);
  }
  return cached;
}

export function getFontForStyle(
  fontName: string,
  bold: boolean,
  italic: boolean,
  sampleCodepoint?: number,
): Promise<Font> {
  const baseKey = `${styleBasePrefix}${fontName}|${bold ? 1 : 0}|${italic ? 1 : 0}`;
  let baseCached = cache.get(baseKey);
  if (!baseCached) {
    baseCached = loadFontForStyle(fontName, bold, italic, undefined);
    cache.set(baseKey, baseCached);
  }
  if (!sampleCodepoint || !Number.isFinite(sampleCodepoint) || sampleCodepoint <= 0) {
    return baseCached;
  }

  const key = `${styleCachePrefix}${fontName}|${bold ? 1 : 0}|${italic ? 1 : 0}|${sampleCodepoint}`;
  let cached = cache.get(key);
  if (!cached) {
    cached = (async () => {
      const baseFont = await baseCached!;
      if (baseFont.glyphId(sampleCodepoint) !== 0) return baseFont;
      return await loadFontForStyle(fontName, bold, italic, sampleCodepoint);
    })();
    cache.set(key, cached);
  }
  return cached;
}

export function resetFontCache(): void {
  cache.clear();
}

export function clearRegisteredFontSourcesForTests(): void {
  sourceMap.clear();
  cache.clear();
}

export function registerFontSource(fontName: string, source: FontSource): void {
  if (!fontName) return;
  sourceMap.set(fontName, source);
  sourceMap.set(fontName.toLowerCase(), source);
  // Style and codepoint cache keys include the font name as a component and
  // cannot be invalidated by deleting the raw name alone. Font registration is
  // a cold-path operation, so clear the small promise cache deterministically.
  cache.clear();
}

export function registerScopedFontSource(
  fontName: string,
  source: FontSource,
): () => void {
  if (!fontName) return () => {};
  const keys = [...new Set([fontName, fontName.toLowerCase()])];
  const previous = keys.map((key) => ({
    key,
    had: sourceMap.has(key),
    source: sourceMap.get(key),
  }));
  for (let i = 0; i < keys.length; i++) sourceMap.set(keys[i]!, source);
  cache.clear();
  let active = true;
  return () => {
    if (!active) return;
    active = false;
    for (let i = 0; i < previous.length; i++) {
      const entry = previous[i]!;
      if (sourceMap.get(entry.key) !== source) continue;
      if (entry.had) sourceMap.set(entry.key, entry.source!);
      else sourceMap.delete(entry.key);
    }
    cache.clear();
  };
}

export function setFontResolver(
  resolver: FontResolver | null,
  options: { beforeRegistered?: boolean } = {},
): void {
  fontResolver = resolver;
  fontResolverBeforeRegistered = options.beforeRegistered === true;
}

// Snapshot of registered font sources that survive structured clone across a
// worker boundary. Live Font instances hold non-transferable native state and
// are skipped; the worker re-resolves those by name via the font search paths.
export function snapshotFontSources(): Array<{
  name: string;
  source: string | ArrayBuffer | Uint8Array;
}> {
  const out: Array<{ name: string; source: string | ArrayBuffer | Uint8Array }> = [];
  const seen = new Set<string>();
  for (const [name, source] of sourceMap) {
    if (seen.has(name)) continue;
    seen.add(name);
    if (source instanceof Font) continue;
    out[out.length] = { name, source };
  }
  return out;
}

async function resolveFontSource(fontName: string): Promise<FontSource | null> {
  let resolverTried = false;
  if (fontResolverBeforeRegistered && fontResolver) {
    resolverTried = true;
    const resolved = await fontResolver(fontName);
    if (resolved) return resolved;
  }
  const direct = sourceMap.get(fontName) ?? sourceMap.get(fontName.toLowerCase());
  if (direct) return direct;
  if (!fontResolver || resolverTried) return null;
  const resolved = await fontResolver(fontName);
  return resolved ?? null;
}

async function loadFontSource(source: FontSource): Promise<Font> {
  if (source instanceof Font) return source;
  if (typeof source === "string") {
    if (isURLLike(source)) return await Font.fromURL(source);
    if (typeof Bun === "undefined") {
      throw new Error(
        "Font loading in browser requires a URL (http/https/data/blob).",
      );
    }
    const { path, collectionIndex } = splitFontRef(source);
    if (collectionIndex !== null) {
      return await Font.fromFile(path, { collectionIndex });
    }
    return await Font.fromFile(path);
  }
  if (source instanceof ArrayBuffer) return await Font.loadAsync(source);
  if (ArrayBuffer.isView(source)) {
    const slice = new Uint8Array(
      source.buffer,
      source.byteOffset,
      source.byteLength,
    ).slice().buffer;
    return await Font.loadAsync(slice);
  }
  throw new Error("Unsupported font source type.");
}

async function loadFont(fontName: string): Promise<Font> {
  const resolved = await resolveFontSource(fontName);
  if (resolved) return await loadFontSource(resolved);

  if (isURLLike(fontName)) {
    return await Font.fromURL(fontName);
  }

  if (typeof Bun === "undefined") {
    throw new Error(
      "Font resolution in browser requires a URL (http/https/data/blob) or registerFontSource().",
    );
  }

  const { resolveFontPath } = await import("./resolve");
  const path = resolveFontPath(fontName);
  return await loadFontSource(path);
}

async function loadFontForStyle(
  fontName: string,
  bold: boolean,
  italic: boolean,
  sampleCodepoint?: number,
): Promise<Font> {
  const resolved = await resolveFontSource(fontName);
  if (resolved) return await loadFontSource(resolved);

  if (isURLLike(fontName)) {
    return await Font.fromURL(fontName);
  }

  if (typeof Bun === "undefined") {
    throw new Error(
      "Font resolution in browser requires a URL (http/https/data/blob) or registerFontSource().",
    );
  }

  const { findFontFacesForFamily, resolveFontPath, resolveFontPathForCodepoint } =
    await import("./resolve");
  const hasSample =
    typeof sampleCodepoint === "number" &&
    Number.isFinite(sampleCodepoint) &&
    sampleCodepoint > 0;

  // Family-name match against fonts in the search paths (libass find_font
  // parity). This must win over fc-match, which only sees system fonts.
  const familyMatches = findFontFacesForFamily(fontName, bold, italic);
  if (familyMatches.length > 0) {
    if (!hasSample) return await getFont(familyMatches[0]!);
    // libass checks glyph coverage across the family's faces; fall through to
    // codepoint-based fallback only when no face covers the codepoint.
    for (let i = 0; i < familyMatches.length; i++) {
      try {
        const font = await getFont(familyMatches[i]!);
        if (font.glyphId(sampleCodepoint) !== 0) return font;
      } catch {
        continue;
      }
    }
  }

  const cp = hasSample ? sampleCodepoint : 0x41;
  if (bold || italic) {
    const styled = resolveFontPathForCodepoint(fontName, cp, bold, italic);
    if (styled) return await loadFontSource(styled);
  }
  const path = resolveFontPath(fontName);
  return await loadFontSource(path);
}
