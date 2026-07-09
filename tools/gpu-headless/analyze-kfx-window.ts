// Diagnose active ASS event structure in a fixed 60fps stress window.
//
// Usage:
//   bun run tools/gpu-headless/analyze-kfx-window.ts --ass test/fixtures/.../FGOBD.ass --t0 39000
import { readFileSync } from "node:fs";

type EventLine = {
  index: number;
  startMs: number;
  endMs: number;
  style: string;
  effect: string;
  text: string;
};

const argv = process.argv.slice(2);
function argVal(flag: string): string | null {
  const idx = argv.indexOf(flag);
  return idx !== -1 ? (argv[idx + 1] ?? null) : null;
}

const assPath = argVal("--ass");
const t0 = Number(argVal("--t0"));
const frames = Number(argVal("--frames") ?? "300");
const frameMs = 1000 / 60;
if (!assPath || !Number.isFinite(t0)) {
  throw new Error("usage: --ass <file.ass> --t0 <ms> [--frames 300]");
}

function parseAssTime(s: string): number {
  const m = s.trim().match(/^(\d+):(\d\d):(\d\d)\.(\d\d)$/);
  if (!m) return 0;
  return (
    Number(m[1]) * 3600_000 +
    Number(m[2]) * 60_000 +
    Number(m[3]) * 1000 +
    Number(m[4]) * 10
  );
}

function parseDialogue(line: string, index: number): EventLine | null {
  if (!line.startsWith("Dialogue:")) return null;
  const body = line.slice("Dialogue:".length).trim();
  const parts = body.split(",");
  if (parts.length < 10) return null;
  return {
    index,
    startMs: parseAssTime(parts[1] ?? "0:00:00.00"),
    endMs: parseAssTime(parts[2] ?? "0:00:00.00"),
    style: parts[3]?.trim() ?? "",
    effect: parts[8]?.trim() ?? "",
    text: parts.slice(9).join(","),
  };
}

function tagCount(text: string, re: RegExp): number {
  const m = text.match(re);
  return m ? m.length : 0;
}

function tagSet(text: string): string[] {
  const out: string[] = [];
  const checks: Array<[string, RegExp]> = [
    ["t", /\\t(?:\(|\d)/g],
    ["move", /\\move\s*\(/g],
    ["fad", /\\fad\s*\(/g],
    ["fade", /\\fade\s*\(/g],
    ["k", /\\(?:k|K|kf|ko)\d/g],
    ["clip", /\\i?clip\s*\(/g],
    ["blur", /\\blur[\d.-]+/g],
    ["be", /\\be[\d.-]+/g],
    ["fr", /\\fr[xyz]?[\d.-]+/g],
    ["fsc", /\\fsc[xy][\d.-]+/g],
    ["alpha", /\\(?:alpha|[1234]a)&H[0-9A-Fa-f]+&/g],
  ];
  for (const [name, re] of checks) {
    if (re.test(text)) out.push(name);
  }
  return out;
}

function isTimeVariant(text: string): boolean {
  return /\\t(?:\(|\d)|\\move\s*\(|\\fad\s*\(|\\fade\s*\(|\\(?:k|K|kf|ko)\d/.test(text);
}

const lines = readFileSync(assPath, "utf8").split(/\r?\n/);
const events = lines.map((line, i) => parseDialogue(line, i + 1)).filter((e): e is EventLine => e !== null);
const activeSets = new Map<string, number>();
const activeCounts: number[] = [];
const layerStyle = new Map<string, number>();
let staticEventFrames = 0;
let animatedEventFrames = 0;
let maxActive = 0;
let maxActiveAt = t0;
const uniqueEvents = new Map<number, EventLine>();
const tagTotals = new Map<string, number>();

for (let i = 0; i < frames; i++) {
  const t = t0 + i * frameMs;
  const active = events.filter((e) => e.startMs <= t && t < e.endMs);
  const key = active.map((e) => e.index).join("|");
  activeSets.set(key, (activeSets.get(key) ?? 0) + 1);
  activeCounts.push(active.length);
  if (active.length > maxActive) {
    maxActive = active.length;
    maxActiveAt = t;
  }
  for (const e of active) {
    uniqueEvents.set(e.index, e);
    layerStyle.set(e.style, (layerStyle.get(e.style) ?? 0) + 1);
    if (isTimeVariant(e.text)) animatedEventFrames++;
    else staticEventFrames++;
    for (const tag of tagSet(e.text)) tagTotals.set(tag, (tagTotals.get(tag) ?? 0) + 1);
  }
}

const unique = [...uniqueEvents.values()];
let staticUnique = 0;
let animatedUnique = 0;
for (const e of unique) {
  if (isTimeVariant(e.text)) animatedUnique++;
  else staticUnique++;
}

function pct(n: number, d: number): string {
  return d > 0 ? `${((100 * n) / d).toFixed(1)}%` : "0.0%";
}

function summarize(nums: number[]): string {
  const sorted = [...nums].sort((a, b) => a - b);
  const p = (x: number) => sorted[Math.min(sorted.length - 1, Math.round((x / 100) * (sorted.length - 1)))] ?? 0;
  const mean = nums.reduce((a, b) => a + b, 0) / (nums.length || 1);
  return `min=${sorted[0] ?? 0} p50=${p(50)} p95=${p(95)} max=${sorted[sorted.length - 1] ?? 0} mean=${mean.toFixed(1)}`;
}

console.log(`ass=${assPath}`);
console.log(`window=${t0.toFixed(0)}..${(t0 + frames * frameMs).toFixed(0)} frames=${frames}`);
console.log(`activeEvents ${summarize(activeCounts)} maxAt=${maxActiveAt.toFixed(1)}ms`);
console.log(`distinctActiveSets=${activeSets.size}/${frames} repeatedFrameSets=${frames - activeSets.size}`);
console.log(`uniqueEvents=${unique.length} static=${staticUnique} (${pct(staticUnique, unique.length)}) animated=${animatedUnique} (${pct(animatedUnique, unique.length)})`);
console.log(`eventFrames static=${staticEventFrames} (${pct(staticEventFrames, staticEventFrames + animatedEventFrames)}) animated=${animatedEventFrames} (${pct(animatedEventFrames, staticEventFrames + animatedEventFrames)})`);
console.log("tagFrames=" + [...tagTotals.entries()].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}:${v}`).join(" "));
console.log("styles=" + [...layerStyle.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12).map(([k, v]) => `${k}:${v}`).join(" | "));
console.log("top animated examples:");
for (const e of unique.filter((ev) => isTimeVariant(ev.text)).slice(0, 12)) {
  const tags = tagSet(e.text).join(",");
  const sample = e.text.replace(/\{[^}]*\}/g, "{}").slice(0, 140);
  console.log(`  line=${e.index} ${e.startMs}-${e.endMs} style=${e.style} tags=${tags} text=${sample}`);
}
