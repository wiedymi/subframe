import type { SubtitleDocument, SubtitleEvent } from "subforge/core";
import type { BitmapLayer, FrameContext } from "./core/data/types";
import type { CompositorBackend, CompositorStats } from "./backend/types";
import { createWebGPUBackend } from "./backend/webgpu";
import { createWebGLBackend } from "./backend/webgl";
import {
  attachDocument,
  getEventLayerCacheStats,
  getFramePipelineStats,
  releaseRenderResult,
  renderFrame,
  setWorkerPool,
  setWorkerSource,
  type RenderResult,
} from "./core/pipeline";
import { getMemoryStats } from "./core/memory";
import { getWorkerPoolStats } from "./core/worker-pool";
import {
  registerFontSource,
  setFontResolver,
  type FontSource,
} from "./io/fonts/cache";
import {
  decodeAssEmbeddedFont,
  fontInputToBytes,
  registerFontBytesByOwnNames,
  type SubframeFontInput,
} from "./io/fonts/sources";
import {
  getLocalFontStats,
  resolveLocalFontBuffer,
} from "./io/fonts/local-access";
import {
  RenderAheadPlayer,
  type BufferedFrame,
  type RenderAheadStats,
} from "./player/render-ahead";
import { INLINED_WORKER_CODE } from "./generated/worker-inline";

export type SubframeBackend = "auto" | "webgpu" | "webgl";

export type SubframeOptions = {
  canvas?: HTMLCanvasElement;
  backend?: SubframeBackend;
  fonts?:
    | SubframeFontInput[]
    | Record<string, ArrayBuffer | Uint8Array | string>;
  fontResolver?: (name: string) => Promise<ArrayBuffer | null>;
  workers?: boolean;
  workerUrl?: string;
};

export type SubframeFrame = {
  layers: BitmapLayer[];
  frame: FrameContext;
  activeEvents: SubtitleEvent[];
  release(): void;
};

type InternalFrame = SubframeFrame & {
  result: RenderResult;
};

export type SubframeStats = {
  backend: CompositorBackend["kind"] | "cpu" | "headless";
  backendStats: CompositorStats | null;
  player: RenderAheadStats | null;
  pipeline: ReturnType<typeof getFramePipelineStats>;
  workerPool: ReturnType<typeof getWorkerPoolStats>;
  eventLayerCache: ReturnType<typeof getEventLayerCacheStats>;
  memory: ReturnType<typeof getMemoryStats>;
  fonts: {
    local: number;
    embedded: number;
    provided: number;
    resolver: number;
    misses: number;
    parseFailures: number;
    embeddedFonts: number;
    providedFonts: number;
    localAccess: ReturnType<typeof getLocalFontStats>;
  };
  width: number | undefined;
  height: number | undefined;
  hasDocument: boolean;
};

let liveInstance: Subframe | null = null;

function hasDom(): boolean {
  return typeof window !== "undefined" && typeof document !== "undefined";
}

function nowMs(): number {
  return typeof performance !== "undefined" ? performance.now() : Date.now();
}

function requestDisplayFrame(cb: (ts: number) => void): void {
  if (typeof requestAnimationFrame === "function") {
    requestAnimationFrame(cb);
  } else {
    setTimeout(() => cb(nowMs()), 16);
  }
}

function makeInlineWorkerFactory(code: string): () => Worker {
  let url: string | null = null;
  return () => {
    if (url === null) {
      const blob = new Blob([code], { type: "text/javascript" });
      url = URL.createObjectURL(blob);
    }
    return new Worker(url, { type: "module" });
  };
}

function isVideoElement(value: unknown): value is HTMLVideoElement {
  return (
    hasDom() &&
    typeof HTMLVideoElement !== "undefined" &&
    value instanceof HTMLVideoElement
  );
}

export class Subframe {
  readonly ready: Promise<void>;

  private readonly options: SubframeOptions;
  private readonly canvas: HTMLCanvasElement | null;
  private backend: CompositorBackend | null = null;
  private backendKind: SubframeStats["backend"] = "headless";
  private ctx2d: CanvasRenderingContext2D | null = null;
  private frameImageData: ImageData | null = null;
  private frameData: Uint8ClampedArray | null = null;
  private frameW = 0;
  private frameH = 0;
  private widthValue: number | undefined;
  private heightValue: number | undefined;

  private doc: SubtitleDocument | null = null;
  private docSeq = 0;
  private attachPromise: Promise<void> = Promise.resolve();
  private lastAttachStats: Awaited<ReturnType<typeof attachDocument>> | null = null;

  private player: RenderAheadPlayer<InternalFrame> | null = null;
  private video: HTMLVideoElement | null = null;
  private videoCleanup: Array<() => void> = [];
  private lastPresentedFrame: InternalFrame | null = null;
  private disposed = false;
  private installedWorkerSource = false;
  private installedFontResolver = false;
  private embeddedFonts = new Map<string, ArrayBuffer>();
  private providedFonts = new Map<string, ArrayBuffer>();
  private fontStats = {
    local: 0,
    embedded: 0,
    provided: 0,
    resolver: 0,
    misses: 0,
    parseFailures: 0,
    embeddedFonts: 0,
    providedFonts: 0,
  };

  constructor(options: SubframeOptions = {}) {
    if (liveInstance) {
      throw new Error("one Subframe instance per page for now");
    }
    liveInstance = this;
    this.options = options;
    this.canvas = options.canvas ?? null;
    if (this.canvas) {
      this.widthValue = this.canvas.width || undefined;
      this.heightValue = this.canvas.height || undefined;
    }
    this.ready = this.init();
  }

  setDocument(doc: SubtitleDocument): void {
    this.assertLive();
    this.doc = doc;
    const seq = ++this.docSeq;
    this.attachPromise = this.ready.then(async () => {
      if (this.disposed || this.doc !== doc || this.docSeq !== seq) return;
      await this.registerEmbeddedDocumentFonts(doc);
      if (this.disposed || this.doc !== doc || this.docSeq !== seq) return;
      this.lastAttachStats = await attachDocument(
        doc,
        this.widthValue,
        this.heightValue,
        { playbackFps: 60 },
      );
      if (this.video && !this.video.paused) this.startVideoPlayback();
    });
  }

  attachVideo(video: HTMLVideoElement): void {
    this.assertLive();
    if (!hasDom() || !isVideoElement(video)) {
      throw new Error("Subframe.attachVideo requires a browser HTMLVideoElement");
    }
    if (!this.canvas) {
      throw new Error("Subframe.attachVideo requires a canvas-backed Subframe");
    }
    this.detachVideo();
    this.video = video;
    const onPlay = () => this.startVideoPlayback();
    const onPause = () => this.stopPlayer();
    const onSeeked = () => {
      if (!video.paused) this.startVideoPlayback();
      else void this.render(video.currentTime * 1000);
    };
    video.addEventListener("play", onPlay);
    video.addEventListener("pause", onPause);
    video.addEventListener("seeked", onSeeked);
    this.videoCleanup = [
      () => video.removeEventListener("play", onPlay),
      () => video.removeEventListener("pause", onPause),
      () => video.removeEventListener("seeked", onSeeked),
    ];
    if (!video.paused) this.startVideoPlayback();
  }

  detachVideo(): void {
    this.stopPlayer();
    for (let i = 0; i < this.videoCleanup.length; i++) this.videoCleanup[i]!();
    this.videoCleanup.length = 0;
    this.video = null;
  }

  async render(timeMs: number): Promise<void> {
    this.assertLive();
    if (!this.canvas) throw new Error("Subframe.render requires a canvas");
    const frame = await this.frame(timeMs);
    this.presentFrame(frame);
  }

  async frame(timeMs: number): Promise<SubframeFrame> {
    this.assertLive();
    await this.ready;
    await this.attachPromise;
    if (!this.doc) throw new Error("Subframe.frame requires setDocument() first");
    const result = await renderFrame(
      this.doc,
      timeMs,
      this.widthValue,
      this.heightValue,
    );
    return this.wrapResult(result);
  }

  resize(width: number, height: number): void {
    this.assertLive();
    const w = Math.max(1, Math.round(width));
    const h = Math.max(1, Math.round(height));
    this.widthValue = w;
    this.heightValue = h;
    if (this.canvas) {
      if (this.canvas.width !== w) this.canvas.width = w;
      if (this.canvas.height !== h) this.canvas.height = h;
    }
    this.backend?.resize(w, h);
  }

  stats(): SubframeStats {
    return {
      backend: this.backendKind,
      backendStats: this.backend?.stats?.() ?? null,
      player: this.player?.stats() ?? null,
      pipeline: getFramePipelineStats(),
      workerPool: getWorkerPoolStats(),
      eventLayerCache: getEventLayerCacheStats(),
      memory: getMemoryStats(),
      fonts: {
        ...this.fontStats,
        localAccess: getLocalFontStats(),
      },
      width: this.widthValue,
      height: this.heightValue,
      hasDocument: this.doc !== null,
    };
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.detachVideo();
    this.releaseLastPresented();
    try {
      this.backend?.dispose();
    } catch {
      /* ignore */
    }
    this.backend = null;
    this.backendKind = "headless";
    if (this.installedFontResolver) setFontResolver(null);
    if (this.installedWorkerSource) setWorkerSource(null);
    setWorkerPool(false);
    if (liveInstance === this) liveInstance = null;
  }

  private async init(): Promise<void> {
    try {
      await this.installFonts();
      this.installWorkers();
      if (this.canvas) await this.initBackend();
    } catch (err) {
      if (liveInstance === this) liveInstance = null;
      throw err;
    }
  }

  private async installFonts(): Promise<void> {
    this.installFontResolver();
    const fonts = this.options.fonts;
    if (Array.isArray(fonts)) {
      for (let i = 0; i < fonts.length; i++) {
        try {
          const bytes = await fontInputToBytes(fonts[i]!);
          const info = await registerFontBytesByOwnNames(bytes, "provided");
          this.indexFontNames(this.providedFonts, info.names, info.bytes);
          this.fontStats.providedFonts++;
        } catch (err) {
          this.fontStats.parseFailures++;
          console.warn("[subframe] skipped unparseable provided font", err);
        }
      }
    } else if (fonts) {
      for (const name of Object.keys(fonts)) {
        registerFontSource(name, fonts[name]! as FontSource);
      }
    }
  }

  private installFontResolver(): void {
    setFontResolver(async (name) => {
      const local = await resolveLocalFontBuffer(name);
      if (local) {
        this.fontStats.local++;
        registerFontSource(name, local);
        return local;
      }
      const key = name.toLowerCase();
      const embedded = this.embeddedFonts.get(key);
      if (embedded) {
        this.fontStats.embedded++;
        return embedded;
      }
      const provided = this.providedFonts.get(key);
      if (provided) {
        this.fontStats.provided++;
        return provided;
      }
      if (this.options.fontResolver) {
        const resolved = await this.options.fontResolver(name);
        if (resolved) {
          this.fontStats.resolver++;
          return resolved;
        }
      }
      this.fontStats.misses++;
      return null;
    }, { beforeRegistered: true });
    this.installedFontResolver = true;
  }

  private indexFontNames(target: Map<string, ArrayBuffer>, names: string[], bytes: ArrayBuffer): void {
    for (let i = 0; i < names.length; i++) target.set(names[i]!.toLowerCase(), bytes);
  }

  private async registerEmbeddedDocumentFonts(doc: SubtitleDocument): Promise<void> {
    const fonts = (doc as SubtitleDocument & { fonts?: Array<{ name: string; data: string }> }).fonts;
    if (!fonts || fonts.length === 0) return;
    this.embeddedFonts.clear();
    this.fontStats.embeddedFonts = 0;
    for (let i = 0; i < fonts.length; i++) {
      const embedded = fonts[i]!;
      try {
        const decoded = decodeAssEmbeddedFont(embedded.data);
        const bytes = decoded.buffer.slice(decoded.byteOffset, decoded.byteOffset + decoded.byteLength);
        const info = await registerFontBytesByOwnNames(bytes, "embedded", embedded.name);
        this.indexFontNames(this.embeddedFonts, info.names, info.bytes);
        this.fontStats.embeddedFonts++;
      } catch (err) {
        this.fontStats.parseFailures++;
        console.warn(`[subframe] skipped embedded font ${embedded.name}`, err);
      }
    }
  }

  private installWorkers(): void {
    const workers = this.options.workers !== false;
    setWorkerPool(workers);
    if (!workers) return;
    if (this.options.workerUrl) {
      setWorkerSource(this.options.workerUrl);
      this.installedWorkerSource = true;
      return;
    }
    if (hasDom() && INLINED_WORKER_CODE) {
      setWorkerSource(makeInlineWorkerFactory(INLINED_WORKER_CODE));
      this.installedWorkerSource = true;
    }
  }

  private async initBackend(): Promise<void> {
    const requested = this.options.backend ?? "auto";
    if (requested === "webgpu" || requested === "auto") {
      try {
        this.backend = await createWebGPUBackend({ canvas: this.canvas! });
        this.backendKind = "webgpu";
        this.backend.resize(
          this.widthValue ?? this.canvas!.width,
          this.heightValue ?? this.canvas!.height,
        );
        return;
      } catch (err) {
        if (requested === "webgpu") throw err;
      }
    }
    if (requested === "webgl" || requested === "auto") {
      try {
        this.backend = createWebGLBackend({ canvas: this.canvas!, preferWebGL2: true });
        this.backendKind = "webgl";
        this.backend.resize(
          this.widthValue ?? this.canvas!.width,
          this.heightValue ?? this.canvas!.height,
        );
        return;
      } catch (err) {
        if (requested === "webgl") throw err;
      }
    }
    this.ctx2d = this.canvas!.getContext("2d");
    this.backendKind = this.ctx2d ? "cpu" : "headless";
  }

  private startVideoPlayback(): void {
    if (!this.video || !this.doc || this.disposed) return;
    void this.ready.then(async () => {
      if (!this.video || !this.doc || this.disposed) return;
      await this.attachPromise;
      this.ensurePlayer().start(this.doc, this.video.currentTime * 1000);
    });
  }

  private ensurePlayer(): RenderAheadPlayer<InternalFrame> {
    if (this.player) return this.player;
    this.player = new RenderAheadPlayer<InternalFrame>(
      {
        render: (_doc, t, _w, _h) => this.frame(t) as Promise<InternalFrame>,
        present: (frame) => this.presentFrame(frame.result),
        release: (frame) => frame.result.release(),
        width: () => this.widthValue ?? this.canvas?.width ?? 1,
        height: () => this.heightValue ?? this.canvas?.height ?? 1,
        now: nowMs,
        requestFrame: (cb) => this.requestVideoOrDisplayFrame(cb),
      },
      { fps: 60 },
    );
    return this.player;
  }

  private requestVideoOrDisplayFrame(cb: (ts: number) => void): void {
    const video = this.video as
      | (HTMLVideoElement & {
          requestVideoFrameCallback?: (
            cb: (now: number, metadata: unknown) => void,
          ) => number;
        })
      | null;
    if (video && typeof video.requestVideoFrameCallback === "function") {
      video.requestVideoFrameCallback((now) => cb(now));
      return;
    }
    requestDisplayFrame(cb);
  }

  private stopPlayer(): void {
    this.player?.stop();
    this.releaseLastPresented();
  }

  private wrapResult(result: RenderResult): InternalFrame {
    let released = false;
    const frame: InternalFrame = {
      result,
      layers: result.layers,
      frame: result.frame,
      activeEvents: result.activeEvents,
      release: () => {
        if (released) return;
        released = true;
        releaseRenderResult(result);
      },
    };
    return frame;
  }

  private presentFrame(frame: InternalFrame): void {
    if (!this.canvas) throw new Error("Subframe.render requires a canvas");
    if (this.backend) {
      this.backend.render(frame.layers, frame.frame);
    } else if (this.ctx2d) {
      this.compositeCpu(frame.layers, frame.frame.width, frame.frame.height);
    }
    const previous = this.lastPresentedFrame;
    this.lastPresentedFrame = frame;
    if (previous && previous.result !== frame.result) previous.release();
  }

  private releaseLastPresented(): void {
    const previous = this.lastPresentedFrame;
    this.lastPresentedFrame = null;
    previous?.release();
  }

  private compositeCpu(layers: BitmapLayer[], width: number, height: number): void {
    const ctx = this.ctx2d;
    if (!ctx) return;
    const imageData = this.getFrameBuffer(ctx, width, height);
    const data = this.frameData!;
    for (let i = 0; i < layers.length; i++) {
      this.compositeLayerInto(layers[i]!, width, height, data);
    }
    for (let y = 0; y < height; y++) {
      const row = y * width * 4;
      for (let x = 0; x < width; x++) {
        const idx = row + x * 4;
        const alpha = data[idx + 3]!;
        if (alpha) {
          const inv = Math.floor(((255 << 16) / alpha) + 1);
          const offs = 1 << 15;
          data[idx + 0] = (data[idx + 0]! * inv + offs) >> 16;
          data[idx + 1] = (data[idx + 1]! * inv + offs) >> 16;
          data[idx + 2] = (data[idx + 2]! * inv + offs) >> 16;
        }
      }
    }
    ctx.globalCompositeOperation = "source-over";
    ctx.putImageData(imageData, 0, 0);
  }

  private getFrameBuffer(
    ctx: CanvasRenderingContext2D,
    width: number,
    height: number,
  ): ImageData {
    if (!this.frameImageData || this.frameW !== width || this.frameH !== height) {
      this.frameImageData = ctx.createImageData(width, height);
      this.frameData = this.frameImageData.data;
      this.frameW = width;
      this.frameH = height;
    }
    this.frameData!.fill(0);
    return this.frameImageData;
  }

  private compositeLayerInto(
    layer: BitmapLayer,
    width: number,
    height: number,
    data: Uint8ClampedArray,
  ): void {
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
        const mask = src[srcRow + x]!;
        if (mask === 0) continue;
        const k = mask * a;
        const di = dstRow + dstX * 4;
        const dr = data[di + 0]!;
        const dg = data[di + 1]!;
        const db = data[di + 2]!;
        const da = data[di + 3]!;
        data[di + 0] = ((k * r + (255 * 255 - k) * dr + rounding) / (255 * 255)) | 0;
        data[di + 1] = ((k * g + (255 * 255 - k) * dg + rounding) / (255 * 255)) | 0;
        data[di + 2] = ((k * b + (255 * 255 - k) * db + rounding) / (255 * 255)) | 0;
        data[di + 3] = ((k * 255 + (255 * 255 - k) * da + rounding) / (255 * 255)) | 0;
      }
    }
  }

  private assertLive(): void {
    if (this.disposed) throw new Error("Subframe instance has been disposed");
  }
}
