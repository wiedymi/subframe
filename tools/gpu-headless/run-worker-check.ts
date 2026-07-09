// Headless driver for worker-check.html: serves it through Bun's dev bundler
// (same pipeline as `bun playground/index.html`), launches headless Chrome,
// waits for the page's JSON report, prints it. Also inspects the served JS
// chunk server-side to show what the bundler emitted for `new Worker(...)`.
//
// Usage: bun run tools/gpu-headless/run-worker-check.ts [--keep] [--out result.json]
// @ts-ignore Bun html import
import page from "./worker-check.html";
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
const TIMEOUT_MS = 60_000;
const argv = process.argv.slice(2);
const keep = argv.includes("--keep");
const outIdx = argv.indexOf("--out");
const outPath = outIdx !== -1 ? argv[outIdx + 1]! : null;

setFontSearchPaths([join(FIXTURES, "fonts")]);

// Bundle the worker entry once at startup and serve it at /worker-entry.js —
// the same wiring as playground/server.ts — so this check verifies what a
// playground user actually gets.
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

const requestLog: string[] = [];

const server = Bun.serve({
  port: PORT,
  development: true,
  routes: { "/": page },
  async fetch(req) {
    const url = new URL(req.url);
    requestLog.push(`${req.method} ${url.pathname}`);
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
        return new Response(readFileSync(filePath), {
          headers: { "content-type": "application/octet-stream" },
        });
      } catch {
        return new Response("not found", { status: 404 });
      }
    }
    if (url.pathname === "/result" && req.method === "POST") {
      resolveResult(await req.json());
      return new Response("ok");
    }
    return new Response("not found", { status: 404 });
  },
});

async function inspectServedBundle(): Promise<void> {
  const html = await (await fetch(`http://localhost:${PORT}/`)).text();
  const m = html.match(/src="(\/_bun\/[^"]+\.js)"/);
  if (!m) {
    console.log("bundle-inspect: no dev-server script tag found");
    return;
  }
  const js = await (await fetch(`http://localhost:${PORT}${m[1]}`)).text();
  const workerLines = js.match(/new NativeWorker\([^;]*|new Worker\([^;]*/g) ?? [];
  console.log(`bundle-inspect: chunk ${m[1]} (${js.length} bytes)`);
  for (const line of workerLines) console.log(`bundle-inspect: ${line.slice(0, 300)}`);
  const urlLines = js.match(/new URL\([^)]*worker[^)]*\)/g) ?? [];
  for (const line of urlLines) console.log(`bundle-inspect url: ${line.slice(0, 300)}`);
}

async function main() {
  await inspectServedBundle();

  const userDataDir = mkdtempSync(join(tmpdir(), "worker-check-"));
  const flags = [
    "--headless=new",
    "--use-angle=metal",
    "--enable-features=Vulkan",
    "--enable-unsafe-webgpu",
    "--no-sandbox",
    `--user-data-dir=${userDataDir}`,
    "--no-first-run",
    "--disable-gpu-sandbox",
    `http://localhost:${PORT}/`,
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

  if (outPath) writeFileSync(outPath, JSON.stringify({ result, requestLog }, null, 2));

  console.log("\n=== worker-pool check result ===");
  console.log(JSON.stringify(result, null, 2));
  console.log("\nserver request log:");
  for (const r of requestLog) console.log(`  ${r}`);
  process.exit(result.ok ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
