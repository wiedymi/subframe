import type { BitmapLayer, FrameContext } from "../core/data/types";

export type CompositorStats = {
  drawCalls: number;
  uploads: number;
  atlasPages: number;
};

export type CompositorBackend = {
  kind: "webgl" | "webgpu";
  resize(width: number, height: number, dpr?: number): void;
  render(layers: BitmapLayer[], frame: FrameContext): void;
  dispose(): void;
  stats?: () => CompositorStats;
};
