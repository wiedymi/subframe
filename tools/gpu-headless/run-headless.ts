// Headless hardware gate for the WebGPU blur engine. Bundles selftest-entry.ts,
// serves it + selftest.html over a local bun HTTP server, launches headless
// Chrome with WebGPU enabled, waits for the page to POST its JSON verdict to
// /result, prints it, and exits nonzero on FAIL. This is the permanent hardware
// gate: reproduces failures AND verifies fixes without needing the user.
//
// Usage:
//   bun run tools/gpu-headless/run-headless.ts            # full run
//   bun run tools/gpu-headless/run-headless.ts --keep     # keep chrome logs
//   bun run tools/gpu-headless/run-headless.ts --no-unsafe  # omit unsafe-webgpu flag
//
// Exit code 0 = all groups pass; 1 = failures/error/timeout.

import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { setFontSearchPaths, resolveFontPath } from "../../src/io/fonts/resolve";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "../..");
const FIXTURES = join(ROOT, "test/fixtures/jassub-benchmark");
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const PORT = 8777;
const TIMEOUT_MS = 180_000;
const argv = process.argv.slice(2);
const noUnsafe = argv.includes("--no-unsafe");
const keep = argv.includes("--keep");
const argVal = (name: string): string | null => {
  const idx = argv.indexOf(name);
  if (idx >= 0) return argv[idx + 1] ?? null;
  const pref = `${name}=`;
  const found = argv.find((a) => a.startsWith(pref));
  return found ? found.slice(pref.length) : null;
};
const fullframeMode = argVal("--fullframe") ?? "default";

async function bundle(): Promise<string> {
  const out = await Bun.build({
    entrypoints: [join(HERE, "selftest-entry.ts")],
    target: "browser",
    format: "esm",
    minify: false,
  });
  if (!out.success) {
    for (const l of out.logs) console.error(l);
    throw new Error("bundle failed");
  }
  return await out.outputs[0]!.text();
}

async function bundleWorker(): Promise<string> {
  const out = await Bun.build({
    entrypoints: [join(ROOT, "src/core/worker-entry.ts")],
    target: "browser",
    format: "esm",
    minify: false,
  });
  if (!out.success) {
    for (const l of out.logs) console.error(l);
    throw new Error("worker bundle failed");
  }
  return await out.outputs[0]!.text();
}

let resolveResult: (r: any) => void;
const resultPromise = new Promise<any>((res) => { resolveResult = res; });

async function main() {
  const bundleJs = await bundle();
  const workerJs = await bundleWorker();
  const html = await Bun.file(join(HERE, "selftest.html")).text();

  setFontSearchPaths([join(FIXTURES, "fonts")]);

  const server = Bun.serve({
    port: PORT,
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === "/" || url.pathname === "/selftest.html") {
        return new Response(html, { headers: { "content-type": "text/html" } });
      }
      if (url.pathname === "/selftest.bundle.js") {
        return new Response(bundleJs, { headers: { "content-type": "text/javascript" } });
      }
      if (url.pathname === "/worker-entry.js") {
        return new Response(workerJs, { headers: { "content-type": "text/javascript" } });
      }
      if (url.pathname === "/ass/FGOBD.ass") {
        const f = Bun.file(join(FIXTURES, "subtitles", "FGOBD.ass"));
        return new Response(f, { headers: { "content-type": "text/plain; charset=utf-8" } });
      }
      if (url.pathname === "/ass/beastars.ass") {
        const f = Bun.file(join(FIXTURES, "subtitles", "beastars.ass"));
        return new Response(f, { headers: { "content-type": "text/plain; charset=utf-8" } });
      }
      if (url.pathname === "/font") {
        const name = url.searchParams.get("name") ?? "";
        try {
          const resolved = resolveFontPath(name);
          const hash = resolved.lastIndexOf("#");
          const filePath = hash > 0 ? resolved.slice(0, hash) : resolved;
          return new Response(readFileSync(filePath), {
            headers: { "content-type": "application/octet-stream" },
          });
        } catch {
          return new Response("not found", { status: 404 });
        }
      }
      if (url.pathname === "/arial.ttf") {
        const f = Bun.file(join(HERE, "../../test/fixtures/jassub-benchmark/fonts/arial.ttf"));
        return new Response(f, { headers: { "content-type": "font/ttf" } });
      }
      if (url.pathname === "/result" && req.method === "POST") {
        const body = await req.json();
        resolveResult(body);
        return new Response("ok");
      }
      return new Response("not found", { status: 404 });
    },
  });

  const userDataDir = mkdtempSync(join(tmpdir(), "gpu-headless-"));
  const flags = [
    "--headless=new",
    "--use-angle=metal",
    "--enable-features=Vulkan",
    "--no-sandbox",
    `--user-data-dir=${userDataDir}`,
    "--no-first-run",
    "--disable-gpu-sandbox",
  ];
  if (!noUnsafe) flags.push("--enable-unsafe-webgpu");
  const qs = fullframeMode === "default"
    ? ""
    : `?fullframe=${encodeURIComponent(fullframeMode)}`;
  flags.push(`http://localhost:${PORT}/selftest.html${qs}`);

  const chrome = spawn(CHROME, flags, { stdio: keep ? "inherit" : "ignore" });

  const timer = setTimeout(() => resolveResult({ ok: false, error: "timeout waiting for /result", timeout: true }), TIMEOUT_MS);

  const result = await resultPromise;
  clearTimeout(timer);
  chrome.kill("SIGKILL");
  server.stop(true);
  if (!keep) { try { rmSync(userDataDir, { recursive: true, force: true }); } catch {} }

  printResult(result);
  process.exit(result.ok ? 0 : 1);
}

function printResult(r: any) {
  console.log("\n=== GPU headless self-test result ===");
  if (r.adapterInfo) console.log(`adapter: ${JSON.stringify(r.adapterInfo)}`);
  console.log(`timestamp-query: ${r.timestampQuery}`);
  if (r.error) console.log(`ERROR: ${r.error}`);
  if (r.shaderCompile) {
    const sc = r.shaderCompile;
    console.log(`shaderCompile: ${sc.messages ? sc.messages.length + " messages" : ""}${sc.validationError ? " validationError=" + sc.validationError : ""}${sc.thrown ? " thrown=" + sc.thrown : ""}`);
    for (const m of sc.messages || []) console.log(`  [${m.type}] ${m.lineNum}:${m.linePos} ${m.message}`);
  }
  const g = r.groups || {};
  if (g.stage1) console.log(`stage1:  ${g.stage1.pass} PASS / ${g.stage1.fail} FAIL`);
  if (g.batched) console.log(`batched: ${g.batched.pass} PASS / ${g.batched.fail} FAIL${g.batched.fail ? "  fails=" + JSON.stringify(g.batched.fails) : ""}`);
  if (g.cache) console.log(`cache:   ${g.cache.pass} PASS / ${g.cache.fail} FAIL, frame2 hits ${g.cache.frame2Hits}/${g.cache.total}`);
  if (r.gpuTimeMs != null) console.log(`gpuTimeMs (last batch): ${r.gpuTimeMs}`);
  if (r.fullframe) {
    const ff = r.fullframe;
    if (ff.error) console.log(`fullframe: ERROR ${ff.error}`);
    else if (!ff.available) console.log(`fullframe: unavailable (no GPU filter provider)`);
    else {
      console.log(`fullframe: ${ff.pass ? "PASS" : "FAIL"}`);
      for (const c of ff.cases || []) console.log(`  ${c.name}: ${c.pass ? "PASS" : "FAIL"} maxDiff=${c.maxDiff} diffPx=${c.diffPx} gpuRouted=${c.gpuRouted} gpuRoutedOff=${c.gpuRoutedOff ?? 0} layers ON=${c.layersOn} OFF=${c.layersOff}`);
    }
  }
  if (r.debug) {
    for (const which of ["singleton", "mixed"]) {
      const d = r.debug[which];
      if (!d) continue;
      if (d.firstDivergentRound != null && d.firstDivergentRound >= 0) {
        console.log(`\ndebug[${which}] FIRST DIVERGENT PASS: round ${d.firstDivergentRound} entry=${d.entry} jobs=${d.jobCount} totalPixels=${d.totalPixels}`);
        console.log(`  first idx=${d.firstIdx} gpu=${d.gpuVal} emu=${d.emuVal} diffCount=${d.diffCount} owner=mask${d.owner.mask}/${d.owner.slot}+${d.owner.rel}`);
        console.log(`  samples: ${JSON.stringify(d.samples)}`);
        console.log(`  rounds: ${JSON.stringify(d.rounds)}`);
      } else {
        console.log(`\ndebug[${which}]: all rounds match emulator; output diff=${d.output ? d.output.diffCount : "?"}`);
      }
    }
  }
  console.log(`\nVERDICT: ${r.ok ? "PASS" : "FAIL"}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
