import type { getFont } from "../../io/fonts/cache";

type NameRecord = { nameId: number; value: string; platformId?: number };

type FontHandle = Awaited<ReturnType<typeof getFont>>;

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

function resolveFontSizingMetrics(font: FontHandle): FontSizingMetrics {
  const ascender = font.ascender;
  const descender = font.descender;
  const height = font.height;
  return { ascender, descender, height: height || ascender - descender || font.unitsPerEm };
}

export function getFontSizingMetrics(font: FontHandle): FontSizingMetrics {
  return resolveFontSizingMetrics(font);
}

export function getFontScaleForSize(font: FontHandle, sizePx: number): number {
  return font.scaleForSize(sizePx, "height");
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
  font: FontHandle,
  boldRequested: boolean,
  italicRequested: boolean,
): ResolvedFontStyle {
  const fontMeta = font as unknown as {
    os2?: { usWeightClass?: number; fsSelection?: number };
    post?: { italicAngle?: number };
    name?: unknown;
    hasHinting?: boolean;
  };
  const os2 = fontMeta.os2;
  const post = fontMeta.post;
  const nameRecords = ((fontMeta.name as { records?: NameRecord[] } | null)
    ?.records ?? []) as NameRecord[];
  const nameStyle =
    getNameValue(nameRecords, 2) ??
    getNameValue(nameRecords, 17) ??
    getNameValue(nameRecords, 4) ??
    getNameValue(nameRecords, 6) ??
    "";
  const nameStyleLower = nameStyle.toLowerCase();
  const nameIsBold =
    /\b(bold|black|heavy|demi|semi\s*bold|extrabold)\b/.test(nameStyleLower);
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
  const fontHintingSupported =
    fontMeta.hasHinting ??
    (font as unknown as { hasTable?: (tag: string) => boolean }).hasTable?.(
      "glyf",
    ) ??
    false;
  const fontMetrics = font as unknown as {
    underlinePosition?: number;
    underlineThickness?: number;
    strikeoutPosition?: number;
    strikeoutThickness?: number;
  };
  const underlinePos = fontMetrics.underlinePosition ?? -font.unitsPerEm * 0.1;
  const underlineThickness =
    fontMetrics.underlineThickness ?? Math.max(1, font.unitsPerEm * 0.05);
  const strikeoutPos = fontMetrics.strikeoutPosition ?? -font.unitsPerEm * 0.3;
  const strikeoutThickness =
    fontMetrics.strikeoutThickness ?? Math.max(1, font.unitsPerEm * 0.05);

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
