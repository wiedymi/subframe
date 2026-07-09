# Subframe

[![GitHub](https://img.shields.io/badge/-GitHub-181717?style=flat-square&logo=github&logoColor=white)](https://github.com/wiedymi)
[![Twitter](https://img.shields.io/badge/-Twitter-1DA1F2?style=flat-square&logo=twitter&logoColor=white)](https://x.com/wiedymi)
[![Email](https://img.shields.io/badge/-Email-EA4335?style=flat-square&logo=gmail&logoColor=white)](mailto:contact@wiedymi.com)
[![Discord](https://img.shields.io/badge/-Discord-5865F2?style=flat-square&logo=discord&logoColor=white)](https://discord.gg/zemMZtrkSb)
[![Support me](https://img.shields.io/badge/-Support%20me-ff69b4?style=flat-square&logo=githubsponsors&logoColor=white)](https://github.com/sponsors/vivy-company)

Subframe is a realtime ASS/SSA subtitle renderer for web and Bun. It renders Subforge `SubtitleDocument` directly, targets libass visual parity, and is written entirely in TypeScript plus WGSL — no libass-to-wasm builds involved.

- **Realtime on hostile content.** The jassub benchmark suite — including the Beastars frame-by-frame typesetting storm (~120 events, ~2,100 layers per frame) — plays at 60 fps with zero dropped frames (Apple Silicon, headless Chrome).
- **Byte-exact GPU filters.** Blur and subpixel shift run as batched WGSL compute fused into the composite submit. A hardware gate proves GPU output identical (`maxDiff 0`) to the CPU reference path.
- **Deterministic CPU core.** Fixed-point (1/64 px) layout and raster; same inputs, same pixels. The CPU path is the source of truth and the fallback when no GPU is available.
- **Bounded memory.** Byte-bounded caches and buffer recycling keep the heaviest benchmark fixture around ~106 MB steady JS heap; typical content runs in tens of MB.

## Install

```sh
bun add subframe subforge
# or: npm install subframe subforge
```

Fonts are your responsibility: register the font files your subtitles use (see below). Subframe ships no fonts.

## Quick start (browser, WebGPU)

```ts
import { parseASS } from "subforge/ass";
import {
  createWebGPUBackend,
  registerFontSource,
  attachDocument,
  renderFrame,
  releaseRenderResult,
  setWorkerSource,
} from "subframe";

// 1. Fonts: register every family the script uses (ArrayBuffer or URL string).
registerFontSource("Lato", await (await fetch("/fonts/Lato-Regular.ttf")).arrayBuffer());

// 2. Workers (recommended): point the pool at the bundled worker entry.
//    The package build emits dist/worker-entry.js next to dist/index.js —
//    serve it and pass its URL. Without this, rendering stays single-threaded.
setWorkerSource("/node_modules/subframe/dist/worker-entry.js");

// 3. Backend: composites layers into your canvas. GPU filters default ON.
const canvas = document.querySelector("canvas")!;
const backend = await createWebGPUBackend({ canvas });

// 4. Document: parse once, attach once. attachDocument warms fonts, workers,
//    and the frame pipeline in the background so the first frames are cheap.
const doc = parseASS(await (await fetch("/subs.ass")).text(), {
  onError: "collect",
}).document;
void attachDocument(doc, canvas.width, canvas.height);

// 5. Render loop: feed media time (ms), composite, release when done showing.
let shown: Awaited<ReturnType<typeof renderFrame>> | null = null;
function onFrame(mediaTimeMs: number) {
  void renderFrame(doc, mediaTimeMs, canvas.width, canvas.height).then((result) => {
    backend.render(result.layers, result.frame);
    if (shown && shown !== result) releaseRenderResult(shown);
    shown = result;
  });
}
// Drive onFrame from requestVideoFrameCallback / your player clock.
```

Notes:

- `renderFrame` is safe to call at display rate. Duplicate subtitle frames (static content sampled faster than it changes) are served by reference in ~0.1 ms; unique frames are pre-rendered on the worker pool ahead of their deadline.
- `releaseRenderResult(result)` is optional but recommended for players that buffer frames: it returns the frame's transport buffers to the worker pool. Never call it while the frame can still be composited.
- Seeking needs no special handling — jump the time you pass to `renderFrame`; the pipeline re-primes itself.

## Quick start (Bun / offline)

```ts
import { parseASS } from "subforge/ass";
import { renderFrame, registerFontSource } from "subframe";

registerFontSource("Lato", await Bun.file("fonts/Lato-Regular.ttf").arrayBuffer());
const doc = parseASS(await Bun.file("episode.ass").text(), { onError: "collect" }).document;

const { layers } = await renderFrame(doc, 90_000, 1920, 1080);
// Each layer is a grayscale bitmap + premultiply color + placement — composite
// however you like (Canvas2D, PNG encode, an encoder pipeline, ...):
for (const layer of layers) {
  // layer.bitmap (Uint8Array), layer.width / height / stride,
  // layer.originX / originY (1/64 px fixed point), layer.color, layer.z
}
```

The same worker pool runs under Bun (`setWorkerSource` with the worker entry path) for realtime server-side rendering.

## Backends

| Backend | Entry | Notes |
|---|---|---|
| WebGPU | `createWebGPUBackend({ canvas, enableGpuFilters? })` | Default choice. Batched WGSL filter chain fused into the composite; `enableGpuFilters` defaults on. |
| WebGL | `createWebGLBackend({ canvas })` | Compositing only; filters run on CPU. |
| none | — | `renderFrame` returns plain bitmap layers; composite anywhere. |

Playground backend selection order: WebGPU → WebGL → CPU.

## Performance knobs

Everything defaults to the fast path; these exist for A/B tests and constrained hosts.

| Control | Default | Purpose |
|---|---|---|
| `setWorkerSource(url)` | unset | Enables the worker pool (parallel rendering, prewarm, frame pipeline). |
| `setWorkerPool(false)` / `setWorkerCount(n)` | on / auto | Disable or size the pool. |
| `attachDocument(doc, w, h)` | — | Optional explicit warmup at load; otherwise warmup self-triggers on playback. |
| `setMemoryBudget(bytes)` | ~120 MB ceilings | Scales all byte-bounded caches proportionally. |
| `setFrameHybrid(false)` / `setFrameScatter(false)` | on | A/B switches for the frame pipeline engines. |
| `releaseRenderResult(result)` | — | Returns a consumed frame's buffers to the pool (buffering players). |

## Playground

```sh
bun run playground
```

Local demo UI with a live perf panel (display cadence, pipeline stats, memory, GPU counters), backend switcher, and GPU self-tests. Workers and GPU filters are on by default (`?workers=0` opts out).

## Build

```sh
bun run build
```

Emits `dist/index.js` and `dist/worker-entry.js` (ESM, browser target).

## Verification tooling

The repo carries its own proof harnesses; all run headless:

```sh
bun test test/                                 # unit + render tests
bun run test:golden                            # golden-image parity fixtures
bun run tools/parity/sweep.ts                  # frame sweep vs native libass (pixel diff)
bun run tools/gpu-headless/run-headless.ts     # GPU==CPU byte-exactness gate (real hardware)
bun run tools/gpu-headless/run-bench.ts        # headless-Chrome realtime benchmark
bun run tools/gpu-headless/run-versus.ts       # side-by-side vs JASSUB on its own fixtures
```

Parity is enforced, not claimed: the golden suite and the parity sweep compare against a native libass build (`tools/ref/`), and the hardware gate rejects any GPU change that is not byte-identical to the CPU path. Current parity scope and known gaps live in `docs/GOALS.md`.

## Repository layout

```
src/            # Renderer core + backends
playground/     # Local demo UI
docs/           # Goals, architecture, perf notes
tools/          # Parity, diff, bench, and GPU verification tooling
test/           # Fixtures and golden data
refs/           # Reference submodules (libass, subforge, text-shaper)
```

## Submodules

Reference submodules are used for parity research only (not needed to use the library):

```sh
git submodule update --init --recursive
```

See `refs/README.md` for details.

## License

MIT. See `LICENSE`.
