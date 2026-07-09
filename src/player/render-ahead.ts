// Render-ahead display scheduler — decouples RENDER latency from DISPLAY cadence.
//
// The old playback loop was reactive and SERIAL: advance currentTime by the real
// elapsed wall time, `await renderFrame(currentTime)`, then present. The on-screen
// cadence therefore EQUALLED the render latency, so the 20-100ms per-frame variance
// on dense typeset content (beastars) showed up directly as visible STUTTER, and —
// because the caller fed jittery wall-clock timestamps — the core ring/hybrid
// prefetch almost never hit (its cadence detector needs a uniform t0 + i*step grid).
//
// This scheduler splits the two:
//
//   PRODUCTION LOOP  — an async loop that renders UPCOMING frames on a fixed media
//     grid (baseTimeMs + i*frameStep) into a bounded ready-buffer. Feeding renderFrame
//     a clean uniform grid is exactly what the core ring/hybrid path wants: it seeds
//     the workers ahead, so each subsequent grid call returns as a cheap ring HIT
//     (reassemble + z-sort, no raster). The producer paces ITSELF to render throughput
//     (it awaits each frame) and never blocks the display loop.
//
//   DISPLAY LOOP     — a requestAnimationFrame loop that presents the next buffered
//     frame at a STEADY vsync-multiple cadence. It NEVER awaits a render: it shows the
//     already-produced frame for the current playhead and, if the next one is not ready
//     yet, holds the current frame (a rare single-vsync hitch) instead of stalling.
//
// HONEST PACING: the present cadence is `stride` display refreshes per frame, where
// `stride` tracks the smoothed PRODUCTION rate snapped to the refresh grid. When
// production sustains 60fps the stride is 1 (present every vsync). When it can only
// sustain ~22fps on heavy content, the stride settles at 3 (present every 3rd vsync,
// a rock-steady 20fps) rather than jittering 20-100ms. Consistency beats peak fps for
// perceived smoothness — libass looks smooth precisely because it is uniform. The
// playhead advances one grid step per present, so motion stays smooth; on heavy
// content the timeline simply runs slower than real time (the honest tradeoff).
//
// Parity: display-only. It calls the SAME renderFrame and the SAME present path the
// reactive loop used; buffered RenderResults are byte-identical to what the serial
// loop would have shown for the same media time.

import type { SubtitleDocument } from "subforge/core";
import type { RenderResult } from "../core/pipeline";

export interface BufferedFrame<T = RenderResult> {
  result: T;
  timeMs: number;
  frameIndex: number;
}

export interface RenderAheadDeps<T = RenderResult> {
  // Render one frame. Normally the core `renderFrame`; injected so the bench can
  // drive the exact scheduler against a real backend + fixture.
  render(doc: SubtitleDocument, timeMs: number, w: number, h: number): Promise<T>;
  // Present a produced frame (backend.render / CPU composite + UI). Called from the
  // display loop; must be synchronous so the present interval reflects real cadence.
  present(frame: BufferedFrame<T>): void;
  // Release a produced frame that will not be presented. Presented frames are
  // released by present()'s owner after its last UI/backend use.
  release?(frame: BufferedFrame<T>): void;
  // Active render target size (canvas may resize between frames).
  width(): number;
  height(): number;
  // Injected clock + scheduler so the loop is testable/benchable. Default to
  // performance.now / requestAnimationFrame in the browser wiring.
  now(): number;
  requestFrame(cb: (ts: number) => void): void;
  // Called after a discontinuity/seed reset so the core ring relearns cleanly.
  onSeek?(): void;
  onError?(err: unknown): void;
  // Emitted after every present with the live smoothness/pacing numbers.
  onStats?(s: RenderAheadStats): void;
}

export interface RenderAheadOptions {
  fps?: number; // media grid rate (default 60)
  maxAhead?: number; // producer buffer depth cap (default 4)
  maxStride?: number; // slowest steady cadence, in refreshes/frame (default 6)
  // Frames to pre-buffer before the FIRST present, so a heavy opening frame (the
  // dense window often starts on its worst frame) is absorbed by the buffer
  // instead of stalling the display into a startup hitch. Default min(maxAhead, 4).
  minStartAhead?: number;
}

export interface RenderAheadStats {
  achievedFps: number; // presents per second (EMA), the TRUE on-screen rate
  presentIntervalP50: number;
  presentIntervalP95: number;
  presentIntervalMax: number;
  presentIntervalStdev: number;
  renderP50: number; // producer renderFrame ms
  renderP95: number;
  compositeP50: number; // present() ms
  compositeMs: number; // last present() ms
  bufferDepth: number; // ready frames ahead of the playhead
  stride: number; // refreshes per present (1 == 60fps)
  refreshMs: number; // measured display refresh period
  produced: number;
  presented: number;
  holds: number; // display underruns (next frame not ready at its slot)
  timeMs: number; // media time of the last presented frame
}

const PROD_ALPHA = 0.12; // EMA weight for production inter-arrival (stats only)
const REFRESH_ALPHA = 0.05; // EMA weight for the display refresh period
const FPS_ALPHA = 0.1; // EMA weight for achieved (present) fps
const CAPABILITY_ALPHA = 0.2; // EMA weight for awaited render duration (stride signal)
const STRIDE_SAFETY = 1.25; // headroom multiplier: stride covers capability + jitter
const STRIDE_STREAK = 10; // presents a new stride target must persist before applying
const BUFFER_FED_MARGIN = 2; // bufferDepth >= stride + this counts as overfull

// Rolling window of the most recent inter-present wall deltas. p50/p95/max/stdev
// over this window IS the perceived-smoothness metric the mission asks for.
const SAMPLE_WINDOW = 240;

function percentile(sortedAsc: number[], p: number): number {
  const n = sortedAsc.length;
  if (n === 0) return 0;
  const idx = Math.min(n - 1, Math.max(0, Math.round((p / 100) * (n - 1))));
  return sortedAsc[idx]!;
}

export class RenderAheadPlayer<T = RenderResult> {
  private deps: RenderAheadDeps<T>;
  private frameStepMs: number;
  private maxAhead: number;
  private maxStride: number;
  private minStartAhead: number;

  private doc: SubtitleDocument | null = null;
  private running = false;
  // Bumped on every start(). A producer / display chain captures its epoch and
  // exits the instant it no longer matches, so a restart (seek / config change)
  // can never leave an old loop running alongside the new one (which would
  // double-consume the buffer and corrupt the ring cadence).
  private epoch = 0;
  private baseTimeMs = 0;

  private buffer = new Map<number, BufferedFrame<T>>();
  private productionCursor = 0; // next grid index to render
  private displayCursor = -1; // last grid index presented

  // Producer gate (resolves when the display advances or playback stops).
  private producerWakeResolve: (() => void) | null = null;

  // Pacing state.
  private stride = 1;
  private vsyncCount = 0;
  private refreshMs = 1000 / 60;
  private prodIntervalEma = 1000 / 60;
  private lastProducedAt = -1;
  private lastTickTs = -1;
  private lastPresentTs = -1;
  private achievedFps = 0;
  // Production CAPABILITY: EMA of the awaited renderFrame duration. This is the
  // stride signal — NOT prodIntervalEma. Once the buffer caps, the producer
  // throttles to consumption pace, so inter-production intervals mirror the
  // current stride and a stride raised during cold start can never recover
  // (ratio ~= stride forever). The awaited render duration keeps measuring true
  // capability regardless of buffer state: dedup-served duplicates cost ~0 and
  // count — that is real capability. Seeded pessimistically; converges within
  // ~a second of presents.
  private renderCapabilityEma = 50;
  private strideTargetLast = 1;
  private strideTargetStreak = 0;
  private bufferFedStreak = 0;

  // Diagnostics.
  private produced = 0;
  private presented = 0;
  private holds = 0;
  private lastCompositeMs = 0;
  private lastTimeMs = 0;
  private presentIntervals: number[] = [];
  private presentIntervalPos = 0;
  private renderSamples: number[] = [];
  private renderPos = 0;
  private compositeSamples: number[] = [];
  private compositePos = 0;

  constructor(deps: RenderAheadDeps<T>, opts: RenderAheadOptions = {}) {
    this.deps = deps;
    const fps = opts.fps && opts.fps > 0 ? opts.fps : 60;
    this.frameStepMs = 1000 / fps;
    this.maxAhead = opts.maxAhead && opts.maxAhead > 0 ? opts.maxAhead : 4;
    this.maxStride = opts.maxStride && opts.maxStride > 0 ? opts.maxStride : 6;
    this.minStartAhead =
      opts.minStartAhead && opts.minStartAhead > 0
        ? opts.minStartAhead
        : Math.min(this.maxAhead, 4);
  }

  get isRunning(): boolean {
    return this.running;
  }

  get currentTimeMs(): number {
    return this.lastTimeMs;
  }

  // Begin render-ahead playback from a media time. Idempotent-safe: a running
  // player is stopped and reseeded (used for seek).
  start(doc: SubtitleDocument, startTimeMs: number): void {
    this.stop();
    this.doc = doc;
    this.baseTimeMs = startTimeMs;
    this.lastTimeMs = startTimeMs;
    this.productionCursor = 0;
    this.displayCursor = -1;
    this.clearBuffer();
    this.vsyncCount = 0;
    this.lastProducedAt = -1;
    this.lastTickTs = -1;
    this.lastPresentTs = -1;
    this.running = true;
    const myEpoch = ++this.epoch;
    void this.runProducer(myEpoch);
    this.scheduleDisplay(myEpoch);
  }

  stop(): void {
    this.running = false;
    this.clearBuffer();
    // Release a parked producer so its loop observes running=false and exits.
    this.wakeProducer();
  }

  private releaseFrame(frame: BufferedFrame<T>): void {
    try {
      this.deps.release?.(frame);
    } catch (err) {
      this.deps.onError?.(err);
    }
  }

  private clearBuffer(): void {
    if (this.buffer.size === 0) return;
    for (const frame of this.buffer.values()) this.releaseFrame(frame);
    this.buffer.clear();
  }

  // --- Production loop ------------------------------------------------------

  private producerGate(): Promise<void> {
    return new Promise<void>((resolve) => {
      this.producerWakeResolve = resolve;
    });
  }

  private wakeProducer(): void {
    const r = this.producerWakeResolve;
    if (r) {
      this.producerWakeResolve = null;
      r();
    }
  }

  private async runProducer(epoch: number): Promise<void> {
    const deps = this.deps;
    while (this.running && this.epoch === epoch) {
      // Bounded lookahead: do not render more than maxAhead frames past the
      // playhead. When the buffer is full (light content producing faster than
      // the display drains) the producer parks until a present frees a slot.
      if (this.productionCursor - this.displayCursor > this.maxAhead) {
        await this.producerGate();
        continue;
      }
      const i = this.productionCursor;
      const t = this.baseTimeMs + i * this.frameStepMs;
      const w = deps.width();
      const h = deps.height();
      const t0 = deps.now();
      let result: T;
      try {
        result = await deps.render(this.doc!, t, w, h);
      } catch (err) {
        deps.onError?.(err);
        // Skip this index so the display loop does not wait on it forever.
        this.productionCursor = i + 1;
        continue;
      }
      if (!this.running || this.epoch !== epoch) {
        this.releaseFrame({ result, timeMs: t, frameIndex: i });
        break;
      }
      const renderMs = deps.now() - t0;
      this.pushSample(this.renderSamples, "renderPos", renderMs);
      this.renderCapabilityEma += (renderMs - this.renderCapabilityEma) * CAPABILITY_ALPHA;
      this.buffer.set(i, { result, timeMs: t, frameIndex: i });
      const at = deps.now();
      if (this.lastProducedAt >= 0) {
        const d = at - this.lastProducedAt;
        if (d > 0) this.prodIntervalEma += (d - this.prodIntervalEma) * PROD_ALPHA;
      }
      this.lastProducedAt = at;
      this.produced++;
      this.productionCursor = i + 1;
    }
  }

  // --- Display loop ---------------------------------------------------------

  private scheduleDisplay(epoch: number): void {
    this.deps.requestFrame((ts) => this.displayTick(ts, epoch));
  }

  private displayTick(ts: number, epoch: number): void {
    if (!this.running || this.epoch !== epoch) return;
    this.scheduleDisplay(epoch);

    // Track the real display refresh period from rAF deltas.
    if (this.lastTickTs >= 0) {
      const d = ts - this.lastTickTs;
      if (d > 4 && d < 100) this.refreshMs += (d - this.refreshMs) * REFRESH_ALPHA;
    }
    this.lastTickTs = ts;

    // Startup: hold the first present until the buffer has pre-filled, so a heavy
    // opening frame is absorbed rather than stalling the display into a hitch. Once
    // presentation has begun, the normal per-frame hold logic governs underruns.
    // The producer-saturated escape prevents a startup deadlock: error-skipped
    // indices advance productionCursor without filling the buffer, so with
    // maxAhead == minStartAhead a single early render rejection parks the
    // producer below the prebuffer threshold — and nothing would ever call
    // wakeProducer because no present happens. When the producer is parked at
    // its lookahead bound, start presenting with whatever is buffered.
    const producerSaturated =
      this.productionCursor - this.displayCursor > this.maxAhead;
    if (
      this.presented === 0 &&
      this.buffer.size < this.minStartAhead &&
      !producerSaturated &&
      this.running
    ) {
      return;
    }

    this.vsyncCount++;
    if (this.vsyncCount < this.stride) return;

    const nextI = this.displayCursor + 1;
    const frame = this.buffer.get(nextI);
    if (!frame) {
      // Not ready at its slot. If the producer already moved past it (errored/
      // skipped), drop the gap; otherwise hold the current frame — a single-vsync
      // hitch, never a multi-frame render stall.
      if (this.productionCursor > nextI) {
        this.displayCursor = nextI;
        this.wakeProducer();
      }
      this.holds++;
      return;
    }

    this.vsyncCount = 0;
    const c0 = this.deps.now();
    this.deps.present(frame);
    this.lastCompositeMs = this.deps.now() - c0;
    this.pushSample(this.compositeSamples, "compositePos", this.lastCompositeMs);

    this.buffer.delete(nextI);
    this.displayCursor = nextI;
    this.lastTimeMs = frame.timeMs;
    this.presented++;
    this.wakeProducer();

    // Record the present-to-present interval (the smoothness metric) + fps EMA.
    if (this.lastPresentTs >= 0) {
      const interval = ts - this.lastPresentTs;
      this.pushSample(this.presentIntervals, "presentIntervalPos", interval);
      const fps = interval > 0 ? 1000 / interval : 0;
      this.achievedFps = this.achievedFps === 0 ? fps : this.achievedFps + (fps - this.achievedFps) * FPS_ALPHA;
    }
    this.lastPresentTs = ts;

    // Re-evaluate the steady cadence every present (O(1), hysteretic so it does
    // not flip-flop) — it settles within the first few frames and then holds.
    this.reevaluateStride();

    this.deps.onStats?.(this.stats());
  }

  // Snap the steady present cadence to a whole number of display refreshes.
  // Presenting on a vsync multiple is the smoothest a fixed-refresh display
  // allows. The cadence trails production CAPABILITY (awaited render duration),
  // never the inter-production interval: when the buffer is capped the producer
  // paces itself to consumption, so intervals mirror the current stride and can
  // only ratchet it upward (measured: stride stuck at 4 with a 9-deep buffer and
  // 0.4ms renders). Capability keeps measuring the true cost either way.
  //
  // HYSTERESIS: a new target must persist for STRIDE_STREAK consecutive presents
  // before it applies, so a single slow unique frame (which briefly lifts the
  // EMA) cannot flip the cadence. Independently, a buffer that stays overfull
  // (depth >= stride + BUFFER_FED_MARGIN) for the same streak lowers the stride
  // by one: a persistently overfull buffer is direct evidence the cadence is too
  // slow, whatever the EMA claims.
  private reevaluateStride(): void {
    // Media floor: each present advances media time by one frameStep, so the
    // stride must satisfy stride*refresh ~= frameStep for realtime playback
    // (2 on a 120Hz display for 60fps media). Below it playback would run fast.
    // Round-to-nearest, NOT ceil: refreshMs is a noisy EMA, so a true ratio of
    // 1.0 measures as ~1.003 and ceil would double the floor (halving fps on a
    // 60Hz display). For non-multiple ratios (e.g. 2.4) no integer stride is
    // exact; nearest minimizes the rate error either way.
    const mediaFloor = Math.max(1, Math.round(this.frameStepMs / this.refreshMs));
    const target = Math.min(
      Math.max(
        Math.ceil((this.renderCapabilityEma * STRIDE_SAFETY) / this.refreshMs),
        mediaFloor,
      ),
      this.maxStride,
    );
    if (target === this.strideTargetLast) {
      this.strideTargetStreak++;
    } else {
      this.strideTargetLast = target;
      this.strideTargetStreak = 1;
    }
    if (target !== this.stride && this.strideTargetStreak >= STRIDE_STREAK) {
      this.stride = target;
      this.bufferFedStreak = 0;
      return;
    }
    const depth = this.productionCursor - this.displayCursor - 1;
    if (this.stride > mediaFloor && depth >= this.stride + BUFFER_FED_MARGIN) {
      if (++this.bufferFedStreak >= STRIDE_STREAK) {
        this.stride--;
        this.bufferFedStreak = 0;
      }
    } else {
      this.bufferFedStreak = 0;
    }
  }

  private pushSample(
    arr: number[],
    posKey: "presentIntervalPos" | "renderPos" | "compositePos",
    v: number,
  ): void {
    if (arr.length < SAMPLE_WINDOW) {
      arr.push(v);
    } else {
      arr[(this as any)[posKey] % SAMPLE_WINDOW] = v;
    }
    (this as any)[posKey] = ((this as any)[posKey] + 1) % SAMPLE_WINDOW;
  }

  stats(): RenderAheadStats {
    const iv = [...this.presentIntervals].sort((a, b) => a - b);
    const rv = [...this.renderSamples].sort((a, b) => a - b);
    const cv = [...this.compositeSamples].sort((a, b) => a - b);
    let mean = 0;
    for (let i = 0; i < iv.length; i++) mean += iv[i]!;
    mean = iv.length ? mean / iv.length : 0;
    let varSum = 0;
    for (let i = 0; i < iv.length; i++) {
      const d = iv[i]! - mean;
      varSum += d * d;
    }
    const stdev = iv.length ? Math.sqrt(varSum / iv.length) : 0;
    return {
      achievedFps: this.achievedFps,
      presentIntervalP50: percentile(iv, 50),
      presentIntervalP95: percentile(iv, 95),
      presentIntervalMax: iv.length ? iv[iv.length - 1]! : 0,
      presentIntervalStdev: stdev,
      renderP50: percentile(rv, 50),
      renderP95: percentile(rv, 95),
      compositeP50: percentile(cv, 50),
      compositeMs: this.lastCompositeMs,
      bufferDepth: this.productionCursor - this.displayCursor - 1,
      stride: this.stride,
      refreshMs: this.refreshMs,
      produced: this.produced,
      presented: this.presented,
      holds: this.holds,
      timeMs: this.lastTimeMs,
    };
  }
}
