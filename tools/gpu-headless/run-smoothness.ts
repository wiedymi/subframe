// Headless-Chrome driver for the perceived-smoothness bench. Serves
// smoothness.html through Bun's dev bundler (same pipeline as the playground),
// launches headless Chrome with WebGPU, waits for the page to POST its
// present-interval measurements, and prints a BEFORE/AFTER table.
//
// Usage: bun run tools/gpu-headless/run-smoothness.ts [--keep] [--out result.json]
//        [--workers 6] [--measure-ms 8000] [--t0 246350] [--fixture beastars.ass]
// @ts-ignore Bun html import
import bench from "./smoothness.html";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { setFontSearchPaths, resolveFontPath } from "../../src/io/fonts/resolve";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "../..");
const FIXTURES = join(ROOT, "test/fixtures/jassub-benchmark");
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const PORT = 8795;
const TIMEOUT_MS = 300_000;

const argv = process.argv.slice(2);
const keep = argv.includes("--keep");
function argVal(flag: string): string | null {
  const i = argv.indexOf(flag);
  return i !== -1 ? (argv[i + 1] ?? null) : null;
}
const outPath = argVal("--out");
const qs = new URLSearchParams();
{
  const workers = argVal("--workers");
  const measureMs = argVal("--measure-ms");
  const t0 = argVal("--t0");
  const fixture = argVal("--fixture");
  if (workers) qs.set("workers", workers);
  if (measureMs) qs.set("measureMs", measureMs);
  if (t0) qs.set("t0", t0);
  if (fixture) qs.set("fixture", fixture);
}
const QUERY = qs.toString() ? `?${qs.toString()}` : "";

setFontSearchPaths([join(FIXTURES, "fonts")]);

const workerBuild = await Bun.build({
  entrypoints: [join(ROOT, "src/core/worker-entry.ts")],
  target: "browser",
  format: "esm",
  minify: false,
});
if (!workerBuild.success) {
  for (const l of workerBuild.logs) console.error(l);
  throw new Error("worker-entry bundle failed");
}
const workerJs = await workerBuild.outputs[0]!.text();

let resolveResult: (r: any) => void;
const resultPromise = new Promise<any>((res) => {
  resolveResult = res;
});
const fontLog: Array<{ name: string; resolved: string | null }> = [];

const server = Bun.serve({
  port: PORT,
  development: true,
  routes: { "/": bench },
  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === "/worker-entry.js") {
      return new Response(workerJs, {
        headers: { "content-type": "text/javascript; charset=utf-8" },
      });
    }
    if (url.pathname.startsWith("/ass/")) {
      const name = url.pathname.slice(5);
      if (name.includes("..") || name.includes("/")) return new Response("bad", { status: 400 });
      const f = Bun.file(join(FIXTURES, "subtitles", name));
      if (!(await f.exists())) return new Response("not found", { status: 404 });
      return new Response(f, { headers: { "content-type": "text/plain; charset=utf-8" } });
    }
    if (url.pathname === "/font") {
      const name = url.searchParams.get("name") ?? "";
      try {
        const resolved = resolveFontPath(name);
        const hash = resolved.lastIndexOf("#");
        const filePath = hash > 0 ? resolved.slice(0, hash) : resolved;
        fontLog.push({ name, resolved });
        return new Response(readFileSync(filePath), {
          headers: { "content-type": "application/octet-stream" },
        });
      } catch {
        fontLog.push({ name, resolved: null });
        return new Response("not found", { status: 404 });
      }
    }
    if (url.pathname === "/log" && req.method === "POST") {
      const body = await req.json();
      console.log(`[page] ${body.msg}`);
      return new Response("ok");
    }
    if (url.pathname === "/result" && req.method === "POST") {
      resolveResult(await req.json());
      return new Response("ok");
    }
    return new Response("not found", { status: 404 });
  },
});

function fmt(n: number): string {
  return n.toFixed(2);
}

function printSide(label: string, side: any): void {
  const d = side.display;
  const r = side.render;
  const p = side.pipeline;
  console.log(`\n--- ${label} ---`);
  console.log(
    `  DISPLAY interval: p50 ${fmt(d.p50)}  p95 ${fmt(d.p95)}  p99 ${fmt(d.p99)}  max ${fmt(d.max)}  ` +
      `min ${fmt(d.min)}  mean ${fmt(d.mean)}  stdev ${fmt(d.stdev)} ms  (n=${d.samples})`,
  );
  console.log(`  achieved on-screen fps (from median interval): ${fmt(d.achievedFps)}`);
  console.log(
    `  render latency:   p50 ${fmt(r.p50)}  p95 ${fmt(r.p95)}  max ${fmt(r.max)} ms  (n=${r.samples})`,
  );
  if (side.finalStrideFps != null) {
    console.log(`  steady present cadence: ~${fmt(side.finalStrideFps)} fps`);
  }
  if (Array.isArray(side.strideTimeline) && side.strideTimeline.length > 0) {
    const tail = side.strideTimeline.slice(-8);
    const timeline = tail
      .map(
        (p: any) =>
          `${fmt(p.elapsedMs)}ms:${p.stride}x(depth ${p.bufferDepth}, holds ${p.holds})`,
      )
      .join(" -> ");
    console.log(`  stride timeline: ${timeline}`);
  }
  console.log(
    `  pipeline: served ${p.served}  ring-hit ${fmt(p.ringHitPct)}% (hits ${p.ringHits}, awaited ${p.ringAwaited})  ` +
      `scatter ${p.scatter}  single ${p.single}  conceded ${p.conceded}  ~${fmt(p.frameCpuEmaMs)}ms/worker`,
  );
}

async function main() {
  const userDataDir = mkdtempSync(join(tmpdir(), "smoothness-"));
  const flags = [
    "--headless=new",
    "--use-angle=metal",
    "--enable-features=Vulkan",
    "--enable-unsafe-webgpu",
    "--no-sandbox",
    `--user-data-dir=${userDataDir}`,
    "--no-first-run",
    "--disable-gpu-sandbox",
    `http://localhost:${PORT}/${QUERY}`,
  ];
  const chrome = spawn(CHROME, flags, { stdio: keep ? "inherit" : "ignore" });
  const timer = setTimeout(
    () => resolveResult({ ok: false, error: "timeout waiting for /result" }),
    TIMEOUT_MS,
  );

  const result = await resultPromise;
  clearTimeout(timer);
  chrome.kill("SIGKILL");
  server.stop(true);
  if (!keep) {
    try {
      rmSync(userDataDir, { recursive: true, force: true });
    } catch {}
  }

  if (outPath) {
    writeFileSync(outPath, JSON.stringify({ result, fontLog }, null, 2));
    console.log(`raw result written to ${outPath}`);
  }

  console.log("\n=== perceived-smoothness bench (headless Chrome, WebGPU) ===");
  if (!result.ok) {
    console.log(`ERROR: ${result.error}`);
    if (result.stack) console.log(result.stack);
    process.exit(1);
  }
  console.log(`env: ${JSON.stringify(result.env)}`);
  printSide("BEFORE  (reactive: cadence == render latency)", result.reactive);
  printSide("AFTER   (render-ahead: steady vsync-multiple cadence)", result.renderAhead);

  const b = result.reactive.display;
  const a = result.renderAhead.display;
  console.log("\n--- summary ---");
  console.log(
    `  display-interval stdev:  ${fmt(b.stdev)} -> ${fmt(a.stdev)} ms  (${
      b.stdev > 0 ? fmt((1 - a.stdev / b.stdev) * 100) : "0"
    }% lower)`,
  );
  console.log(`  display-interval p95:    ${fmt(b.p95)} -> ${fmt(a.p95)} ms`);
  console.log(`  display-interval max:    ${fmt(b.max)} -> ${fmt(a.max)} ms`);
  console.log(`  achieved on-screen fps:  ${fmt(b.achievedFps)} -> ${fmt(a.achievedFps)}`);
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
