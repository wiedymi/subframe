import { describe, expect, test } from "bun:test";
import { RenderAheadPlayer } from "../src/player/render-ahead";
import type { RenderResult } from "../src/core/pipeline";

// Drives the player with a mock 60Hz vsync and a render whose cost starts cold
// (40ms) and drops to 0.4ms — the beastars profile after frame dedup. The old
// stride logic ratcheted up during the cold phase and never recovered because
// it compared inter-production intervals (which mirror consumption once the
// buffer caps) to the refresh period. The capability-based logic must recover
// to the media floor and keep playback at the media rate.

function makeDoc(): any {
  return { events: [], styles: new Map(), dirty: false };
}

function makeResult(): RenderResult {
  return { layers: [], activeEvents: [], frame: { width: 640, height: 360 } } as any;
}

async function drive(player: RenderAheadPlayer, pump: () => Promise<void>, ticks: number) {
  for (let i = 0; i < ticks; i++) await pump();
}

describe("render-ahead stride recovery", () => {
  test("stride recovers to the media floor after a cold start", async () => {
    let clock = 0;
    const refresh = 1000 / 60;
    let rendered = 0;
    const pendingTicks: Array<(ts: number) => void> = [];
    const strideLog: number[] = [];

    const player = new RenderAheadPlayer(
      {
        render: async (_doc, _t, _w, _h) => {
          // Cold: first 30 frames cost 40ms (long enough to beat the stride
          // hysteresis and engage a slower cadence); warm: 0.4ms (dedup-served).
          const cost = rendered < 30 ? 40 : 0.4;
          rendered++;
          clock += cost;
          return makeResult();
        },
        present: () => {},
        width: () => 640,
        height: () => 360,
        now: () => clock,
        requestFrame: (cb) => pendingTicks.push(cb),
        onStats: (s) => strideLog.push(s.stride),
      },
      { fps: 60, maxAhead: 12, maxStride: 6 },
    );

    player.start(makeDoc(), 0);

    // Pump: advance the clock one refresh, fire the queued rAF callback, and
    // yield so producer microtasks run.
    const pump = async () => {
      const cbs = pendingTicks.splice(0, pendingTicks.length);
      clock += refresh;
      for (const cb of cbs) cb(clock);
      for (let i = 0; i < 8; i++) await Promise.resolve();
    };

    await drive(player, pump, 600); // ~10s of 60Hz vsyncs
    player.stop();

    const tail = strideLog.slice(-60);
    expect(tail.length).toBeGreaterThan(0);
    // Media floor at 60Hz/60fps is 1; the cold start must not pin the cadence.
    expect(Math.max(...tail)).toBe(1);
    // And the cold phase did engage a slower cadence at least once (the test
    // exercises recovery, not a never-slow path).
    expect(Math.max(...strideLog)).toBeGreaterThan(1);
  });

  test("an external media clock selects the matching frame instead of slowing time", async () => {
    let clock = 0;
    const callbacks: Array<(ts: number, mediaTimeMs?: number) => void> = [];
    const presented: number[] = [];
    const player = new RenderAheadPlayer(
      {
        render: async (_doc, timeMs) => ({ ...makeResult(), timeMs } as any),
        present: (frame) => presented.push(frame.timeMs),
        width: () => 640,
        height: () => 360,
        now: () => clock,
        requestFrame: (cb) => callbacks.push(cb),
      },
      { fps: 60, maxAhead: 12, minStartAhead: 1 },
    );

    player.start(makeDoc(), 0);
    for (let i = 0; i < 20; i++) await Promise.resolve();
    for (const mediaTimeMs of [0, 1000 / 24, 2000 / 24, 3000 / 24]) {
      const cb = callbacks.shift();
      expect(cb).toBeDefined();
      clock += 1000 / 24;
      cb!(clock, mediaTimeMs);
      for (let i = 0; i < 20; i++) await Promise.resolve();
    }
    player.stop();

    expect(presented.length).toBeGreaterThan(1);
    expect(Math.abs(presented[presented.length - 1]! - 125)).toBeLessThanOrEqual(
      1000 / 60,
    );
  });

  test("an external media-clock jump abandons an obsolete in-flight render", async () => {
    let clock = 0;
    let finishFirst!: () => void;
    const firstRender = new Promise<void>((resolve) => {
      finishFirst = resolve;
    });
    const callbacks: Array<(ts: number, mediaTimeMs?: number) => void> = [];
    const renderedTimes: number[] = [];
    const releasedTimes: number[] = [];
    const player = new RenderAheadPlayer(
      {
        render: async (_doc, timeMs) => {
          renderedTimes.push(timeMs);
          if (renderedTimes.length === 1) await firstRender;
          return { ...makeResult(), timeMs } as any;
        },
        present: () => {},
        release: (frame) => releasedTimes.push(frame.timeMs),
        width: () => 640,
        height: () => 360,
        now: () => clock,
        requestFrame: (cb) => callbacks.push(cb),
      },
      { fps: 60, maxAhead: 4, minStartAhead: 1 },
    );

    player.start(makeDoc(), 0);
    await Promise.resolve();
    clock = 1000;
    callbacks.shift()!(clock, 1000);
    finishFirst();
    for (let i = 0; i < 20; i++) await Promise.resolve();
    player.stop();

    expect(renderedTimes[0]).toBe(0);
    expect(renderedTimes[1]).toBeCloseTo(1000, 6);
    expect(releasedTimes).toContain(0);
  });

  test("restart resets pacing and session statistics", async () => {
    let clock = 0;
    let seeks = 0;
    const callbacks: Array<(ts: number, mediaTimeMs?: number) => void> = [];
    const player = new RenderAheadPlayer(
      {
        render: async () => makeResult(),
        present: () => {},
        width: () => 640,
        height: () => 360,
        now: () => clock,
        requestFrame: (cb) => callbacks.push(cb),
        onSeek: () => seeks++,
      },
      { minStartAhead: 1 },
    );
    player.start(makeDoc(), 0);
    expect(seeks).toBe(0);
    for (let i = 0; i < 10; i++) await Promise.resolve();
    clock += 1000 / 60;
    callbacks.shift()!(clock);
    expect(player.stats().presented).toBe(1);

    player.start(makeDoc(), 5000);
    expect(seeks).toBe(1);
    const stats = player.stats();
    expect(stats.presented).toBe(0);
    expect(stats.produced).toBe(0);
    expect(stats.holds).toBe(0);
    expect(stats.stride).toBe(1);
    expect(stats.presentIntervalP50).toBe(0);
    player.stop();
  });
});
