# TS/JS Performance Guidelines (General)

Source: ts_js_performance_cheatsheet.pdf (2025-12-30)

## Principles
- Predictable code is fast code: stable object shapes, dense arrays, consistent types.
- Measure on real workloads; avoid overfitting to microbenchmarks.
- Use the simplest structure that matches semantics, then verify with a profiler.

## Measuring correctly
- Warm up the JIT.
- Use realistic input sizes and the same process for comparisons.
- Keep outputs alive to avoid dead-code elimination.
- Use profilers for final decisions; microbenchmarks only validate single changes.

## Objects and classes
- Initialize properties up front in a fixed order.
- Avoid delete in hot code; use sentinel values or rebuild off the hot path.
- Avoid dynamic property keys in hot loops; specialize by key or use Map.
- Prefer Map for large, dynamic key sets; use objects for small fixed fields.
- Class fields are generally fine, but constructor assignments are the most predictable.
- Avoid Proxy in hot paths; keep it at boundaries.

## Arrays
- Prefer indexed for/for...of in hot loops over callback-based iteration.
- Avoid holes (delete or sparse indices) in hot arrays.
- Preallocate arrays when size is known, but validate downstream performance.
- Keep arrays type-consistent; use typed arrays for numeric-heavy work.
- Do not read past array.length in hot loops.

## Strings and text
- Choose join vs += based on workload shape; preallocate arrays when joining many parts.
- Prefer the API with correct semantics (slice vs substring), then measure if it matters.
- Use TextDecoder or Buffer.toString for UTF-8 decoding; reuse decoders.
- Compile RegExp once when used repeatedly.

## Functions and control flow
- Avoid per-iteration closure creation in hot code; hoist callbacks.
- Avoid repeated bind/apply in hot paths; bind once or call directly.
- Do not use exceptions for normal control flow; use error-returning APIs.

## Memory and GC
- Avoid intermediate arrays in hot pipelines; use single-pass loops.
- Reuse large buffers when safe; be careful with allocUnsafe.
- Avoid unbounded caches and accidental retention.

## Binary data and parsing
- Use TypedArray views for bulk numeric reads; DataView for endianness or unaligned fields.
- Use bulk copies (TypedArray.set, Buffer.copy) instead of per-byte loops.
- Avoid repeated buffer concatenation; parse incrementally with a cursor or ring buffer.

## Web performance (DOM)
- Separate layout reads from writes to avoid layout thrash.
- Batch DOM inserts with DocumentFragment.
- Prefer transform/opacity for animations and schedule with requestAnimationFrame.

## WebGL
- Batch draw calls and minimize state changes.
- Avoid readPixels and getError in the frame loop.

## WebGPU
- Create resources once and update buffers instead of recreating.
- Cache pipelines and bind groups; reuse layouts.
- Consider render bundles for repeated static draws.
- Use queue.writeBuffer for small updates; map buffers for large streaming only when needed.

## TypeScript notes
- Runtime performance depends on emitted JS, not TS types.
- useDefineForClassFields is a correctness choice, not a direct perf knob.
- Build-time performance: use incremental builds and project references in large repos.

## Sample trend hints (do not treat as universal)
- Callback-based loops can be much slower than indexed loops in hot paths.
- Dynamic property keys and delete can severely slow property access.
- Preallocation can help large array builds; test for your usage.
