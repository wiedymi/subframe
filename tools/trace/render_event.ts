import { writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { PNG } from "pngjs";
import { parseASS } from "subforge/ass";
import { renderFrameFromDocumentWithTrace } from "../../src/core/render";
import { resetFontCache } from "../../src/io/fonts/cache";
import { setFontSearchPaths } from "../../src/io/fonts/resolve";

function getArg(args: string[], name: string, fallback?: string) {
  const idx = args.indexOf(name);
  if (idx === -1) return fallback;
  return args[idx + 1];
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const ass = getArg(args, "--ass");
  const out = getArg(args, "--out");
  const timeMs = Number(getArg(args, "--time", "0"));
  const w = Number(getArg(args, "--w", "0"));
  const h = Number(getArg(args, "--h", "0"));
  const fonts = getArg(args, "--fonts");
  const eventIndex = Number(getArg(args, "--event", "0"));

  if (!ass || !out || !w || !h) {
    console.error(
      "Usage: bun run tools/trace/render_event.ts --ass <file.ass> --time <ms> --w <width> --h <height> --event <index> [--fonts <dir>] --out <out.png>"
    );
    process.exit(1);
  }

  if (fonts) {
    setFontSearchPaths(fonts.split(","));
    resetFontCache();
  }

  const input = Bun.file(ass).text();
  input
    .then(async (text) => {
      const parsed = parseASS(text, { onError: "collect", strict: false, preserveOrder: true });
      if (!parsed.ok && parsed.errors.length > 0) {
        console.warn(`subframe: parse errors: ${parsed.errors.length}`);
      }

      const rendered = await renderFrameFromDocumentWithTrace(parsed.document, timeMs, w, h);
      const traceEvent = rendered.trace.events[eventIndex];
      if (!traceEvent) {
        console.error(`Event index ${eventIndex} out of range (events=${rendered.trace.events.length}).`);
        process.exit(1);
      }

      const layerIndexSet = new Set<number>();
      for (const layer of traceEvent.layers) layerIndexSet.add(layer.index);

      const png = new PNG({ width: w, height: h });
      png.data.fill(0);

      const layers = rendered.result.layers;
      for (let i = 0; i < layers.length; i++) {
        if (!layerIndexSet.has(i)) continue;
        const layer = layers[i]!;
        const lw = layer.width;
        const lh = layer.height;
        const stride = layer.stride;
        const src = layer.bitmap;
        const baseX = Math.round(layer.originX);
        const baseY = Math.round(layer.originY);
        const r = layer.color[0];
        const g = layer.color[1];
        const b = layer.color[2];
        const a = layer.color[3];

        for (let y = 0; y < lh; y++) {
          const dstY = baseY + y;
          if (dstY < 0 || dstY >= h) continue;
          const srcRow = y * stride;
          const dstRow = dstY * w * 4;
          for (let x = 0; x < lw; x++) {
            const dstX = baseX + x;
            if (dstX < 0 || dstX >= w) continue;
            const mask = src[srcRow + x];
            if (mask === 0) continue;

            const k = mask * a;
            const di = dstRow + dstX * 4;

            const dr = png.data[di + 0];
            const dg = png.data[di + 1];
            const db = png.data[di + 2];
            const da = png.data[di + 3];

            const rounding = 255 * 255 / 2;
            png.data[di + 0] = (k * r + (255 * 255 - k) * dr + rounding) / (255 * 255);
            png.data[di + 1] = (k * g + (255 * 255 - k) * dg + rounding) / (255 * 255);
            png.data[di + 2] = (k * b + (255 * 255 - k) * db + rounding) / (255 * 255);
            png.data[di + 3] = (k * 255 + (255 * 255 - k) * da + rounding) / (255 * 255);
          }
        }
      }

      for (let y = 0; y < h; y++) {
        const row = y * w * 4;
        for (let x = 0; x < w; x++) {
          const idx = row + x * 4;
          const alpha = png.data[idx + 3]!;
          if (alpha) {
            const inv = Math.floor(((255 << 16) / alpha) + 1);
            const offs = 1 << 15;
            png.data[idx + 0] = (png.data[idx + 0]! * inv + offs) >> 16;
            png.data[idx + 1] = (png.data[idx + 1]! * inv + offs) >> 16;
            png.data[idx + 2] = (png.data[idx + 2]! * inv + offs) >> 16;
          }
        }
      }

      mkdirSync(dirname(out), { recursive: true });
      writeFileSync(out, PNG.sync.write(png));
      console.log(`subframe: event=${eventIndex} layers=${layerIndexSet.size} out=${out}`);
    })
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
