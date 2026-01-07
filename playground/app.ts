import { parseASS } from "subforge/ass";
import type { SubtitleDocument } from "subforge/core";
import {
  renderFrame,
  registerFontSource,
  resetFontCache,
  setFontResolver,
} from "../src";
import type { BitmapLayer } from "../src/core/data/types";

interface AppState {
  document: SubtitleDocument | null;
  videoUrl: string | null;
  isPlaying: boolean;
  currentTime: number;
  duration: number;
  lastRenderTime: number;
  pendingRender: boolean;
  loadedFonts: Array<{ name: string; source: string }>;
  loadedFontNames: Set<string>;
  timerMode: boolean;
  timerStartTime: number;
  timerAnimationId: number | null;
  renderAtPlayRes: boolean;
}

const state: AppState = {
  document: null,
  videoUrl: null,
  isPlaying: false,
  currentTime: 0,
  duration: 300,
  lastRenderTime: -1,
  pendingRender: false,
  loadedFonts: [],
  loadedFontNames: new Set(),
  timerMode: true,
  timerStartTime: 0,
  timerAnimationId: null,
  renderAtPlayRes: false,
};

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

const video = $<HTMLVideoElement>("video");
const canvas = $<HTMLCanvasElement>("subtitle-canvas");
const ctx = canvas.getContext("2d")!;
const playPauseBtn = $<HTMLButtonElement>("play-pause");
const timeline = $<HTMLInputElement>("timeline");
const timeDisplay = $<HTMLSpanElement>("time-display");
const renderModeToggle = $<HTMLInputElement>("render-mode");
const videoInput = $<HTMLInputElement>("video-input");
const subtitleInput = $<HTMLInputElement>("subtitle-input");
const fontInput = $<HTMLInputElement>("font-input");
const localFontsBtn = $<HTMLButtonElement>("local-fonts-btn");
const videoStatus = $<HTMLSpanElement>("video-status");
const subtitleStatus = $<HTMLSpanElement>("subtitle-status");
const fontStatus = $<HTMLSpanElement>("font-status");
const renderStatus = $<HTMLSpanElement>("render-status");
const fontList = $<HTMLUListElement>("font-list");
const logEl = $<HTMLPreElement>("log");
const playerContainer = document.querySelector(".player-container") as HTMLElement | null;
const panel = document.querySelector(".panel") as HTMLElement | null;
const perfRender = $<HTMLSpanElement>("perf-render");
const perfComposite = $<HTMLSpanElement>("perf-composite");
const perfTotal = $<HTMLSpanElement>("perf-total");
const perfLayers = $<HTMLSpanElement>("perf-layers");
const perfMemory = $<HTMLSpanElement>("perf-memory");
const perfGraph = $<HTMLCanvasElement>("perf-graph");
const memoryGraph = $<HTMLCanvasElement>("memory-graph");
const bgMode = $<HTMLSelectElement>("bg-mode");
const bgColorA = $<HTMLInputElement>("bg-color-a");
const bgColorB = $<HTMLInputElement>("bg-color-b");
const videoWrapper = document.querySelector(".video-wrapper") as HTMLElement | null;

const MAX_LOG_LINES = 500;
const HISTORY_SIZE = 120;
const renderHistory = new Float32Array(HISTORY_SIZE);
const memoryHistory = new Float32Array(HISTORY_SIZE);
let historyIndex = 0;
let historyCount = 0;

function log(msg: string, level: "info" | "warn" | "error" = "info") {
  const time = new Date().toISOString().slice(11, 23);
  const line = document.createElement("div");
  line.className = level;
  line.textContent = `[${time}] ${msg}`;
  logEl.appendChild(line);
  while (logEl.childNodes.length > MAX_LOG_LINES) {
    logEl.removeChild(logEl.firstChild!);
  }
  logEl.scrollTop = logEl.scrollHeight;
  if (level === "error") console.error(msg);
}

function formatTime(seconds: number): string {
  const mins = Math.floor(seconds / 60);
  const secs = seconds % 60;
  return `${mins.toString().padStart(2, "0")}:${secs.toFixed(3).padStart(6, "0")}`;
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  let idx = 0;
  let value = bytes;
  while (value >= 1024 && idx < units.length - 1) {
    value /= 1024;
    idx++;
  }
  return `${value.toFixed(value >= 100 ? 0 : value >= 10 ? 1 : 2)} ${units[idx]}`;
}

function getHeapBytes(): number | null {
  const memory = (performance as any).memory as { usedJSHeapSize?: number } | undefined;
  if (!memory || typeof memory.usedJSHeapSize !== "number") return null;
  return memory.usedJSHeapSize;
}

function pushHistory(renderMs: number, frameBytes: number) {
  renderHistory[historyIndex] = renderMs;
  memoryHistory[historyIndex] = frameBytes / (1024 * 1024);
  historyIndex = (historyIndex + 1) % HISTORY_SIZE;
  if (historyCount < HISTORY_SIZE) historyCount++;
}

function drawGraphs() {
  drawGraph(perfGraph, renderHistory, historyCount, historyIndex, "#7ee787");
  drawGraph(memoryGraph, memoryHistory, historyCount, historyIndex, "#58a6ff");
}

function drawGraph(
  canvasEl: HTMLCanvasElement,
  data: Float32Array,
  count: number,
  index: number,
  color: string,
) {
  if (count <= 0) return;
  const ctx2d = canvasEl.getContext("2d");
  if (!ctx2d) return;
  const w = canvasEl.width;
  const h = canvasEl.height;
  ctx2d.clearRect(0, 0, w, h);

  let max = 0.001;
  for (let i = 0; i < count; i++) {
    const idx = (index - count + i + HISTORY_SIZE) % HISTORY_SIZE;
    const v = data[idx]!;
    if (v > max) max = v;
  }

  const step = count > 1 ? w / (count - 1) : w;
  ctx2d.beginPath();
  for (let i = 0; i < count; i++) {
    const idx = (index - count + i + HISTORY_SIZE) % HISTORY_SIZE;
    const v = data[idx]!;
    const x = i * step;
    const y = h - (v / max) * h;
    if (i === 0) {
      ctx2d.moveTo(x, y);
    } else {
      ctx2d.lineTo(x, y);
    }
  }
  ctx2d.strokeStyle = color;
  ctx2d.lineWidth = 2;
  ctx2d.stroke();
}

function updateTimeDisplay() {
  timeDisplay.textContent = `${formatTime(state.currentTime)} / ${formatTime(state.duration)}`;
}

function applyBackground() {
  if (!videoWrapper) return;
  const mode = bgMode.value;
  const colorA = bgColorA.value;
  const colorB = bgColorB.value;

  switch (mode) {
    case "solid":
      videoWrapper.style.backgroundColor = colorA;
      videoWrapper.style.backgroundImage = "none";
      videoWrapper.style.backgroundSize = "auto";
      break;
    case "gradient":
      videoWrapper.style.backgroundColor = colorA;
      videoWrapper.style.backgroundImage = `linear-gradient(135deg, ${colorA}, ${colorB})`;
      videoWrapper.style.backgroundSize = "auto";
      break;
    case "dark":
      videoWrapper.style.backgroundColor = "#0a0a0a";
      videoWrapper.style.backgroundImage = "none";
      videoWrapper.style.backgroundSize = "auto";
      break;
    case "light":
      videoWrapper.style.backgroundColor = "#f2f2f2";
      videoWrapper.style.backgroundImage = "none";
      videoWrapper.style.backgroundSize = "auto";
      break;
    case "checker":
    default:
      videoWrapper.style.backgroundColor = colorA;
      videoWrapper.style.backgroundImage = `repeating-conic-gradient(${colorA} 0% 25%, ${colorB} 0% 50%)`;
      videoWrapper.style.backgroundSize = "16px 16px";
      break;
  }
}

function updateFontList() {
  fontList.innerHTML = "";
  for (const font of state.loadedFonts) {
    const li = document.createElement("li");
    li.innerHTML = `<span class="font-name">${font.name}</span><span class="font-source">${font.source}</span>`;
    fontList.appendChild(li);
  }
  fontStatus.textContent = `${state.loadedFonts.length} loaded`;
}

function addLoadedFont(name: string, source: string) {
  const key = name.toLowerCase();
  if (state.loadedFontNames.has(key)) return;
  state.loadedFontNames.add(key);
  state.loadedFonts.push({ name, source });
  updateFontList();
}

function registerFontOnce(name: string, source: ArrayBuffer, label: string, listInUi = true) {
  registerFontSource(name, source);
  if (!listInUi) return;
  addLoadedFont(name, label);
}

async function loadVideo(file: File) {
  if (state.videoUrl) {
    URL.revokeObjectURL(state.videoUrl);
  }
  state.videoUrl = URL.createObjectURL(file);
  video.src = state.videoUrl;
  state.timerMode = false;
  video.parentElement?.classList.add("has-video");
  videoStatus.textContent = file.name;
  log(`Video loaded: ${file.name}`);
}

async function loadSubtitle(file: File) {
  try {
    const text = await file.text();
    const result = parseASS(text, { onError: "collect", strict: false, preserveOrder: true });
    if (!result.ok) {
      throw new Error("Failed to parse ASS file");
    }
    state.document = result.document;
    resetFontCache();

    // Calculate duration from subtitle events
    if (result.document.events?.length) {
      const maxEnd = Math.max(...result.document.events.map((e) => e.end ?? 0));
      if (state.timerMode && maxEnd > 0) {
        state.duration = maxEnd / 1000 + 5;
      }
    }

    subtitleStatus.textContent = file.name;
    log(`Subtitle loaded: ${file.name} (${result.document.events?.length ?? 0} events)`);
    await primeLocalFonts();
    resizeCanvas();
    updateTimeDisplay();
    renderCurrentFrame();
  } catch (err) {
    log(`Failed to load subtitle: ${err}`, "error");
    subtitleStatus.textContent = "error";
  }
}

async function loadFontFile(file: File) {
  try {
    const buffer = await file.arrayBuffer();
    const baseName = file.name.replace(/\.(ttf|otf|ttc|otc|woff|woff2)$/i, "");

    // Register with ArrayBuffer directly - subframe supports this
    registerFontOnce(baseName, buffer, "file");
    log(`Font registered: ${baseName}`);
  } catch (err) {
    log(`Failed to load font ${file.name}: ${err}`, "error");
  }
}

type LocalFontData = {
  family: string;
  fullName?: string;
  postscriptName?: string;
  style?: string;
  blob: () => Promise<Blob>;
};

let localFontIndex: Map<string, LocalFontData> | null = null;
let localFontIndexPromise: Promise<Map<string, LocalFontData> | null> | null = null;
const localFontBufferCache = new WeakMap<LocalFontData, Promise<ArrayBuffer>>();
let localFontList: LocalFontData[] | null = null;
const localFontAliasCache = new Map<string, LocalFontData>();

function normalizeFontKey(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function sanitizeFontName(name: string): string {
  return name
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .trim()
    .replace(/^@+/, "")
    .replace(/^["']+|["']+$/g, "");
}

function nameHasStyle(name: string, style: string): boolean {
  const lower = name.toLowerCase();
  const s = style.toLowerCase();
  return lower.includes(s);
}

function scoreFontEntry(requested: string, entry: LocalFontData): number {
  const req = requested.toLowerCase();
  const reqNorm = normalizeFontKey(requested);
  const names = [entry.fullName ?? "", entry.family ?? "", entry.postscriptName ?? ""];
  let score = 0;
  for (const name of names) {
    if (!name) continue;
    const lower = name.toLowerCase();
    if (lower === req) score = Math.max(score, 100);
    const norm = normalizeFontKey(name);
    if (norm && reqNorm && norm === reqNorm) score = Math.max(score, 90);
    if (req && lower.includes(req)) score = Math.max(score, 70);
    if (reqNorm && norm && norm.includes(reqNorm)) score = Math.max(score, 60);
  }

  const style = entry.style ?? "";
  if (style) {
    if (!/(bold|italic|oblique|black|light|thin|regular)/i.test(requested)) {
      if (/regular/i.test(style)) score += 5;
      if (/bold|italic|oblique|black|light|thin/i.test(style)) score -= 2;
    } else if (nameHasStyle(requested, style)) {
      score += 5;
    }
  }

  return score;
}

function findFontEntryByIncludes(name: string): LocalFontData | null {
  if (!localFontList || localFontList.length === 0) return null;
  const cached = localFontAliasCache.get(name);
  if (cached) return cached;
  const needle = name.toLowerCase();
  const needleNorm = normalizeFontKey(name);
  let match: LocalFontData | null = null;
  for (const entry of localFontList) {
    const fullName = entry.fullName ?? "";
    const family = entry.family ?? "";
    const postscriptName = entry.postscriptName ?? "";
    const fullLower = fullName.toLowerCase();
    const familyLower = family.toLowerCase();
    const postLower = postscriptName.toLowerCase();
    if (fullLower.includes(needle) || familyLower.includes(needle) || postLower.includes(needle)) {
      match = entry;
      break;
    }
    if (needleNorm) {
      const fullNorm = normalizeFontKey(fullName);
      const familyNorm = normalizeFontKey(family);
      const postNorm = normalizeFontKey(postscriptName);
      if (
        (fullNorm && fullNorm.includes(needleNorm)) ||
        (familyNorm && familyNorm.includes(needleNorm)) ||
        (postNorm && postNorm.includes(needleNorm))
      ) {
        match = entry;
        break;
      }
    }
  }
  if (match) localFontAliasCache.set(name, match);
  return match;
}

function resolveBestFontEntry(name: string, index: Map<string, LocalFontData>): LocalFontData | null {
  const cached = localFontAliasCache.get(name);
  if (cached) return cached;
  const key = name.toLowerCase();
  const normKey = normalizeFontKey(name);
  const direct = index.get(key) ?? (normKey ? index.get(normKey) : undefined);
  if (!localFontList || localFontList.length === 0) {
    if (direct) localFontAliasCache.set(name, direct);
    return direct ?? null;
  }
  let best: LocalFontData | null = null;
  let bestScore = 0;
  for (const entry of localFontList) {
    const score = scoreFontEntry(name, entry);
    if (score > bestScore) {
      bestScore = score;
      best = entry;
    }
  }
  if (!best) best = direct ?? findFontEntryByIncludes(name);
  if (best) localFontAliasCache.set(name, best);
  return best;
}

function getLocalFontBuffer(entry: LocalFontData): Promise<ArrayBuffer> {
  const cached = localFontBufferCache.get(entry);
  if (cached) return cached;
  const load = entry
    .blob()
    .then((blob) => blob.arrayBuffer())
    .catch((err) => {
      localFontBufferCache.delete(entry);
      throw err;
    });
  localFontBufferCache.set(entry, load);
  return load;
}

async function buildLocalFontIndex(): Promise<Map<string, LocalFontData> | null> {
  if (!("queryLocalFonts" in window)) return null;
  if (localFontIndex) return localFontIndex;
  if (localFontIndexPromise) return localFontIndexPromise;
  localFontIndexPromise = (async () => {
    try {
      log("Indexing local fonts (lazy resolver)...");
      const fonts = await (window as any).queryLocalFonts();
      const list = fonts as LocalFontData[];
      const index = new Map<string, LocalFontData>();
      localFontAliasCache.clear();
      for (const fontData of list) {
        const family = fontData.family ?? "";
        const fullName = fontData.fullName ?? "";
        const postscriptName = fontData.postscriptName ?? "";
        if (family) {
          const familyKey = family.toLowerCase();
          if (!index.has(familyKey)) index.set(familyKey, fontData);
          const familyNorm = normalizeFontKey(family);
          if (familyNorm && !index.has(familyNorm)) index.set(familyNorm, fontData);
        }
        if (fullName) {
          const fullKey = fullName.toLowerCase();
          if (!index.has(fullKey)) index.set(fullKey, fontData);
          const fullNorm = normalizeFontKey(fullName);
          if (fullNorm && !index.has(fullNorm)) index.set(fullNorm, fontData);
        }
        if (postscriptName) {
          const postKey = postscriptName.toLowerCase();
          if (!index.has(postKey)) index.set(postKey, fontData);
          const postNorm = normalizeFontKey(postscriptName);
          if (postNorm && !index.has(postNorm)) index.set(postNorm, fontData);
        }
      }
      localFontList = list;
      log(`Indexed ${index.size} local font families`);
      resetFontCache();
      if (state.document) {
        state.lastRenderTime = -1;
        renderCurrentFrame();
      }
      return index;
    } catch (err) {
      log(`Failed to query local fonts: ${err}`, "error");
      return null;
    } finally {
      localFontIndexPromise = null;
    }
  })();
  localFontIndex = await localFontIndexPromise;
  return localFontIndex;
}

async function primeLocalFonts() {
  if (!("queryLocalFonts" in window)) {
    log("No local font access; load fonts via file input for browser rendering.", "warn");
    return;
  }
  await buildLocalFontIndex();
}

async function queryLocalFonts() {
  if (!("queryLocalFonts" in window)) {
    log("queryLocalFonts not supported in this browser", "warn");
    return;
  }

  try {
    log("Requesting local font access...");
    const index = await buildLocalFontIndex();
    if (!index) {
      log("Local font access failed", "error");
      return;
    }
    log(`Indexed ${index.size} local font families (lazy)`);
  } catch (err) {
    log(`Failed to query local fonts: ${err}`, "error");
  }
}

function getCanvasSize(): { width: number; height: number } {
  if (!state.timerMode && video.videoWidth > 0 && !state.renderAtPlayRes) {
    return { width: video.videoWidth, height: video.videoHeight };
  }
  const doc = state.document;
  const width = doc?.info?.playResX ?? 1920;
  const height = doc?.info?.playResY ?? 1080;
  return { width, height };
}

function resizeCanvas() {
  const wrapper = canvas.parentElement!;
  const wrapperRect = wrapper.getBoundingClientRect();

  if (!state.timerMode && video.videoWidth > 0) {
    const videoRect = video.getBoundingClientRect();
    if (videoRect.width > 0 && videoRect.height > 0) {
      const { width: targetW, height: targetH } = getCanvasSize();
      const dpr = window.devicePixelRatio || 1;
      const renderW = state.renderAtPlayRes
        ? Math.max(1, Math.round(targetW))
        : Math.max(1, Math.round(videoRect.width * dpr));
      const renderH = state.renderAtPlayRes
        ? Math.max(1, Math.round(targetH))
        : Math.max(1, Math.round(videoRect.height * dpr));

      canvas.width = renderW;
      canvas.height = renderH;
      canvas.style.width = `${videoRect.width}px`;
      canvas.style.height = `${videoRect.height}px`;
      canvas.style.left = `${videoRect.left - wrapperRect.left}px`;
      canvas.style.top = `${videoRect.top - wrapperRect.top}px`;
      resizeGraphs();
      return;
    }
  }

  const { width: canvasW, height: canvasH } = getCanvasSize();
  const videoAspect = canvasW / canvasH;
  const containerAspect = wrapperRect.width / wrapperRect.height;

  let w: number, h: number;
  if (containerAspect > videoAspect) {
    h = wrapperRect.height;
    w = h * videoAspect;
  } else {
    w = wrapperRect.width;
    h = w / videoAspect;
  }

  const dpr = window.devicePixelRatio || 1;
  const renderW = Math.max(1, Math.round(w * dpr));
  const renderH = Math.max(1, Math.round(h * dpr));

  canvas.width = renderW;
  canvas.height = renderH;
  canvas.style.width = `${w}px`;
  canvas.style.height = `${h}px`;
  canvas.style.left = `${(wrapperRect.width - w) / 2}px`;
  canvas.style.top = `${(wrapperRect.height - h) / 2}px`;
  resizeGraphs();
}

function resizeGraphs() {
  resizeGraphCanvas(perfGraph);
  resizeGraphCanvas(memoryGraph);
}

function resizeGraphCanvas(graph: HTMLCanvasElement) {
  const rect = graph.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  const w = Math.max(1, Math.round(rect.width * dpr));
  const h = Math.max(1, Math.round(rect.height * dpr));
  if (graph.width !== w || graph.height !== h) {
    graph.width = w;
    graph.height = h;
  }
}

function compositeLayer(layer: BitmapLayer) {
  const x = Math.round(layer.originX);
  const y = Math.round(layer.originY);
  const { width, height, stride, bitmap, color } = layer;

  if (width <= 0 || height <= 0) return;

  const imageData = ctx.createImageData(width, height);
  const data = imageData.data;

  const [r, g, b, a] = color;
  const alpha = a / 255;

  for (let row = 0; row < height; row++) {
    for (let col = 0; col < width; col++) {
      const srcIdx = row * stride + col;
      const dstIdx = (row * width + col) * 4;
      const coverage = bitmap[srcIdx]! / 255;
      const finalAlpha = coverage * alpha;

      data[dstIdx] = r;
      data[dstIdx + 1] = g;
      data[dstIdx + 2] = b;
      data[dstIdx + 3] = Math.round(finalAlpha * 255);
    }
  }

  ctx.globalCompositeOperation = "source-over";
  ctx.putImageData(imageData, x, y);
}

async function renderCurrentFrame() {
  if (!state.document) return;
  if (state.pendingRender) return;

  const timeMs = state.currentTime * 1000;
  if (Math.abs(timeMs - state.lastRenderTime) < 1) return;

  state.pendingRender = true;
  renderStatus.textContent = "rendering...";

  try {
    const width = canvas.width;
    const height = canvas.height;

    ctx.clearRect(0, 0, width, height);

    const startTime = performance.now();
    const result = await renderFrame(state.document, timeMs, width, height);
    const renderMs = performance.now() - startTime;

    const compositeStart = performance.now();
    let frameBytes = 0;
    for (const layer of result.layers) {
      if (layer.bitmap) {
        frameBytes += (layer.bitmap as Uint8Array).byteLength ?? layer.bitmap.length ?? 0;
      }
      compositeLayer(layer);
    }
    const compositeMs = performance.now() - compositeStart;
    const totalMs = renderMs + compositeMs;

    state.lastRenderTime = timeMs;
    renderStatus.textContent = `${result.layers.length} layers (${totalMs.toFixed(1)}ms)`;

    const heapBytes = getHeapBytes();
    perfRender.textContent = `${renderMs.toFixed(2)} ms`;
    perfComposite.textContent = `${compositeMs.toFixed(2)} ms`;
    perfTotal.textContent = `${totalMs.toFixed(2)} ms`;
    perfLayers.textContent = `${result.layers.length}`;
    perfMemory.textContent = `${formatBytes(frameBytes)} frame, ${
      heapBytes ? formatBytes(heapBytes) : "heap n/a"
    }`;
    pushHistory(totalMs, frameBytes);
    drawGraphs();
  } catch (err) {
    log(`Render error: ${err}`, "error");
    renderStatus.textContent = "error";
  } finally {
    state.pendingRender = false;
  }
}

function onVideoTimeUpdate() {
  if (state.timerMode) return;
  state.currentTime = video.currentTime;
  timeline.value = String((video.currentTime / state.duration) * 100 || 0);
  updateTimeDisplay();
  renderCurrentFrame();
}

function onVideoLoadedMetadata() {
  if (state.timerMode) return;
  state.duration = video.duration;
  timeline.max = "100";
  updateTimeDisplay();
  resizeCanvas();
  log(`Video ready: ${video.videoWidth}x${video.videoHeight}, ${formatTime(video.duration)}`);
}

function timerLoop() {
  if (!state.isPlaying || !state.timerMode) return;

  const elapsed = (performance.now() - state.timerStartTime) / 1000;
  state.currentTime = Math.min(elapsed, state.duration);

  timeline.value = String((state.currentTime / state.duration) * 100);
  updateTimeDisplay();
  renderCurrentFrame();

  if (state.currentTime >= state.duration) {
    stopPlayback();
    return;
  }

  state.timerAnimationId = requestAnimationFrame(timerLoop);
}

function startPlayback() {
  state.isPlaying = true;
  playPauseBtn.textContent = "⏸";

  if (state.timerMode) {
    state.timerStartTime = performance.now() - state.currentTime * 1000;
    state.timerAnimationId = requestAnimationFrame(timerLoop);
  } else {
    video.play().catch(() => {});
  }
}

function stopPlayback() {
  state.isPlaying = false;
  playPauseBtn.textContent = "▶";

  if (state.timerAnimationId !== null) {
    cancelAnimationFrame(state.timerAnimationId);
    state.timerAnimationId = null;
  }

  if (!state.timerMode) {
    video.pause();
  }
}

function togglePlayPause() {
  if (state.isPlaying) {
    stopPlayback();
  } else {
    startPlayback();
  }
}

function onTimelineInput() {
  const pct = parseFloat(timeline.value);
  const time = (pct / 100) * state.duration;
  state.currentTime = time;

  if (state.timerMode) {
    state.timerStartTime = performance.now() - time * 1000;
  } else {
    video.currentTime = time;
  }

  updateTimeDisplay();
  renderCurrentFrame();
}

function seekBy(delta: number) {
  const newTime = Math.max(0, Math.min(state.duration, state.currentTime + delta));
  state.currentTime = newTime;

  if (state.timerMode) {
    state.timerStartTime = performance.now() - newTime * 1000;
  } else {
    video.currentTime = newTime;
  }

  timeline.value = String((newTime / state.duration) * 100);
  updateTimeDisplay();
  renderCurrentFrame();
}

function onKeyDown(e: KeyboardEvent) {
  if (e.target instanceof HTMLInputElement) return;

  switch (e.key) {
    case " ":
      e.preventDefault();
      togglePlayPause();
      break;
    case "ArrowLeft":
      e.preventDefault();
      seekBy(-5);
      break;
    case "ArrowRight":
      e.preventDefault();
      seekBy(5);
      break;
    case ",":
      e.preventDefault();
      seekBy(-1 / 30);
      break;
    case ".":
      e.preventDefault();
      seekBy(1 / 30);
      break;
  }
}

function init() {
  renderModeToggle.checked = state.renderAtPlayRes;
  setFontResolver(async (fontName) => {
    const index = localFontIndex ?? (await buildLocalFontIndex());
    if (!index) return null;
    const cleanedName = sanitizeFontName(fontName);
    const key = cleanedName.toLowerCase();
    const entry = resolveBestFontEntry(cleanedName, index);
    if (!entry) return null;
    const buffer = await getLocalFontBuffer(entry);
    const familyKey = entry.family.toLowerCase();
    registerFontOnce(entry.family, buffer, "system");
    if (key && key !== familyKey) {
      registerFontOnce(cleanedName, buffer, "system", false);
    }
    const fullName = entry.fullName;
    if (fullName) {
      const fullKey = fullName.toLowerCase();
      if (fullKey !== familyKey && fullKey !== key) {
        registerFontOnce(fullName, buffer, "system", false);
      }
    }
    const postscriptName = entry.postscriptName;
    if (postscriptName) {
      const postKey = postscriptName.toLowerCase();
      if (postKey !== familyKey && postKey !== key) {
        registerFontOnce(postscriptName, buffer, "system", false);
      }
    }
    return buffer;
  });

  const cleanup: Array<() => void> = [];
  const on = <T extends EventTarget>(target: T, type: string, handler: EventListener) => {
    target.addEventListener(type, handler);
    cleanup.push(() => target.removeEventListener(type, handler));
  };

  on(video, "timeupdate", onVideoTimeUpdate);
  on(video, "loadedmetadata", onVideoLoadedMetadata);
  on(video, "play", () => {
    if (!state.timerMode) {
      state.isPlaying = true;
      playPauseBtn.textContent = "⏸";
    }
  });
  on(video, "pause", () => {
    if (!state.timerMode) {
      state.isPlaying = false;
      playPauseBtn.textContent = "▶";
    }
  });

  on(playPauseBtn, "click", togglePlayPause);
  on(timeline, "input", onTimelineInput);
  on(renderModeToggle, "change", () => {
    state.renderAtPlayRes = renderModeToggle.checked;
    state.lastRenderTime = -1;
    resizeCanvas();
    renderCurrentFrame();
  });
  on(bgMode, "change", applyBackground);
  on(bgColorA, "input", applyBackground);
  on(bgColorB, "input", applyBackground);

  on(videoInput, "change", () => {
    if (videoInput.files?.[0]) loadVideo(videoInput.files[0]);
  });

  on(subtitleInput, "change", () => {
    if (subtitleInput.files?.[0]) loadSubtitle(subtitleInput.files[0]);
  });

  on(fontInput, "change", () => {
    if (fontInput.files) {
      for (const file of fontInput.files) {
        loadFontFile(file);
      }
    }
  });

  on(localFontsBtn, "click", queryLocalFonts);

  on(window, "resize", resizeCanvas);
  on(document, "keydown", onKeyDown);

  let resizeObserver: ResizeObserver | null = null;
  if (typeof ResizeObserver !== "undefined") {
    resizeObserver = new ResizeObserver(() => {
      resizeCanvas();
    });
    if (playerContainer) resizeObserver.observe(playerContainer);
    if (panel) resizeObserver.observe(panel);
  }

  resizeCanvas();
  applyBackground();
  updateTimeDisplay();
  log("Playground initialized (timer mode - no video required)");
  void queryLocalFonts();

  const cleanupFn = () => {
    if (state.timerAnimationId !== null) {
      cancelAnimationFrame(state.timerAnimationId);
      state.timerAnimationId = null;
    }
    if (resizeObserver) {
      resizeObserver.disconnect();
      resizeObserver = null;
    }
    for (const dispose of cleanup) dispose();
  };
  (window as any).__subframePlaygroundCleanup = cleanupFn;
}

if ((window as any).__subframePlaygroundCleanup) {
  (window as any).__subframePlaygroundCleanup();
}
init();
