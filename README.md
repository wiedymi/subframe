# Subframe

[![GitHub](https://img.shields.io/badge/-GitHub-181717?style=flat-square&logo=github&logoColor=white)](https://github.com/wiedymi)
[![Twitter](https://img.shields.io/badge/-Twitter-1DA1F2?style=flat-square&logo=twitter&logoColor=white)](https://x.com/wiedymi)
[![Email](https://img.shields.io/badge/-Email-EA4335?style=flat-square&logo=gmail&logoColor=white)](mailto:contact@wiedymi.com)
[![Discord](https://img.shields.io/badge/-Discord-5865F2?style=flat-square&logo=discord&logoColor=white)](https://discord.gg/zemMZtrkSb)
[![Support me](https://img.shields.io/badge/-Support%20me-ff69b4?style=flat-square&logo=githubsponsors&logoColor=white)](https://github.com/sponsors/vivy-company)

Subframe is a realtime ASS/SSA subtitle renderer for web and Bun. It renders Subforge `SubtitleDocument` directly, targets libass visual parity, and is written entirely in TypeScript plus WGSL — no libass-to-wasm builds involved.

- **Measured on hostile content.** The repository includes Bun and real-browser harnesses for the JASSUB suite, including the Beastars frame-by-frame typesetting storm. Current measured tails are recorded in `docs/GOALS.md`; 60 fps is a target, not a blanket guarantee.
- **Byte-exact GPU filters.** Blur and subpixel shift run as batched WGSL compute fused into the composite submit. A hardware gate proves GPU output identical (`maxDiff 0`) to the CPU reference path.
- **Deterministic CPU core.** Fixed-point (1/64 px) layout and raster; same inputs, same pixels. The CPU path is the source of truth and the fallback when no GPU is available.
- **Bounded memory.** Byte-bounded caches and buffer recycling keep the heaviest benchmark fixture around ~106 MB steady JS heap; typical content runs in tens of MB.

## Install

```sh
bun add subframe subforge
# or: npm install subframe subforge
```

Fonts are your responsibility: register the font files your subtitles use (see below). Subframe ships no fonts.

## Quick start (browser)

```ts
import { parseASS } from "subforge/ass";
import { Subframe } from "subframe";

const canvas = document.querySelector("canvas")!;

const doc = parseASS(await (await fetch("/subs.ass")).text(), {
  onError: "collect",
}).document;

const sf = new Subframe({
  canvas,
  backend: "auto", // WebGPU -> WebGL -> Canvas2D CPU fallback
  fonts: [
    await (await fetch("/fonts/Lato-Regular.ttf")).arrayBuffer(),
  ],
});

await sf.ready;
sf.resize(canvas.width, canvas.height);
await sf.setDocument(doc);

// Manual clock: render and composite one subtitle frame.
await sf.render(video.currentTime * 1000);

// Or let Subframe drive requestVideoFrameCallback-synced playback.
sf.attachVideo(video);
```

Notes:

- `Subframe` starts async initialization in the constructor; `ready`, `render()`, and `frame()` queue behind it.
- Workers default on. Package builds embed an inline module worker; strict CSP pages can serve the exported `subframe/worker-entry.js` asset from their own origin and pass that URL through `workerUrl`, or use `workers: false` to stay single-threaded.
- Only one live `Subframe` instance is supported per page for now because the renderer core owns module-global caches and worker-pool state.
- Seeking needs no special handling — jump the time you pass to `render()` or the attached video; the pipeline re-primes itself.

## Quick start (Bun / offline)

```ts
import { parseASS } from "subforge/ass";
import { Subframe } from "subframe";

const doc = parseASS(await Bun.file("episode.ass").text(), { onError: "collect" }).document;

const sf = new Subframe({
  fonts: [await Bun.file("fonts/Lato-Regular.ttf").arrayBuffer()],
});
await sf.ready;
sf.resize(1920, 1080);
await sf.setDocument(doc);

const { layers, release } = await sf.frame(90_000);
// Each layer is a grayscale bitmap + premultiply color + placement — composite
// however you like (Canvas2D, PNG encode, an encoder pipeline, ...):
for (const layer of layers) {
  // layer.bitmap (Uint8Array), layer.width / height / stride,
  // layer.originX / originY (pixel coordinates), layer.color, layer.z
}
release();
sf.dispose();
```

The same worker pool runs under Bun for realtime server-side rendering. Use `workers: false` for deterministic single-threaded scripts.

## Fonts

`new Subframe({ fonts })` accepts an array of font bytes, `Blob`/`File` objects, or URLs. Each file is parsed once and registered under its own names from the font name table: family, typographic family, full name, and PostScript name. Name matching remains case-insensitive.

```ts
const sf = new Subframe({
  canvas,
  fonts: [
    await (await fetch("/fonts/Lato-Regular.ttf")).arrayBuffer(),
    "/fonts/Allison-Regular.otf",
  ],
  fontResolver: async (name) => {
    const res = await fetch(`/fallback-fonts/${encodeURIComponent(name)}.ttf`);
    return res.ok ? await res.arrayBuffer() : null;
  },
});
```

Font resolution priority is:

1. Embedded ASS `[Fonts]` data on the active document.
2. The `fonts` input passed to `Subframe`.
3. `fontResolver`.
4. Chromium Local Font Access API, when available and permitted.

Local Font Access requires Chromium support and usually a user gesture/permission grant; denied or unavailable access silently falls through to the next source. Embedded ASS fonts are decoded from the script's UUEncoded `[Fonts]` section and registered by the decoded font's own names, not by the embedded filename.

The old name-keyed object form is accepted as deprecated compatibility before publish, but new integrations should use the array form.

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
| `new Subframe({ workerUrl })` / `setWorkerSource(url)` | inline worker / unset | Worker bootstrap. `workerUrl` is the CSP escape hatch; low-level callers can still use `setWorkerSource`. |
| `setWorkerPool(false)` / `setWorkerCount(n)` | on / auto | Disable or size the pool. |
| `await sf.setDocument(doc)` / `attachDocument(doc, w, h)` | — | Public facade attach/warmup, or explicit low-level warmup. |
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

Builds the worker in memory, injects it through a build plugin without modifying source files, emits `dist/index.js`, `dist/worker-entry.js`, and generated declarations, then type-checks the public package. The inline worker increases the main bundle size; pass `workerUrl` if your deployment prefers the exported standalone worker or blocks Blob workers with CSP.

## Advanced / core API

The facade owns backend selection, font registration, worker lifecycle, document warmup, playback scheduling, and result lifetime. Advanced integrations can compose the intentionally exported low-level pieces directly:

```ts
import {
  createWebGPUBackend,
  renderFrame,
  releaseRenderResult,
  registerFontSource,
  setWorkerSource,
} from "subframe";
```

Use the core API when you need custom scheduling, tracing, or backend ownership. If you buffer returned `RenderResult`s, call `releaseRenderResult(result)` only after the last presentation of that frame.

## Verification tooling

The repo carries its own proof harnesses; all run headless:

```sh
bun test ./test                                # unit + render tests
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
