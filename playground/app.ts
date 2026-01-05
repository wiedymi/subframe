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
};

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

const video = $<HTMLVideoElement>("video");
const canvas = $<HTMLCanvasElement>("subtitle-canvas");
const ctx = canvas.getContext("2d")!;
const playPauseBtn = $<HTMLButtonElement>("play-pause");
const timeline = $<HTMLInputElement>("timeline");
const timeDisplay = $<HTMLSpanElement>("time-display");
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

function log(msg: string, level: "info" | "warn" | "error" = "info") {
  const time = new Date().toISOString().slice(11, 23);
  const line = document.createElement("div");
  line.className = level;
  line.textContent = `[${time}] ${msg}`;
  logEl.appendChild(line);
  logEl.scrollTop = logEl.scrollHeight;
  if (level === "error") console.error(msg);
}

function formatTime(seconds: number): string {
  const mins = Math.floor(seconds / 60);
  const secs = seconds % 60;
  return `${mins.toString().padStart(2, "0")}:${secs.toFixed(3).padStart(6, "0")}`;
}

function updateTimeDisplay() {
  timeDisplay.textContent = `${formatTime(state.currentTime)} / ${formatTime(state.duration)}`;
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
    registerFontSource(baseName, buffer);
    addLoadedFont(baseName, "file");
    log(`Font registered: ${baseName}`);
  } catch (err) {
    log(`Failed to load font ${file.name}: ${err}`, "error");
  }
}

type LocalFontData = {
  family: string;
  fullName?: string;
  style?: string;
  blob: () => Promise<Blob>;
};

let localFontIndex: Map<string, LocalFontData> | null = null;
let localFontIndexPromise: Promise<Map<string, LocalFontData> | null> | null = null;

async function buildLocalFontIndex(): Promise<Map<string, LocalFontData> | null> {
  if (!("queryLocalFonts" in window)) return null;
  if (localFontIndex) return localFontIndex;
  if (localFontIndexPromise) return localFontIndexPromise;
  localFontIndexPromise = (async () => {
    try {
      log("Indexing local fonts (lazy resolver)...");
      const fonts = await (window as any).queryLocalFonts();
      const index = new Map<string, LocalFontData>();
      for (const fontData of fonts as LocalFontData[]) {
        const family = fontData.family;
        if (!family) continue;
        const key = family.toLowerCase();
        if (!index.has(key)) index.set(key, fontData);
      }
      log(`Indexed ${index.size} local font families`);
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
  if (state.loadedFonts.length > 0) return;
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
    const fonts = await (window as any).queryLocalFonts();
    log(`Found ${fonts.length} local fonts`);

    const seen = new Set<string>();
    let loadedCount = 0;

    for (const fontData of fonts as LocalFontData[]) {
      const family = fontData.family;
      if (seen.has(family)) continue;
      seen.add(family);

      try {
        const blob = await fontData.blob();
        const buffer = await blob.arrayBuffer();
        registerFontSource(family, buffer);
        addLoadedFont(family, "system");
        loadedCount++;
      } catch {
        // Skip fonts that fail to load
      }
    }

    log(`Loaded ${loadedCount} unique font families`);
  } catch (err) {
    log(`Failed to query local fonts: ${err}`, "error");
  }
}

function getCanvasSize(): { width: number; height: number } {
  if (!state.timerMode && video.videoWidth > 0) {
    return { width: video.videoWidth, height: video.videoHeight };
  }
  const doc = state.document;
  const width = doc?.info?.playResX ?? 1920;
  const height = doc?.info?.playResY ?? 1080;
  return { width, height };
}

function resizeCanvas() {
  const rect = canvas.parentElement!.getBoundingClientRect();
  const { width: canvasW, height: canvasH } = getCanvasSize();
  const videoAspect = canvasW / canvasH;
  const containerAspect = rect.width / rect.height;

  let w: number, h: number;
  if (containerAspect > videoAspect) {
    h = rect.height;
    w = h * videoAspect;
  } else {
    w = rect.width;
    h = w / videoAspect;
  }

  const dpr = window.devicePixelRatio || 1;
  const renderW = Math.max(1, Math.round(w * dpr));
  const renderH = Math.max(1, Math.round(h * dpr));

  canvas.width = renderW;
  canvas.height = renderH;
  canvas.style.width = `${w}px`;
  canvas.style.height = `${h}px`;
  canvas.style.left = `${(rect.width - w) / 2}px`;
  canvas.style.top = `${(rect.height - h) / 2}px`;
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
    const elapsed = performance.now() - startTime;

    for (const layer of result.layers) {
      compositeLayer(layer);
    }

    state.lastRenderTime = timeMs;
    renderStatus.textContent = `${result.layers.length} layers (${elapsed.toFixed(1)}ms)`;
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
  setFontResolver(async (fontName) => {
    const index = localFontIndex;
    if (!index) return null;
    const entry = index.get(fontName.toLowerCase());
    if (!entry) return null;
    const buffer = await (await entry.blob()).arrayBuffer();
    registerFontSource(entry.family, buffer);
    addLoadedFont(entry.family, "system");
    return buffer;
  });

  video.addEventListener("timeupdate", onVideoTimeUpdate);
  video.addEventListener("loadedmetadata", onVideoLoadedMetadata);
  video.addEventListener("play", () => {
    if (!state.timerMode) {
      state.isPlaying = true;
      playPauseBtn.textContent = "⏸";
    }
  });
  video.addEventListener("pause", () => {
    if (!state.timerMode) {
      state.isPlaying = false;
      playPauseBtn.textContent = "▶";
    }
  });

  playPauseBtn.addEventListener("click", togglePlayPause);
  timeline.addEventListener("input", onTimelineInput);

  videoInput.addEventListener("change", () => {
    if (videoInput.files?.[0]) loadVideo(videoInput.files[0]);
  });

  subtitleInput.addEventListener("change", () => {
    if (subtitleInput.files?.[0]) loadSubtitle(subtitleInput.files[0]);
  });

  fontInput.addEventListener("change", () => {
    if (fontInput.files) {
      for (const file of fontInput.files) {
        loadFontFile(file);
      }
    }
  });

  localFontsBtn.addEventListener("click", queryLocalFonts);

  window.addEventListener("resize", resizeCanvas);
  document.addEventListener("keydown", onKeyDown);

  resizeCanvas();
  updateTimeDisplay();
  log("Playground initialized (timer mode - no video required)");
}

init();
