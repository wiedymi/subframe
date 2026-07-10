import { Font } from "text-shaper";

const styleCachePrefix = "__style__:";
const styleBasePrefix = "__style_base__:";

export type FontSource = string | ArrayBuffer | Uint8Array | Font;
export type FontResolver = (
  fontName: string,
) => FontSource | Promise<FontSource | null> | null;

export class FontRegistry {
  readonly cache = new Map<string, Promise<Font>>();
  readonly sources = new Map<string, FontSource>();
  resolver: FontResolver | null = null;
  resolverBeforeRegistered = false;

  getFont(fontName: string): Promise<Font> {
    let cached = this.cache.get(fontName);
    if (!cached) {
      cached = loadFont(this, fontName);
      this.cache.set(fontName, cached);
    }
    return cached;
  }

  getFontForStyle(
    fontName: string,
    bold: boolean,
    italic: boolean,
    sampleCodepoint?: number,
  ): Promise<Font> {
    const baseKey = `${styleBasePrefix}${fontName}|${bold ? 1 : 0}|${italic ? 1 : 0}`;
    let baseCached = this.cache.get(baseKey);
    if (!baseCached) {
      baseCached = loadFontForStyle(this, fontName, bold, italic, undefined);
      this.cache.set(baseKey, baseCached);
    }
    if (
      !sampleCodepoint ||
      !Number.isFinite(sampleCodepoint) ||
      sampleCodepoint <= 0
    ) {
      return baseCached;
    }

    const key = `${styleCachePrefix}${fontName}|${bold ? 1 : 0}|${italic ? 1 : 0}|${sampleCodepoint}`;
    let cached = this.cache.get(key);
    if (!cached) {
      cached = (async () => {
        const baseFont = await baseCached!;
        if (baseFont.glyphId(sampleCodepoint) !== 0) return baseFont;
        return await loadFontForStyle(
          this,
          fontName,
          bold,
          italic,
          sampleCodepoint,
        );
      })();
      this.cache.set(key, cached);
    }
    return cached;
  }

  register(fontName: string, source: FontSource): void {
    if (!fontName) return;
    this.sources.set(fontName, source);
    this.sources.set(fontName.toLowerCase(), source);
    this.cache.clear();
  }

  registerScoped(fontName: string, source: FontSource): () => void {
    if (!fontName) return () => {};
    const keys = [...new Set([fontName, fontName.toLowerCase()])];
    const previous = keys.map((key) => ({
      key,
      had: this.sources.has(key),
      source: this.sources.get(key),
    }));
    for (let i = 0; i < keys.length; i++) this.sources.set(keys[i]!, source);
    this.cache.clear();
    let active = true;
    return () => {
      if (!active) return;
      active = false;
      for (let i = 0; i < previous.length; i++) {
        const entry = previous[i]!;
        if (this.sources.get(entry.key) !== source) continue;
        if (entry.had) this.sources.set(entry.key, entry.source!);
        else this.sources.delete(entry.key);
      }
      this.cache.clear();
    };
  }

  setResolver(
    resolver: FontResolver | null,
    options: { beforeRegistered?: boolean } = {},
  ): void {
    this.resolver = resolver;
    this.resolverBeforeRegistered = options.beforeRegistered === true;
    this.cache.clear();
  }

  snapshot(): Array<{
    name: string;
    source: string | ArrayBuffer | Uint8Array;
  }> {
    const out: Array<{
      name: string;
      source: string | ArrayBuffer | Uint8Array;
    }> = [];
    const seen = new Set<string>();
    for (const [name, source] of this.sources) {
      if (seen.has(name)) continue;
      seen.add(name);
      if (source instanceof Font) continue;
      out[out.length] = { name, source };
    }
    return out;
  }

  clear(): void {
    this.sources.clear();
    this.cache.clear();
    this.resolver = null;
  }
}

export const defaultFontRegistry = new FontRegistry();
const ownerRegistries = new WeakMap<object, FontRegistry>();

export function bindFontRegistry(owner: object, registry: FontRegistry): void {
  ownerRegistries.set(owner, registry);
}

export function getFontRegistry(owner?: object): FontRegistry {
  return (owner && ownerRegistries.get(owner)) ?? defaultFontRegistry;
}

function isURLLike(value: string): boolean {
  return (
    value.startsWith("http://") ||
    value.startsWith("https://") ||
    value.startsWith("data:") ||
    value.startsWith("blob:")
  );
}

function splitFontRef(value: string): {
  path: string;
  collectionIndex: number | null;
} {
  const hash = value.lastIndexOf("#");
  if (hash <= 0) return { path: value, collectionIndex: null };
  const idx = Number(value.slice(hash + 1));
  if (!Number.isFinite(idx) || idx < 0)
    return { path: value, collectionIndex: null };
  return { path: value.slice(0, hash), collectionIndex: idx };
}

export function getFont(fontName: string): Promise<Font> {
  return defaultFontRegistry.getFont(fontName);
}

export function getFontForStyle(
  fontName: string,
  bold: boolean,
  italic: boolean,
  sampleCodepoint?: number,
): Promise<Font> {
  return defaultFontRegistry.getFontForStyle(
    fontName,
    bold,
    italic,
    sampleCodepoint,
  );
}

export function resetFontCache(): void {
  defaultFontRegistry.cache.clear();
}

export function clearRegisteredFontSourcesForTests(): void {
  defaultFontRegistry.clear();
}

export function registerFontSource(fontName: string, source: FontSource): void {
  defaultFontRegistry.register(fontName, source);
}

export function registerScopedFontSource(
  fontName: string,
  source: FontSource,
): () => void {
  return defaultFontRegistry.registerScoped(fontName, source);
}

export function setFontResolver(
  resolver: FontResolver | null,
  options: { beforeRegistered?: boolean } = {},
): void {
  defaultFontRegistry.setResolver(resolver, options);
}

// Snapshot of registered font sources that survive structured clone across a
// worker boundary. Live Font instances hold non-transferable native state and
// are skipped; the worker re-resolves those by name via the font search paths.
export function snapshotFontSources(): Array<{
  name: string;
  source: string | ArrayBuffer | Uint8Array;
}> {
  return defaultFontRegistry.snapshot();
}

async function resolveFontSource(
  registry: FontRegistry,
  fontName: string,
): Promise<FontSource | null> {
  let resolverTried = false;
  if (registry.resolverBeforeRegistered && registry.resolver) {
    resolverTried = true;
    const resolved = await registry.resolver(fontName);
    if (resolved) return resolved;
  }
  const direct =
    registry.sources.get(fontName) ??
    registry.sources.get(fontName.toLowerCase());
  if (direct) return direct;
  if (!registry.resolver || resolverTried) return null;
  const resolved = await registry.resolver(fontName);
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

async function loadFont(
  registry: FontRegistry,
  fontName: string,
): Promise<Font> {
  const resolved = await resolveFontSource(registry, fontName);
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
  registry: FontRegistry,
  fontName: string,
  bold: boolean,
  italic: boolean,
  sampleCodepoint?: number,
): Promise<Font> {
  const resolved = await resolveFontSource(registry, fontName);
  if (resolved) return await loadFontSource(resolved);

  if (isURLLike(fontName)) {
    return await Font.fromURL(fontName);
  }

  if (typeof Bun === "undefined") {
    throw new Error(
      "Font resolution in browser requires a URL (http/https/data/blob) or registerFontSource().",
    );
  }

  const {
    findFontFacesForFamily,
    resolveFontPath,
    resolveFontPathForCodepoint,
  } = await import("./resolve");
  const hasSample =
    typeof sampleCodepoint === "number" &&
    Number.isFinite(sampleCodepoint) &&
    sampleCodepoint > 0;

  // Family-name match against fonts in the search paths (libass find_font
  // parity). This must win over fc-match, which only sees system fonts.
  const familyMatches = findFontFacesForFamily(fontName, bold, italic);
  if (familyMatches.length > 0) {
    if (!hasSample) return await registry.getFont(familyMatches[0]!);
    // libass checks glyph coverage across the family's faces; fall through to
    // codepoint-based fallback only when no face covers the codepoint.
    for (let i = 0; i < familyMatches.length; i++) {
      try {
        const font = await registry.getFont(familyMatches[i]!);
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
