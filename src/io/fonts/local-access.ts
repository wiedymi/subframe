export type LocalFontData = {
  family: string;
  fullName?: string;
  postscriptName?: string;
  style?: string;
  blob: () => Promise<Blob>;
};

export type LocalFontStats = {
  available: boolean;
  indexed: boolean;
  entries: number;
};

let localFontIndex: Map<string, LocalFontData> | null = null;
let localFontIndexPromise: Promise<Map<string, LocalFontData> | null> | null = null;
const localFontBufferCache = new WeakMap<LocalFontData, Promise<ArrayBuffer>>();
let localFontList: LocalFontData[] | null = null;
const localFontAliasCache = new Map<string, LocalFontData>();

function localFontQuery(): (() => Promise<unknown[]>) | null {
  const g = globalThis as unknown as {
    queryLocalFonts?: () => Promise<unknown[]>;
    window?: { queryLocalFonts?: () => Promise<unknown[]> };
  };
  return g.queryLocalFonts ?? g.window?.queryLocalFonts ?? null;
}

export function normalizeFontKey(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

export function sanitizeFontName(name: string): string {
  return name
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .trim()
    .replace(/^@+/, "")
    .replace(/^["']+|["']+$/g, "");
}

function nameHasStyle(name: string, style: string): boolean {
  const lower = name.toLowerCase();
  const s = style.toLowerCase();
  return lower.includes(s);
}

function scoreFontEntry(requested: string, entry: LocalFontData): number {
  const req = requested.toLowerCase();
  const reqNorm = normalizeFontKey(requested);
  const names = [entry.fullName ?? "", entry.family ?? "", entry.postscriptName ?? ""];
  let score = 0;
  for (let i = 0; i < names.length; i++) {
    const name = names[i]!;
    if (!name) continue;
    const lower = name.toLowerCase();
    if (lower === req) score = Math.max(score, 100);
    const norm = normalizeFontKey(name);
    if (norm && reqNorm && norm === reqNorm) score = Math.max(score, 90);
    if (req && lower.includes(req)) score = Math.max(score, 70);
    if (reqNorm && norm && norm.includes(reqNorm)) score = Math.max(score, 60);
  }

  const style = entry.style ?? "";
  if (style) {
    if (!/(bold|italic|oblique|black|light|thin|regular)/i.test(requested)) {
      if (/regular/i.test(style)) score += 5;
      if (/bold|italic|oblique|black|light|thin/i.test(style)) score -= 2;
    } else if (nameHasStyle(requested, style)) {
      score += 5;
    }
  }

  return score;
}

function findFontEntryByIncludes(name: string): LocalFontData | null {
  if (!localFontList || localFontList.length === 0) return null;
  const cached = localFontAliasCache.get(name);
  if (cached) return cached;
  const needle = name.toLowerCase();
  const needleNorm = normalizeFontKey(name);
  let match: LocalFontData | null = null;
  for (let i = 0; i < localFontList.length; i++) {
    const entry = localFontList[i]!;
    const fullName = entry.fullName ?? "";
    const family = entry.family ?? "";
    const postscriptName = entry.postscriptName ?? "";
    const fullLower = fullName.toLowerCase();
    const familyLower = family.toLowerCase();
    const postLower = postscriptName.toLowerCase();
    if (fullLower.includes(needle) || familyLower.includes(needle) || postLower.includes(needle)) {
      match = entry;
      break;
    }
    if (needleNorm) {
      const fullNorm = normalizeFontKey(fullName);
      const familyNorm = normalizeFontKey(family);
      const postNorm = normalizeFontKey(postscriptName);
      if (
        (fullNorm && fullNorm.includes(needleNorm)) ||
        (familyNorm && familyNorm.includes(needleNorm)) ||
        (postNorm && postNorm.includes(needleNorm))
      ) {
        match = entry;
        break;
      }
    }
  }
  if (match) localFontAliasCache.set(name, match);
  return match;
}

export function resolveBestLocalFontEntry(
  name: string,
  index: Map<string, LocalFontData>,
): LocalFontData | null {
  const cached = localFontAliasCache.get(name);
  if (cached) return cached;
  const key = name.toLowerCase();
  const normKey = normalizeFontKey(name);
  const direct = index.get(key) ?? (normKey ? index.get(normKey) : undefined);
  if (!localFontList || localFontList.length === 0) {
    if (direct) localFontAliasCache.set(name, direct);
    return direct ?? null;
  }
  let best: LocalFontData | null = null;
  let bestScore = 0;
  for (let i = 0; i < localFontList.length; i++) {
    const entry = localFontList[i]!;
    const score = scoreFontEntry(name, entry);
    if (score > bestScore) {
      bestScore = score;
      best = entry;
    }
  }
  if (!best) best = direct ?? findFontEntryByIncludes(name);
  if (best) localFontAliasCache.set(name, best);
  return best;
}

export function getLocalFontBuffer(entry: LocalFontData): Promise<ArrayBuffer> {
  const cached = localFontBufferCache.get(entry);
  if (cached) return cached;
  const load = entry
    .blob()
    .then((blob) => blob.arrayBuffer())
    .catch((err) => {
      localFontBufferCache.delete(entry);
      throw err;
    });
  localFontBufferCache.set(entry, load);
  return load;
}

export async function buildLocalFontIndex(): Promise<Map<string, LocalFontData> | null> {
  const query = localFontQuery();
  if (!query) return null;
  if (localFontIndex) return localFontIndex;
  if (localFontIndexPromise) return localFontIndexPromise;
  localFontIndexPromise = (async () => {
    try {
      const fonts = (await query()) as LocalFontData[];
      const index = new Map<string, LocalFontData>();
      localFontAliasCache.clear();
      for (let i = 0; i < fonts.length; i++) {
        const fontData = fonts[i]!;
        const family = fontData.family ?? "";
        const fullName = fontData.fullName ?? "";
        const postscriptName = fontData.postscriptName ?? "";
        if (family) {
          const familyKey = family.toLowerCase();
          if (!index.has(familyKey)) index.set(familyKey, fontData);
          const familyNorm = normalizeFontKey(family);
          if (familyNorm && !index.has(familyNorm)) index.set(familyNorm, fontData);
        }
        if (fullName) {
          const fullKey = fullName.toLowerCase();
          if (!index.has(fullKey)) index.set(fullKey, fontData);
          const fullNorm = normalizeFontKey(fullName);
          if (fullNorm && !index.has(fullNorm)) index.set(fullNorm, fontData);
        }
        if (postscriptName) {
          const postKey = postscriptName.toLowerCase();
          if (!index.has(postKey)) index.set(postKey, fontData);
          const postNorm = normalizeFontKey(postscriptName);
          if (postNorm && !index.has(postNorm)) index.set(postNorm, fontData);
        }
      }
      localFontList = fonts;
      return index;
    } catch {
      return null;
    } finally {
      localFontIndexPromise = null;
    }
  })();
  localFontIndex = await localFontIndexPromise;
  return localFontIndex;
}

export async function resolveLocalFontBuffer(fontName: string): Promise<ArrayBuffer | null> {
  const index = localFontIndex ?? (await buildLocalFontIndex());
  if (!index) return null;
  const entry = resolveBestLocalFontEntry(sanitizeFontName(fontName), index);
  return entry ? await getLocalFontBuffer(entry) : null;
}

export function getLocalFontStats(): LocalFontStats {
  return {
    available: localFontQuery() !== null,
    indexed: localFontIndex !== null,
    entries: localFontIndex?.size ?? 0,
  };
}

export function resetLocalFontAccessForTests(): void {
  localFontIndex = null;
  localFontIndexPromise = null;
  localFontList = null;
  localFontAliasCache.clear();
}
