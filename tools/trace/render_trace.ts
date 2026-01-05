import { writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
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

  if (!ass || !w || !h) {
    console.error(
      "Usage: bun run tools/trace/render_trace.ts --ass <file.ass> --time <ms> --w <width> --h <height> [--fonts <dir>] [--out <out.json>]"
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
        console.warn(`trace: parse errors: ${parsed.errors.length}`);
      }

      const rendered = await renderFrameFromDocumentWithTrace(parsed.document, timeMs, w, h);
      const layerSummary = rendered.result.layers.map((layer, index) => ({
        index,
        width: layer.width,
        height: layer.height,
        originX: layer.originX,
        originY: layer.originY,
        z: layer.z,
        color: layer.color,
        clip: layer.clip ? layer.clip.type : null,
      }));
      const payload = {
        trace: rendered.trace,
        layerCount: rendered.result.layers.length,
        layers: layerSummary,
      };
      const json = JSON.stringify(payload, null, 2);

      if (out) {
        mkdirSync(dirname(out), { recursive: true });
        writeFileSync(out, json);
      } else {
        console.log(json);
      }
    })
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
