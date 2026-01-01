# Test harness (planned)

Purpose: render the same ASS input with libass and subframe, then compare images and traces.

Planned pieces:
- Render libass to PNG at fixed timestamps.
- Render subframe to PNG at the same timestamps.
- Produce a diff heatmap and summary statistics.
- Emit JSON traces for pipeline stage debugging.

This is a placeholder; implementation will be added when the render pipeline is ready.
