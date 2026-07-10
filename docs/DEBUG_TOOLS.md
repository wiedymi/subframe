# Debug and verification tools

Only tools that currently exist are listed here.

- `tools/ref/render_libass`: native libass frame renderer (built by `tools/ref/build_libass.sh`).
- `tools/ref/render_subframe.ts`: Subframe frame renderer used by the golden harness.
- `tools/diff/pngdiff.ts`: PNG heatmap and summary statistics.
- `tools/diff/bbox_compare.ts` and `layer_bbox_compare.ts`: frame/layer bounds comparisons.
- `tools/trace/render_trace.ts`: JSON trace for a frame.
- `tools/trace/render_event.ts`: targeted event render/trace.
- `tools/trace/trace_diff.ts` and `move_rotate_diff.ts`: locate the first trace or transform mismatch.
- `tools/parity/sweep.ts`: multi-frame libass comparison.
- `tools/parity/analyze_pair.ts`: alpha bounds, best integer translation, and coverage-error statistics for a libass/Subframe PNG pair.
- `tools/bench/*`: Bun micro, fixture, reference, baseline-update, and comparison harnesses.
- `tools/gpu-headless/run-headless.ts`: real-WebGPU CPU/GPU byte-equality gate.
- `tools/gpu-headless/run-worker-check.ts`: browser worker bootstrap check.
- `tools/gpu-headless/run-bench.ts`, `run-smoothness.ts`, and `run-versus.ts`: browser performance harnesses.
- `tools/gpu-headless/run-heap-profile.ts`: browser heap/profile capture.

The trace schema exposes resolved event/style inputs, line placement, transform values, glyph/layer bounds, filter parameters, clips, and final ordering. A standalone repro packager and graphical trace viewer remain future work; they are not currently shipped.
