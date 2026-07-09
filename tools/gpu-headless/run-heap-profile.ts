// V8 allocation/retention attribution for the headless Chrome bench. This is a diagnostic
// harness only: it serves the same bench-entry/worker-entry bundles as
// run-bench.ts, attaches CDP HeapProfiler sampling to the page and workers, and
// writes raw heap sampling profiles plus a grouped summary. With --snapshot it
// also takes post-GC heap snapshots for the page and one worker and aggregates
// large ArrayBuffer backing-store retainers.
//
// Usage:
//   bun run tools/gpu-headless/run-heap-profile.ts --fixture beastars --out-dir tools/gpu-headless/results/heap-beastars
//   bun run tools/gpu-headless/run-heap-profile.ts --fixture FGOBD --out-dir tools/gpu-headless/results/heap-fgobd
import { spawn, type ChildProcess } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { SourceMapConsumer } from "source-map-js";
import { setFontSearchPaths, resolveFontPath } from "../../src/io/fonts/resolve";

type JsonObject = Record<string, any>;

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "../..");
const FIXTURES = join(ROOT, "test/fixtures/jassub-benchmark");
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const TIMEOUT_MS = 600_000;
const SAMPLING_INTERVAL = 65_536;
const ISOLATION_HEADERS = {
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Embedder-Policy": "require-corp",
} as const;

const argv = process.argv.slice(2);
function argVal(flag: string): string | null {
  const i = argv.indexOf(flag);
  return i !== -1 ? (argv[i + 1] ?? null) : null;
}

const fixture = argVal("--fixture") ?? "beastars";
const config = argVal("--config") ?? "default";
const frames = Number(argVal("--frames") ?? "300");
const outDir = argVal("--out-dir") ?? join(HERE, "results", `heap-${fixture}`);
const keep = argv.includes("--keep");
const jsFlags = argVal("--js-flags");
const takeSnapshots = argv.includes("--snapshot");
const samplingEnabled = !argv.includes("--no-sampling");

const qs = new URLSearchParams();
qs.set("only", fixture);
qs.set("configs", config);
qs.set("frames", String(frames));
const QUERY = `?${qs.toString()}`;

setFontSearchPaths([join(FIXTURES, "fonts")]);
mkdirSync(outDir, { recursive: true });

type BuildOutput = {
  js: string;
  map: JsonObject | null;
};

async function bundle(entrypoint: string): Promise<BuildOutput> {
  const result = await Bun.build({
    entrypoints: [entrypoint],
    target: "browser",
    format: "esm",
    minify: false,
    sourcemap: "external",
  });
  if (!result.success) {
    for (const log of result.logs) console.error(log);
    throw new Error(`bundle failed: ${entrypoint}`);
  }
  let js = "";
  let map: JsonObject | null = null;
  for (const output of result.outputs) {
    if (output.path.endsWith(".js")) js = await output.text();
    if (output.path.endsWith(".js.map")) map = JSON.parse(await output.text()) as JsonObject;
  }
  if (!js) throw new Error(`bundle produced no JS for ${entrypoint}`);
  return { js, map };
}

const workerBuild = await bundle(join(ROOT, "src/core/worker-entry.ts"));
const benchBuild = await bundle(join(HERE, "bench-entry.ts"));
const benchHtml = `<!doctype html>
<meta charset="utf-8">
<title>subframe heap profile</title>
<body>
  <script type="module" src="/bench-entry.js"></script>
</body>
`;

function withIsolation(init?: ResponseInit): ResponseInit {
  const headers = new Headers(init?.headers);
  for (const [key, value] of Object.entries(ISOLATION_HEADERS)) headers.set(key, value);
  return { ...init, headers };
}

let resolveResult!: (r: any) => void;
const resultPromise = new Promise<any>((res) => {
  resolveResult = res;
});

const fontLog: Array<{ name: string; resolved: string | null }> = [];
const server = Bun.serve({
  port: 0,
  development: true,
  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === "/" || url.pathname === "/index.html") {
      return new Response(benchHtml, withIsolation({
        headers: { "content-type": "text/html; charset=utf-8" },
      }));
    }
    if (url.pathname === "/bench-entry.js") {
      return new Response(benchBuild.js, withIsolation({
        headers: { "content-type": "text/javascript; charset=utf-8" },
      }));
    }
    if (url.pathname === "/bench-entry.js.map" && benchBuild.map) {
      return new Response(JSON.stringify(benchBuild.map), withIsolation({
        headers: { "content-type": "application/json; charset=utf-8" },
      }));
    }
    if (url.pathname === "/worker-entry.js") {
      return new Response(workerBuild.js, withIsolation({
        headers: { "content-type": "text/javascript; charset=utf-8" },
      }));
    }
    if (url.pathname === "/worker-entry.js.map" && workerBuild.map) {
      return new Response(JSON.stringify(workerBuild.map), withIsolation({
        headers: { "content-type": "application/json; charset=utf-8" },
      }));
    }
    if (url.pathname.startsWith("/ass/")) {
      const name = url.pathname.slice(5);
      if (name.includes("..") || name.includes("/")) {
        return new Response("bad", withIsolation({ status: 400 }));
      }
      const file = Bun.file(join(FIXTURES, "subtitles", name));
      if (!(await file.exists())) return new Response("not found", withIsolation({ status: 404 }));
      return new Response(file, withIsolation({
        headers: { "content-type": "text/plain; charset=utf-8" },
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

class CdpConnection {
  private ws: WebSocket;
  private nextId = 1;
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  private handlers: Array<(msg: any) => void> = [];

  private constructor(ws: WebSocket) {
    this.ws = ws;
    ws.onmessage = (event) => {
      const msg = JSON.parse(String(event.data));
      if (typeof msg.id === "number") {
        const cb = this.pending.get(msg.id);
        if (!cb) return;
        this.pending.delete(msg.id);
        if (msg.error) cb.reject(new Error(`${msg.error.message ?? "CDP error"} ${JSON.stringify(msg.error)}`));
        else cb.resolve(msg.result);
        return;
      }
      for (const handler of this.handlers) handler(msg);
    };
  }

  static connect(url: string): Promise<CdpConnection> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url);
      ws.onopen = () => resolve(new CdpConnection(ws));
      ws.onerror = () => reject(new Error(`failed to connect CDP websocket ${url}`));
    });
  }

  onEvent(handler: (msg: any) => void): () => void {
    this.handlers.push(handler);
    return () => {
      const idx = this.handlers.indexOf(handler);
      if (idx !== -1) this.handlers.splice(idx, 1);
    };
  }

  send(method: string, params?: JsonObject, sessionId?: string): Promise<any> {
    const id = this.nextId++;
    const payload: JsonObject = { id, method };
    if (params) payload.params = params;
    if (sessionId) payload.sessionId = sessionId;
    this.ws.send(JSON.stringify(payload));
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
    });
  }

  close(): void {
    this.ws.close();
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: Timer | null = null;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

function waitForDevTools(userDataDir: string, chrome: ChildProcess): Promise<string> {
  const path = join(userDataDir, "DevToolsActivePort");
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + 30_000;
    const tick = () => {
      if (chrome.exitCode !== null) {
        reject(new Error(`Chrome exited before DevToolsActivePort appeared: ${chrome.exitCode}`));
        return;
      }
      if (existsSync(path)) {
        const [port, wsPath] = readFileSync(path, "utf8").trim().split(/\r?\n/);
        resolve(`ws://127.0.0.1:${port}${wsPath}`);
        return;
      }
      if (Date.now() > deadline) {
        reject(new Error("timeout waiting for DevToolsActivePort"));
        return;
      }
      setTimeout(tick, 50);
    };
    tick();
  });
}

type TargetSession = {
  sessionId: string;
  targetId: string;
  type: string;
  url: string;
  title: string;
  label: string;
  started: boolean;
  beforeGc?: JsonObject;
  endBeforeGc?: JsonObject;
  afterGc?: JsonObject;
  profile?: JsonObject;
  stopError?: string;
};

function safeLabel(targetInfo: JsonObject, count: number): string {
  const type = String(targetInfo.type ?? "target");
  const url = String(targetInfo.url ?? "");
  const base =
    url.includes("/worker-entry.js") ? "worker" :
    url.includes("/bench-entry.js") ? "page-script" :
    type === "page" ? "page" :
    type.replace(/[^a-z0-9_-]+/gi, "-");
  return `${String(count).padStart(2, "0")}-${base}`;
}

function bytesToMiB(bytes: number): number {
  return bytes / (1024 * 1024);
}

function summarize(values: number[]): { p50: number; p95: number; max: number; mean: number } {
  const sorted = [...values].sort((a, b) => a - b);
  const at = (p: number) => sorted[Math.min(sorted.length - 1, Math.max(0, Math.round((p / 100) * (sorted.length - 1))))] ?? 0;
  return {
    p50: at(50),
    p95: at(95),
    max: sorted[sorted.length - 1] ?? 0,
    mean: values.reduce((a, b) => a + b, 0) / (values.length || 1),
  };
}

function heapWatermarkMiB(run: any): { peak: number; steady: number; last: number } {
  const samples = Array.isArray(run?.heapSamples) ? run.heapSamples : [];
  const vals = samples
    .map((s: any) => Number(s.usedJSHeapSize ?? 0))
    .filter((v: number) => Number.isFinite(v) && v > 0)
    .map(bytesToMiB);
  if (vals.length === 0) return { peak: 0, steady: 0, last: 0 };
  const steadyVals = vals.slice(Math.floor(vals.length * (2 / 3)));
  return {
    peak: Math.max(...vals),
    steady: steadyVals.reduce((a, b) => a + b, 0) / (steadyVals.length || 1),
    last: vals[vals.length - 1] ?? 0,
  };
}

type SourceMapper = {
  original(url: string, line0: number, column0: number): { source: string; line: number; column: number } | null;
};

function makeSourceMapper(port: number): SourceMapper {
  const consumers = new Map<string, any>();
  if (benchBuild.map) consumers.set(`http://localhost:${port}/bench-entry.js`, new SourceMapConsumer(benchBuild.map));
  if (workerBuild.map) consumers.set(`http://localhost:${port}/worker-entry.js`, new SourceMapConsumer(workerBuild.map));
  return {
    original(url: string, line0: number, column0: number) {
      const consumer = consumers.get(url);
      if (!consumer) return null;
      const pos = consumer.originalPositionFor({
        line: line0 + 1,
        column: Math.max(0, column0),
      });
      if (!pos || !pos.source) return null;
      return { source: pos.source, line: pos.line ?? 0, column: pos.column ?? 0 };
    },
  };
}

function groupFor(source: string, fn: string): string {
  const s = source.toLowerCase();
  if (s.includes("text-shaper")) return "text-shaper";
  if (s.includes("src/backend") || s.includes("webgpu") || s.includes("webgl")) return "subframe backend";
  if (s.includes("src/core")) return "subframe src/core";
  if (!source || s === "(anonymous)" || s.includes("v8") || s.includes("native") || fn.includes("(system)")) {
    return "V8/engine-internal";
  }
  if (s.startsWith("http://localhost") && (s.endsWith("/bench-entry.js") || s.endsWith("/worker-entry.js"))) {
    return "unmapped bundled JS";
  }
  return "other";
}

type SiteRow = {
  fn: string;
  source: string;
  line: number;
  selfBytes: number;
  group: string;
};

function analyzeProfile(profile: JsonObject | undefined, mapper: SourceMapper): {
  totalBytes: number;
  top: SiteRow[];
  groups: Record<string, number>;
} {
  const bySite = new Map<string, SiteRow>();
  const groups: Record<string, number> = {};
  let totalBytes = 0;
  function visit(node: JsonObject): void {
    const selfBytes = Number(node.selfSize ?? 0);
    if (selfBytes > 0) {
      const cf = node.callFrame ?? {};
      const generatedUrl = String(cf.url ?? "");
      const original = mapper.original(
        generatedUrl,
        Number(cf.lineNumber ?? 0),
        Number(cf.columnNumber ?? 0),
      );
      const source = original?.source ?? generatedUrl ?? "(anonymous)";
      const line = original?.line ?? (Number(cf.lineNumber ?? -1) + 1);
      const fn = String(cf.functionName || "(anonymous)");
      const group = groupFor(source, fn);
      const key = `${fn}\n${source}\n${line}\n${group}`;
      let row = bySite.get(key);
      if (!row) {
        row = { fn, source, line, selfBytes: 0, group };
        bySite.set(key, row);
      }
      row.selfBytes += selfBytes;
      groups[group] = (groups[group] ?? 0) + selfBytes;
      totalBytes += selfBytes;
    }
    const children = Array.isArray(node.children) ? node.children : [];
    for (const child of children) visit(child);
  }
  if (profile?.head) visit(profile.head);
  const top = [...bySite.values()].sort((a, b) => b.selfBytes - a.selfBytes).slice(0, 20);
  return { totalBytes, top, groups };
}

type SnapshotClassRow = {
  cls: string;
  bytes: number;
  count: number;
  sampleChain: string;
};

function edgeName(snapshot: JsonObject, edgeType: string, nameOrIndex: number): string {
  if (edgeType === "element" || edgeType === "hidden") return `#${nameOrIndex}`;
  return String(snapshot.strings?.[nameOrIndex] ?? nameOrIndex);
}

function classifyRetainerChain(chain: string): string {
  const c = chain.toLowerCase();
  if (c.includes("object memory.") || c.includes("webassembly.memory")) {
    return "WebAssembly.Memory backing store";
  }
  if (c.includes("arenafreelist")) return "worker arena freelist";
  if (c.includes("sabarena")) return "SAB arena slot";
  if (c.includes("boundaryslots") || c.includes("lastframededup")) return "pipeline boundary/dedup holder";
  if (c.includes("lastrenderedresult") || c.includes("lastreturnedresult")) return "pipeline last-returned holder";
  if (c.includes("renderaheadplayer") || (c.includes(".buffer") && c.includes(".result"))) {
    return "render-ahead buffered result";
  }
  if (c.includes("gpufilter") || c.includes("webgpubackend") || c.includes("staging")) {
    return "GPU filter/backend staging";
  }
  if (c.includes("worker") && c.includes("message")) return "worker message/structured clone";
  if (c.includes("font")) return "font source/cache";
  if (c.includes("map") && c.includes(".layers")) return "render result layers";
  if (c.includes("arraybuffer") || c.includes("typedarray") || c.includes("uint8array")) {
    return "typed-array backing store";
  }
  return "other backing store";
}

function isSpecificRetainerClass(cls: string): boolean {
  return (
    cls !== "typed-array backing store" &&
    cls !== "render result layers" &&
    cls !== "other backing store"
  );
}

function analyzeHeapSnapshot(snapshot: JsonObject, minBytes = 64 * 1024): {
  totalBackingBytes: number;
  largeNodeCount: number;
  classes: SnapshotClassRow[];
  topNodeNames: Array<{ name: string; type: string; bytes: number; count: number }>;
} {
  const meta = snapshot.snapshot?.meta;
  const nodes = snapshot.nodes as number[];
  const edges = snapshot.edges as number[];
  const strings = snapshot.strings as string[];
  if (!meta || !Array.isArray(nodes) || !Array.isArray(edges) || !Array.isArray(strings)) {
    return { totalBackingBytes: 0, largeNodeCount: 0, classes: [], topNodeNames: [] };
  }
  const nodeFields = meta.node_fields as string[];
  const edgeFields = meta.edge_fields as string[];
  const nodeTypes = meta.node_types?.[0] as string[];
  const edgeTypes = meta.edge_types?.[0] as string[];
  const nf = nodeFields.length;
  const ef = edgeFields.length;
  const nType = nodeFields.indexOf("type");
  const nName = nodeFields.indexOf("name");
  const nSelf = nodeFields.indexOf("self_size");
  const nEdgeCount = nodeFields.indexOf("edge_count");
  const eType = edgeFields.indexOf("type");
  const eName = edgeFields.indexOf("name_or_index");
  const eTo = edgeFields.indexOf("to_node");
  if (nType < 0 || nName < 0 || nSelf < 0 || nEdgeCount < 0 || eType < 0 || eName < 0 || eTo < 0) {
    return { totalBackingBytes: 0, largeNodeCount: 0, classes: [], topNodeNames: [] };
  }
  const nodeCount = (nodes.length / nf) | 0;
  const edgeStarts = new Int32Array(nodeCount);
  const edgeCounts = new Int32Array(nodeCount);
  const incoming: Array<Array<{ from: number; name: string; type: string }> | undefined> = new Array(nodeCount);
  let edgeCursor = 0;
  for (let i = 0; i < nodeCount; i++) {
    const off = i * nf;
    const count = nodes[off + nEdgeCount]!;
    edgeStarts[i] = edgeCursor;
    edgeCounts[i] = count;
    for (let j = 0; j < count; j++) {
      const edgeOff = edgeCursor + j * ef;
      const to = (nodes.length > 0 ? (edges[edgeOff + eTo]! / nf) | 0 : 0);
      const type = edgeTypes[edges[edgeOff + eType]!] ?? "";
      const name = edgeName(snapshot, type, edges[edgeOff + eName]!);
      (incoming[to] ??= []).push({ from: i, name, type });
    }
    edgeCursor += count * ef;
  }
  const nodeName = (idx: number) => strings[nodes[idx * nf + nName]!] ?? "";
  const nodeType = (idx: number) => nodeTypes[nodes[idx * nf + nType]!] ?? "";
  const nodeSelf = (idx: number) => nodes[idx * nf + nSelf] ?? 0;

  function chainFor(idx: number): string {
    type Q = { idx: number; chain: string; depth: number };
    const seen = new Set<number>([idx]);
    const start = `${nodeType(idx)} ${nodeName(idx)}`;
    const queue: Q[] = [{ idx, chain: start, depth: 0 }];
    let fallback = start;
    for (let q = 0; q < queue.length && q < 600; q++) {
      const cur = queue[q]!;
      const cls = classifyRetainerChain(cur.chain);
      if (isSpecificRetainerClass(cls) && cur.depth > 0) return cur.chain;
      if (cur.depth >= 10) {
        if (fallback === start) fallback = cur.chain;
        continue;
      }
      const ins = incoming[cur.idx] ?? [];
      for (let i = 0; i < ins.length; i++) {
        const edge = ins[i]!;
        if (edge.type === "weak") continue;
        if (seen.has(edge.from)) continue;
        seen.add(edge.from);
        const next = `${cur.chain} <- ${nodeType(edge.from)} ${nodeName(edge.from)}.${edge.name}`;
        queue.push({ idx: edge.from, chain: next, depth: cur.depth + 1 });
      }
    }
    return fallback;
  }

  const classes = new Map<string, SnapshotClassRow>();
  const names = new Map<string, { name: string; type: string; bytes: number; count: number }>();
  let totalBackingBytes = 0;
  let largeNodeCount = 0;
  for (let i = 0; i < nodeCount; i++) {
    const self = nodeSelf(i);
    if (self < minBytes) continue;
    const type = nodeType(i);
    const name = nodeName(i);
    const lower = name.toLowerCase();
    const looksLikeBacking =
      type === "native" ||
      lower.includes("arraybuffer") ||
      lower.includes("backing") ||
      lower.includes("typedarray") ||
      lower.includes("uint8array");
    if (!looksLikeBacking) continue;
    totalBackingBytes += self;
    largeNodeCount++;
    const key = `${type}:${name}`;
    const nameRow = names.get(key) ?? { name, type, bytes: 0, count: 0 };
    nameRow.bytes += self;
    nameRow.count++;
    names.set(key, nameRow);
    const chain = chainFor(i);
    const cls = classifyRetainerChain(chain);
    const row = classes.get(cls) ?? { cls, bytes: 0, count: 0, sampleChain: chain };
    row.bytes += self;
    row.count++;
    if (chain.length < row.sampleChain.length || row.sampleChain === "") row.sampleChain = chain;
    classes.set(cls, row);
  }
  return {
    totalBackingBytes,
    largeNodeCount,
    classes: [...classes.values()].sort((a, b) => b.bytes - a.bytes),
    topNodeNames: [...names.values()].sort((a, b) => b.bytes - a.bytes).slice(0, 20),
  };
}

async function takeHeapSnapshotForSession(
  cdp: CdpConnection,
  session: TargetSession,
  filePath: string,
): Promise<ReturnType<typeof analyzeHeapSnapshot>> {
  const chunks: string[] = [];
  const off = cdp.onEvent((msg) => {
    if (msg.sessionId !== session.sessionId) return;
    if (msg.method !== "HeapProfiler.addHeapSnapshotChunk") return;
    chunks.push(String(msg.params?.chunk ?? ""));
  });
  try {
    await withTimeout(
      cdp.send("HeapProfiler.takeHeapSnapshot", { reportProgress: false }, session.sessionId),
      180_000,
      `takeHeapSnapshot:${session.label}`,
    );
  } finally {
    off();
  }
  const text = chunks.join("");
  writeFileSync(filePath, text);
  return analyzeHeapSnapshot(JSON.parse(text) as JsonObject);
}

function printRunSummary(run: any): void {
  const total = summarize(run.renderMs.map((v: number, i: number) => v + run.compositeMs[i]));
  const wm = heapWatermarkMiB(run);
  console.log(
    `bench ${run.fixture}/${run.config}: total p50 ${total.p50.toFixed(2)} p95 ${total.p95.toFixed(2)} mean ${total.mean.toFixed(2)} max ${total.max.toFixed(2)} ms, fps ${Number(run.achievedFps ?? 0).toFixed(1)}`,
  );
  console.log(
    `performance.memory watermark: peak ${wm.peak.toFixed(1)} MiB steady ${wm.steady.toFixed(1)} MiB last ${wm.last.toFixed(1)} MiB`,
  );
}

async function main(): Promise<void> {
  const port = server.port;
  const mapper = makeSourceMapper(port);
  const userDataDir = mkdtempSync(join(tmpdir(), "gpu-heap-profile-"));
  const flags = [
    "--headless=new",
    "--use-angle=metal",
    "--enable-features=Vulkan",
    "--enable-unsafe-webgpu",
    "--enable-precise-memory-info",
    "--no-sandbox",
    "--remote-debugging-port=0",
    `--user-data-dir=${userDataDir}`,
    "--no-first-run",
    "--disable-gpu-sandbox",
    "about:blank",
  ];
  if (jsFlags) flags.splice(flags.length - 1, 0, `--js-flags=${jsFlags}`);
  const chrome = spawn(CHROME, flags, { stdio: keep ? "inherit" : "ignore" });
  let cdp: CdpConnection | null = null;
  const sessions = new Map<string, TargetSession>();
  const setupTasks = new Set<Promise<void>>();
  let sessionCount = 0;
  let targetPageId: string | null = null;

  try {
    const wsUrl = await waitForDevTools(userDataDir, chrome);
    cdp = await CdpConnection.connect(wsUrl);
    const setupSession = async (record: TargetSession, attachWorkers: boolean): Promise<void> => {
      try {
        await withTimeout(cdp!.send("Runtime.enable", {}, record.sessionId), 5_000, `Runtime.enable:${record.label}`);
        await withTimeout(cdp!.send("HeapProfiler.enable", {}, record.sessionId), 5_000, `HeapProfiler.enable:${record.label}`);
        if (attachWorkers && record.targetId) {
          await withTimeout(cdp!.send("Target.autoAttachRelated", {
            targetId: record.targetId,
            waitForDebuggerOnStart: true,
          }), 5_000, "Target.autoAttachRelated").catch(() => null);
        }
        await withTimeout(cdp!.send("HeapProfiler.collectGarbage", {}, record.sessionId), 5_000, `collectGarbage(before:${record.label})`).catch(() => null);
        record.beforeGc = await withTimeout(cdp!.send("Runtime.getHeapUsage", {}, record.sessionId), 5_000, `Runtime.getHeapUsage(before:${record.label})`).catch((err) => ({ error: String(err) }));
        if (samplingEnabled) {
          await withTimeout(cdp!.send("HeapProfiler.startSampling", { samplingInterval: SAMPLING_INTERVAL }, record.sessionId), 5_000, `HeapProfiler.startSampling:${record.label}`);
        }
        record.started = true;
      } catch (err) {
        record.stopError = String(err);
      } finally {
        await withTimeout(cdp!.send("Runtime.runIfWaitingForDebugger", {}, record.sessionId), 5_000, `Runtime.runIfWaitingForDebugger:${record.label}`).catch(() => null);
      }
    };

    cdp.onEvent((msg) => {
      if (msg.method !== "Target.attachedToTarget") return;
      const params = msg.params ?? {};
      const targetInfo = params.targetInfo ?? {};
      const type = String(targetInfo.type ?? "");
      if (type === "page") {
        void cdp!.send("Runtime.runIfWaitingForDebugger", {}, params.sessionId).catch(() => {});
        return;
      }
      if (type !== "worker" && type !== "dedicated_worker" && type !== "shared_worker") {
        void cdp!.send("Runtime.runIfWaitingForDebugger", {}, params.sessionId).catch(() => {});
        return;
      }
      const sessionId = String(params.sessionId);
      const record: TargetSession = {
        sessionId,
        targetId: String(targetInfo.targetId ?? ""),
        type,
        url: String(targetInfo.url ?? ""),
        title: String(targetInfo.title ?? ""),
        label: safeLabel(targetInfo, ++sessionCount),
        started: false,
      };
      sessions.set(sessionId, record);
      const task = setupSession(record, false);
      setupTasks.add(task);
      void task.finally(() => setupTasks.delete(task));
    });

    await cdp.send("Target.setDiscoverTargets", { discover: true });
    const created = await cdp.send("Target.createTarget", {
      url: "about:blank",
    });
    targetPageId = String(created.targetId ?? "");
    const attached = await cdp.send("Target.attachToTarget", {
      targetId: targetPageId,
      flatten: true,
    });
    const pageSessionId = String(attached.sessionId ?? "");
    const pageRecord: TargetSession = {
      sessionId: pageSessionId,
      targetId: targetPageId,
      type: "page",
      url: `http://localhost:${port}/${QUERY}`,
      title: "bench",
      label: safeLabel({ type: "page", url: `http://localhost:${port}/${QUERY}` }, ++sessionCount),
      started: false,
    };
    sessions.set(pageSessionId, pageRecord);
    await setupSession(pageRecord, true);
    await cdp.send("Page.enable", {}, pageSessionId).catch(() => null);
    await cdp.send("Page.navigate", { url: `http://localhost:${port}/${QUERY}` }, pageSessionId);

    const timer = setTimeout(() => {
      resolveResult({ ok: false, error: "timeout waiting for /result" });
    }, TIMEOUT_MS);
    const result = await resultPromise;
    clearTimeout(timer);
    await Promise.allSettled([...setupTasks]);

    const stopTasks = [...sessions.values()].map(async (session) => {
      if (!session.started) return;
      try {
        session.endBeforeGc = await withTimeout(cdp!.send("Runtime.getHeapUsage", {}, session.sessionId), 5_000, `getHeapUsage(end:${session.label})`).catch((err) => ({ error: String(err) }));
        if (samplingEnabled) {
          session.profile = (await withTimeout(cdp!.send("HeapProfiler.stopSampling", {}, session.sessionId), 60_000, `stopSampling:${session.label}`)).profile;
        }
        await withTimeout(cdp!.send("HeapProfiler.collectGarbage", {}, session.sessionId), 10_000, `collectGarbage(after:${session.label})`).catch(() => null);
        session.afterGc = await withTimeout(cdp!.send("Runtime.getHeapUsage", {}, session.sessionId), 5_000, `getHeapUsage(after:${session.label})`).catch((err) => ({ error: String(err) }));
      } catch (err) {
        session.stopError = String(err);
      }
    });
    await Promise.allSettled(stopTasks);

    const snapshotSummaries: Array<{
      label: string;
      type: string;
      url: string;
      path: string;
      totalBackingBytes: number;
      largeNodeCount: number;
      classes: SnapshotClassRow[];
      topNodeNames: Array<{ name: string; type: string; bytes: number; count: number }>;
    }> = [];
    if (takeSnapshots) {
      const snapTargets: TargetSession[] = [];
      const page = [...sessions.values()].find((s) => s.started && s.type === "page" && s.url.includes(`localhost:${port}`));
      if (page) snapTargets.push(page);
      const worker = [...sessions.values()].find((s) => s.started && (s.type === "worker" || s.type === "dedicated_worker" || s.url.includes("worker-entry.js")));
      if (worker) snapTargets.push(worker);
      for (const session of snapTargets) {
        await withTimeout(cdp!.send("HeapProfiler.collectGarbage", {}, session.sessionId), 10_000, `collectGarbage(snapshot:${session.label})`).catch(() => null);
        const path = join(outDir, `${fixture}-${session.label}.heapsnapshot`);
        const analysis = await takeHeapSnapshotForSession(cdp!, session, path);
        snapshotSummaries.push({
          label: session.label,
          type: session.type,
          url: session.url,
          path,
          ...analysis,
        });
      }
    }

    if (targetPageId) await cdp.send("Target.closeTarget", { targetId: targetPageId }).catch(() => null);

    const analyses = [...sessions.values()]
      .filter((s) => s.started && (samplingEnabled ? !!s.profile : true))
      .map((s) => {
        const analysis = analyzeProfile(s.profile, mapper);
        const profilePath = s.profile ? join(outDir, `${fixture}-${s.label}.heapprofile.json`) : null;
        if (profilePath) writeFileSync(profilePath, JSON.stringify(s.profile));
        return {
          label: s.label,
          type: s.type,
          url: s.url,
          title: s.title,
          beforeGc: s.beforeGc,
          endBeforeGc: s.endBeforeGc,
          afterGc: s.afterGc,
          totalSampledBytes: analysis.totalBytes,
          groups: analysis.groups,
          top: analysis.top,
          profilePath,
          stopError: s.stopError,
        };
      })
      .filter((s) => !samplingEnabled || s.totalSampledBytes > 0 || s.type === "page" || s.url.includes("worker-entry.js"));

    const allSessions = [...sessions.values()].map((s) => ({
      label: s.label,
      type: s.type,
      url: s.url,
      title: s.title,
      started: s.started,
      hasProfile: !!s.profile,
      stopError: s.stopError,
      beforeGc: s.beforeGc,
      endBeforeGc: s.endBeforeGc,
      afterGc: s.afterGc,
    }));
    const summary = { fixture, config, frames, samplingInterval: samplingEnabled ? SAMPLING_INTERVAL : 0, result, fontLog, allSessions, targets: analyses, snapshots: snapshotSummaries };
    const summaryPath = join(outDir, `${fixture}-${config}-heap-summary.json`);
    writeFileSync(summaryPath, JSON.stringify(summary, null, 2));

    console.log(`raw heap profiles written to ${outDir}`);
    console.log(`summary written to ${summaryPath}`);
    if (!result.ok) {
      console.log(`bench ERROR: ${result.error}`);
      if (result.stack) console.log(result.stack);
      process.exitCode = 1;
      return;
    }
    const run = result.runs?.[0];
    printRunSummary(run);

    const pageLike = analyses.filter((s) => s.type === "page");
    const workers = analyses.filter((s) => s.type === "worker" || s.type === "dedicated_worker" || s.url.includes("worker-entry.js"));
    console.log(`targets sampled: page=${pageLike.length} workers=${workers.length} total=${analyses.length}`);
    if (snapshotSummaries.length > 0) {
      console.log("\n=== post-GC heap snapshot backing-store retainers ===");
      for (const snap of snapshotSummaries) {
        console.log(`\n--- snapshot ${snap.label} (${snap.type}) ---`);
        console.log(`path: ${snap.path}`);
        console.log(`large backing nodes: ${snap.largeNodeCount}  bytes ${bytesToMiB(snap.totalBackingBytes).toFixed(1)} MiB`);
        console.log("retainer classes:");
        for (const row of snap.classes.slice(0, 12)) {
          console.log(
            `  ${bytesToMiB(row.bytes).toFixed(1)} MiB  n=${row.count}  ${row.cls}  sample=${row.sampleChain.slice(0, 220)}`,
          );
        }
        console.log("top backing node names:");
        for (const row of snap.topNodeNames.slice(0, 10)) {
          console.log(`  ${bytesToMiB(row.bytes).toFixed(1)} MiB  n=${row.count}  ${row.type} ${row.name}`);
        }
      }
    }

    for (const target of analyses) {
      const before = Number(target.beforeGc?.usedSize ?? 0);
      const endBefore = Number(target.endBeforeGc?.usedSize ?? 0);
      const after = Number(target.afterGc?.usedSize ?? 0);
      console.log(`\n--- ${target.label} (${target.type}) ---`);
      console.log(`url: ${target.url || target.title || "(blank)"}`);
      console.log(
        `sampled ${bytesToMiB(target.totalSampledBytes).toFixed(1)} MiB | live before ${bytesToMiB(before).toFixed(1)} MiB, end-before-GC ${bytesToMiB(endBefore).toFixed(1)} MiB, post-GC ${bytesToMiB(after).toFixed(1)} MiB`,
      );
      const groupRows = Object.entries(target.groups)
        .sort((a, b) => b[1] - a[1])
        .map(([group, bytes]) => `${group} ${bytesToMiB(bytes).toFixed(1)} MiB (${((100 * bytes) / (target.totalSampledBytes || 1)).toFixed(1)}%)`);
      console.log(`groups: ${groupRows.join(" | ") || "(none)"}`);
      console.log("top allocation self sites:");
      for (const row of target.top) {
        console.log(
          `  ${bytesToMiB(row.selfBytes).toFixed(1)} MiB ${((100 * row.selfBytes) / (target.totalSampledBytes || 1)).toFixed(1).padStart(5)}% [${row.group}] ${row.fn} @ ${row.source}:${row.line}`,
        );
      }
    }
  } finally {
    cdp?.close();
    chrome.kill("SIGKILL");
    server.stop(true);
    if (!keep) {
      try {
        rmSync(userDataDir, { recursive: true, force: true });
      } catch {}
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
