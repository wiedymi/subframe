import type { BitmapLayer, FrameContext } from "../core/data/types";

export type CompositorStats = {
  drawCalls: number;
  uploads: number;
  atlasPages: number;
  gpuFilter?: {
    routedLayers: number;
    groups: number;
    requests: number;
    inputBytes: number;
    outputBytes: number;
    copyBytes: number;
    copies: number;
    cacheHits: number;
    cacheMisses: number;
    areaLt1k: number;
    areaLt4k: number;
    areaLt16k: number;
    areaGte16k: number;
    filterSubmitted: number;
    filterRounds?: number;
    filterJobs?: number;
    filterPixels?: number;
    maskRequests?: number;
    maskUploads?: number;
    maskPixels?: number;
    inputCpuMs: number;
    filterCpuMs: number;
    copyCpuMs: number;
    totalCpuMs: number;
  };
};

export type CompositorBackend = {
  kind: "webgl" | "webgpu";
  resize(width: number, height: number, dpr?: number): void;
  render(layers: BitmapLayer[], frame: FrameContext): void;
  dispose(): void;
  stats?: () => CompositorStats;
};
