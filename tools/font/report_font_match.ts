import { readFileSync, writeFileSync } from "node:fs";
import { parseASS } from "subforge/ass";
import { resolveFontPath, setFontSearchPaths } from "../../src/io/fonts/resolve";

type FontRequest = {
  source: string;
  styleName: string;
  fontName: string;
  bold: boolean;
  italic: boolean;
};

function getArg(args: string[], name: string, fallback?: string): string | undefined {
  const idx = args.indexOf(name);
  if (idx === -1) return fallback;
  return args[idx + 1] ?? fallback;
}

function uniqKey(req: FontRequest): string {
  return `${req.fontName}::${req.bold ? "b" : "n"}${req.italic ? "i" : "n"}`;
}

function buildFcPattern(fontName: string, bold: boolean, italic: boolean): string {
  const styles: string[] = [];
  if (bold) styles[styles.length] = "Bold";
  if (italic) styles[styles.length] = "Italic";
  const style = styles.length > 0 ? styles.join(" ") : "Regular";
  return `${fontName}:style=${style}`;
}

function fcMatch(pattern: string): { file: string; family: string; style: string; weight: string; slant: string } | null {
  if (typeof Bun === "undefined") return null;
  const proc = Bun.spawnSync({
    cmd: ["fc-match", "-f", "%{file}|%{family}|%{style}|%{weight}|%{slant}", pattern],
    stdout: "pipe",
    stderr: "pipe",
  });
  if (proc.exitCode !== 0) return null;
  const out = new TextDecoder().decode(proc.stdout).trim();
  if (!out) return null;
  const [file, family, style, weight, slant] = out.split("|");
  if (!file) return null;
  return { file, family: family ?? "", style: style ?? "", weight: weight ?? "", slant: slant ?? "" };
}

function collectFontRequests(doc: ReturnType<typeof parseASS>["document"]): FontRequest[] {
  const out: FontRequest[] = [];

  for (const style of doc.styles.values()) {
    out[out.length] = {
      source: "style",
      styleName: style.name,
      fontName: style.fontName,
      bold: !!style.bold,
      italic: !!style.italic,
    };
  }

  for (let i = 0; i < doc.events.length; i++) {
    const ev = doc.events[i]!;
    for (let s = 0; s < ev.segments.length; s++) {
      const seg = ev.segments[s]!;
      if (!seg.style) continue;
      if (!seg.style.fontName && seg.style.bold === undefined && seg.style.italic === undefined) continue;
      const baseStyle = doc.styles.get(ev.style);
      const fontName = seg.style.fontName ?? baseStyle?.fontName ?? "";
      const bold = seg.style.bold !== undefined ? !!seg.style.bold : !!baseStyle?.bold;
      const italic = seg.style.italic !== undefined ? !!seg.style.italic : !!baseStyle?.italic;
      out[out.length] = {
        source: `inline:${i}:${s}`,
        styleName: ev.style,
        fontName,
        bold,
        italic,
      };
    }
  }

  return out;
}

async function main() {
  const args = process.argv.slice(2);
  const assPath = getArg(args, "--ass");
  const outPath = getArg(args, "--out");
  const fonts = getArg(args, "--fonts");

  if (!assPath) {
    console.error("Usage: bun run tools/font/report_font_match.ts --ass <file.ass> [--fonts <dir>] [--out <out.md>]");
    process.exit(1);
  }

  if (fonts) {
    setFontSearchPaths(fonts.split(","));
  }

  const text = readFileSync(assPath, "utf8");
  const parsed = parseASS(text, { onError: "collect", strict: false, preserveOrder: true });
  if (!parsed.ok && parsed.errors.length > 0) {
    console.warn(`font report: parse errors: ${parsed.errors.length}`);
  }

  const requests = collectFontRequests(parsed.document);
  const rows = new Map<string, { req: FontRequest; ours: string; fc: ReturnType<typeof fcMatch> | null }>();
  for (const req of requests) {
    const key = uniqKey(req);
    if (rows.has(key)) continue;
    let ours = "";
    try {
      ours = resolveFontPath(req.fontName);
    } catch (err) {
      ours = `error: ${(err as Error).message}`;
    }
    const pattern = buildFcPattern(req.fontName, req.bold, req.italic);
    const fc = fcMatch(pattern);
    rows.set(key, { req, ours, fc });
  }

  const lines: string[] = [];
  lines[lines.length] = `# Font Match Report`;
  lines[lines.length] = "";
  lines[lines.length] = `ASS: \`${assPath}\``;
  if (fonts) lines[lines.length] = `Fonts dir: \`${fonts}\``;
  lines[lines.length] = "";
  lines[lines.length] = `| Font | Bold | Italic | Subframe resolver | fc-match (libass-like) |`;
  lines[lines.length] = `|---|---|---|---|---|`;
  for (const { req, ours, fc } of rows.values()) {
    const fcPath = fc ? `${fc.file} (${fc.family} ${fc.style})` : "n/a";
    lines[lines.length] =
      `| ${req.fontName} | ${req.bold ? "yes" : "no"} | ${req.italic ? "yes" : "no"} | ${ours} | ${fcPath} |`;
  }

  const output = lines.join("\n");
  if (outPath) {
    writeFileSync(outPath, output);
  } else {
    console.log(output);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
