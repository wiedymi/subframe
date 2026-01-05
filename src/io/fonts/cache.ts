import { Font } from "text-shaper";

const cache = new Map<string, Promise<Font>>();
const sourceMap = new Map<string, FontSource>();
let fontResolver: FontResolver | null = null;

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

export function resetFontCache(): void {
  cache.clear();
}

export function registerFontSource(fontName: string, source: FontSource): void {
  if (!fontName) return;
  sourceMap.set(fontName, source);
  sourceMap.set(fontName.toLowerCase(), source);
  cache.delete(fontName);
}

export function setFontResolver(resolver: FontResolver | null): void {
  fontResolver = resolver;
}

async function resolveFontSource(fontName: string): Promise<FontSource | null> {
  const direct = sourceMap.get(fontName) ?? sourceMap.get(fontName.toLowerCase());
  if (direct) return direct;
  if (!fontResolver) return null;
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
    const slice = source.buffer.slice(
      source.byteOffset,
      source.byteOffset + source.byteLength,
    );
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
