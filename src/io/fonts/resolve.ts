type NodeFs = {
  existsSync: (path: string) => boolean;
  readdirSync: (path: string) => string[];
  readFileSync: (path: string) => Uint8Array;
};
type NodePath = {
  extname: (path: string) => string;
  join: (...parts: string[]) => string;
};
type NodeOs = { homedir: () => string };

import { Font } from "text-shaper";

type NodeModules = { fs: NodeFs; path: NodePath; os: NodeOs };

const FONT_EXTS = new Set([".ttf", ".otf", ".ttc", ".otc"]);
let fontSearchPaths: string[] = [];
let fontSearchIndex: Map<string, string> | null = null;
let fontFaceIndex: FontFaceInfo[] | null = null;
let nodeModules: NodeModules | null | undefined;
let macPingFangPath: string | null | undefined;
let macPingFangIndex: number | null | undefined;

const CJK_RANGES: Array<[number, number]> = [
  [0x2e80, 0x2eff], // CJK Radicals Supplement
  [0x2f00, 0x2fdf], // Kangxi Radicals
  [0x3040, 0x30ff], // Hiragana + Katakana
  [0x3100, 0x312f], // Bopomofo
  [0x3190, 0x319f], // Kanbun
  [0x31a0, 0x31bf], // Bopomofo Extended
  [0x3400, 0x4dbf], // CJK Unified Ideographs Extension A
  [0x4e00, 0x9fff], // CJK Unified Ideographs
  [0xf900, 0xfaff], // CJK Compatibility Ideographs
  [0xff00, 0xffef], // Halfwidth and Fullwidth Forms
];

function getNodeModules(): NodeModules | null {
  if (nodeModules !== undefined) return nodeModules;
  const metaReq = (import.meta as any).require as
    undefined | ((id: string) => unknown);
  const req = (globalThis as any).require ?? metaReq;
  if (typeof req !== "function") {
    nodeModules = null;
    return null;
  }
  try {
    const fs = req("node:fs") as NodeFs;
    const path = req("node:path") as NodePath;
    const os = req("node:os") as NodeOs;
    nodeModules = { fs, path, os };
    return nodeModules;
  } catch {
    nodeModules = null;
    return null;
  }
}

function requireNodeModules(): NodeModules {
  const mods = getNodeModules();
  if (!mods) {
    throw new Error(
      "Font resolution requires Bun runtime with access to system fonts.",
    );
  }
  return mods;
}

function getMacFontDirs(): string[] {
  const { path, os } = requireNodeModules();
  return [
    "/System/Library/Fonts/Supplemental",
    "/System/Library/Fonts",
    "/Library/Fonts",
    path.join(os.homedir(), "Library", "Fonts"),
  ];
}

function isCjkCodepoint(codepoint: number): boolean {
  for (let i = 0; i < CJK_RANGES.length; i++) {
    const [start, end] = CJK_RANGES[i]!;
    if (codepoint >= start && codepoint <= end) return true;
  }
  return false;
}

function findMacPingFangPath(): string | null {
  if (macPingFangPath !== undefined) return macPingFangPath;
  const { fs, path } = requireNodeModules();
  const root = "/System/Library/AssetsV2";
  let entries: string[] = [];
  try {
    entries = fs.readdirSync(root);
  } catch {
    macPingFangPath = null;
    return null;
  }
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i]!;
    if (!entry.startsWith("com_apple_MobileAsset_Font")) continue;
    const assetRoot = path.join(root, entry);
    let assets: string[] = [];
    try {
      assets = fs.readdirSync(assetRoot);
    } catch {
      continue;
    }
    for (let j = 0; j < assets.length; j++) {
      const asset = assets[j]!;
      if (!asset.endsWith(".asset")) continue;
      const candidate = path.join(
        assetRoot,
        asset,
        "AssetData",
        "PingFang.ttc",
      );
      if (fs.existsSync(candidate)) {
        macPingFangPath = candidate;
        return candidate;
      }
    }
  }

  const candidates = [
    "/System/Library/Fonts/PingFang.ttc",
    "/System/Library/Fonts/Supplemental/PingFang.ttc",
  ];
  for (let i = 0; i < candidates.length; i++) {
    const cand = candidates[i]!;
    if (fs.existsSync(cand)) {
      macPingFangPath = cand;
      return cand;
    }
  }
  macPingFangPath = null;
  return null;
}

function findPingFangScIndex(path: string): number | null {
  if (macPingFangIndex !== undefined) return macPingFangIndex;
  const { fs } = requireNodeModules();
  let buffer: ArrayBuffer;
  try {
    const file = fs.readFileSync(path);
    buffer = new Uint8Array(
      file.buffer,
      file.byteOffset,
      file.byteLength,
    ).slice().buffer;
  } catch {
    macPingFangIndex = null;
    return null;
  }

  try {
    const collection = Font.collection(buffer);
    if (!collection) {
      macPingFangIndex = null;
      return null;
    }
    const names = collection.names();
    for (let i = 0; i < names.length; i++) {
      const entry = names[i]!;
      const family = entry.family ?? "";
      const full = entry.fullName ?? "";
      if (
        family.includes("蘋方-簡") ||
        full.includes("蘋方-簡") ||
        family.toLowerCase().includes("pingfang sc") ||
        full.toLowerCase().includes("pingfang sc") ||
        family.toLowerCase().includes("pingfangsc") ||
        full.toLowerCase().includes("pingfangsc")
      ) {
        macPingFangIndex = entry.index;
        return entry.index;
      }
    }
  } catch {
    macPingFangIndex = null;
    return null;
  }

  macPingFangIndex = 0;
  return 0;
}

export function setFontSearchPaths(paths: string[]): void {
  fontSearchPaths = paths.map((p) => p.trim()).filter((p) => p.length > 0);
  fontSearchIndex = null;
  fontFaceIndex = null;
}

export function getFontSearchPaths(): string[] {
  return fontSearchPaths.slice();
}

function buildFontSearchIndex(): Map<string, string> {
  if (fontSearchIndex) return fontSearchIndex;
  const { fs, path } = requireNodeModules();
  const index = new Map<string, string>();
  for (let i = 0; i < fontSearchPaths.length; i++) {
    const dir = fontSearchPaths[i]!;
    let entries: string[] = [];
    try {
      entries = fs.readdirSync(dir);
    } catch {
      continue;
    }
    for (let e = 0; e < entries.length; e++) {
      const file = entries[e]!;
      const ext = path.extname(file).toLowerCase();
      if (!FONT_EXTS.has(ext)) continue;
      const base = file.slice(0, -ext.length).toLowerCase();
      const full = path.join(dir, file);
      if (!index.has(base)) index.set(base, full);
      if (!index.has(file.toLowerCase())) index.set(file.toLowerCase(), full);
    }
  }
  fontSearchIndex = index;
  return index;
}

// Per-face metadata mirroring libass ASS_FontInfo (ass_fontselect.c).
type FontFaceInfo = {
  path: string; // file path, with "#<index>" suffix for collection faces
  families: string[]; // lowercased name IDs 1 + 16
  fullnames: string[]; // lowercased name ID 4
  postscriptName: string | null; // lowercased name ID 6
  weight: number; // libass ass_face_get_weight mapping
  bold: boolean; // OS/2 fsSelection bit 5 (or head.macStyle bit 0)
  italic: boolean; // OS/2 fsSelection bit 0 (or head.macStyle bit 1)
  postscriptOutlines: boolean; // CFF-flavored (libass check_postscript)
};

// libass ass_font.c ass_face_get_weight
function faceWeightFromOs2(usWeightClass: number, boldFlag: boolean): number {
  switch (usWeightClass) {
    case 0:
      return boldFlag ? 700 : 400;
    case 1:
      return 100;
    case 2:
      return 200;
    case 3:
      return 300;
    case 4:
      return 350;
    case 5:
      return 400;
    case 6:
      return 600;
    case 7:
      return 700;
    case 8:
      return 800;
    case 9:
      return 900;
    default:
      return usWeightClass;
  }
}

function extractFaceInfo(font: Font, path: string): FontFaceInfo {
  const records = font.name?.records ?? [];
  const families: string[] = [];
  const fullnames: string[] = [];
  let postscriptName: string | null = null;
  for (let i = 0; i < records.length; i++) {
    const rec = records[i]!;
    const id = rec.nameId;
    if (id !== 1 && id !== 16 && id !== 4 && id !== 6) continue;
    const value = rec.value.trim().toLowerCase();
    if (!value) continue;
    if (id === 1 || id === 16) {
      if (!families.includes(value)) families[families.length] = value;
    } else if (id === 4) {
      if (!fullnames.includes(value)) fullnames[fullnames.length] = value;
    } else if (postscriptName === null) {
      postscriptName = value;
    }
  }
  const os2 = font.os2;
  let bold = false;
  let italic = false;
  if (os2 && os2.fsSelection !== undefined) {
    // libass fsSelection_to_style_flags: GDI ignores other bits.
    bold = (os2.fsSelection & 0x20) !== 0;
    italic = (os2.fsSelection & 0x01) !== 0;
  } else {
    const macStyle = font.head.macStyle;
    bold = (macStyle & 0x01) !== 0;
    italic = (macStyle & 0x02) !== 0;
  }
  const weight = faceWeightFromOs2(os2?.usWeightClass ?? 0, bold);
  return {
    path,
    families,
    fullnames,
    postscriptName,
    weight,
    bold,
    italic,
    postscriptOutlines: font.isCFF,
  };
}

function buildFontFaceIndex(): FontFaceInfo[] {
  if (fontFaceIndex) return fontFaceIndex;
  const { fs, path } = requireNodeModules();
  const faces: FontFaceInfo[] = [];
  for (let i = 0; i < fontSearchPaths.length; i++) {
    const dir = fontSearchPaths[i]!;
    let entries: string[] = [];
    try {
      entries = fs.readdirSync(dir);
    } catch {
      continue;
    }
    for (let e = 0; e < entries.length; e++) {
      const file = entries[e]!;
      const ext = path.extname(file).toLowerCase();
      if (!FONT_EXTS.has(ext)) continue;
      const full = path.join(dir, file);
      try {
        const data = fs.readFileSync(full);
        const buffer = data.buffer.slice(
          data.byteOffset,
          data.byteOffset + data.byteLength,
        ) as ArrayBuffer;
        const collection = Font.collection(buffer);
        if (collection) {
          for (let f = 0; f < collection.count; f++) {
            try {
              faces[faces.length] = extractFaceInfo(
                collection.get(f),
                `${full}#${f}`,
              );
            } catch {}
          }
        } else {
          faces[faces.length] = extractFaceInfo(Font.load(buffer), full);
        }
      } catch {}
    }
  }
  fontFaceIndex = faces;
  return faces;
}

// libass ass_fontselect.c font_attributes_similarity (lower is better)
function fontAttributesSimilarity(
  face: FontFaceInfo,
  reqWeight: number,
  reqItalic: boolean,
): number {
  let score = 0;
  if (reqItalic && !face.italic) score += 1;
  else if (!reqItalic && face.italic) score += 4;
  let weight = face.weight;
  // Offset effective weight for faux-bold (only if face isn't flagged bold)
  if (reqWeight > face.weight + 150 && !face.bold) weight += 120;
  score += Math.floor((73 * Math.abs(weight - reqWeight)) / 256);
  return score;
}

// libass ass_fontselect.c matches_full_or_postscript_name
function matchesFullOrPostscriptName(
  face: FontFaceInfo,
  fullname: string,
): boolean {
  const matchesFullname = face.fullnames.includes(fullname);
  const matchesPostscript = face.postscriptName === fullname;
  if (matchesFullname === matchesPostscript) return matchesFullname;
  return face.postscriptOutlines ? matchesPostscript : matchesFullname;
}

/**
 * Match a requested family against fonts found in the search paths, mirroring
 * libass find_font (ass_fontselect.c): family-name matches are ranked by
 * font_attributes_similarity, full/PostScript-name matches rank best (0).
 * Returns candidate paths best-first; empty when the family is unknown.
 */
export function findFontFacesForFamily(
  family: string,
  bold: boolean,
  italic: boolean,
): string[] {
  if (fontSearchPaths.length === 0) return [];
  let name = family.trim().toLowerCase();
  if (name.startsWith("@")) name = name.slice(1); // vertical layout prefix
  if (!name) return [];
  const faces = buildFontFaceIndex();
  if (faces.length === 0) return [];
  const reqWeight = bold ? 700 : 400;
  const matched: Array<{ face: FontFaceInfo; score: number; order: number }> =
    [];
  for (let i = 0; i < faces.length; i++) {
    const face = faces[i]!;
    let score: number;
    if (face.families.includes(name)) {
      score = fontAttributesSimilarity(face, reqWeight, italic);
    } else if (matchesFullOrPostscriptName(face, name)) {
      score = 0;
    } else {
      continue;
    }
    matched[matched.length] = { face, score, order: i };
  }
  if (matched.length === 0) return [];
  matched.sort((a, b) => a.score - b.score || a.order - b.order);
  const out: string[] = [];
  for (let i = 0; i < matched.length; i++) {
    out[out.length] = matched[i]!.face.path;
  }
  return out;
}

function findFontInDirs(fontName: string, dirs: string[]): string | null {
  const { fs, path } = requireNodeModules();
  for (let i = 0; i < dirs.length; i++) {
    const dir = dirs[i]!;
    const direct = path.join(dir, fontName);
    if (fs.existsSync(direct)) return direct;
    for (const ext of FONT_EXTS) {
      const candidate = path.join(dir, `${fontName}${ext}`);
      if (fs.existsSync(candidate)) return candidate;
    }
  }

  const index = new Map<string, string>();
  for (let i = 0; i < dirs.length; i++) {
    const dir = dirs[i]!;
    let entries: string[] = [];
    try {
      entries = fs.readdirSync(dir);
    } catch {
      continue;
    }
    for (let e = 0; e < entries.length; e++) {
      const file = entries[e]!;
      const ext = path.extname(file).toLowerCase();
      if (!FONT_EXTS.has(ext)) continue;
      const base = file.slice(0, -ext.length).toLowerCase();
      const full = path.join(dir, file);
      if (!index.has(base)) index.set(base, full);
      if (!index.has(file.toLowerCase())) index.set(file.toLowerCase(), full);
    }
  }
  const key = fontName.toLowerCase();
  return index.get(key) ?? null;
}

function tryFcMatch(fontName: string): string | null {
  if (typeof Bun === "undefined") return null;
  const proc = Bun.spawnSync({
    cmd: ["fc-match", "-f", "%{file}", fontName],
    stdout: "pipe",
    stderr: "pipe",
  });
  if (proc.exitCode !== 0) return null;
  const out = new TextDecoder().decode(proc.stdout).trim();
  return out || null;
}

function buildFcPatternForCodepoint(
  fontName: string | null,
  codepoint: number,
  bold: boolean,
  italic: boolean,
): string {
  const hex = codepoint.toString(16);
  const parts = [`charset=${hex}`];
  if (bold) parts[parts.length] = "weight=bold";
  if (italic) parts[parts.length] = "slant=italic";
  const base = fontName && fontName.trim().length > 0 ? fontName.trim() : "";
  if (base) return `${base}:${parts.join(":")}`;
  return `:${parts.join(":")}`;
}

function tryFcMatchCodepoint(
  fontName: string | null,
  codepoint: number,
  bold: boolean,
  italic: boolean,
): string | null {
  if (typeof Bun === "undefined") return null;
  const pattern = buildFcPatternForCodepoint(fontName, codepoint, bold, italic);
  const proc = Bun.spawnSync({
    cmd: ["fc-match", "-f", "%{file}", pattern],
    stdout: "pipe",
    stderr: "pipe",
  });
  if (proc.exitCode !== 0) return null;
  const out = new TextDecoder().decode(proc.stdout).trim();
  return out || null;
}

function tryFcMatchCodepointList(
  fontName: string | null,
  codepoint: number,
  bold: boolean,
  italic: boolean,
): string[] {
  if (typeof Bun === "undefined") return [];
  const pattern = buildFcPatternForCodepoint(fontName, codepoint, bold, italic);
  const proc = Bun.spawnSync({
    cmd: ["fc-match", "-s", "-f", "%{file}\n", pattern],
    stdout: "pipe",
    stderr: "pipe",
  });
  if (proc.exitCode !== 0) return [];
  const out = new TextDecoder().decode(proc.stdout).trim();
  if (!out) return [];
  const lines = out.split(/\r?\n/);
  const seen = new Set<string>();
  const results: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!.trim();
    if (!line) continue;
    if (seen.has(line)) continue;
    seen.add(line);
    results[results.length] = line;
  }
  return results;
}

export function resolveFontPathForCodepoint(
  fontName: string | null,
  codepoint: number,
  bold: boolean,
  italic: boolean,
): string | null {
  if (!Number.isFinite(codepoint) || codepoint <= 0) return null;
  if (process.platform === "darwin" && isCjkCodepoint(codepoint)) {
    const pingfang = findMacPingFangPath();
    if (pingfang) {
      const { path } = requireNodeModules();
      const ext = path.extname(pingfang).toLowerCase();
      if (ext === ".ttc" || ext === ".otc") {
        const idx = findPingFangScIndex(pingfang);
        return `${pingfang}#${idx ?? 0}`;
      } else {
        return pingfang;
      }
    }
  }
  return tryFcMatchCodepoint(fontName, codepoint, bold, italic);
}

export function resolveFontPathsForCodepoint(
  fontName: string | null,
  codepoint: number,
  bold: boolean,
  italic: boolean,
): string[] {
  if (!Number.isFinite(codepoint) || codepoint <= 0) return [];
  if (process.platform === "darwin" && isCjkCodepoint(codepoint)) {
    const pingfang = findMacPingFangPath();
    if (pingfang) {
      const { path } = requireNodeModules();
      const ext = path.extname(pingfang).toLowerCase();
      if (ext === ".ttc" || ext === ".otc") {
        const idx = findPingFangScIndex(pingfang);
        return [`${pingfang}#${idx ?? 0}`];
      }
      return [pingfang];
    }
  }
  return tryFcMatchCodepointList(fontName, codepoint, bold, italic);
}

export function resolveFontPath(fontName: string): string {
  const { fs, path } = requireNodeModules();
  const hash = fontName.lastIndexOf("#");
  const suffix = hash > 0 ? fontName.slice(hash) : "";
  const baseName = hash > 0 ? fontName.slice(0, hash) : fontName;
  const ext = path.extname(baseName).toLowerCase();
  if (FONT_EXTS.has(ext) && fs.existsSync(baseName))
    return `${baseName}${suffix}`;

  if (fontSearchPaths.length > 0) {
    for (let i = 0; i < fontSearchPaths.length; i++) {
      const dir = fontSearchPaths[i]!;
      const direct = path.join(dir, baseName);
      if (fs.existsSync(direct)) return `${direct}${suffix}`;
      for (const ext of FONT_EXTS) {
        const candidate = path.join(dir, `${baseName}${ext}`);
        if (fs.existsSync(candidate)) return `${candidate}${suffix}`;
      }
    }
    const index = buildFontSearchIndex();
    const key = baseName.toLowerCase();
    const indexed = index.get(key);
    if (indexed) return `${indexed}${suffix}`;
  }

  if (typeof Bun === "undefined") {
    throw new Error(
      "Font resolution requires Bun runtime with access to system fonts.",
    );
  }

  if (process.platform === "darwin") {
    const macMatch = findFontInDirs(fontName, getMacFontDirs());
    if (macMatch) return macMatch;
  }

  if (!FONT_EXTS.has(ext)) {
    const fcMatch = tryFcMatch(baseName);
    if (fcMatch) return fcMatch;
  }

  if (!FONT_EXTS.has(ext)) {
    const err = `fc-match failed for '${baseName}'`;
    throw new Error(err);
  }

  throw new Error(`Unable to resolve font '${baseName}'.`);
}
