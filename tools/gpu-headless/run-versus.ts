// Competitive browser benchmark: subframe product path vs JASSUB's documented
// canvas/manualRender path, plus an approximate native libass one-shot timing.
//
// Usage:
//   bun run tools/gpu-headless/run-versus.ts --out tools/gpu-headless/results/versus.json
//   bun run tools/gpu-headless/run-versus.ts --only jassub_beastars --frames 300
import { spawn } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, normalize, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveFontPath, setFontSearchPaths } from "../../src/io/fonts/resolve";

type ManifestCase = {
  id: string;
  upstreamId?: string;
  ass: string;
  timestampsMs: number[];
  fonts?: string[];
};

type Manifest = {
  viewport: { width: number; height: number };
  fontsDir: string;
  cases: ManifestCase[];
};

type BrowserRun = {
  caseId: string;
  renderer: "subframe" | "jassub";
  frames: number;
  windows: number;
  achievedFps: number;
  frameMs: number[];
  peakHeapBytes: number;
  steadyHeapBytes: number;
  notes?: string[];
};

type NativeRun = {
  caseId: string;
  renderer: "libass-native";
  frames: number;
  achievedFps: number;
  frameMs: number[];
  baselineMs: number;
  notes: string[];
};

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "../..");
const FIXTURES = join(ROOT, "test/fixtures/jassub-benchmark");
const MANIFEST_PATH = join(FIXTURES, "manifest.json");
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const PORT = 8795;
const TIMEOUT_MS = 1_500_000;
const ISOLATION_HEADERS = {
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Embedder-Policy": "require-corp",
} as const;

const argv = process.argv.slice(2);
const keep = argv.includes("--keep");
const skipNative = argv.includes("--skip-native");

function argVal(flag: string): string | null {
  const idx = argv.indexOf(flag);
  return idx !== -1 ? (argv[idx + 1] ?? null) : null;
}

const outPath =
  argVal("--out") ??
  join(
    ROOT,
    "tools/gpu-headless/results",
    `versus-${new Date().toISOString().replace(/[:.]/g, "-")}.json`,
  );
const onlyArg = argVal("--only");
const framesArg = argVal("--frames");
const warmupArg = argVal("--warmup");
const frames = framesArg ? Number(framesArg) : 300;
const warmup = warmupArg ? Number(warmupArg) : 120;
const only = onlyArg
  ? onlyArg.split(",").map((s) => s.trim()).filter(Boolean)
  : [];

setFontSearchPaths([join(FIXTURES, "fonts")]);

const manifest = JSON.parse(readFileSync(MANIFEST_PATH, "utf8")) as Manifest;
const cases =
  only.length > 0
    ? manifest.cases.filter((c) => only.includes(c.id) || only.includes(c.upstreamId ?? ""))
    : manifest.cases;

if (cases.length === 0) {
  throw new Error(`no manifest cases matched --only=${onlyArg}`);
}

function withIsolation(init?: ResponseInit): ResponseInit {
  const headers = new Headers(init?.headers);
  for (const [key, value] of Object.entries(ISOLATION_HEADERS)) headers.set(key, value);
  return { ...init, headers };
}

function ensureInsideRoot(path: string): string | null {
  const full = normalize(join(ROOT, path));
  const rel = relative(ROOT, full);
  if (rel.startsWith("..") || rel === "" || rel.includes("..")) return null;
  return full;
}

function decodeAssetPath(pathname: string): string | null {
  const encoded = pathname.slice("/asset/".length);
  if (!encoded) return null;
  return encoded.split("/").map(decodeURIComponent).join("/");
}

function contentType(path: string): string {
  if (path.endsWith(".js")) return "text/javascript; charset=utf-8";
  if (path.endsWith(".wasm")) return "application/wasm";
  if (path.endsWith(".json")) return "application/json; charset=utf-8";
  if (path.endsWith(".ass")) return "text/plain; charset=utf-8";
  if (path.endsWith(".ttf")) return "font/ttf";
  if (path.endsWith(".otf")) return "font/otf";
  if (path.endsWith(".woff2")) return "font/woff2";
  return "application/octet-stream";
}

async function bundleText(entrypoint: string, label: string): Promise<string> {
  const build = await Bun.build({
    entrypoints: [entrypoint],
    target: "browser",
    format: "esm",
    minify: false,
  });
  if (!build.success) {
    for (const log of build.logs) console.error(log);
    throw new Error(`${label} bundle failed`);
  }
  return await build.outputs[0]!.text();
}

const workerJs = await bundleText(join(ROOT, "src/core/worker-entry.ts"), "subframe worker");
const versusJs = await bundleText(join(HERE, "versus-entry.ts"), "versus entry");
const jassubWorkerJs = await bundleText(
  join(ROOT, "node_modules/jassub/dist/worker/worker.js"),
  "JASSUB worker",
);

const html = `<!doctype html>
<meta charset="utf-8">
<title>subframe vs jassub</title>
<body style="margin:0;background:#000">
  <script type="module" src="/versus-entry.js"></script>
</body>
`;

let resolveResult!: (value: any) => void;
const resultPromise = new Promise<any>((resolve) => {
  resolveResult = resolve;
});
const fontLog: Array<{ name: string; resolved: string | null }> = [];

const server = Bun.serve({
  port: PORT,
  development: true,
  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === "/" || url.pathname === "/index.html") {
      return new Response(html, withIsolation({
        headers: { "content-type": "text/html; charset=utf-8" },
      }));
    }
    if (url.pathname === "/versus-entry.js") {
      return new Response(versusJs, withIsolation({
        headers: { "content-type": "text/javascript; charset=utf-8" },
      }));
    }
    if (url.pathname === "/worker-entry.js") {
      return new Response(workerJs, withIsolation({
        headers: { "content-type": "text/javascript; charset=utf-8" },
      }));
    }
    if (url.pathname === "/jassub-worker.js") {
      return new Response(jassubWorkerJs, withIsolation({
        headers: { "content-type": "text/javascript; charset=utf-8" },
      }));
    }
    if (url.pathname === "/jassub-worker.wasm") {
      return new Response(Bun.file(join(ROOT, "node_modules/jassub/dist/wasm/jassub-worker.wasm")), withIsolation({
        headers: { "content-type": "application/wasm" },
      }));
    }
    if (url.pathname === "/jassub-worker-modern.wasm") {
      return new Response(Bun.file(join(ROOT, "node_modules/jassub/dist/wasm/jassub-worker-modern.wasm")), withIsolation({
        headers: { "content-type": "application/wasm" },
      }));
    }
    if (url.pathname === "/manifest.json") {
      return new Response(JSON.stringify({ ...manifest, cases }), withIsolation({
        headers: { "content-type": "application/json; charset=utf-8" },
      }));
    }
    if (url.pathname.startsWith("/asset/")) {
      const rel = decodeAssetPath(url.pathname);
      const full = rel ? ensureInsideRoot(rel) : null;
      if (!full) return new Response("bad", withIsolation({ status: 400 }));
      const f = Bun.file(full);
      if (!(await f.exists())) return new Response("not found", withIsolation({ status: 404 }));
      return new Response(f, withIsolation({
        headers: { "content-type": contentType(full) },
      }));
    }
    if (url.pathname === "/font") {
      const name = url.searchParams.get("name") ?? "";
      try {
        const resolved = resolveFontPath(name);
        const hash = resolved.lastIndexOf("#");
        const filePath = hash > 0 ? resolved.slice(0, hash) : resolved;
        fontLog.push({ name, resolved });
        return new Response(readFileSync(filePath), withIsolation({
          headers: { "content-type": "application/octet-stream" },
        }));
      } catch {
        fontLog.push({ name, resolved: null });
        return new Response("not found", withIsolation({ status: 404 }));
      }
    }
    if (url.pathname === "/log" && req.method === "POST") {
      const body = await req.json();
      console.log(`[page] ${body.msg}`);
      return new Response("ok", withIsolation());
    }
    if (url.pathname === "/result" && req.method === "POST") {
      resolveResult(await req.json());
      return new Response("ok", withIsolation());
    }
    return new Response("not found", withIsolation({ status: 404 }));
  },
});

function percentile(sortedAsc: number[], p: number): number {
  if (sortedAsc.length === 0) return 0;
  const idx = Math.min(
    sortedAsc.length - 1,
    Math.max(0, Math.round((p / 100) * (sortedAsc.length - 1))),
  );
  return sortedAsc[idx]!;
}

function summarize(values: number[]): { p50: number; p95: number; max: number; mean: number } {
  const sorted = [...values].sort((a, b) => a - b);
  let sum = 0;
  for (let i = 0; i < values.length; i++) sum += values[i]!;
  return {
    p50: percentile(sorted, 50),
    p95: percentile(sorted, 95),
    max: sorted[sorted.length - 1] ?? 0,
    mean: sum / (values.length || 1),
  };
}

function mib(bytes: number): number {
  return bytes / (1024 * 1024);
}

function fmt(n: number, digits = 2): string {
  return Number.isFinite(n) ? n.toFixed(digits) : "n/a";
}

function runLibassOnce(caseInfo: ManifestCase, timeMs: number, out: string): number {
  const start = performance.now();
  const proc = Bun.spawnSync({
    cmd: [
      join(ROOT, "tools/ref/render_libass"),
      "--ass",
      join(ROOT, caseInfo.ass),
      "--time",
      String(timeMs),
      "--w",
      String(manifest.viewport.width),
      "--h",
      String(manifest.viewport.height),
      "--fonts",
      join(ROOT, manifest.fontsDir),
      "--out",
      out,
    ],
    cwd: ROOT,
    env: {
      ...process.env,
      DYLD_LIBRARY_PATH: join(ROOT, "refs/libass/libass/.libs"),
    },
    stdout: "ignore",
    stderr: "pipe",
  });
  const elapsed = performance.now() - start;
  if (proc.exitCode !== 0) {
    const err = new TextDecoder().decode(proc.stderr).trim();
    throw new Error(`render_libass failed for ${caseInfo.id}@${timeMs}: ${err}`);
  }
  return elapsed;
}

function runNativeTimings(tmp: string): NativeRun[] {
  const runs: NativeRun[] = [];
  for (const c of cases) {
    const baseSamples: number[] = [];
    for (let i = 0; i < 3; i++) {
      baseSamples.push(runLibassOnce(c, -1_000_000, join(tmp, `${c.id}-empty-${i}.png`)));
    }
    const baseline = summarize(baseSamples).p50;
    const raw: number[] = [];
    for (let i = 0; i < c.timestampsMs.length; i++) {
      raw.push(runLibassOnce(c, c.timestampsMs[i]!, join(tmp, `${c.id}-${i}.png`)));
    }
    const adjusted = raw.map((v) => Math.max(0, v - baseline));
    const mean = summarize(adjusted).mean;
    runs.push({
      caseId: c.id,
      renderer: "libass-native",
      frames: adjusted.length,
      achievedFps: mean > 0 ? 1000 / mean : 0,
      frameMs: adjusted,
      baselineMs: baseline,
      notes: [
        `one-shot CLI timing over manifest stress timestamps only; adjusted by subtracting ${baseline.toFixed(2)}ms empty-render median`,
      ],
    });
  }
  return runs;
}

function printTable(rows: Array<BrowserRun | NativeRun>): void {
  console.log("\ncase,renderer,frames,achievedFps,p50Ms,p95Ms,maxMs,peakHeapMiB,steadyHeapMiB,notes");
  for (const row of rows) {
    const s = summarize(row.frameMs);
    const peak = "peakHeapBytes" in row ? fmt(mib(row.peakHeapBytes), 1) : "";
    const steady = "steadyHeapBytes" in row ? fmt(mib(row.steadyHeapBytes), 1) : "";
    const notes = (row.notes ?? []).join(" | ").replaceAll(",", ";");
    console.log(
      [
        row.caseId,
        row.renderer,
        row.frames,
        fmt(row.achievedFps, 1),
        fmt(s.p50),
        fmt(s.p95),
        fmt(s.max),
        peak,
        steady,
        notes,
      ].join(","),
    );
  }
}

async function main(): Promise<void> {
  const qs = new URLSearchParams();
  if (onlyArg) qs.set("only", onlyArg);
  if (framesArg) qs.set("frames", framesArg);
  qs.set("warmup", String(warmup));
  const query = qs.toString() ? `?${qs.toString()}` : "";
  const userDataDir = mkdtempSync(join(tmpdir(), "versus-chrome-"));
  const flags = [
    "--headless=new",
    "--use-angle=metal",
    "--enable-features=Vulkan",
    "--enable-unsafe-webgpu",
    "--enable-precise-memory-info",
    "--no-sandbox",
    `--user-data-dir=${userDataDir}`,
    "--no-first-run",
    "--disable-gpu-sandbox",
    `http://localhost:${PORT}/${query}`,
  ];
  console.log(`serving harness at http://localhost:${PORT}/${query}`);
  console.log(`cases: ${cases.map((c) => c.id).join(", ")} frames/window=${frames} warmup=${warmup}`);
  const chrome = spawn(CHROME, flags, { stdio: keep ? "inherit" : "ignore" });
  const timer = setTimeout(
    () => resolveResult({ ok: false, error: "timeout waiting for /result" }),
    TIMEOUT_MS,
  );
  const browserResult = await resultPromise;
  clearTimeout(timer);
  chrome.kill("SIGKILL");
  server.stop(true);
  if (!keep) {
    try {
      rmSync(userDataDir, { recursive: true, force: true });
    } catch {}
  }

  if (!browserResult.ok) {
    console.error(`ERROR: ${browserResult.error}`);
    if (browserResult.stack) console.error(browserResult.stack);
    process.exit(1);
  }

  const tmp = mkdtempSync(join(tmpdir(), "versus-libass-"));
  let nativeRuns: NativeRun[] = [];
  if (!skipNative) {
    console.log("timing native libass one-shot reference...");
    nativeRuns = runNativeTimings(tmp);
  }
  if (!keep) {
    try {
      rmSync(tmp, { recursive: true, force: true });
    } catch {}
  }

  const output = {
    generatedAt: new Date().toISOString(),
    methodology: {
      viewport: manifest.viewport,
      framesPerWindow: frames,
      warmupFramesPerWindow: warmup,
      pacingFps: 60,
      fairness: [
        "same headless Chrome binary and viewport for subframe and JASSUB",
        "one browser renderer active at a time, same ASS files and font URLs, warmup before measured frames",
        "subframe records renderFrame plus WebGPU backend.render completion",
        "JASSUB records awaited canvas manualRender completion on the same 60fps media-time grid",
        "native libass is approximate one-shot CLI timing over manifest timestamps, not browser playback",
      ],
    },
    browserEnv: browserResult.env,
    fontLog,
    browserRuns: browserResult.runs as BrowserRun[],
    nativeRuns,
  };
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, JSON.stringify(output, null, 2));
  console.log(`raw result written to ${outPath}`);
  console.log(`env: ${JSON.stringify(browserResult.env)}`);
  printTable([...(browserResult.runs as BrowserRun[]), ...nativeRuns]);
}

main().catch((err) => {
  try {
    server.stop(true);
  } catch {}
  console.error(err);
  process.exit(1);
});
