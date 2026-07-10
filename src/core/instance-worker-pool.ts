import type { SubtitleDocument } from "subforge/core";
import type { FrameArenaMessage } from "./data/types";
import { activeEventsAtTime, frameContextFromDocument } from "./frame";
import { reassembleFrameArena } from "./frame-arena";
import type { FramePipelineStats, RenderResult } from "./pipeline";
import type { getWorkerPoolStats, WorkerSource } from "./worker-pool";
import type { FontRegistry } from "../io/fonts/cache";
import { getFontSearchPaths } from "../io/fonts/resolve";

type WorkerPoolStats = ReturnType<typeof getWorkerPoolStats>;

export function emptyInstancePipelineStats(): FramePipelineStats {
  return {
    enabled: false,
    scatter: false,
    hybrid: false,
    dedupHits: 0,
    dedupFrames: 0,
    boundaryHits: 0,
    boundaryAwaited: 0,
    boundaryMisfires: 0,
    boundaryFiredEarly: 0,
    boundaryStale: 0,
    boundaryPrewarmSuppressed: 0,
    boundaryDepth: 0,
    boundaryTimingSamples: [],
    boundarySlots: 0,
    boundaryReady: 0,
    boundaryInFlight: 0,
    workers: 0,
    ringSize: 0,
    ready: 0,
    inFlight: 0,
    delta: Number.NaN,
    continuousRun: 0,
    hits: 0,
    misses: 0,
    seeks: 0,
    staleDrops: 0,
    errors: 0,
    scatterFrames: 0,
    scatterFallbacks: 0,
    scatterSingle: 0,
    scatterWorstSubsetMs: 0,
    scatterLastSubsets: 0,
    hybridColdScatter: 0,
    hybridSeekScatter: 0,
    ringAwaited: 0,
    ringConceded: 0,
    ringReadyAvg: 0,
    ringInFlightAvg: 0,
    ringReadyMax: 0,
    frameProduced: 0,
    frameErrors: 0,
    frameCpuEmaMs: 0,
    frameCpuMsTotal: 0,
  };
}

export function emptyInstanceWorkerPoolStats(): WorkerPoolStats {
  return {
    active: false,
    workers: 0,
    workerCap: 0,
    scaleUps: 0,
    maxPending: 0,
    dispatched: 0,
    results: 0,
    inserted: 0,
    noEntry: 0,
    gateSkipped: 0,
    pending: 0,
    taskCpuEmaMs: 0,
    taskCpuMsTotal: 0,
    drainMsTotal: 0,
    noEntryReasons: {},
    arenaReturned: 0,
    arenaReused: 0,
    arenaDropped: 0,
    sabArenasWanted: false,
    sabArenaWorkers: 0,
    sabArenaPacked: 0,
    sabArenaFallbacks: 0,
    sabArenaGrows: 0,
    sabArenaBytes: 0,
    sabArenaHeldSlots: 0,
    sabArenaAllocatedSlots: 0,
    sabArenaSlotReleased: 0,
    sabArenaSlotDropped: 0,
    workerHeapMeasured: false,
    workerHeapWorkers: 0,
    workerHeapLatestBytes: 0,
    workerHeapPeakBytes: 0,
    workerHeapTotalBytes: 0,
    workerHeapLimitBytes: 0,
    bitmapPoolBytes: 0,
    bitmapPoolBuckets: 0,
    bitmapPoolHits: 0,
    bitmapPoolMisses: 0,
    bitmapPoolReleased: 0,
    bitmapPoolDropped: 0,
  };
}

type WorkerMessage =
  | FrameArenaMessage
  | { type: "ready" }
  | { type: "font-request"; name: string };

type FrameTask = {
  key: string;
  doc: SubtitleDocument;
  docId: number;
  timeMs: number;
  width: number;
  height: number;
  priority: boolean;
  boundary: boolean;
  state: "queued" | "inflight" | "ready" | "stale";
  workerIndex: number;
  message: FrameArenaMessage | null;
  promise: Promise<void>;
  resolve: () => void;
  reject: (error: unknown) => void;
};

type PoolWorker = {
  worker: Worker;
  resultPort: MessagePort | null;
  ready: Promise<void>;
  resolveReady: () => void;
  rejectReady: (error: unknown) => void;
  failed: boolean;
  task: FrameTask | null;
  docId: number;
};

type ArenaLease = {
  message: FrameArenaMessage;
  workerIndex: number;
  refs: number;
  recycled: boolean;
};

type RetainedStaticFrame = {
  doc: SubtitleDocument;
  activeEvents: ReturnType<typeof activeEventsAtTime>;
  frame: ReturnType<typeof frameContextFromDocument>;
  layers: RenderResult["layers"];
  lease: ArenaLease;
};

export type InstanceWorkerPoolOptions = {
  source?: WorkerSource;
  workerCount?: number;
  fontRegistry: FontRegistry;
  gpuFiltersEnabled?: boolean;
};

export type InstanceRenderResult = {
  result: RenderResult;
  release(): void;
};

function hardwareWorkerCount(): number {
  const hardware = Number(
    (globalThis as { navigator?: { hardwareConcurrency?: number } }).navigator
      ?.hardwareConcurrency,
  );
  if (!Number.isFinite(hardware) || hardware <= 1) return 1;
  return Math.min(8, Math.max(1, Math.floor(hardware) - 1));
}

function makeTaskKey(
  docId: number,
  timeMs: number,
  width: number,
  height: number,
): string {
  // Equivalent cadence calculations can differ in their last floating-point
  // bits (`start + (i + 1) * delta` vs `start + i * delta + delta`). Without a
  // canonical key those aliases enqueue duplicate future frames, saturate the
  // instance workers, and are later discarded as stale. One microsecond is
  // well below the renderer's timestamp precision while preserving event
  // boundary behavior at every practical media timescale.
  const timeUs = Math.round(timeMs * 1_000);
  return `${docId}|${timeUs}|${width}|${height}`;
}

function createWorker(source?: WorkerSource): Worker {
  if (typeof source === "function") return source();
  if (source) return new Worker(source, { type: "module" });
  const sibling = new URL(
    import.meta.url.endsWith(".ts") ? "./worker-entry.ts" : "./worker-entry.js",
    import.meta.url,
  );
  return new Worker(sibling, { type: "module" });
}

function unrefResource(resource: unknown): void {
  const unref = (resource as { unref?: () => void }).unref;
  if (typeof unref === "function") unref.call(resource);
}

export class InstanceWorkerPool {
  private readonly source: WorkerSource | undefined;
  private readonly targetWorkerCount: number;
  private readonly fontRegistry: FontRegistry;
  private readonly gpuFiltersEnabled: boolean;
  private readonly workers: PoolWorker[] = [];
  private readonly tasks = new Map<string, FrameTask>();
  private readonly queue: FrameTask[] = [];
  private doc: SubtitleDocument | null = null;
  private docId = 0;
  private disposed = false;
  private cadenceMs = 1000 / 60;
  private lastRequestedTime = Number.NaN;
  private retainedStaticFrame: RetainedStaticFrame | null = null;
  private staticWindow = false;
  private dedupHits = 0;
  private dedupFrames = 0;
  private boundaryHits = 0;
  private boundaryAwaited = 0;
  private hits = 0;
  private misses = 0;
  private staleDrops = 0;
  private errors = 0;
  private dispatched = 0;
  private results = 0;
  private maxPending = 0;
  private cpuMsTotal = 0;
  private cpuEmaMs = 0;
  private arenaReturned = 0;
  private arenaDropped = 0;
  private heapMeasuredWorkers = new Set<number>();
  private heapLatest = new Map<number, number>();
  private heapPeak = new Map<number, number>();
  private heapTotal = new Map<number, number>();
  private heapLimit = new Map<number, number>();
  private bitmapPoolBytes = new Map<number, number>();
  private bitmapPoolBuckets = new Map<number, number>();
  private bitmapPoolHits = new Map<number, number>();
  private bitmapPoolMisses = new Map<number, number>();
  private bitmapPoolReleased = new Map<number, number>();
  private bitmapPoolDropped = new Map<number, number>();

  constructor(options: InstanceWorkerPoolOptions) {
    this.source = options.source;
    this.targetWorkerCount = Math.max(
      1,
      Math.min(8, Math.floor(options.workerCount ?? hardwareWorkerCount())),
    );
    this.fontRegistry = options.fontRegistry;
    this.gpuFiltersEnabled = options.gpuFiltersEnabled === true;
  }

  get workerCount(): number {
    return this.workers.length;
  }

  async attach(
    doc: SubtitleDocument,
    timeMs: number,
    width: number,
    height: number,
    playbackFps = 60,
  ): Promise<{
    workerMs: number;
    prepareMs: number;
    primeMs: number;
    primed: number;
  }> {
    this.assertLive();
    const workerStart = performance.now();
    await this.ensureWorkers();
    const workerMs = performance.now() - workerStart;
    this.setDocument(doc);
    const fps = Number(playbackFps);
    this.cadenceMs = Number.isFinite(fps) && fps > 0 ? 1000 / fps : 1000 / 60;
    this.lastRequestedTime = timeMs - this.cadenceMs;

    const prepareStart = performance.now();
    const current = this.enqueue(doc, timeMs, width, height, true);
    const future = this.seed(doc, timeMs, width, height);
    await current.promise;
    if (current.state !== "ready") {
      throw new Error(
        "Subframe instance worker failed to prepare the first frame",
      );
    }
    const prepareMs = performance.now() - prepareStart;

    const primeStart = performance.now();
    if (current.message?.nonStaticOrdinals?.length === 0) {
      // A static window needs event boundaries, not cadence duplicates.
      this.dropNonBoundaryTasks(current);
      this.enqueueBoundaryLookahead(doc, timeMs, width, height);
    } else {
      // Animated content is not warm merely because its current frame is
      // ready. Fill the bounded cadence ring so cold font/raster work stays
      // ahead of presentation.
      await Promise.all(future.map((task) => task.promise));
    }
    const primed = this.countFutureTasks(timeMs);
    return {
      workerMs,
      prepareMs,
      primeMs: performance.now() - primeStart,
      primed,
    };
  }

  async render(
    doc: SubtitleDocument,
    timeMs: number,
    width?: number,
    height?: number,
  ): Promise<InstanceRenderResult> {
    this.assertLive();
    await this.ensureWorkers();
    if (doc !== this.doc) this.setDocument(doc);
    const frame = frameContextFromDocument(doc, timeMs, width, height);
    const activeEvents = activeEventsAtTime(doc, timeMs);
    this.dedupFrames++;
    const retained = this.retainedStaticFrame;
    if (
      retained &&
      retained.doc === doc &&
      this.sameFrameContext(retained.frame, frame) &&
      this.sameActiveEvents(retained.activeEvents, activeEvents) &&
      !this.eventsAreDirty(activeEvents)
    ) {
      this.dedupHits++;
      if (!this.staticWindow) {
        this.dropNonBoundaryTasks();
        this.staticWindow = true;
      }
      this.updateCadence(timeMs);
      const release = this.retainLease(retained.lease);
      return {
        result: {
          layers: retained.layers,
          activeEvents,
          frame,
        },
        release,
      };
    }
    this.staticWindow = false;
    this.clearRetainedStaticFrame();
    this.dropStale(timeMs, frame.width, frame.height);
    const key = makeTaskKey(this.docId, timeMs, frame.width, frame.height);
    let task = this.findBoundaryTask(
      doc,
      timeMs,
      frame.width,
      frame.height,
      activeEvents,
    );
    const boundaryTask = task !== null;
    if (!task) task = this.tasks.get(key) ?? null;
    if (task) {
      this.hits++;
      task.priority = true;
      this.promoteQueuedTask(task);
    } else {
      this.misses++;
      task = this.enqueue(doc, timeMs, frame.width, frame.height, true);
    }
    const awaitedBoundary = boundaryTask && task.state !== "ready";
    await task.promise;
    if (task.state !== "ready" || !task.message) {
      throw new Error("Subframe instance worker did not produce a frame");
    }
    if (boundaryTask) {
      this.boundaryHits++;
      if (awaitedBoundary) this.boundaryAwaited++;
    }
    this.tasks.delete(task.key);
    const message = task.message;
    task.message = null;
    const layers = reassembleFrameArena(
      message.arena,
      message.meta,
      message.count,
    );
    const result: RenderResult = {
      layers,
      activeEvents,
      frame,
    };
    const lease: ArenaLease = {
      message,
      workerIndex: task.workerIndex,
      refs: 0,
      recycled: false,
    };
    const fullyStatic =
      message.nonStaticOrdinals !== undefined &&
      message.nonStaticOrdinals.length === 0;
    if (fullyStatic) {
      lease.refs++;
      this.retainedStaticFrame = {
        doc,
        activeEvents,
        frame,
        layers,
        lease,
      };
    }
    const release = this.retainLease(lease);

    this.updateCadence(timeMs);
    if (fullyStatic) {
      // Static windows need only the next event-set boundary, not every 60 Hz
      // timestamp. Keeping a full ring here renders and then discards up to 16
      // byte-identical frames at each boundary.
      this.dropNonBoundaryTasks();
      this.staticWindow = true;
      this.enqueueBoundaryLookahead(doc, timeMs, frame.width, frame.height);
    } else {
      this.seed(doc, timeMs, frame.width, frame.height);
    }
    return { result, release };
  }

  resetCadence(): void {
    this.lastRequestedTime = Number.NaN;
    this.dropAllTasks();
  }

  pipelineStats(): FramePipelineStats {
    let ready = 0;
    let inFlight = 0;
    let boundarySlots = 0;
    let boundaryReady = 0;
    let boundaryInFlight = 0;
    for (const task of this.tasks.values()) {
      if (task.state === "ready") ready++;
      else if (task.state === "inflight") inFlight++;
      if (task.boundary) {
        boundarySlots++;
        if (task.state === "ready") boundaryReady++;
        else if (task.state === "inflight") boundaryInFlight++;
      }
    }
    return {
      enabled: true,
      scatter: false,
      hybrid: false,
      dedupHits: this.dedupHits,
      dedupFrames: this.dedupFrames,
      boundaryHits: this.boundaryHits,
      boundaryAwaited: this.boundaryAwaited,
      boundaryMisfires: 0,
      boundaryFiredEarly: 0,
      boundaryStale: 0,
      boundaryPrewarmSuppressed: 0,
      boundaryDepth: this.targetWorkerCount,
      boundaryTimingSamples: [],
      boundarySlots,
      boundaryReady,
      boundaryInFlight,
      workers: this.workers.length,
      ringSize: this.tasks.size,
      ready,
      inFlight,
      delta: this.cadenceMs,
      continuousRun: Number.isFinite(this.lastRequestedTime) ? 1 : 0,
      hits: this.hits,
      misses: this.misses,
      seeks: 0,
      staleDrops: this.staleDrops,
      errors: this.errors,
      scatterFrames: 0,
      scatterFallbacks: 0,
      scatterSingle: 0,
      scatterWorstSubsetMs: 0,
      scatterLastSubsets: 0,
      hybridColdScatter: 0,
      hybridSeekScatter: 0,
      ringAwaited: 0,
      ringConceded: 0,
      ringReadyAvg: ready,
      ringInFlightAvg: inFlight,
      ringReadyMax: ready,
      frameProduced: this.results,
      frameErrors: this.errors,
      frameCpuEmaMs: this.cpuEmaMs,
      frameCpuMsTotal: this.cpuMsTotal,
    };
  }

  stats(): WorkerPoolStats {
    const sum = (values: Map<number, number>): number => {
      let total = 0;
      for (const value of values.values()) total += value;
      return total;
    };
    let pending = 0;
    for (const task of this.tasks.values()) {
      if (task.state === "queued" || task.state === "inflight") pending++;
    }
    return {
      active: !this.disposed && this.workers.length > 0,
      workers: this.workers.length,
      workerCap: this.targetWorkerCount,
      scaleUps: 0,
      maxPending: this.maxPending,
      dispatched: this.dispatched,
      results: this.results,
      inserted: 0,
      noEntry: this.errors,
      gateSkipped: 0,
      pending,
      taskCpuEmaMs: this.cpuEmaMs,
      taskCpuMsTotal: this.cpuMsTotal,
      drainMsTotal: 0,
      noEntryReasons: {},
      arenaReturned: this.arenaReturned,
      arenaReused: 0,
      arenaDropped: this.arenaDropped,
      sabArenasWanted: false,
      sabArenaWorkers: 0,
      sabArenaPacked: 0,
      sabArenaFallbacks: 0,
      sabArenaGrows: 0,
      sabArenaBytes: 0,
      sabArenaHeldSlots: 0,
      sabArenaAllocatedSlots: 0,
      sabArenaSlotReleased: 0,
      sabArenaSlotDropped: 0,
      workerHeapMeasured: this.heapMeasuredWorkers.size > 0,
      workerHeapWorkers: this.heapMeasuredWorkers.size,
      workerHeapLatestBytes: sum(this.heapLatest),
      workerHeapPeakBytes: sum(this.heapPeak),
      workerHeapTotalBytes: sum(this.heapTotal),
      workerHeapLimitBytes: sum(this.heapLimit),
      bitmapPoolBytes: sum(this.bitmapPoolBytes),
      bitmapPoolBuckets: sum(this.bitmapPoolBuckets),
      bitmapPoolHits: sum(this.bitmapPoolHits),
      bitmapPoolMisses: sum(this.bitmapPoolMisses),
      bitmapPoolReleased: sum(this.bitmapPoolReleased),
      bitmapPoolDropped: sum(this.bitmapPoolDropped),
    };
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.dropAllTasks();
    this.clearRetainedStaticFrame();
    for (let i = 0; i < this.workers.length; i++) {
      const slot = this.workers[i]!;
      slot.resultPort?.close();
      void slot.worker.terminate();
    }
    this.workers.length = 0;
    this.doc = null;
  }

  private async ensureWorkers(): Promise<void> {
    if (this.workers.length === 0) {
      for (let i = 0; i < this.targetWorkerCount; i++) this.spawnWorker(i);
    }
    await Promise.all(this.workers.map((worker) => worker.ready));
  }

  private spawnWorker(index: number): void {
    let resolveReady = (): void => {};
    let rejectReady = (_error: unknown): void => {};
    const ready = new Promise<void>((resolve, reject) => {
      resolveReady = resolve;
      rejectReady = reject;
    });
    const worker = createWorker(this.source);
    const slot: PoolWorker = {
      worker,
      resultPort: null,
      ready,
      resolveReady,
      rejectReady,
      failed: false,
      task: null,
      docId: -1,
    };
    this.workers[index] = slot;
    worker.onmessage = (event: MessageEvent): void => {
      this.handleWorkerMessage(index, event.data as WorkerMessage);
    };
    worker.onerror = (error: unknown): void => this.failWorker(index, error);

    let resultPort: MessagePort | undefined;
    let transfer: Transferable[] | undefined;
    if (typeof MessageChannel === "function") {
      const channel = new MessageChannel();
      slot.resultPort = channel.port1;
      channel.port1.onmessage = (event: MessageEvent): void => {
        this.handleWorkerMessage(index, event.data as WorkerMessage);
      };
      channel.port1.start?.();
      unrefResource(channel.port1);
      resultPort = channel.port2;
      transfer = [channel.port2];
    }
    const init = {
      type: "init",
      fontSearchPaths: getFontSearchPaths(),
      fontSources: [],
      resultPort,
      workerIndex: index,
      workerCount: this.targetWorkerCount,
      gpuFiltersEnabled: this.gpuFiltersEnabled,
      allocCensusEnabled: false,
      sabArenasEnabled: false,
    };
    if (transfer) worker.postMessage(init, transfer);
    else worker.postMessage(init);
    unrefResource(worker);
  }

  private handleWorkerMessage(index: number, message: WorkerMessage): void {
    if (message.type === "ready") {
      this.workers[index]?.resolveReady();
      return;
    }
    if (message.type === "font-request") {
      void this.answerFontRequest(index, message.name);
      return;
    }
    this.handleFrame(index, message);
  }

  private async answerFontRequest(index: number, name: string): Promise<void> {
    let source: string | ArrayBuffer | Uint8Array | null = null;
    try {
      await this.fontRegistry.getFont(name);
      const lower = name.toLowerCase();
      const snapshot = this.fontRegistry.snapshot();
      for (let i = 0; i < snapshot.length; i++) {
        const candidate = snapshot[i]!;
        if (candidate.name === name || candidate.name.toLowerCase() === lower) {
          source = candidate.source;
          break;
        }
      }
    } catch {
      source = null;
    }
    this.workers[index]?.worker.postMessage({
      type: "font-response",
      name,
      source,
    });
  }

  private handleFrame(index: number, message: FrameArenaMessage): void {
    const slot = this.workers[index];
    const task = slot?.task ?? null;
    if (!slot || !task) {
      this.recycleArena(index, message);
      return;
    }
    slot.task = null;
    this.recordWorkerStats(index, message);
    if (message.error) {
      this.errors++;
      task.state = "stale";
      task.reject(new Error(message.error));
      this.tasks.delete(task.key);
    } else if (task.state === "stale" || this.disposed) {
      this.recycleArena(index, message);
      task.resolve();
    } else {
      task.state = "ready";
      task.workerIndex = index;
      task.message = message;
      this.results++;
      task.resolve();
    }
    this.pumpQueue();
  }

  private recordWorkerStats(index: number, message: FrameArenaMessage): void {
    const ms = message.ms ?? 0;
    if (ms > 0) {
      this.cpuMsTotal += ms;
      this.cpuEmaMs =
        this.cpuEmaMs === 0 ? ms : this.cpuEmaMs + (ms - this.cpuEmaMs) * 0.1;
    }
    const record = (
      target: Map<number, number>,
      value: number | undefined,
    ): void => {
      if (typeof value === "number" && Number.isFinite(value))
        target.set(index, value);
    };
    if (typeof message.workerHeapUsed === "number")
      this.heapMeasuredWorkers.add(index);
    record(this.heapLatest, message.workerHeapUsed);
    const previousPeak = this.heapPeak.get(index) ?? 0;
    if ((message.workerHeapUsed ?? 0) > previousPeak) {
      this.heapPeak.set(index, message.workerHeapUsed!);
    }
    record(this.heapTotal, message.workerHeapTotal);
    record(this.heapLimit, message.workerHeapLimit);
    record(this.bitmapPoolBytes, message.bitmapPoolBytes);
    record(this.bitmapPoolBuckets, message.bitmapPoolBuckets);
    record(this.bitmapPoolHits, message.bitmapPoolHits);
    record(this.bitmapPoolMisses, message.bitmapPoolMisses);
    record(this.bitmapPoolReleased, message.bitmapPoolReleased);
    record(this.bitmapPoolDropped, message.bitmapPoolDropped);
  }

  private failWorker(index: number, error: unknown): void {
    this.errors++;
    const slot = this.workers[index];
    if (slot) {
      slot.failed = true;
      slot.rejectReady(error);
    }
    const task = slot?.task;
    if (task) {
      task.state = "stale";
      task.reject(error);
      this.tasks.delete(task.key);
      slot.task = null;
    }
    this.pumpQueue();
  }

  private setDocument(doc: SubtitleDocument): void {
    this.dropAllTasks();
    this.clearRetainedStaticFrame();
    this.staticWindow = false;
    this.doc = doc;
    this.docId++;
    this.lastRequestedTime = Number.NaN;
    const fontSources = this.fontRegistry.snapshot();
    for (let i = 0; i < this.workers.length; i++) {
      const slot = this.workers[i]!;
      slot.worker.postMessage({
        type: "doc",
        docId: this.docId,
        doc,
        fontSources,
      });
      slot.docId = this.docId;
    }
  }

  private enqueue(
    doc: SubtitleDocument,
    timeMs: number,
    width: number,
    height: number,
    priority: boolean,
    boundary = false,
  ): FrameTask {
    const key = makeTaskKey(this.docId, timeMs, width, height);
    const existing = this.tasks.get(key);
    if (existing) {
      if (boundary) existing.boundary = true;
      return existing;
    }
    let resolve = (): void => {};
    let reject = (_error: unknown): void => {};
    const promise = new Promise<void>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    const task: FrameTask = {
      key,
      doc,
      docId: this.docId,
      timeMs,
      width,
      height,
      priority,
      boundary,
      state: "queued",
      workerIndex: -1,
      message: null,
      promise,
      resolve,
      reject,
    };
    this.tasks.set(key, task);
    if (priority) this.queue.unshift(task);
    else this.queue.push(task);
    if (this.tasks.size > this.maxPending) this.maxPending = this.tasks.size;
    this.pumpQueue();
    return task;
  }

  private promoteQueuedTask(task: FrameTask): void {
    if (task.state !== "queued") return;
    const index = this.queue.indexOf(task);
    if (index <= 0) return;
    this.queue.splice(index, 1);
    this.queue.unshift(task);
  }

  private pumpQueue(): void {
    if (this.disposed) return;
    for (let i = 0; i < this.workers.length; i++) {
      const slot = this.workers[i]!;
      if (slot.failed || slot.task) continue;
      let task: FrameTask | undefined;
      while ((task = this.queue.shift())) {
        if (task.state === "queued" && task.docId === this.docId) break;
        task = undefined;
      }
      if (!task) return;
      task.state = "inflight";
      task.workerIndex = i;
      slot.task = task;
      this.dispatched++;
      try {
        slot.worker.postMessage({
          type: "renderFrame",
          docId: task.docId,
          timeMs: task.timeMs,
          width: task.width,
          height: task.height,
        });
      } catch (error) {
        slot.task = null;
        task.state = "stale";
        task.reject(error);
        this.tasks.delete(task.key);
      }
    }
  }

  private seed(
    doc: SubtitleDocument,
    timeMs: number,
    width: number,
    height: number,
  ): FrameTask[] {
    const depth = this.targetWorkerCount * 2;
    const tasks = new Array<FrameTask>(depth);
    for (let i = 1; i <= depth; i++) {
      tasks[i - 1] = this.enqueue(
        doc,
        timeMs + this.cadenceMs * i,
        width,
        height,
        false,
      );
    }
    return tasks;
  }

  private countFutureTasks(timeMs: number): number {
    let count = 0;
    for (const task of this.tasks.values()) {
      if (task.timeMs > timeMs && task.state !== "stale") count++;
    }
    return count;
  }

  private dropStale(timeMs: number, width: number, height: number): void {
    const cutoff = timeMs - Math.max(0.25, this.cadenceMs * 0.125);
    for (const task of this.tasks.values()) {
      if (
        task.docId !== this.docId ||
        task.width !== width ||
        task.height !== height ||
        (!task.boundary && task.timeMs < cutoff)
      ) {
        this.dropTask(task);
      }
    }
  }

  private dropAllTasks(error?: Error): void {
    for (const task of this.tasks.values()) this.dropTask(task, error);
    this.queue.length = 0;
  }

  private dropNonBoundaryTasks(keep?: FrameTask): void {
    for (const task of this.tasks.values()) {
      if (task !== keep && !task.boundary) this.dropTask(task);
    }
    for (let i = this.queue.length - 1; i >= 0; i--) {
      if (this.queue[i]!.state !== "queued") this.queue.splice(i, 1);
    }
  }

  private dropTask(task: FrameTask, error?: Error): void {
    if (task.state === "stale") return;
    this.tasks.delete(task.key);
    if (task.state === "ready" && task.message) {
      this.recycleArena(task.workerIndex, task.message);
      task.message = null;
    }
    task.state = "stale";
    this.staleDrops++;
    if (error) task.reject(error);
    else task.resolve();
  }

  private recycleArena(workerIndex: number, message: FrameArenaMessage): void {
    if (message.sabSlotIdx !== undefined) {
      this.workers[workerIndex]?.worker.postMessage({
        type: "arena-slot-release",
        slotIdx: message.sabSlotIdx,
      });
      this.arenaReturned++;
      return;
    }
    if (
      !(message.arena instanceof ArrayBuffer) ||
      message.arena.byteLength === 0
    ) {
      this.arenaDropped++;
      return;
    }
    const worker = this.workers[workerIndex]?.worker;
    if (!worker || this.disposed) {
      this.arenaDropped++;
      return;
    }
    worker.postMessage({ type: "arena-return", buffer: message.arena }, [
      message.arena,
    ]);
    this.arenaReturned++;
  }

  private retainLease(lease: ArenaLease): () => void {
    lease.refs++;
    let released = false;
    return (): void => {
      if (released) return;
      released = true;
      this.releaseLease(lease);
    };
  }

  private releaseLease(lease: ArenaLease): void {
    if (lease.refs > 0) lease.refs--;
    if (lease.refs !== 0 || lease.recycled) return;
    lease.recycled = true;
    this.recycleArena(lease.workerIndex, lease.message);
  }

  private clearRetainedStaticFrame(): void {
    const retained = this.retainedStaticFrame;
    if (!retained) return;
    this.retainedStaticFrame = null;
    this.releaseLease(retained.lease);
  }

  private sameFrameContext(
    a: ReturnType<typeof frameContextFromDocument>,
    b: ReturnType<typeof frameContextFromDocument>,
  ): boolean {
    return (
      a.width === b.width &&
      a.height === b.height &&
      a.marginL === b.marginL &&
      a.marginR === b.marginR &&
      a.marginV === b.marginV &&
      a.wrapStyle === b.wrapStyle
    );
  }

  private sameActiveEvents(
    a: ReturnType<typeof activeEventsAtTime>,
    b: ReturnType<typeof activeEventsAtTime>,
  ): boolean {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
    return true;
  }

  private eventsAreDirty(
    events: ReturnType<typeof activeEventsAtTime>,
  ): boolean {
    for (let i = 0; i < events.length; i++) if (events[i]!.dirty) return true;
    return false;
  }

  private enqueueBoundaryLookahead(
    doc: SubtitleDocument,
    timeMs: number,
    width: number,
    height: number,
  ): void {
    const limit = timeMs + 250;
    const boundaries: number[] = [];
    for (let i = 0; i < doc.events.length; i++) {
      const event = doc.events[i]!;
      if (event.start > timeMs && event.start <= limit)
        boundaries.push(event.start);
      if (event.end > timeMs && event.end <= limit) boundaries.push(event.end);
    }
    boundaries.sort((a, b) => a - b);
    let previous = Number.NaN;
    let enqueued = 0;
    for (let i = 0; i < boundaries.length; i++) {
      const boundary = boundaries[i]!;
      if (boundary === previous) continue;
      previous = boundary;
      this.enqueue(doc, boundary, width, height, false, true);
      if (++enqueued >= this.targetWorkerCount) break;
    }
  }

  private findBoundaryTask(
    doc: SubtitleDocument,
    timeMs: number,
    width: number,
    height: number,
    activeEvents: ReturnType<typeof activeEventsAtTime>,
  ): FrameTask | null {
    let best: FrameTask | null = null;
    for (const task of this.tasks.values()) {
      if (
        !task.boundary ||
        task.docId !== this.docId ||
        task.timeMs > timeMs ||
        task.width !== width ||
        task.height !== height
      ) {
        continue;
      }
      const boundaryEvents = activeEventsAtTime(doc, task.timeMs);
      if (!this.sameActiveEvents(boundaryEvents, activeEvents)) {
        this.dropTask(task);
        continue;
      }
      if (!best || task.timeMs > best.timeMs) best = task;
    }
    return best;
  }

  private updateCadence(timeMs: number): void {
    const previousTime = this.lastRequestedTime;
    if (Number.isFinite(previousTime)) {
      const delta = timeMs - previousTime;
      const tolerance = Math.max(0.25, this.cadenceMs * 0.125);
      if (delta > 0 && Math.abs(delta - this.cadenceMs) > tolerance) {
        this.cadenceMs = delta;
      }
    }
    this.lastRequestedTime = timeMs;
  }

  private assertLive(): void {
    if (this.disposed)
      throw new Error("Subframe instance worker pool is disposed");
  }
}
