# Subframe

[![GitHub](https://img.shields.io/badge/-GitHub-181717?style=flat-square&logo=github&logoColor=white)](https://github.com/wiedymi)
[![Twitter](https://img.shields.io/badge/-Twitter-1DA1F2?style=flat-square&logo=twitter&logoColor=white)](https://x.com/wiedymi)
[![Email](https://img.shields.io/badge/-Email-EA4335?style=flat-square&logo=gmail&logoColor=white)](mailto:contact@wiedymi.com)
[![Discord](https://img.shields.io/badge/-Discord-5865F2?style=flat-square&logo=discord&logoColor=white)](https://discord.gg/zemMZtrkSb)
[![Support me](https://img.shields.io/badge/-Support%20me-ff69b4?style=flat-square&logo=githubsponsors&logoColor=white)](https://github.com/sponsors/vivy-company)

Subframe is a WebGL-first subtitle renderer that renders Subforge `SubtitleDocument` directly and targets libass visual parity for ASS/SSA on web and Bun. The core is CPU-rendered and deterministic; GPU backends only composite bitmaps.

## Status
- Early but working. Visual parity is focused on the documented scope in `docs/GOALS.md`.
- WebGL and WebGPU backends are available; the CPU path remains the source of truth.

## Features
- Deterministic, fixed-point (1/64 px) core rendering.
- libass-style raster + post filters (outline/blur/shadow).
- WebGL/WebGPU compositors with atlas-less uploads per layer (easy to extend later).
- Trace tooling for debug and parity analysis.

## Playground
```
bun playground/index.html
```
Default backend selection order: WebGPU → WebGL → CPU.

## Parity quickstart (smoke)
1) Build libass (submodule): `tools/ref/build_libass.sh`
2) Build the render helper (see `tools/ref/README.md`)
3) Run the smoke parity test:
```
bun run test:golden:smoke -- --trace-on-fail
```

## Repository layout
```
src/            # Renderer core + backends
playground/     # Local demo UI
docs/           # Goals, architecture, perf notes
tools/          # Parity and diff tooling
test/           # Fixtures and golden data
refs/           # Reference submodules (libass, subforge, text-shaper)
```

## Submodules
This repo uses reference submodules for implementation parity research:
```
git submodule update --init --recursive
```
See `refs/README.md` for details.

## License
MIT. See `LICENSE`.
