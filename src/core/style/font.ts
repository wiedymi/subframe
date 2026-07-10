import type { Font, NameRecord } from "text-shaper";

export type ResolvedFontStyle = {
  syntheticBold: boolean;
  syntheticItalic: boolean;
  fontHintingSupported: boolean;
  underlinePos: number;
  underlineThickness: number;
  strikeoutPos: number;
  strikeoutThickness: number;
};

export type FontSizingMetrics = {
  ascender: number;
  descender: number;
  height: number;
};

function resolveFontSizingMetrics(font: Font): FontSizingMetrics {
  const os2 = font.os2;
  let ascender = font.ascender;
  let descender = font.descender;
  let height = font.height;
  if (os2) {
    const winAscent = os2.usWinAscent ?? 0;
    const winDescent = os2.usWinDescent ?? 0;
    if (winAscent + winDescent !== 0) {
      ascender = winAscent;
      descender = -winDescent;
      height = ascender - descender;
    } else {
      const typoAsc = os2.sTypoAscender ?? 0;
      const typoDesc = os2.sTypoDescender ?? 0;
      if (typoAsc - typoDesc !== 0) {
        ascender = typoAsc;
        descender = typoDesc;
        height = ascender - descender;
      }
    }
  }
  return {
    ascender,
    descender,
    height: height || ascender - descender || font.unitsPerEm,
  };
}

export function getFontSizingMetrics(font: Font): FontSizingMetrics {
  return resolveFontSizingMetrics(font);
}

export function getFontScaleForSize(font: Font, sizePx: number): number {
  const metrics = getFontSizingMetrics(font);
  const denom = metrics.height > 0 ? metrics.height : font.unitsPerEm;
  const baseHeight = font.height;
  if (!Number.isFinite(baseHeight) || baseHeight <= 0) {
    return sizePx / denom;
  }
  const adjustedSize = (sizePx * baseHeight) / denom;
  return font.scaleForSize(adjustedSize, "height");
}

function getNameValue(records: NameRecord[], nameId: number): string | null {
  for (let i = 0; i < records.length; i++) {
    const rec = records[i]!;
    if (rec.nameId !== nameId) continue;
    if (rec.platformId === 3 || rec.platformId === 0) return rec.value;
  }
  for (let i = 0; i < records.length; i++) {
    const rec = records[i]!;
    if (rec.nameId === nameId) return rec.value;
  }
  return null;
}

export function resolveFontStyle(
  font: Font,
  boldRequested: boolean,
  italicRequested: boolean,
): ResolvedFontStyle {
  const os2 = font.os2;
  const post = font.post;
  const nameRecords = font.name?.records ?? [];
  const nameStyle =
    getNameValue(nameRecords, 2) ??
    getNameValue(nameRecords, 17) ??
    getNameValue(nameRecords, 4) ??
    getNameValue(nameRecords, 6) ??
    "";
  const nameStyleLower = nameStyle.toLowerCase();
  const nameIsBold = /\b(bold|black|heavy|demi|semi\s*bold|extrabold)\b/.test(
    nameStyleLower,
  );
  const nameIsItalic = /\b(italic|oblique|slanted)\b/.test(nameStyleLower);
  const fontIsBold =
    (os2?.usWeightClass !== undefined && os2.usWeightClass >= 600) ||
    ((os2?.fsSelection ?? 0) & 0x20) !== 0 ||
    nameIsBold;
  const fontIsItalic =
    ((os2?.fsSelection ?? 0) & 0x01) !== 0 ||
    (post?.italicAngle !== undefined && post.italicAngle !== 0) ||
    nameIsItalic;
  const syntheticBold = boldRequested && !fontIsBold;
  const syntheticItalic = italicRequested && !fontIsItalic;
  const fontHintingSupported = font.hasHinting;
  const underlinePos = post?.underlinePosition ?? -font.unitsPerEm * 0.1;
  const underlineThickness =
    post?.underlineThickness ?? Math.max(1, font.unitsPerEm * 0.05);
  const strikeoutPos = os2?.yStrikeoutPosition ?? -font.unitsPerEm * 0.3;
  const strikeoutThickness =
    os2?.yStrikeoutSize ?? Math.max(1, font.unitsPerEm * 0.05);

  return {
    syntheticBold,
    syntheticItalic,
    fontHintingSupported,
    underlinePos,
    underlineThickness,
    strikeoutPos,
    strikeoutThickness,
  };
}
