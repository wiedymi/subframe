// End-to-end DIST story check: serves the built dist/index.js +
// dist/worker-entry.js over plain http (no dev bundler, no setWorkerSource),
// loads a page that imports the dist bundle, renders frames, and reports
// worker pool stats. Verifies the default sibling-URL bootstrap: worker-pool
// inside dist/index.js must resolve ./worker-entry.js next to itself and boot.
//
// Usage: bun run tools/gpu-headless/run-dist-check.ts   (run `bun run build` first)
// Exit 0 = pool booted (workers > 0, no construct errors); 1 otherwise.
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parseASS } from "subforge/ass";
import { setFontSearchPaths, resolveFontPath } from "../../src/io/fonts/resolve";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "../..");
const FIXTURES = join(ROOT, "test/fixtures/jassub-benchmark");
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const PORT = 8796;
const TIMEOUT_MS = 60_000;

setFontSearchPaths([join(FIXTURES, "fonts")]);

const assText = readFileSync(join(FIXTURES, "subtitles/beastars.ass"), "utf8");
const parsed = parseASS(assText, { onError: "collect", strict: false, preserveOrder: true });
// SubtitleDocument crosses to the page via JSON; Maps (e.g. doc.styles) need
// an explicit replacer/reviver because JSON.stringify(Map) yields {}.
const docJson = JSON.stringify(parsed.document, (_k, v) =>
  v instanceof Map ? { __map: [...v] } : v,
);

const PAGE = `<!doctype html>
<html><head><meta charset="utf-8"><title>dist check</title></head><body>
<script type="module">
const post = (b) => fetch("/result", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(b) }).catch(() => {});
const attempts = [];
const NativeWorker = globalThis.Worker;
globalThis.Worker = function PatchedWorker(url, opts) {
  const rec = { url: String(url), constructed: false, asyncErrors: [] };
  attempts.push(rec);
  let w;
  try { w = new NativeWorker(url, opts); } catch (e) { rec.constructError = String(e); throw e; }
  rec.constructed = true;
  w.addEventListener("error", (e) => rec.asyncErrors.push(String(e.message ?? e)));
  return w;
};
globalThis.Worker.prototype = NativeWorker.prototype;
try {
  const mod = await import("/dist/index.js");
  const docText = await (await fetch("/doc.json")).text();
  const doc = JSON.parse(docText, (k, v) => (v && v.__map ? new Map(v.__map) : v));
  mod.setFontResolver(async (name) => {
    const res = await fetch("/font?name=" + encodeURIComponent(name));
    if (!res.ok) return null;
    const buf = await res.arrayBuffer();
    mod.registerFontSource(name, buf);
    return buf;
  });
  const T0 = 246350;
  for (let i = 0; i < 10; i++) {
    await mod.renderFrame(doc, T0 + i * 100, 1920, 1080);
    await new Promise((r) => setTimeout(r, 100));
  }
  await new Promise((r) => setTimeout(r, 1500));
  await mod.renderFrame(doc, T0 + 1200, 1920, 1080);
  await post({ ok: true, stats: mod.getWorkerPoolStats ? mod.getWorkerPoolStats() : null, attempts });
} catch (err) {
  await post({ ok: false, error: String(err), stack: err && err.stack, attempts });
}
</script></body></html>`;

let resolveResult: (r: any) => void;
const resultPromise = new Promise<any>((res) => {
  resolveResult = res;
});

const server = Bun.serve({
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === "/") {
      return new Response(PAGE, { headers: { "content-type": "text/html" } });
    }
    if (url.pathname === "/dist/index.js" || url.pathname === "/dist/worker-entry.js") {
      return new Response(Bun.file(join(ROOT, url.pathname.slice(1))), {
        headers: { "content-type": "text/javascript" },
      });
    }
    if (url.pathname === "/doc.json") {
      return new Response(docJson, { headers: { "content-type": "application/json" } });
    }
    if (url.pathname === "/font") {
      const name = url.searchParams.get("name") ?? "";
      try {
        const resolved = resolveFontPath(name);
        const hash = resolved.lastIndexOf("#");
        return new Response(readFileSync(hash > 0 ? resolved.slice(0, hash) : resolved));
      } catch {
        return new Response("nf", { status: 404 });
      }
    }
    if (url.pathname === "/result" && req.method === "POST") {
      resolveResult(await req.json());
      return new Response("ok");
    }
    return new Response("nf", { status: 404 });
  },
});

const userDataDir = mkdtempSync(join(tmpdir(), "dist-check-"));
const chrome = spawn(
  CHROME,
  ["--headless=new", "--no-sandbox", "--no-first-run", `--user-data-dir=${userDataDir}`, `http://localhost:${PORT}/`],
  { stdio: "ignore" },
);
const timer = setTimeout(() => resolveResult({ ok: false, error: "timeout" }), TIMEOUT_MS);
const result = await resultPromise;
clearTimeout(timer);
chrome.kill("SIGKILL");
server.stop(true);
try {
  rmSync(userDataDir, { recursive: true, force: true });
} catch {
  /* ignore */
}
console.log(JSON.stringify(result, null, 2));
const booted = result.ok && result.stats && result.stats.workers > 0;
console.log(`DIST CHECK: ${booted ? "PASS" : "FAIL"}`);
process.exit(booted ? 0 : 1);
