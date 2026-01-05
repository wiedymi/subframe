import type { GlyphBuffer } from "text-shaper";
import { measureRasterGlyph, PixelMode, rasterizeGlyph, emboldenBitmapWithBearing } from "text-shaper";
import type { getFont } from "../../io/fonts/cache";
import { getFontScaleForSize, getFontSizingMetrics } from "../style/font";
import { quantSubpixel } from "../math/fixed";

type FontHandle = Awaited<ReturnType<typeof getFont>>;

const rasterMetricCache = new WeakMap<
  FontHandle,
  Map<string, { ascent: number; descent: number }>
>();

export function getRasterGlyphMetrics(
  font: FontHandle,
  glyphId: number,
  fontSizePx: number,
  hinting: boolean,
  boldStrength: number,
): { ascent: number; descent: number } {
  let cache = rasterMetricCache.get(font);
  if (!cache) {
    cache = new Map();
    rasterMetricCache.set(font, cache);
  }
  const key =
    `${glyphId}|${fontSizePx.toFixed(3)}|${hinting ? 1 : 0}|${boldStrength.toFixed(3)}`;
  const cached = cache.get(key);
  if (cached) return cached;

  let raster = rasterizeGlyph(font, glyphId, fontSizePx, {
    pixelMode: PixelMode.Gray,
    padding: 1,
    hinting,
    sizeMode: "height",
  });
  if (!raster) {
    const empty = { ascent: 0, descent: 0 };
    cache.set(key, empty);
    return empty;
  }
  if (boldStrength > 0) {
    const emb = emboldenBitmapWithBearing(
      raster.bitmap,
      raster.bearingX,
      raster.bearingY,
      boldStrength,
      boldStrength,
    );
    raster = emb;
  }
  const metrics = measureRasterGlyph(
    raster.bitmap,
    raster.bearingX,
    raster.bearingY,
  );
  cache.set(key, metrics);
  return metrics;
}

export function computeRunMetrics(
  font: FontHandle,
  shaped: GlyphBuffer,
  fontSizePx: number,
  scaleYFactor: number,
  hinting: boolean,
  boldStrength: number,
): { ascent: number; descent: number } {
  const metrics = getFontSizingMetrics(font);
  const runScaleY = getFontScaleForSize(font, fontSizePx) * scaleYFactor;
  const ascent = quantSubpixel(metrics.ascender * runScaleY);
  const descent = quantSubpixel(-metrics.descender * runScaleY);
  return { ascent, descent };
}
