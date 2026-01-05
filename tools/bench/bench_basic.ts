import { UnicodeBuffer, shape, rasterizeGlyph, PixelMode } from "text-shaper";
import { getFont } from "../../src/io/fonts/cache";
import { resetFontCache } from "../../src/io/fonts/cache";
import { setFontSearchPaths } from "../../src/io/fonts/resolve";

function getArg(args: string[], name: string, fallback?: string) {
  const idx = args.indexOf(name);
  if (idx === -1) return fallback;
  return args[idx + 1];
}

function nowMs(): number {
  return performance.now();
}

async function benchShape(fontName: string, text: string, iters: number): Promise<number> {
  const font = await getFont(fontName);
  const buffer = new UnicodeBuffer();
  buffer.addStr(text);

  let totalGlyphs = 0;
  const t0 = nowMs();
  for (let i = 0; i < iters; i++) {
    const shaped = shape(font, buffer);
    totalGlyphs += shaped.infos.length;
  }
  const t1 = nowMs();
  const elapsed = t1 - t0;
  console.log(`shape: ${iters} iters, ${totalGlyphs} glyphs, ${elapsed.toFixed(2)}ms`);
  return elapsed;
}

async function benchRaster(fontName: string, text: string, iters: number, fontSize: number): Promise<number> {
  const font = await getFont(fontName);
  const buffer = new UnicodeBuffer();
  buffer.addStr(text);
  const shaped = shape(font, buffer);
  const glyphId = shaped.infos.length > 0 ? shaped.infos[0]!.glyphId : 0;

  let totalPixels = 0;
  const t0 = nowMs();
  for (let i = 0; i < iters; i++) {
    const raster = rasterizeGlyph(font, glyphId, fontSize, {
      pixelMode: PixelMode.Gray,
      padding: 1,
      hinting: false,
    });
    if (raster) totalPixels += raster.bitmap.width * raster.bitmap.rows;
  }
  const t1 = nowMs();
  const elapsed = t1 - t0;
  console.log(`raster: ${iters} iters, ${totalPixels} px, ${elapsed.toFixed(2)}ms`);
  return elapsed;
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const mode = (getArg(args, "--mode", "both") || "both").toLowerCase();
  const iters = Number(getArg(args, "--iters", "1000"));
  const text = getArg(args, "--text", "Hello World")!;
  const fontName = getArg(args, "--font", "Arial")!;
  const fontSize = Number(getArg(args, "--size", "32"));
  const fonts = getArg(args, "--fonts");

  if (!Number.isFinite(iters) || iters <= 0) {
    console.error("Invalid --iters");
    process.exit(1);
  }

  (async () => {
    if (fonts) {
      setFontSearchPaths(fonts.split(","));
      resetFontCache();
    }
    if (mode === "shape" || mode === "both") {
      await benchShape(fontName, text, iters);
    }
    if (mode === "raster" || mode === "both") {
      await benchRaster(fontName, text, iters, fontSize);
    }
  })().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
