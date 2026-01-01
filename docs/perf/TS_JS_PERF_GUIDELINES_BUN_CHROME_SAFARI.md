# TS/JS Performance Guidelines (Bun + Chrome + Safari)

Source: ts_js_perf_cheatsheet_bun_chrome_safari_DEEP.pdf (2025-12-30)

## Core goals
- Favor algorithmic wins before micro-optimizations.
- Keep allocation rate low in hot paths.
- Keep object shapes stable and arrays dense.
- Batch GPU work and avoid CPU-GPU sync points.
- Measure on your real target (Bun/JSC, Chrome/V8, Safari/JSC).

## Measuring without fooling yourself
- Warm up JIT tiers before timing.
- Make each sample large enough (roughly 1-50 ms) to avoid timer noise.
- Keep a sink value to prevent dead-code elimination.
- Run multiple samples and report median and p90.
- Always verify micro wins with macro metrics (fps, p95 latency, memory).

## Engine fundamentals
- Shape stability drives fast property access in both V8 and JSC.
- Inline caches (ICs) get slower when a site sees many shapes or types.
- Frequent add/remove or delete can push objects into slower modes.

## Objects and classes
- Initialize all fields up front in a fixed order.
- Avoid delete in hot code; use sentinel values or rebuild off the hot path.
- Prefer data properties over getters/setters and Proxy in hot loops.
- Choose the right structure: object for small fixed keys, Map for dynamic keys, array for ordered data, Set for membership.
- Avoid polymorphic options objects in hot functions; normalize once or use positional args.

## Functions and call overhead
- Avoid creating closures in hot loops; prefer simple loops or hoisted callbacks.
- Keep call sites monomorphic; split by type when needed.
- Avoid bind/apply/call in hot paths; prebind once if needed.
- Do not use exceptions for normal control flow.

## Arrays and iteration
- Keep arrays dense (no holes) and element types consistent.
- Preallocate when size is known.
- Prefer for/while for hot loops; for...of over arrays is often OK.
- Avoid destructuring and spread in tight loops.
- Use TypedArray for numeric kernels.
- Use Set for large membership checks instead of array includes.

## Strings and text
- Many parts: join can win; few parts: direct concatenation is fine.
- Avoid repeated substring allocation in loops; scan by index and materialize only at boundaries.
- Prefer TextDecoder/TextEncoder for UTF-8.
- Cache Intl formatters.

## Numbers and formatting
- Do not mix Number and BigInt in hot code.
- Bitwise ops coerce to 32-bit; use them intentionally, not as a speed hack.
- Avoid toFixed/toString in hot loops; format at boundaries.

## Memory and GC
- Reuse buffers and objects when safe; avoid per-iteration allocations.
- Use pools only for very hot paths and keep them bounded.
- Avoid accidental retention (unbounded caches, lingering listeners, large arrays kept alive).

## Async and promises
- Avoid await inside loops; use concurrency-limited workers.
- Avoid creating massive numbers of Promises in hot loops.

## Binary data
- Prefer subarray() over slice() to avoid copies.
- Use DataView for explicit endianness and unaligned reads.
- Decode into arrays/buffers rather than per-field objects.
- Avoid atob/btoa for large data; use Uint8Array or Buffer-based codecs.

## Bun-specific tips
- Prefer Bun.serve for HTTP handling when it fits.
- Stream files instead of reading whole buffers.
- Use Bun.write or FileSink for fast writes.

## Browser performance (DOM)
- Separate layout reads from writes to avoid layout thrash.
- Use requestAnimationFrame for render loops and keep per-frame allocations near zero.
- Use passive listeners for scroll/touch where possible.

## WebGL performance
- Batch draw calls and reduce state changes.
- Use VAOs in WebGL2 for cheaper attribute setup.
- Avoid gl.getError and gl.finish in production loops.
- Avoid readPixels in the frame loop; use async techniques if needed.

## WebGPU performance
- Create pipelines once and cache them.
- Cache bind groups; use dynamic offsets and ring buffers for updates.
- Use render bundles for static geometry.
- Avoid CPU-GPU sync; do readbacks sparingly and off the critical path.
- Measure GPU time with timestamp queries when available.

## TypeScript emission gotchas
- Target ES2022+ for Bun and modern browsers.
- Beware downlevelIteration in hot loops; native for...of is usually faster.
- Avoid accidental polyfills that add heavy runtime cost.

## When Chrome is fast but Safari/Bun is slow
- Confirm warm-up and steady state.
- Look for polymorphism, mixed array types, variable keys.
- Look for hidden allocations (spread, destructuring, substring in loops).
- Check for CPU-GPU sync points.
- Profile with Chrome DevTools and Safari Web Inspector.

## Quick rewrites
- Optional/missing props -> initialize all fields with sentinels.
- delete obj.k -> obj.k = undefined (or rebuild off hot path).
- obj[key] in inner loop -> fixed property access or Map/array.
- any[] mixing types -> dense arrays or typed arrays.
- forEach/map/reduce in hot loops -> for/while with preallocated output.
- slice() in parsers -> cursor + subarray().
- per-frame pipeline/bind group creation -> cache and reuse.
- gl.readPixels each frame -> avoid or make async/off critical path.
- read entire file into memory -> stream it.
