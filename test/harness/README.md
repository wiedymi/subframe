# Test harness

Purpose: render the same ASS input with libass and subframe, then compare images and traces.

Implemented pieces:
- Render libass to PNG at fixed timestamps (see `tools/ref/render_libass`).
- Render subframe to PNG at the same timestamps (see `tools/ref/render_subframe.ts`).
- Produce a diff heatmap and summary statistics (see `tools/diff/pngdiff.ts`).
- Orchestrate runs from a manifest (see `tools/run-golden.ts` and `test/manifest.json`).
- Dump minimal layout trace JSON (see `tools/trace/render_trace.ts`).

Remaining pieces:
- Expand traces to include raster/filter/composite stages (planned).
