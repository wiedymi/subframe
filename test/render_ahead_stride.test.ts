import { describe, expect, test } from "bun:test";
import { RenderAheadPlayer } from "../playground/render-ahead";
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
});
