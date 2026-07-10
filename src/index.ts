// Stable public surface. Keep implementation helpers reachable through their
// source modules inside this repository, but do not publish them accidentally.
export {
  Subframe,
  type SubframeBackend,
  type SubframeFrame,
  type SubframeOptions,
  type SubframeStats,
} from "./subframe";

export {
  attachDocument,
  getFramePipelineStats,
  getWorkerPoolStats,
  prepareDocument,
  releaseRenderResult,
  renderFrame,
  renderFrameWithTrace,
  resetFramePipeline,
  setFrameHybrid,
  setFramePipeline,
  setFrameScatter,
  setRenderAhead,
  setWorkerCount,
  setWorkerPool,
  setWorkerSource,
  type AttachDocumentOptions,
  type AttachDocumentStats,
  type FramePipelineStats,
  type PrepareDocumentOptions,
  type RenderResult,
  type WorkerSource,
} from "./core/pipeline";
export {
  prewarmFrameFromDocument,
  renderFrameFromDocument,
  renderFrameFromDocumentWithTrace,
  type RenderDocumentResult,
  type RenderTraceResult,
} from "./core/render";
export { getMemoryStats, setMemoryBudget, type MemoryStats } from "./core/memory";
export type { BitmapLayer, ColorRGBA, FrameContext } from "./core/data/types";

export {
  registerFontSource,
  resetFontCache,
  setFontResolver,
  type FontResolver,
  type FontSource,
} from "./io/fonts/cache";
export type { SubframeFontInput } from "./io/fonts/sources";

export {
  createWebGLBackend,
  type WebGLBackendOptions,
} from "./backend/webgl";
export {
  createWebGPUBackend,
  type WebGPUBackendOptions,
} from "./backend/webgpu";
export type { CompositorBackend, CompositorStats } from "./backend/types";

export {
  RenderAheadPlayer,
  type BufferedFrame,
  type RenderAheadDeps,
  type RenderAheadOptions,
  type RenderAheadStats,
} from "./player/render-ahead";
