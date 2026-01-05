# TS/JS Performance Guidelines (General)

This document summarizes the general (engine-agnostic) performance guidance from the project performance cheat sheets. Always validate changes with real workloads and profilers.

## 1) Measure correctly
- Prefer macro profiling over microbenchmarks; confirm wins at the frame/RPS level.
- Warm up JITs before timing; run multiple samples and report median/p95.
- Keep outputs alive (sink variables) to avoid dead-code elimination.
- Benchmark on target devices/browsers; results vary across engines.

## 2) Object shapes and property access
- Initialize objects with all properties upfront; keep insertion order consistent.
- Avoid `delete` on hot objects; it can push shapes into slow dictionary mode.
- Keep call sites monomorphic (same shapes/types); avoid megamorphic sites.

## 3) Arrays and iteration
- Keep arrays dense; avoid holes and mixed element types.
- Prefer numeric arrays (or typed arrays) for hot numeric loops.
- Use indexed `for` loops in hot paths; avoid allocating intermediate arrays.
- Cache `length` in tight loops when it helps readability and avoids re-reads.

## 4) Functions and control flow
- Avoid creating closures in tight loops.
- Keep call sites predictable; avoid dynamic function dispatch in hot paths.
- Avoid `try/catch` inside hot loops (use at boundaries if possible).

## 5) Strings and text
- Avoid repeated concatenation in large loops; batch into arrays and `join`.
- Prefer slicing over regex when parsing is simple and hot.
- Minimize per-iteration allocations when building strings.

## 6) Memory and GC
- Reduce allocation rate in hot paths; reuse buffers and objects.
- Pool frequently created objects (but keep pool logic simple and fast).
- Avoid short-lived large allocations in per-frame code.

## 7) Binary data and buffers
- Prefer `Uint8Array`/`Float32Array` over JS arrays for large numeric data.
- Avoid creating many small `DataView` wrappers in hot loops.
- Reuse buffer views where possible.

## 8) Web performance (DOM + main thread)
- Batch DOM changes; avoid forced reflow/relayout in loops.
- Use `requestAnimationFrame` for UI updates; minimize work per frame.
- Avoid excessive event handlers or per-event allocations.

## 9) WebGL/WebGPU
- Batch draw calls; minimize CPU→GPU sync points.
- Reuse pipelines/shaders and bind groups where possible.
- Upload buffers in large chunks rather than many small calls.

## 10) Practical checklist for hot paths
- Algorithmic wins first (big‑O, data layout).
- Stable object shapes; dense arrays; no `delete`.
- Avoid per-iteration allocations (closures, temporary arrays).
- Monomorphic access patterns; predictable branches.
- Profile, don’t guess.
