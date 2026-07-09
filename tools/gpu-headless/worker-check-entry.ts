// Worker-pool initialization probe. Served through Bun's dev bundler with the
// same wiring as the playground (playground/server.ts): the driver serves the
// bundled worker entry at /worker-entry.js and this page points the pool at it
// via setWorkerSource, so what happens here is exactly what a playground user
// gets. Wraps the Worker constructor to capture the URL the library actually
// passes, listens for worker error events, fetches the worker URL to probe the
// dev server's response, renders a few frames to trigger lazy pool init +
// dispatch, then POSTs a JSON report.
import { parseASS } from "subforge/ass";
import type { SubtitleDocument } from "subforge/core";
import { renderFrame, setFontResolver, setWorkerSource, registerFontSource } from "../../src";
import { getWorkerPoolStats, isWorkerPoolUsable } from "../../src/core/worker-pool";

const W = 1920;
const H = 1080;
const T0 = 246350; // dense beastars window; events within worker lookahead

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function post(path: string, body: unknown): Promise<void> {
  try {
    await fetch(path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch {
    /* ignore */
  }
}

const warnings: string[] = [];
const origWarn = console.warn.bind(console);
console.warn = (...args: unknown[]) => {
  warnings.push(args.map((a) => String(a)).join(" "));
  origWarn(...args);
};

type WorkerAttempt = {
  url: string;
  constructed: boolean;
  constructError?: string;
  asyncErrors: string[];
  probeStatus?: number;
  probeContentType?: string | null;
  probeBytes?: number;
  probeSnippet?: string;
};

const workerAttempts: WorkerAttempt[] = [];
const NativeWorker = globalThis.Worker;
(globalThis as any).Worker = function PatchedWorker(url: unknown, opts?: WorkerOptions) {
  const rec: WorkerAttempt = { url: String(url), constructed: false, asyncErrors: [] };
  workerAttempts.push(rec);
  let w: Worker;
  try {
    w = new NativeWorker(url as string | URL, opts);
  } catch (err) {
    rec.constructError = String(err);
    throw err;
  }
  rec.constructed = true;
  w.addEventListener("error", (e: ErrorEvent) => {
    rec.asyncErrors.push(
      `message=${e.message ?? ""} filename=${e.filename ?? ""} line=${e.lineno ?? ""}`,
    );
  });
  return w;
} as unknown as typeof Worker;
(globalThis as any).Worker.prototype = NativeWorker.prototype;

async function main() {
  // Same wiring as the playground: the dev bundler emits no worker chunk, so
  // the driver serves a bundled entry at /worker-entry.js and we point the
  // pool at it before the first render triggers lazy pool init.
  setWorkerSource("/worker-entry.js");

  const env = {
    userAgent: navigator.userAgent,
    hasWorker: typeof NativeWorker !== "undefined",
    hardwareConcurrency: navigator.hardwareConcurrency,
    importMetaUrl: import.meta.url,
    typeofProcess: typeof (globalThis as any).process,
  };

  setFontResolver(async (name: string) => {
    const res = await fetch(`/font?name=${encodeURIComponent(name)}`);
    if (!res.ok) return null;
    const buf = await res.arrayBuffer();
    // Register the source so the pool's font sync can forward it to workers
    // (mirrors the playground resolver, which registers everything it loads).
    registerFontSource(name, buf);
    return buf;
  });

  const usableBefore = isWorkerPoolUsable();
  const statsBefore = getWorkerPoolStats();

  const text = await (await fetch(`/ass/beastars.ass`)).text();
  const parsed = parseASS(text, { onError: "collect", strict: false, preserveOrder: true });
  const doc: SubtitleDocument = parsed.document;

  // Render a few paced frames: first frame triggers lazy pool init + dispatch,
  // later frames give workers time to post results back.
  const frameTimes: number[] = [];
  for (let i = 0; i < 12; i++) {
    const a = performance.now();
    await renderFrame(doc, T0 + i * 100, W, H);
    frameTimes.push(performance.now() - a);
    await sleep(100);
  }
  await sleep(1500);
  await renderFrame(doc, T0 + 1300, W, H); // one more frame to flush stats

  // Network probe: fetch each URL the library handed to `new Worker` and see
  // what the dev server actually returns there.
  for (const a of workerAttempts) {
    try {
      const res = await fetch(a.url);
      a.probeStatus = res.status;
      a.probeContentType = res.headers.get("content-type");
      const body = await res.text();
      a.probeBytes = body.length;
      a.probeSnippet = body.slice(0, 200);
    } catch (err) {
      a.probeSnippet = `fetch failed: ${String(err)}`;
    }
  }

  const resources = performance
    .getEntriesByType("resource")
    .map((e) => ({ name: e.name, initiator: (e as PerformanceResourceTiming).initiatorType }))
    .filter(
      (e) =>
        e.name.includes("worker") ||
        e.initiator === "other" ||
        e.name.endsWith(".ts") ||
        e.name.includes("_bun"),
    );

  await post("/result", {
    ok: true,
    env,
    usableBefore,
    statsBefore,
    usableAfter: isWorkerPoolUsable(),
    statsAfter: getWorkerPoolStats(),
    workerAttempts,
    warnings,
    resources,
    frameTimes,
  });
}

main().catch(async (err) => {
  await post("/result", {
    ok: false,
    error: String(err),
    stack: (err as Error)?.stack,
    workerAttempts,
    warnings,
  });
});
