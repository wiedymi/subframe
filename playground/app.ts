import { parseASS } from "subforge/ass";
import type { SubtitleDocument } from "subforge/core";
import {
  renderFrame,
  releaseRenderResult,
  attachDocument,
  prewarmFrameFromDocument,
  registerFontSource,
  resetFontCache,
  setFontResolver,
  createWebGLBackend,
  createWebGPUBackend,
  getMemoryStats,
  setWorkerSource,
  getFramePipelineStats,
  resetFramePipeline,
  Subframe,
  type CompositorBackend,
  type SubframeFrame,
} from "../src";
import {
  buildLocalFontIndex,
  getLocalFontBuffer,
  resolveBestLocalFontEntry,
  sanitizeFontName,
} from "../src/io/fonts/local-access";
import {
  clearEventLayerCache,
  clearRasterCaches,
  getEventLayerCacheStats,
} from "../src/core/pipeline";
import {
  getGpuFilterProvider,
  setGpuFilterProvider,
} from "../src/core/filters/gpu-provider";
import { RenderAheadPlayer, type BufferedFrame, type RenderAheadStats } from "../src/player/render-ahead";
import type { BitmapLayer } from "../src/core/data/types";
import { libassGaussianBlur } from "../src/core/libass_blur";
import { GpuBlurEngine } from "../src/backend/webgpu/blur";
import {
  BatchedGpuBlurEngine,
  GpuFilteredCache,
  hashMask,
  type BatchMask,
} from "../src/backend/webgpu/blur-batch";
import { PixelMode } from "text-shaper";

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
  backend: "cpu" | "webgl" | "webgpu";
  enableGpuFilters: boolean;
  prewarmed: boolean;
  prewarmPromise: Promise<void> | null;
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
  backend: "cpu",
  // GPU filters default ON: the fused WGSL filter chain is hardware-gate proven
  // byte-identical to the CPU path and carries the measured realtime numbers on
  // both dense-tiny-blur (beastars) and fewer-larger-blur (fate/kusriya) content
  // since the single-submit/batched integration. Opt out via the checkbox.
  enableGpuFilters: true,
  prewarmed: false,
  prewarmPromise: null,
};

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

const video = $<HTMLVideoElement>("video");
const canvas2d = $<HTMLCanvasElement>("subtitle-canvas-2d");
const canvasWebgl = $<HTMLCanvasElement>("subtitle-canvas-webgl");
const canvasWebgpu = $<HTMLCanvasElement>("subtitle-canvas-webgpu");
const ctx2d = canvas2d.getContext("2d")!;
const playPauseBtn = $<HTMLButtonElement>("play-pause");
const timeline = $<HTMLInputElement>("timeline");
const timeDisplay = $<HTMLSpanElement>("time-display");
const renderModeToggle = $<HTMLInputElement>("render-mode");
const gpuFiltersToggle = $<HTMLInputElement>("gpu-filters");
const backendSelect = $<HTMLSelectElement>("backend-select");
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
const perfGpu = $<HTMLSpanElement>("perf-gpu");
const perfCache = $<HTMLSpanElement>("perf-cache");
const perfDisplay = $<HTMLSpanElement>("perf-display");
const perfPacing = $<HTMLSpanElement>("perf-pacing");
const perfPipeline = $<HTMLSpanElement>("perf-pipeline");
const perfNote = document.getElementById("perf-note") as HTMLDivElement | null;
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
let webglBackend: CompositorBackend | null = null;
let webgpuBackend: CompositorBackend | null = null;
let webgpuBackendPromise: Promise<CompositorBackend | null> | null = null;
let defaultBackendSelected = false;

// Render-ahead playback (timer mode). The player renders upcoming frames on a
// uniform media grid into a bounded buffer (feeding the core ring/hybrid prefetch
// consistent future timestamps) and a display loop presents them at a steady
// vsync-multiple cadence, so the on-screen cadence no longer equals render latency.
let player: RenderAheadPlayer<SubframeFrame> | null = null;
let playbackSubframe: Subframe | null = null;
let playbackSubframeDoc: SubtitleDocument | null = null;
let workersRequested = true;
// Backend resolved ONCE at play start so present() is synchronous (no per-frame
// `await ensureWebGPUBackend()`); null => CPU composite path.
let activeBackendRef: CompositorBackend | null = null;
let lastPresentedFrame: BufferedFrame<SubframeFrame> | null = null;
let baselinePipeline = getFramePipelineStats();

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

function updateBackendVisibility() {
  canvas2d.style.display = state.backend === "cpu" ? "block" : "none";
  canvasWebgl.style.display = state.backend === "webgl" ? "block" : "none";
  canvasWebgpu.style.display = state.backend === "webgpu" ? "block" : "none";
}

function ensureWebGLBackend(): CompositorBackend | null {
  if (webglBackend) return webglBackend;
  try {
    webglBackend = createWebGLBackend({ canvas: canvasWebgl, preferWebGL2: true });
  } catch (err) {
    log(`WebGL init failed: ${err}`, "error");
    state.backend = "cpu";
    backendSelect.value = "cpu";
    updateBackendVisibility();
    webglBackend = null;
  }
  return webglBackend;
}

async function ensureWebGPUBackend(): Promise<CompositorBackend | null> {
  if (webgpuBackend) return webgpuBackend;
  if (webgpuBackendPromise) return webgpuBackendPromise;

  webgpuBackendPromise = (async () => {
    try {
      const backend = await createWebGPUBackend({ canvas: canvasWebgpu, enableGpuFilters: state.enableGpuFilters });
      backend.resize(canvasWebgpu.width, canvasWebgpu.height);
      webgpuBackend = backend;
      return backend;
    } catch (err) {
      log(`WebGPU init failed: ${err}`, "error");
      state.backend = "cpu";
      backendSelect.value = "cpu";
      updateBackendVisibility();
      webgpuBackend = null;
      return null;
    } finally {
      webgpuBackendPromise = null;
    }
  })();

  return webgpuBackendPromise;
}

async function selectDefaultBackend(): Promise<void> {
  if (defaultBackendSelected) return;
  defaultBackendSelected = true;

  state.backend = "webgpu";
  backendSelect.value = "webgpu";
  updateBackendVisibility();
  const gpu = await ensureWebGPUBackend();
  if (gpu) return;

  state.backend = "webgl";
  backendSelect.value = "webgl";
  updateBackendVisibility();
  const gl = ensureWebGLBackend();
  if (gl) return;

  state.backend = "cpu";
  backendSelect.value = "cpu";
  updateBackendVisibility();
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
  clearEventLayerCache();
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
    playbackSubframeDoc = null;
    if (playbackSubframe) {
      playbackSubframe.setDocument(result.document);
      playbackSubframeDoc = result.document;
    }
    state.prewarmed = false;
    state.prewarmPromise = null;
    resetFontCache();
    clearEventLayerCache();

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
    await prewarmRangeAtLoad();
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

async function primeLocalFonts() {
  if (!("queryLocalFonts" in window)) {
    log("No local font access; load fonts via file input for browser rendering.", "warn");
    return;
  }
  log("Indexing local fonts (lazy resolver)...");
  const index = await buildLocalFontIndex();
  if (index) {
    log(`Indexed ${index.size} local font families`);
    resetFontCache();
    if (state.document) {
      state.lastRenderTime = -1;
      renderCurrentFrame();
    }
  }
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
  state.prewarmed = false;
  state.prewarmPromise = null;
  const wrapper = canvas2d.parentElement!;
  const wrapperRect = wrapper.getBoundingClientRect();
  const applyCanvasSize = (
    canvasEl: HTMLCanvasElement,
    renderW: number,
    renderH: number,
    cssW: number,
    cssH: number,
    left: number,
    top: number,
  ) => {
    canvasEl.width = renderW;
    canvasEl.height = renderH;
    canvasEl.style.width = `${cssW}px`;
    canvasEl.style.height = `${cssH}px`;
    canvasEl.style.left = `${left}px`;
    canvasEl.style.top = `${top}px`;
  };

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

      const left = videoRect.left - wrapperRect.left;
      const top = videoRect.top - wrapperRect.top;
      applyCanvasSize(canvas2d, renderW, renderH, videoRect.width, videoRect.height, left, top);
      applyCanvasSize(canvasWebgl, renderW, renderH, videoRect.width, videoRect.height, left, top);
      applyCanvasSize(canvasWebgpu, renderW, renderH, videoRect.width, videoRect.height, left, top);
      if (webglBackend) webglBackend.resize(renderW, renderH);
      if (webgpuBackend) webgpuBackend.resize(renderW, renderH);
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

  const left = (wrapperRect.width - w) / 2;
  const top = (wrapperRect.height - h) / 2;
  applyCanvasSize(canvas2d, renderW, renderH, w, h, left, top);
  applyCanvasSize(canvasWebgl, renderW, renderH, w, h, left, top);
  applyCanvasSize(canvasWebgpu, renderW, renderH, w, h, left, top);
  if (webglBackend) webglBackend.resize(renderW, renderH);
  if (webgpuBackend) webgpuBackend.resize(renderW, renderH);
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

let frameImageData: ImageData | null = null;
let frameData: Uint8ClampedArray | null = null;
let frameW = 0;
let frameH = 0;

function getFrameBuffer(width: number, height: number): ImageData {
  if (!frameImageData || frameW !== width || frameH !== height) {
    frameImageData = ctx2d.createImageData(width, height);
    frameData = frameImageData.data;
    frameW = width;
    frameH = height;
  }
  frameData!.fill(0);
  return frameImageData;
}

function compositeLayerInto(
  layer: BitmapLayer,
  width: number,
  height: number,
  data: Uint8ClampedArray,
) {
  if (!layer.bitmap || layer.width <= 0 || layer.height <= 0) return;

  const lw = layer.width;
  const lh = layer.height;
  const stride = layer.stride;
  const src = layer.bitmap;
  const baseX = Math.round(layer.originX);
  const baseY = Math.round(layer.originY);
  const r = layer.color[0];
  const g = layer.color[1];
  const b = layer.color[2];
  const a = layer.color[3];
  const rounding = (255 * 255) / 2;

  for (let y = 0; y < lh; y++) {
    const dstY = baseY + y;
    if (dstY < 0 || dstY >= height) continue;
    const srcRow = y * stride;
    const dstRow = dstY * width * 4;
    for (let x = 0; x < lw; x++) {
      const dstX = baseX + x;
      if (dstX < 0 || dstX >= width) continue;
      const mask = src[srcRow + x];
      if (mask === 0) continue;

      const k = mask * a;
      const di = dstRow + dstX * 4;
      const dr = data[di + 0];
      const dg = data[di + 1];
      const db = data[di + 2];
      const da = data[di + 3];

      data[di + 0] = ((k * r + (255 * 255 - k) * dr + rounding) / (255 * 255)) | 0;
      data[di + 1] = ((k * g + (255 * 255 - k) * dg + rounding) / (255 * 255)) | 0;
      data[di + 2] = ((k * b + (255 * 255 - k) * db + rounding) / (255 * 255)) | 0;
      data[di + 3] = ((k * 255 + (255 * 255 - k) * da + rounding) / (255 * 255)) | 0;
    }
  }
}

function compositeLayers(layers: BitmapLayer[], width: number, height: number) {
  const imageData = getFrameBuffer(width, height);
  const data = frameData!;

  for (const layer of layers) {
    compositeLayerInto(layer, width, height, data);
  }

  // Convert from premultiplied to straight alpha for canvas.
  for (let y = 0; y < height; y++) {
    const row = y * width * 4;
    for (let x = 0; x < width; x++) {
      const idx = row + x * 4;
      const alpha = data[idx + 3];
      if (alpha) {
        const inv = Math.floor(((255 << 16) / alpha) + 1);
        const offs = 1 << 15;
        data[idx + 0] = (data[idx + 0] * inv + offs) >> 16;
        data[idx + 1] = (data[idx + 1] * inv + offs) >> 16;
        data[idx + 2] = (data[idx + 2] * inv + offs) >> 16;
      }
    }
  }

  ctx2d.globalCompositeOperation = "source-over";
  ctx2d.putImageData(imageData, 0, 0);
}

function getActiveCanvas(): HTMLCanvasElement {
  return state.backend === "cpu"
    ? canvas2d
    : state.backend === "webgl"
      ? canvasWebgl
      : canvasWebgpu;
}

async function prewarmCurrentFrame() {
  if (!state.document || state.prewarmed) return;
  if (state.prewarmPromise) return state.prewarmPromise;

  const timeMs = state.currentTime * 1000;
  const activeCanvas = getActiveCanvas();
  const width = activeCanvas.width;
  const height = activeCanvas.height;

  renderStatus.textContent = "prewarming...";
  state.prewarmPromise = prewarmFrameFromDocument(
    state.document,
    timeMs,
    width,
    height,
  )
    .catch((err) => {
      log(`Prewarm failed: ${err}`, "error");
    })
    .finally(() => {
      state.prewarmPromise = null;
      state.prewarmed = true;
    });
  return state.prewarmPromise;
}

async function prewarmRangeAtLoad() {
  if (!state.document) return;
  if (state.prewarmPromise) return state.prewarmPromise;
  const durationMs = Math.max(0, Math.round(state.duration * 1000));
  const startMs = 0;
  const endMs = Math.min(durationMs, 2000);
  const stepMs = 250;
  const activeCanvas = getActiveCanvas();
  const width = activeCanvas.width;
  const height = activeCanvas.height;

  renderStatus.textContent = "prewarming 0-2s...";
  state.prewarmPromise = (async () => {
    const attach = await attachDocument(state.document!, width, height, {
      timeMs: startMs,
      boundaryWarmupMs: 250,
    });
    log(
      `Document init: total ${attach.totalMs.toFixed(1)}ms, fonts ${attach.fontMs.toFixed(1)}ms, workers ${attach.workerMs.toFixed(1)}ms, prepare ${attach.prepareMs.toFixed(1)}ms`,
    );
    for (let t = startMs; t <= endMs; t += stepMs) {
      await prewarmFrameFromDocument(state.document!, t, width, height);
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  })()
    .catch((err) => {
      log(`Prewarm range failed: ${err}`, "error");
    })
    .finally(() => {
      state.prewarmPromise = null;
      state.prewarmed = true;
    });
  return state.prewarmPromise;
}

function computeFrameBytes(result: { layers: BitmapLayer[] }): number {
  let frameBytes = 0;
  for (const layer of result.layers) {
    if (layer.bitmap) {
      frameBytes += (layer.bitmap as Uint8Array).byteLength ?? layer.bitmap.length ?? 0;
    }
  }
  return frameBytes;
}

// Per-frame (non-pacing) perf rows shared by the single-shot render path and the
// render-ahead display loop.
function updateFrameStatsPanel(result: { layers: BitmapLayer[] }, frameBytes: number): void {
  const heapBytes = getHeapBytes();
  const mem = getMemoryStats();
  perfLayers.textContent = `${result.layers.length}`;
  perfMemory.textContent = `${formatBytes(frameBytes)} frame, caches ${formatBytes(mem.totalBytes)} (ev ${formatBytes(mem.eventLayerBytes)} + draw ${formatBytes(mem.drawingBytes)}), ${
    heapBytes ? `heap ${formatBytes(heapBytes)}` : "heap n/a"
  }`;
  const backendStats =
    state.backend === "webgl"
      ? webglBackend?.stats?.()
      : state.backend === "webgpu"
        ? webgpuBackend?.stats?.()
        : null;
  perfGpu.textContent = backendStats
    ? `draw ${backendStats.drawCalls}, uploads ${backendStats.uploads}, atlas ${backendStats.atlasPages}`
    : "-";
  const cacheStats = getEventLayerCacheStats();
  perfCache.textContent = cacheStats
    ? `${cacheStats.entries} ev, ${cacheStats.layers} layers, ${formatBytes(cacheStats.bytes)} ` +
      `(hit ${cacheStats.hits}, miss ${cacheStats.misses}, evict ${cacheStats.evictions})`
    : "-";
}

// Single-shot render + present (paused, seek, non-timer video timeupdate). Timer
// playback goes through the render-ahead player instead; this stays the reactive
// path for a still frame.
async function renderCurrentFrame() {
  if (!state.document) return;
  if (state.pendingRender) return;

  const timeMs = state.currentTime * 1000;
  if (Math.abs(timeMs - state.lastRenderTime) < 1) return;

  state.pendingRender = true;
  renderStatus.textContent = "rendering...";

  try {
    const activeCanvas = getActiveCanvas();
    const width = activeCanvas.width;
    const height = activeCanvas.height;

    const startTime = performance.now();
    const result = await renderFrame(state.document, timeMs, width, height);
    const renderMs = performance.now() - startTime;

    const compositeStart = performance.now();
    const frameBytes = computeFrameBytes(result);
    if (state.backend === "webgl") {
      const backend = ensureWebGLBackend();
      if (backend) {
        backend.render(result.layers, result.frame);
      }
      else compositeLayers(result.layers, width, height);
    } else if (state.backend === "webgpu") {
      const backend = await ensureWebGPUBackend();
      if (backend) {
        backend.render(result.layers, result.frame);
      }
      else compositeLayers(result.layers, width, height);
    } else {
      compositeLayers(result.layers, width, height);
    }
    const compositeMs = performance.now() - compositeStart;
    const totalMs = renderMs + compositeMs;

    state.lastRenderTime = timeMs;
    renderStatus.textContent = `${result.layers.length} layers (${totalMs.toFixed(1)}ms, ${state.backend})`;
    perfRender.textContent = `${renderMs.toFixed(2)} ms`;
    perfComposite.textContent = `${compositeMs.toFixed(2)} ms`;
    perfTotal.textContent = `${totalMs.toFixed(2)} ms`;
    updateFrameStatsPanel(result, frameBytes);
    pushHistory(totalMs, frameBytes);
    drawGraphs();
    releaseRenderResult(result);
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

// Resolve the compositor backend for the CURRENT selection, awaiting WebGPU init
// only the first time. Called ONCE per play start so the per-frame present path is
// synchronous (the old loop did `await ensureWebGPUBackend()` every single frame).
async function resolveActiveBackend(): Promise<CompositorBackend | null> {
  if (state.backend === "webgl") return ensureWebGLBackend();
  if (state.backend === "webgpu") return await ensureWebGPUBackend();
  return null; // cpu -> compositeLayers
}

// Present a produced frame to the active canvas. Fully synchronous: the backend was
// resolved at play start (activeBackendRef), so the display loop never awaits.
function presentBufferedFrame(frame: BufferedFrame<SubframeFrame>): void {
  const result = frame.result;
  if ((state.backend === "webgl" || state.backend === "webgpu") && activeBackendRef) {
    activeBackendRef.render(result.layers, result.frame);
  } else {
    const activeCanvas = getActiveCanvas();
    compositeLayers(result.layers, activeCanvas.width, activeCanvas.height);
  }
  const previous = lastPresentedFrame;
  lastPresentedFrame = frame;
  if (previous && previous.result !== frame.result) releaseBufferedFrame(previous);
  state.currentTime = frame.timeMs / 1000;
  state.lastRenderTime = frame.timeMs;
}

function releaseBufferedFrame(frame: BufferedFrame<SubframeFrame> | null): void {
  if (!frame) return;
  frame.result.release();
}

function clearLastPresentedFrame(): void {
  releaseBufferedFrame(lastPresentedFrame);
  lastPresentedFrame = null;
}

let statsThrottle = 0;

function onPlayerStats(s: RenderAheadStats): void {
  // Playhead + timeline advance at the steady present cadence.
  timeline.value = String((state.currentTime / state.duration) * 100);
  updateTimeDisplay();

  // Honest pacing / perceived-smoothness rows: achieved (present) fps + the
  // present-to-present interval distribution — the metric that IS perceived stutter.
  perfDisplay.textContent =
    `${s.achievedFps.toFixed(1)} fps  |  interval p50 ${s.presentIntervalP50.toFixed(1)} ` +
    `p95 ${s.presentIntervalP95.toFixed(1)} max ${s.presentIntervalMax.toFixed(1)} ms (σ ${s.presentIntervalStdev.toFixed(1)})`;
  const cadenceFps = s.refreshMs > 0 ? 1000 / (s.stride * s.refreshMs) : 0;
  perfPacing.textContent =
    `cadence ${s.stride}× refresh (~${cadenceFps.toFixed(0)} fps steady), ` +
    `buffer ${s.bufferDepth} ahead, holds ${s.holds}`;

  // Per-frame breakdown: render (p50/p95 over the window) vs composite (present).
  perfRender.textContent = `p50 ${s.renderP50.toFixed(1)} / p95 ${s.renderP95.toFixed(1)} ms`;
  perfComposite.textContent = `${s.compositeMs.toFixed(2)} ms (p50 ${s.compositeP50.toFixed(2)})`;
  perfTotal.textContent = `${(s.renderP50 + s.compositeP50).toFixed(2)} ms est`;

  // Worker-path breakdown (ring hit% vs scatter vs await) since play start.
  const fp = getFramePipelineStats();
  const bp = baselinePipeline;
  const served =
    fp.hits - bp.hits + (fp.scatterFrames - bp.scatterFrames) + (fp.scatterSingle - bp.scatterSingle);
  if (served > 0) {
    const hitPct = (100 * (fp.hits - bp.hits)) / served;
    perfPipeline.textContent =
      `ring-hit ${hitPct.toFixed(0)}% (await ${fp.ringAwaited - bp.ringAwaited}), ` +
      `scatter ${fp.scatterFrames - bp.scatterFrames}, conceded ${fp.ringConceded - bp.ringConceded}, ` +
      `~${fp.frameCpuEmaMs.toFixed(0)}ms/worker`;
  } else {
    perfPipeline.textContent = "single-thread (worker pool off — remove ?workers=0)";
  }

  // End of timeline: stop cleanly.
  if (state.currentTime >= state.duration) {
    stopPlayback();
    return;
  }

  // Per-frame rows + graph are heavier; refresh every 4th present.
  if (lastPresentedFrame && (statsThrottle++ & 3) === 0) {
    const fb = computeFrameBytes(lastPresentedFrame.result);
    updateFrameStatsPanel(lastPresentedFrame.result, fb);
    pushHistory(s.renderP50 + s.compositeMs, fb);
    drawGraphs();
    updateGpuFilterNote(s, lastPresentedFrame.result);
  }
  renderStatus.textContent = `${lastPresentedFrame ? lastPresentedFrame.result.layers.length : 0} layers, ${s.achievedFps.toFixed(0)}fps steady (${state.backend})`;
}

// Surface when the WebGPU GPU-filter path is likely PENALIZING dense tiny-blur
// content (beastars): filters ON, layers routed to the GPU, yet render p95 stays
// high. The core comment documents this exact tradeoff.
function updateGpuFilterNote(s: RenderAheadStats, result: { layers: BitmapLayer[] }): void {
  if (!perfNote) return;
  let routed = 0;
  for (const l of result.layers) if ((l as unknown as { gpuFilter?: unknown }).gpuFilter) routed++;
  if (state.backend === "webgpu" && state.enableGpuFilters && s.renderP95 > 33 && routed > 0) {
    perfNote.textContent =
      `Render p95 ${s.renderP95.toFixed(0)}ms is high with ${routed} GPU-routed layers — ` +
      `if this persists past warmup, try toggling GPU filters to compare.`;
    perfNote.style.display = "";
  } else {
    perfNote.style.display = "none";
  }
}

function ensurePlaybackSubframe(): Subframe {
  if (playbackSubframe) return playbackSubframe;
  playbackSubframe = new Subframe({
    workers: workersRequested,
    workerUrl: workersRequested ? "/worker-entry.js" : undefined,
  });
  if (state.document) {
    playbackSubframe.setDocument(state.document);
    playbackSubframeDoc = state.document;
  }
  return playbackSubframe;
}

function ensurePlayer(): RenderAheadPlayer<SubframeFrame> {
  if (player) return player;
  player = new RenderAheadPlayer<SubframeFrame>(
    {
      render: (doc, t, w, h) => {
        const sf = ensurePlaybackSubframe();
        sf.resize(w, h);
        if (playbackSubframeDoc !== doc) {
          sf.setDocument(doc);
          playbackSubframeDoc = doc;
        }
        return sf.frame(t);
      },
      present: presentBufferedFrame,
      release: releaseBufferedFrame,
      width: () => getActiveCanvas().width,
      height: () => getActiveCanvas().height,
      now: () => performance.now(),
      requestFrame: (cb) => requestAnimationFrame(cb),
      onError: (err) => log(`Render-ahead error: ${err}`, "error"),
      onStats: onPlayerStats,
    },
    { fps: 60 },
  );
  return player;
}

// Start (or restart, for seek / config change) render-ahead playback from the
// current playhead. Resolves the backend once, resets the ring so it relearns the
// fresh uniform cadence, and launches the producer + display loops.
async function startTimerPlayback(): Promise<void> {
  if (!state.document) return;
  activeBackendRef = await resolveActiveBackend();
  const sf = ensurePlaybackSubframe();
  const activeCanvas = getActiveCanvas();
  sf.resize(activeCanvas.width, activeCanvas.height);
  if (playbackSubframeDoc !== state.document) {
    sf.setDocument(state.document);
    playbackSubframeDoc = state.document;
  }
  resetFramePipeline();
  baselinePipeline = getFramePipelineStats();
  // A restart (seek while playing) replaces the player's buffer; release the
  // previous presented frame now rather than waiting for the new player's
  // first present, which may never come (end of timeline).
  clearLastPresentedFrame();
  ensurePlayer().start(state.document, state.currentTime * 1000);
}

function startPlayback() {
  state.isPlaying = true;
  playPauseBtn.textContent = "⏸";
  if (state.timerMode) {
    void startTimerPlayback();
  } else {
    video.play().catch(() => {});
  }
}

function stopPlayback() {
  state.isPlaying = false;
  playPauseBtn.textContent = "▶";
  if (player) player.stop();
  clearLastPresentedFrame();
  if (!state.timerMode) {
    video.pause();
  }
}

// Re-render after a config change (backend / gpu-filters / render-mode): restart
// the render-ahead player if playing, else refresh the single still frame.
function refreshAfterConfigChange(): void {
  if (state.isPlaying && state.timerMode) {
    void startTimerPlayback();
  } else {
    renderCurrentFrame();
  }
}

async function togglePlayPause() {
  if (state.isPlaying) {
    stopPlayback();
    return;
  }
  await prewarmCurrentFrame();
  startPlayback();
}

// Move the playhead (timeline drag / seek keys). While playing in timer mode this
// reseeds the render-ahead player at the new time (a ring discontinuity); otherwise
// it renders the single still frame.
function seekTo(time: number): void {
  state.currentTime = Math.max(0, Math.min(state.duration, time));
  timeline.value = String((state.currentTime / state.duration) * 100);
  updateTimeDisplay();
  if (state.timerMode) {
    if (state.isPlaying) {
      void startTimerPlayback();
    } else {
      renderCurrentFrame();
    }
  } else {
    video.currentTime = state.currentTime;
    renderCurrentFrame();
  }
}

function onTimelineInput() {
  const pct = parseFloat(timeline.value);
  seekTo((pct / 100) * state.duration);
}

function seekBy(delta: number) {
  seekTo(state.currentTime + delta);
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

// ---------------------------------------------------------------------------
// GPU blur self-test (stage 1 validation). Bun has no WebGPU, so this is the
// user's verification path: it runs the WGSL integer blur and the CPU libass
// blur on identical bitmaps and byte-compares them, then times both.
// ---------------------------------------------------------------------------

const SELFTEST_SIZES: Array<[number, number]> = [
  [1, 1], [5, 2], [17, 9], [40, 40], [200, 60], [500, 200], [2, 500],
];
const SELFTEST_R2 = [0.3, 1.7, 5.5, 45.568, 120];

// Same pseudo-random generator as the CPU harness (glibc LCG).
function makeTestBitmap(w: number, h: number, seed = 12345): Uint8Array {
  const a = new Uint8Array(w * h);
  let s = seed;
  for (let i = 0; i < w * h; i++) {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    a[i] = (s >> 8) & 255;
  }
  return a;
}

function percentile(sortedAsc: number[], p: number): number {
  if (sortedAsc.length === 0) return 0;
  const idx = Math.min(sortedAsc.length - 1, Math.max(0, Math.round((p / 100) * (sortedAsc.length - 1))));
  return sortedAsc[idx]!;
}

// Beastars-like frame: many small-to-medium masks with a spread of blur radii.
function makeBeastarsFrame(count: number): BatchMask[] {
  const masks: BatchMask[] = [];
  let s = 7919;
  const rnd = () => {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    return (s >>> 8) / 0x7fffff;
  };
  for (let i = 0; i < count; i++) {
    const w = 30 + Math.floor(rnd() * 170); // 30..200
    const h = 30 + Math.floor(rnd() * 50); // 30..80
    const r2 = 1.7 + rnd() * 10.3; // 1.7..12
    masks.push({ bitmap: makeTestBitmap(w, h, 1000 + i * 13), width: w, height: h, r2x: r2, r2y: r2 });
  }
  return masks;
}

async function runGpuBlurSelfTest() {
  if (!("gpu" in navigator)) {
    log("GPU self-test: navigator.gpu unavailable", "error");
    return;
  }
  const btn = $<HTMLButtonElement>("gpu-selftest-btn");
  btn.disabled = true;
  try {
    log("GPU blur self-test: requesting device...");
    const adapter = await (navigator as any).gpu.requestAdapter();
    if (!adapter) {
      log("GPU self-test: adapter request failed", "error");
      return;
    }
    const hasTimestamp = !!adapter.features?.has?.("timestamp-query");
    const device = await adapter.requestDevice(
      hasTimestamp ? { requiredFeatures: ["timestamp-query"] } : {},
    );
    log(`GPU self-test: timestamp-query ${hasTimestamp ? "available" : "unavailable"}`);
    const engine = new GpuBlurEngine();
    engine.init(device);

    let pass = 0;
    let fail = 0;
    for (const [w, h] of SELFTEST_SIZES) {
      const bmp = makeTestBitmap(w, h);
      for (const r2 of SELFTEST_R2) {
        const cpu = libassGaussianBlur(
          { buffer: bmp, width: w, rows: h, pitch: w, pixelMode: PixelMode.Gray, numGrays: 256 },
          r2,
          r2,
        );
        const gpu = await engine.blur(bmp, w, h, r2, r2);
        let ok = cpu.bitmap.width === gpu.width && cpu.bitmap.rows === gpu.rows;
        let firstDiff = -1;
        if (ok) {
          for (let i = 0; i < gpu.buffer.length; i++) {
            if (cpu.bitmap.buffer[i] !== gpu.buffer[i]) {
              ok = false;
              firstDiff = i;
              break;
            }
          }
        }
        if (ok) {
          pass++;
        } else {
          fail++;
          log(
            `FAIL ${w}x${h} r2=${r2}: cpu ${cpu.bitmap.width}x${cpu.bitmap.rows} ` +
              `gpu ${gpu.width}x${gpu.rows} firstDiff@${firstDiff}`,
            "error",
          );
        }
      }
    }
    log(
      `GPU blur self-test: ${pass} PASS, ${fail} FAIL out of ${pass + fail}`,
      fail === 0 ? "info" : "error",
    );

    // Timing comparison: N iterations on 500x200, r2 = 5.5.
    const N = 100;
    const tw = 500;
    const th = 200;
    const tr2 = 5.5;
    const tbmp = makeTestBitmap(tw, th);
    const cpuInput = {
      buffer: tbmp,
      width: tw,
      rows: th,
      pitch: tw,
      pixelMode: PixelMode.Gray,
      numGrays: 256,
    };

    let cpuStart = performance.now();
    for (let i = 0; i < N; i++) libassGaussianBlur(cpuInput, tr2, tr2);
    const cpuMs = (performance.now() - cpuStart) / N;

    // Warm up the GPU path once (pipeline/buffer allocation) before timing.
    await engine.blur(tbmp, tw, th, tr2, tr2);
    const gpuStart = performance.now();
    for (let i = 0; i < N; i++) await engine.blur(tbmp, tw, th, tr2, tr2);
    const gpuMs = (performance.now() - gpuStart) / N;

    log(
      `Timing (${tw}x${th}, r2=${tr2}, N=${N}): CPU ${cpuMs.toFixed(3)} ms/op, ` +
        `GPU ${gpuMs.toFixed(3)} ms/op (incl. readback)`,
    );

    // -----------------------------------------------------------------------
    // Stage 2: batched engine correctness (byte-identical to stage-1 GPU AND
    // CPU), run as one mixed batch across the whole case matrix.
    // -----------------------------------------------------------------------
    const batchEngine = new BatchedGpuBlurEngine();
    batchEngine.init(device);
    batchEngine.setTiming(hasTimestamp);

    const batchMasks: BatchMask[] = [];
    const batchMeta: Array<{ w: number; h: number; r2: number }> = [];
    for (const [w, h] of SELFTEST_SIZES) {
      const bmp = makeTestBitmap(w, h);
      for (const r2 of SELFTEST_R2) {
        batchMasks.push({ bitmap: bmp, width: w, height: h, r2x: r2, r2y: r2 });
        batchMeta.push({ w, h, r2 });
      }
    }
    const batchResults = await batchEngine.blurBatch(batchMasks);
    let bPass = 0;
    let bFail = 0;
    for (let i = 0; i < batchMasks.length; i++) {
      const meta = batchMeta[i]!;
      const cpu = libassGaussianBlur(
        { buffer: batchMasks[i]!.bitmap, width: meta.w, rows: meta.h, pitch: meta.w, pixelMode: PixelMode.Gray, numGrays: 256 },
        meta.r2,
        meta.r2,
      );
      const single = await engine.blur(batchMasks[i]!.bitmap, meta.w, meta.h, meta.r2, meta.r2);
      const bat = batchResults[i]!;
      let ok = bat.width === cpu.bitmap.width && bat.rows === cpu.bitmap.rows && bat.width === single.width && bat.rows === single.rows;
      if (ok) {
        for (let k = 0; k < bat.buffer.length; k++) {
          if (bat.buffer[k] !== cpu.bitmap.buffer[k] || bat.buffer[k] !== single.buffer[k]) { ok = false; break; }
        }
      }
      if (ok) bPass++;
      else { bFail++; log(`BATCH FAIL ${meta.w}x${meta.h} r2=${meta.r2}`, "error"); }
    }
    log(
      `Batched engine (vs CPU AND stage-1): ${bPass} PASS, ${bFail} FAIL out of ${bPass + bFail}`,
      bFail === 0 ? "info" : "error",
    );

    // -----------------------------------------------------------------------
    // GPU-resident filtered cache: run one Beastars-like frame twice; the
    // second pass must be all cache hits, and readback must still be correct.
    // -----------------------------------------------------------------------
    const cache = new GpuFilteredCache(device, batchEngine, { pageSize: 2048 });
    const frame = makeBeastarsFrame(40);
    const reqs = frame.map((m) => ({ bitmap: m.bitmap, width: m.width, height: m.height, r2x: m.r2x, r2y: m.r2y, key: hashMask(m.bitmap, m.r2x, m.r2y) }));

    const handles1 = await cache.request(reqs, 0);
    let cachePass = 0;
    let cacheFail = 0;
    for (let i = 0; i < frame.length; i++) {
      const h = handles1[i]!;
      const m = frame[i]!;
      const cpu = libassGaussianBlur(
        { buffer: m.bitmap, width: m.width, rows: m.height, pitch: m.width, pixelMode: PixelMode.Gray, numGrays: 256 },
        m.r2x,
        m.r2y,
      );
      const slotBytes = await cache.readSlot(h.pageIndex, h.x, h.y, h.outW, h.outH);
      let ok = h.outW === cpu.bitmap.width && h.outH === cpu.bitmap.rows;
      if (ok) for (let k = 0; k < slotBytes.length; k++) if (slotBytes[k] !== cpu.bitmap.buffer[k]) { ok = false; break; }
      if (ok) cachePass++;
      else { cacheFail++; log(`CACHE FAIL i=${i} ${m.width}x${m.height}`, "error"); }
    }
    const missesAfter1 = cache.misses;
    const handles2 = await cache.request(reqs, 1);
    const hitsFrame2 = handles2.filter((h) => h.hit).length;
    log(
      `Filtered cache: readback ${cachePass} PASS, ${cacheFail} FAIL; ` +
        `frame1 misses=${missesAfter1}, frame2 hits=${hitsFrame2}/${frame.length} (pages=${cache.pageCount})`,
      cacheFail === 0 && hitsFrame2 === frame.length ? "info" : "error",
    );

    // -----------------------------------------------------------------------
    // Throughput benchmark: CPU per-mask loop vs batched GPU, per "frame".
    // Warm up, then sample; report median / p95 / p99 (perf guardrails).
    // -----------------------------------------------------------------------
    const benchFrame = makeBeastarsFrame(40);
    const cpuInputs = benchFrame.map((m) => ({
      buffer: m.bitmap, width: m.width, rows: m.height, pitch: m.width, pixelMode: PixelMode.Gray, numGrays: 256,
    }));
    let sink = 0; // keep outputs alive to defeat DCE
    const FRAMES = 60;
    const WARM = 10;

    for (let i = 0; i < WARM; i++) {
      for (const inp of cpuInputs) sink += libassGaussianBlur(inp, benchFrame[0]!.r2x, benchFrame[0]!.r2y).bitmap.buffer[0]!;
      await batchEngine.blurBatch(benchFrame);
    }
    const cpuSamples: number[] = [];
    for (let f = 0; f < FRAMES; f++) {
      const t0 = performance.now();
      for (let i = 0; i < benchFrame.length; i++) {
        const r = libassGaussianBlur(cpuInputs[i]!, benchFrame[i]!.r2x, benchFrame[i]!.r2y);
        sink += r.bitmap.buffer[0]!;
      }
      cpuSamples.push(performance.now() - t0);
    }
    const gpuSamples: number[] = [];
    const gpuGpuSamples: number[] = [];
    for (let f = 0; f < FRAMES; f++) {
      const t0 = performance.now();
      const res = await batchEngine.blurBatch(benchFrame);
      gpuSamples.push(performance.now() - t0);
      sink += res[0]!.buffer[0]!;
      if (batchEngine.lastGpuTimeMs != null) gpuGpuSamples.push(batchEngine.lastGpuTimeMs);
    }
    cpuSamples.sort((a, b) => a - b);
    gpuSamples.sort((a, b) => a - b);
    gpuGpuSamples.sort((a, b) => a - b);
    log(
      `Throughput (${benchFrame.length} masks/frame, ${FRAMES} frames) CPU loop: ` +
        `median ${percentile(cpuSamples, 50).toFixed(2)} ms, p95 ${percentile(cpuSamples, 95).toFixed(2)}, p99 ${percentile(cpuSamples, 99).toFixed(2)}`,
    );
    log(
      `Throughput batched GPU (incl. readback): ` +
        `median ${percentile(gpuSamples, 50).toFixed(2)} ms, p95 ${percentile(gpuSamples, 95).toFixed(2)}, p99 ${percentile(gpuSamples, 99).toFixed(2)}`,
    );
    if (gpuGpuSamples.length > 0) {
      log(
        `Throughput batched GPU (GPU-side compute only, timestamp): ` +
          `median ${percentile(gpuGpuSamples, 50).toFixed(3)} ms, p95 ${percentile(gpuGpuSamples, 95).toFixed(3)}, p99 ${percentile(gpuGpuSamples, 99).toFixed(3)}`,
      );
    } else {
      log("Throughput GPU-side timing unavailable (no timestamp-query feature).");
    }
    log(`(bench sink=${sink.toFixed(0)})`);

    cache.dispose();
    batchEngine.dispose();
    engine.dispose();
    device.destroy?.();
  } catch (err) {
    log(`GPU self-test error: ${err}`, "error");
  } finally {
    btn.disabled = false;
  }
}

// ---------------------------------------------------------------------------
// Backend compare self-test (Task 2 acceptance test). Renders N frames of the
// loaded subtitles through the core once each, then composites the same layers
// two ways -- the CPU reference compositor into an ImageData, and the selected
// GPU backend into its canvas (read back via a 2D canvas) -- and compares them
// per frame. A correct GPU compositor matches within a couple LSB (float vs
// integer blend); a real corruption (e.g. atlas VRAM exhaustion producing black
// blobs) shows max diff ~255 over thousands of pixels.
// ---------------------------------------------------------------------------

let backendCompareReadback: { canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D } | null = null;
function getReadbackCtx(width: number, height: number): CanvasRenderingContext2D {
  if (!backendCompareReadback) {
    const c = document.createElement("canvas");
    backendCompareReadback = { canvas: c, ctx: c.getContext("2d", { willReadFrequently: true })! };
  }
  const rb = backendCompareReadback;
  if (rb.canvas.width !== width || rb.canvas.height !== height) {
    rb.canvas.width = width;
    rb.canvas.height = height;
  }
  return rb.ctx;
}

// CPU reference: straight-alpha RGBA, same premultiplied-over math as the
// canvas 2D path (compositeLayers), returned as a buffer instead of drawn.
function cpuReferenceComposite(layers: BitmapLayer[], width: number, height: number): Uint8ClampedArray {
  const data = new Uint8ClampedArray(width * height * 4);
  for (const layer of layers) compositeLayerInto(layer, width, height, data);
  for (let y = 0; y < height; y++) {
    const row = y * width * 4;
    for (let x = 0; x < width; x++) {
      const idx = row + x * 4;
      const alpha = data[idx + 3]!;
      if (alpha) {
        const inv = Math.floor((255 << 16) / alpha + 1);
        const offs = 1 << 15;
        data[idx + 0] = (data[idx + 0]! * inv + offs) >> 16;
        data[idx + 1] = (data[idx + 1]! * inv + offs) >> 16;
        data[idx + 2] = (data[idx + 2]! * inv + offs) >> 16;
      }
    }
  }
  return data;
}

async function runBackendCompareSelfTest() {
  const btn = $<HTMLButtonElement>("backend-compare-btn");
  if (!state.document) {
    log("Backend compare: load a subtitle file first", "error");
    return;
  }
  // Pick the GPU backend to verify (prefer WebGPU, then WebGL).
  let backend: CompositorBackend | null = null;
  let backendCanvas: HTMLCanvasElement | null = null;
  const gpu = await ensureWebGPUBackend();
  if (gpu) { backend = gpu; backendCanvas = canvasWebgpu; }
  else { const gl = ensureWebGLBackend(); if (gl) { backend = gl; backendCanvas = canvasWebgl; } }
  if (!backend || !backendCanvas) {
    log("Backend compare: no GPU backend available (WebGPU/WebGL both failed)", "error");
    return;
  }

  btn.disabled = true;
  const wasPlaying = state.isPlaying;
  if (wasPlaying) stopPlayback();
  try {
    const width = backendCanvas.width;
    const height = backendCanvas.height;
    backend.resize(width, height);
    const rb = getReadbackCtx(width, height);

    // N frames stepping forward from the current playhead: exercises the
    // animated-content churn that stresses the atlas allocator.
    const N = 40;
    const stepMs = Math.round(1000 / 24);
    const startMs = Math.round(state.currentTime * 1000);
    const TOL = 2; // float(GPU) vs integer(CPU) blend differ by a couple LSB

    log(`Backend compare (${backend.kind}): ${N} frames @ ${width}x${height} from t=${startMs}ms, tol=${TOL}`);
    let worstMax = 0;
    let worstFrame = -1;
    let passes = 0;
    for (let i = 0; i < N; i++) {
      const t = startMs + i * stepMs;
      const result = await renderFrame(state.document, t, width, height);

      // (b) GPU backend -> its canvas -> read back straight-alpha RGBA.
      backend.render(result.layers, result.frame);
      rb.clearRect(0, 0, width, height);
      rb.drawImage(backendCanvas, 0, 0);
      const gpuData = rb.getImageData(0, 0, width, height).data;

      // (a) CPU reference.
      const cpuData = cpuReferenceComposite(result.layers, width, height);

      let max = 0;
      let diffPx = 0;
      for (let p = 0; p < cpuData.length; p += 4) {
        const dr = Math.abs(cpuData[p]! - gpuData[p]!);
        const dg = Math.abs(cpuData[p + 1]! - gpuData[p + 1]!);
        const db = Math.abs(cpuData[p + 2]! - gpuData[p + 2]!);
        const da = Math.abs(cpuData[p + 3]! - gpuData[p + 3]!);
        const d = Math.max(dr, dg, db, da);
        if (d > max) max = d;
        if (d > TOL) diffPx++;
      }
      if (max > worstMax) { worstMax = max; worstFrame = i; }
      const pass = max <= TOL;
      if (pass) passes++;
      const stats = backend.stats?.();
      log(
        `  frame ${String(i).padStart(2)} t=${t} layers=${result.layers.length} ` +
          `atlas=${stats?.atlasPages ?? "?"} maxDiff=${max} diffPx=${diffPx} ${pass ? "PASS" : "FAIL"}`,
        pass ? "info" : "error",
      );
    }
    const allPass = passes === N;
    log(
      `Backend compare: ${passes}/${N} PASS, worst maxDiff=${worstMax} @frame ${worstFrame} ` +
        `=> ${allPass ? "COMPOSITOR OK" : "COMPOSITOR MISMATCH"}`,
      allPass ? "info" : "error",
    );
  } catch (err) {
    log(`Backend compare error: ${err}`, "error");
  } finally {
    btn.disabled = false;
    state.lastRenderTime = -1;
    renderCurrentFrame();
    if (wasPlaying) startPlayback();
  }
}

// GPU Filter Full-Frame Test (OFF==ON). Renders the same frame(s) twice through
// one filter-enabled WebGPU backend: once with the GPU filter provider OFF (core
// runs the CPU blur/outline/shadow path, backend uploads finished masks) and once
// with it ON (core defers those pixel ops; backend produces them on the GPU with
// no readback). Both canvases are read back and byte-compared with tolerance 0 --
// a GPU-integer filter that is bit-exact to the CPU path yields an identical
// frame. Reports PASS/FAIL, per-frame ms each way, and GPU-routed/total layers.
// Built-in case: a bordered blurred line (routes to CPU -- bordered glyphs are
// not GPU-eligible, so it is an OFF==ON control that must stay identical) plus
// no-border blurred lines (route to the GPU: a static one through the combined
// path and a \t\frz-rotated one through the per-glyph transform path).
const GPU_FRZ_CASE = `[Script Info]
PlayResX: 1920
PlayResY: 1080
[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Def,Arial,72,&H00FFFFFF,&H000000FF,&H0000CC00,&H00000000,0,0,0,0,100,100,0,0,1,4,3,5,10,10,10,1
[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
Dialogue: 0,0:00:00.00,0:00:10.00,Def,,0,0,0,,{\\blur5\\an5\\pos(960,300)}Bordered control (CPU)
Dialogue: 0,0:00:00.00,0:00:10.00,Def,,0,0,0,,{\\blur2\\bord0\\shad0\\an5\\pos(960,540)}No border blurred (GPU)
Dialogue: 0,0:00:00.00,0:00:10.00,Def,,0,0,0,,{\\blur3\\bord0\\shad0\\an5\\pos(960,760)\\t(0,4000,\\frz360)}Rotating no-border blur (GPU)
`;

// Pick the timestamp at which the most events are simultaneously active, so the
// full-frame test renders a non-empty frame (avoids a vacuous 0-layer pass).
function densestActiveTimeMs(doc: SubtitleDocument): number {
  const events = doc.events ?? [];
  let bestT = 0;
  let bestCount = -1;
  for (const cand of events) {
    const t = cand.start ?? 0;
    let count = 0;
    for (const e of events) {
      const s = e.start ?? 0;
      const en = e.end ?? 0;
      if (s <= t && t < en) count++;
    }
    if (count > bestCount) { bestCount = count; bestT = t; }
  }
  return bestT;
}

async function runGpuFilterFullFrameTest() {
  const btn = document.getElementById("gpu-fullframe-btn") as HTMLButtonElement | null;
  if (!("gpu" in navigator)) {
    log("GPU filter full-frame test: navigator.gpu unavailable", "error");
    return;
  }
  if (btn) btn.disabled = true;
  const wasPlaying = state.isPlaying;
  if (wasPlaying) stopPlayback();

  const width = 1920;
  const height = 1080;
  let testCanvas: HTMLCanvasElement | null = null;
  let backend: CompositorBackend | null = null;
  const savedProvider = getGpuFilterProvider();
  try {
    testCanvas = document.createElement("canvas");
    testCanvas.width = width;
    testCanvas.height = height;
    // Filter-enabled backend; its constructor registers the GPU filter provider.
    backend = await createWebGPUBackend({ canvas: testCanvas, enableGpuFilters: true });
    const onProvider = getGpuFilterProvider();
    if (!onProvider) {
      log("GPU filter full-frame test: provider did not register (GPU filters unavailable)", "error");
      return;
    }
    backend.resize(width, height);
    const rb = getReadbackCtx(width, height);

    const readCanvas = (): Uint8ClampedArray => {
      rb.clearRect(0, 0, width, height);
      rb.drawImage(testCanvas!, 0, 0);
      return rb.getImageData(0, 0, width, height).data;
    };

    type Case = { name: string; doc: SubtitleDocument; timeMs: number };
    const cases: Case[] = [];
    if (state.document) {
      const t = densestActiveTimeMs(state.document);
      cases.push({ name: `loaded @${t}ms (densest)`, doc: state.document, timeMs: t });
    }
    cases.push({ name: "\\t\\frz rotation @2000ms", doc: parseASS(GPU_FRZ_CASE, { onError: "collect", strict: false, preserveOrder: true }).document, timeMs: 2000 });

    log(`GPU filter full-frame test @ ${width}x${height}, tol=0`);
    let allPass = true;
    for (const c of cases) {
      // ON pass first so the OFF pass cannot reuse ON's blurred raster caches.
      clearEventLayerCache();
      clearRasterCaches();
      setGpuFilterProvider(onProvider);
      const tOn0 = performance.now();
      const rOn = await renderFrame(c.doc, c.timeMs, width, height);
      const onMs = performance.now() - tOn0;
      backend.render(rOn.layers, rOn.frame);
      const onData = readCanvas();
      const routed = rOn.layers.reduce((n, l) => n + (l.gpuFilter ? 1 : 0), 0);

      clearEventLayerCache();
      clearRasterCaches();
      setGpuFilterProvider(null);
      const tOff0 = performance.now();
      const rOff = await renderFrame(c.doc, c.timeMs, width, height);
      const offMs = performance.now() - tOff0;
      backend.render(rOff.layers, rOff.frame);
      const offData = readCanvas();

      let maxDiff = 0;
      let diffPx = 0;
      for (let p = 0; p < offData.length; p += 4) {
        const d = Math.max(
          Math.abs(offData[p]! - onData[p]!),
          Math.abs(offData[p + 1]! - onData[p + 1]!),
          Math.abs(offData[p + 2]! - onData[p + 2]!),
          Math.abs(offData[p + 3]! - onData[p + 3]!),
        );
        if (d > maxDiff) maxDiff = d;
        if (d > 0) diffPx++;
      }
      const pass = maxDiff === 0 && rOn.layers.length === rOff.layers.length;
      if (!pass) allPass = false;
      log(
        `  ${c.name}: ${pass ? "PASS" : "FAIL"} maxDiff=${maxDiff} diffPx=${diffPx} ` +
          `layers OFF=${rOff.layers.length} ON=${rOn.layers.length} gpuRouted=${routed} ` +
          `ms ON=${onMs.toFixed(1)} OFF=${offMs.toFixed(1)}`,
        pass ? "info" : "error",
      );
    }
    log(
      `GPU filter full-frame test: ${allPass ? "PASS (GPU == CPU, byte-exact)" : "FAIL"}`,
      allPass ? "info" : "error",
    );
  } catch (err) {
    log(`GPU filter full-frame test error: ${err}`, "error");
  } finally {
    // dispose() unregisters the provider, so restore the app's saved one after.
    backend?.dispose?.();
    setGpuFilterProvider(savedProvider);
    if (btn) btn.disabled = false;
    state.lastRenderTime = -1;
    renderCurrentFrame();
    if (wasPlaying) startPlayback();
  }
}

function init() {
  renderModeToggle.checked = state.renderAtPlayRes;
  gpuFiltersToggle.checked = state.enableGpuFilters;
  backendSelect.value = state.backend;
  updateBackendVisibility();

  // Worker pool bootstrap: DEFAULT ON (?workers=0 opts out). The old opt-in
  // rationale — unbounded per-worker glyph memory OOMing the tab on dense
  // scripts — is gone: worker caches, arena freelists, and scratch pools are
  // byte-bounded end-to-end (beastars steady heap ~106MB with 8 workers), and
  // the boundary/ring machinery that carries realtime playback needs the pool.
  workersRequested = new URLSearchParams(location.search).get("workers") !== "0";
  if (workersRequested) {
    void (async () => {
      try {
        const res = await fetch("/worker-entry.js", { method: "HEAD" });
        if (res.ok) {
          setWorkerSource("/worker-entry.js");
          log("Worker pool source: /worker-entry.js");
        } else {
          log("Worker pool: /worker-entry.js not served; inline prewarm only", "warn");
        }
      } catch {
        log("Worker pool: /worker-entry.js probe failed; inline prewarm only", "warn");
      }
    })();
  } else {
    log("Worker pool off (?workers=0); inline prewarm only");
  }
  setFontResolver(async (fontName) => {
    const index = await buildLocalFontIndex();
    if (!index) return null;
    const cleanedName = sanitizeFontName(fontName);
    const key = cleanedName.toLowerCase();
    const entry = resolveBestLocalFontEntry(cleanedName, index);
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
    refreshAfterConfigChange();
  });
  on(backendSelect, "change", () => {
    const value = backendSelect.value;
    if (value === "webgl" || value === "webgpu" || value === "cpu") {
      state.backend = value;
    } else {
      state.backend = "cpu";
    }
    updateBackendVisibility();
    if (state.backend === "webgl") ensureWebGLBackend();
    if (state.backend === "webgpu") void ensureWebGPUBackend();
    // Drop the cached present backend so the next play/refresh re-resolves it.
    activeBackendRef = null;
    state.lastRenderTime = -1;
    resizeCanvas();
    state.prewarmed = false;
    state.prewarmPromise = null;
    refreshAfterConfigChange();
  });
  on(gpuFiltersToggle, "change", () => {
    // Toggling GPU filters changes what the WebGPU backend routes to the GPU
    // filter path, so tear down and recreate it and drop the raster caches
    // (blur/outline eligibility differs between the two paths).
    state.enableGpuFilters = gpuFiltersToggle.checked;
    webgpuBackend?.dispose?.();
    webgpuBackend = null;
    webgpuBackendPromise = null;
    activeBackendRef = null;
    clearEventLayerCache();
    clearRasterCaches();
    if (state.backend === "webgpu") void ensureWebGPUBackend();
    state.lastRenderTime = -1;
    state.prewarmed = false;
    state.prewarmPromise = null;
    refreshAfterConfigChange();
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

  const selftestSection = document.getElementById("gpu-selftest-section");
  const selftestBtn = document.getElementById("gpu-selftest-btn") as HTMLButtonElement | null;
  if (selftestSection && selftestBtn && "gpu" in navigator) {
    selftestSection.style.display = "";
    on(selftestBtn, "click", () => void runGpuBlurSelfTest());
  }

  const backendCompareBtn = document.getElementById("backend-compare-btn") as HTMLButtonElement | null;
  if (backendCompareBtn) {
    on(backendCompareBtn, "click", () => void runBackendCompareSelfTest());
  }

  const gpuFullframeBtn = document.getElementById("gpu-fullframe-btn") as HTMLButtonElement | null;
  if (gpuFullframeBtn && "gpu" in navigator) {
    gpuFullframeBtn.style.display = "";
    on(gpuFullframeBtn, "click", () => void runGpuFilterFullFrameTest());
  }

  on(window, "resize", resizeCanvas);
  on(document, "keydown", onKeyDown as EventListener);

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
  void selectDefaultBackend().then(() => {
    state.lastRenderTime = -1;
    resizeCanvas();
    state.prewarmed = false;
    state.prewarmPromise = null;
    renderCurrentFrame();
  });

  const cleanupFn = () => {
    if (player) {
      player.stop();
      player = null;
    }
    if (playbackSubframe) {
      playbackSubframe.dispose();
      playbackSubframe = null;
      playbackSubframeDoc = null;
    }
    clearLastPresentedFrame();
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
