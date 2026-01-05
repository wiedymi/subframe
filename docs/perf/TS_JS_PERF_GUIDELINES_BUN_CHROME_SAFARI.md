# TS/JS Performance Guidelines (Bun + Chrome + Safari)

Focus: hot‑path runtime performance in Bun (JavaScriptCore), Chrome (V8), and Safari (JavaScriptCore), with emphasis on memory behavior and WebGL/WebGPU workloads.

## Engine fundamentals (V8 + JSC)
- **Stable shapes/structures**: add properties in the same order; avoid late additions.
- **Monomorphic call sites**: keep function calls and property access stable.
- **Avoid `delete`** in hot objects; it can deopt to slow dictionary mode.

## Arrays and numeric data
- Keep arrays **dense** and **type‑consistent** (e.g., all numbers).
- Prefer typed arrays for large numeric buffers and pixel data.
- Avoid holes (`arr[i] = ...` with gaps); holes degrade performance.

## Allocation & GC
- Minimize allocations in render loops.
- Reuse buffers and small objects; keep pools simple.
- Watch for temporary arrays/closures created per frame.

## Control flow
- Avoid megamorphic branches in tight loops.
- Keep hot loops simple; avoid nested `try/catch`.
- Prefer predictable loop bodies to help JIT inline/optimize.

## WebGL/WebGPU specifics
- Batch draw calls and state changes.
- Avoid CPU↔GPU sync (readbacks, forced flushes).
- Group buffer uploads; reuse bind groups/pipelines where possible.

## Practical “fast path” checklist
- Measure with warmup and realistic workloads (JIT tiering matters).
- Ensure objects are shape‑stable and arrays remain packed.
- Avoid frequent allocation in hot paths.
- Keep call sites monomorphic and data layouts consistent.
- Confirm improvements with macro metrics (frame time, p95, p99).
