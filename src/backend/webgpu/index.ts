import type { BitmapLayer, FrameContext } from "../../core/data/types";
import type { CompositorBackend, CompositorStats } from "../types";
import { AtlasAllocator, type AtlasSlot } from "../atlas-allocator";
import { WEBGPU_SHADER_SOURCE } from "./shaders";
import { computeGpuBlurDims, setGpuFilterProvider } from "../../core/filters/gpu-provider";
import { BatchedGpuBlurEngine, type FilterGroupInput, type FilterLayerRequest } from "./blur-batch";

// GPU integer-compute blur re-exports. BatchedGpuBlurEngine IS the render
// path's filter engine (runGpuFilters below, single submit with the composite);
// GpuBlurEngine and GpuFilteredCache remain selftest/offline-only
// (readback-based) and ship for the hardware gate.
export { GpuBlurEngine, findBestMethod, type GpuBlurResult, type BlurMethod } from "./blur";
export {
  BatchedGpuBlurEngine,
  GpuFilteredCache,
  computeOutDims,
  hashMask,
  type BatchMask,
  type BatchResult,
  type FilterRequest,
  type FilterHandle,
} from "./blur-batch";

export type WebGPUBackendOptions = {
  canvas: HTMLCanvasElement;
  powerPreference?: "low-power" | "high-performance";
  atlasSize?: number;
  atlasPadding?: number;
  // GPU-resident filter path. Defaults ON once the backend initializes
  // successfully; opt out with `enableGpuFilters: false` or (under a process)
  // env SUBFRAME_GPU_FILTERS=0.
  enableGpuFilters?: boolean;
};

function readGpuFiltersEnv(): boolean {
  try {
    if (
      typeof process !== "undefined" &&
      (process as any).env?.SUBFRAME_GPU_FILTERS === "0"
    ) {
      return false;
    }
  } catch {
    /* no process env: fall through to default ON */
  }
  return true;
}

const VERTEX_DATA = new Float32Array([
  0, 0, 0, 0,
  1, 0, 1, 0,
  0, 1, 0, 1,
  0, 1, 0, 1,
  1, 0, 1, 0,
  1, 1, 1, 1,
]);

type GpuFilterRenderStats = NonNullable<CompositorStats["gpuFilter"]>;

function emptyGpuFilterStats(): GpuFilterRenderStats {
  return {
    routedLayers: 0,
    groups: 0,
    requests: 0,
    inputBytes: 0,
    outputBytes: 0,
    copyBytes: 0,
    copies: 0,
    cacheHits: 0,
    cacheMisses: 0,
    areaLt1k: 0,
    areaLt4k: 0,
    areaLt16k: 0,
    areaGte16k: 0,
    filterSubmitted: 0,
    filterRounds: 0,
    filterJobs: 0,
    filterPixels: 0,
    maskRequests: 0,
    maskUploads: 0,
    maskPixels: 0,
    inputCpuMs: 0,
    filterCpuMs: 0,
    copyCpuMs: 0,
    totalCpuMs: 0,
  };
}

function align(value: number, alignment: number): number {
  return Math.ceil(value / alignment) * alignment;
}

function createTexture(
  device: GPUDevice,
  width: number,
  height: number,
): { texture: GPUTexture; view: GPUTextureView } {
  const texture = device.createTexture({
    size: { width, height, depthOrArrayLayers: 1 },
    format: "r8unorm",
    usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
  });
  return { texture, view: texture.createView() };
}

function createPipeline(
  device: GPUDevice,
  format: GPUTextureFormat,
  layout: GPUPipelineLayout,
): GPURenderPipeline {
  const module = device.createShaderModule({ code: WEBGPU_SHADER_SOURCE });
  return device.createRenderPipeline({
    layout,
    vertex: {
      module,
      entryPoint: "vs",
      buffers: [
        {
          arrayStride: 16,
          attributes: [
            { shaderLocation: 0, offset: 0, format: "float32x2" },
            { shaderLocation: 1, offset: 8, format: "float32x2" },
          ],
        },
      ],
    },
    fragment: {
      module,
      entryPoint: "fs",
      targets: [
        {
          format,
          blend: {
            color: {
              srcFactor: "one",
              dstFactor: "one-minus-src-alpha",
              operation: "add",
            },
            alpha: {
              srcFactor: "one",
              dstFactor: "one-minus-src-alpha",
              operation: "add",
            },
          },
          writeMask: GPUColorWrite.ALL,
        },
      ],
    },
    primitive: { topology: "triangle-list" },
  });
}

export async function createWebGPUBackend(
  options: WebGPUBackendOptions,
): Promise<CompositorBackend> {
  if (!("gpu" in navigator)) throw new Error("WebGPU: navigator.gpu unavailable");
  const adapter = await navigator.gpu.requestAdapter({
    powerPreference: options.powerPreference,
  });
  if (!adapter) throw new Error("WebGPU: adapter request failed");
  const device = await adapter.requestDevice();
  const context = options.canvas.getContext("webgpu") as GPUCanvasContext | null;
  if (!context) throw new Error("WebGPU: context creation failed");

  const format = navigator.gpu.getPreferredCanvasFormat();
  const queue = device.queue;
  const atlasSize = Math.max(256, options.atlasSize ?? 2048);
  const atlasPadding = Math.max(0, options.atlasPadding ?? 1);
  const drawStride = 64;
  const frameBindGroupLayout = device.createBindGroupLayout({
    entries: [
      {
        binding: 0,
        visibility: GPUShaderStage.VERTEX,
        buffer: { type: "uniform" },
      },
    ],
  });
  const drawBindGroupLayout = device.createBindGroupLayout({
    entries: [
      {
        binding: 0,
        visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
        buffer: { type: "read-only-storage" },
      },
      { binding: 1, visibility: GPUShaderStage.FRAGMENT, sampler: { type: "filtering" } },
      { binding: 2, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "float" } },
    ],
  });
  const pipelineLayout = device.createPipelineLayout({
    bindGroupLayouts: [frameBindGroupLayout, drawBindGroupLayout],
  });
  const pipeline = createPipeline(device, format, pipelineLayout);

  const vertexBuffer = device.createBuffer({
    size: VERTEX_DATA.byteLength,
    usage: GPUBufferUsage.VERTEX,
    mappedAtCreation: true,
  });
  new Float32Array(vertexBuffer.getMappedRange()).set(VERTEX_DATA);
  vertexBuffer.unmap();

  const frameUniformBuffer = device.createBuffer({
    size: 16,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  });
  let drawCapacity = 0;
  let drawStorageBuffer = device.createBuffer({
    size: drawStride,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
  });

  const sampler = device.createSampler({
    minFilter: "nearest",
    magFilter: "nearest",
  });

  const frameBindGroup = device.createBindGroup({
    layout: frameBindGroupLayout,
    entries: [{ binding: 0, resource: { buffer: frameUniformBuffer } }],
  });

  const allocator = new AtlasAllocator({ pageSize: atlasSize, padding: atlasPadding });
  const pages: Array<{
    texture: GPUTexture;
    view: GPUTextureView;
    width: number;
    height: number;
    bindGroup: GPUBindGroup;
  }> = [];
  const cache = new WeakMap<Uint8Array, {
    slot: AtlasSlot;
    gen: number;
    width: number;
    height: number;
    stride: number;
  }>();
  const gpuFilterCache = new WeakMap<NonNullable<BitmapLayer["gpuFilter"]>, {
    slot: AtlasSlot;
    gen: number;
    width: number;
    height: number;
  }>();

  let scratch: Uint8Array<ArrayBuffer> | null = null;
  let scratchSize = 0;
  let frameCounter = 0;
  let lastStats: CompositorStats = { drawCalls: 0, uploads: 0, atlasPages: 0 };
  let drawDataCpu = new Float32Array(16);
  let drawPagesCpu = new Int32Array(1);

  const configure = (width: number, height: number): void => {
    options.canvas.width = width;
    options.canvas.height = height;
    context.configure({
      device,
      format,
      alphaMode: "premultiplied",
    });
  };

  const createPage = (width: number, height: number) => {
    const created = createTexture(device, width, height);
    const bindGroup = device.createBindGroup({
      layout: drawBindGroupLayout,
      entries: [
        { binding: 0, resource: { buffer: drawStorageBuffer } },
        { binding: 1, resource: sampler },
        { binding: 2, resource: created.view },
      ],
    });
    return {
      texture: created.texture,
      view: created.view,
      width,
      height,
      bindGroup,
    };
  };

  const ensurePageResources = (): void => {
    for (let i = pages.length; i < allocator.pages.length; i++) {
      const pg = allocator.pages[i]!;
      pages.push(createPage(pg.width, pg.height));
    }
  };

  const rebuildPageBindGroups = () => {
    for (let i = 0; i < pages.length; i++) {
      const page = pages[i]!;
      page.bindGroup = device.createBindGroup({
        layout: drawBindGroupLayout,
        entries: [
          { binding: 0, resource: { buffer: drawStorageBuffer } },
          { binding: 1, resource: sampler },
          { binding: 2, resource: page.view },
        ],
      });
    }
  };

  const ensureDrawCapacity = (count: number) => {
    if (count <= drawCapacity) return;
    const next = Math.max(64, Math.ceil(count * 1.25));
    drawCapacity = next;
    drawStorageBuffer.destroy?.();
    drawStorageBuffer = device.createBuffer({
      size: drawStride * drawCapacity,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
    drawDataCpu = new Float32Array(drawCapacity * 16);
    drawPagesCpu = new Int32Array(drawCapacity);
    rebuildPageBindGroups();
  };

  const ensureScratch = (size: number): Uint8Array<ArrayBuffer> => {
    if (!scratch || scratchSize < size) {
      scratch = new Uint8Array(size);
      scratchSize = size;
    }
    return scratch;
  };

  const uploadMask = (layer: BitmapLayer, pageIndex: number, x: number, y: number): void => {
    const { width, height, stride, bitmap } = layer;
    const page = pages[pageIndex]!;
    const bytesPerRow = align(width, 256);
    const size = bytesPerRow * height;
    const buf = ensureScratch(size);
    buf.fill(0, 0, size);
    for (let y = 0; y < height; y++) {
      const srcRow = y * stride;
      const dstRow = y * bytesPerRow;
      buf.set(bitmap.subarray(srcRow, srcRow + width), dstRow);
    }
    queue.writeTexture(
      { texture: page.texture, origin: { x, y } },
      buf,
      { bytesPerRow, rowsPerImage: height },
      { width, height, depthOrArrayLayers: 1 },
    );
  };

  const gpuFiltersEnabled = options.enableGpuFilters ?? readGpuFiltersEnv();
  let filterEngine: BatchedGpuBlurEngine | null = null;
  if (gpuFiltersEnabled) {
    filterEngine = new BatchedGpuBlurEngine();
    filterEngine.init(device);
  }

  // Build filter-group inputs from this frame's gpuFilter layers, run the GPU
  // filter engine (no readback), and copy each layer's result region into the
  // atlas texture. Returns a per-layer slot map for the draw loop.
  const runGpuFilters = (
    encoder: GPUCommandEncoder,
    layers: BitmapLayer[],
    frameId: number,
  ): { slots: Map<number, AtlasSlot>; stats: GpuFilterRenderStats } => {
    const stats = emptyGpuFilterStats();
    const slots = new Map<number, AtlasSlot>();
    if (!filterEngine) return { slots, stats };
    // Frames with no routed layers (GPU filters off, or content with nothing
    // deferrable) skip the per-frame map/array setup below entirely.
    let anyRouted = false;
    for (let i = 0; i < layers.length; i++) {
      if (layers[i]!.gpuFilter) {
        anyRouted = true;
        break;
      }
    }
    if (!anyRouted) return { slots, stats };
    const t0 = performance.now();

    // Dedup groups by groupId; each group's masks are blurred once. The first
    // descriptor seen wins, upgraded to one carrying the outline mask if a later
    // layer in the same group supplies it.
    const idToIndex = new Map<number, number>();
    const inputs: FilterGroupInput[] = [];
    for (let i = 0; i < layers.length; i++) {
      const gf = layers[i]!.gpuFilter;
      if (!gf) continue;
      stats.routedLayers++;
      const cached = gpuFilterCache.get(gf);
      if (
        cached &&
        cached.width === layers[i]!.width &&
        cached.height === layers[i]!.height &&
        !cached.slot.free &&
        cached.slot.gen === cached.gen
      ) {
        allocator.touch(cached.slot, frameId);
        slots.set(i, cached.slot);
        stats.cacheHits++;
        continue;
      }
      stats.cacheMisses++;
      let gi = idToIndex.get(gf.groupId);
      if (gi === undefined) {
        gi = inputs.length;
        idToIndex.set(gf.groupId, gi);
        stats.inputBytes += gf.fillW * gf.fillH;
        if (gf.outlineMask) stats.inputBytes += (gf.outlineW ?? 0) * (gf.outlineH ?? 0);
        inputs.push({
          groupId: gf.groupId,
          fillMask: gf.fillMask, fillW: gf.fillW, fillH: gf.fillH, fillStride: gf.fillStride,
          outlineMask: gf.outlineMask, outlineW: gf.outlineW, outlineH: gf.outlineH, outlineStride: gf.outlineStride,
          r2x: gf.r2x, r2y: gf.r2y,
          punchOX: gf.punchOX, punchOY: gf.punchOY, punchFX: gf.punchFX, punchFY: gf.punchFY,
        });
      } else if (gf.outlineMask && !inputs[gi]!.outlineMask) {
        const inp = inputs[gi]!;
        inp.outlineMask = gf.outlineMask; inp.outlineW = gf.outlineW; inp.outlineH = gf.outlineH; inp.outlineStride = gf.outlineStride;
        inp.punchOX = gf.punchOX; inp.punchOY = gf.punchOY; inp.punchFX = gf.punchFX; inp.punchFY = gf.punchFY;
      }
    }
    stats.groups = inputs.length;
    if (inputs.length === 0) {
      stats.totalCpuMs = performance.now() - t0;
      return { slots, stats };
    }

    // One layer request per gpuFilter layer, tracked back to its layer index.
    const reqLayerIndex: number[] = [];
    const reqs: FilterLayerRequest[] = [];
    const countedClipMasks = new WeakMap<object, Set<string>>();
    const countClipMaskInput = (mask: Uint8Array, w: number, h: number, stride: number): void => {
      const owner = mask.buffer as object;
      let slots = countedClipMasks.get(owner);
      if (!slots) {
        slots = new Set();
        countedClipMasks.set(owner, slots);
      }
      const key = `${mask.byteOffset}|${w}|${h}|${stride}`;
      if (slots.has(key)) return;
      slots.add(key);
      stats.inputBytes += w * h;
    };
    for (let i = 0; i < layers.length; i++) {
      const layer = layers[i]!;
      const gf = layers[i]!.gpuFilter;
      if (!gf) continue;
      if (slots.has(i)) continue;
      reqLayerIndex.push(i);
      const req: FilterLayerRequest = {
        groupId: gf.groupId,
        source: gf.source,
        sx: gf.sx,
        sy: gf.sy,
      };
      const clip = layer.clip;
      if (clip?.type === "mask") {
        req.clipMask = clip.bitmap;
        req.clipW = clip.width;
        req.clipH = clip.height;
        req.clipStride = clip.stride;
        req.clipOriginX = clip.originX;
        req.clipOriginY = clip.originY;
        req.clipInverse = clip.inverse;
        req.layerOriginX = Math.round(layer.originX);
        req.layerOriginY = Math.round(layer.originY);
        stats.maskRequests = (stats.maskRequests ?? 0) + 1;
        countClipMaskInput(clip.bitmap, clip.width, clip.height, clip.stride);
      }
      reqs.push(req);
    }
    stats.requests = reqs.length;
    stats.inputCpuMs = performance.now() - t0;

    const tFilter = performance.now();
    const { buffer, regions, stats: filterStats } = filterEngine.filterGroups(inputs, reqs, encoder);
    stats.filterSubmitted = filterStats.submitted ? 1 : 0;
    stats.filterRounds = filterStats.rounds;
    stats.filterJobs = filterStats.jobs;
    stats.filterPixels = filterStats.pixels;
    stats.maskUploads = filterStats.maskUploads ?? 0;
    stats.maskPixels = filterStats.maskPixels ?? 0;
    stats.filterCpuMs = performance.now() - tFilter;

    const tCopy = performance.now();
    for (let r = 0; r < reqs.length; r++) {
      const region = regions[r];
      if (!region) continue;
      const slot = allocator.allocate(region.w, region.h, frameId);
      ensurePageResources();
      const page = pages[slot.pageIndex]!;
      encoder.copyBufferToTexture(
        { buffer, offset: region.byteOffset, bytesPerRow: region.bytesPerRow, rowsPerImage: region.h },
        { texture: page.texture, origin: { x: slot.x, y: slot.y } },
        { width: region.w, height: region.h, depthOrArrayLayers: 1 },
      );
      stats.copies++;
      stats.copyBytes += region.bytesPerRow * region.h;
      stats.outputBytes += region.w * region.h;
      const area = region.w * region.h;
      if (area < 1024) stats.areaLt1k++;
      else if (area < 4096) stats.areaLt4k++;
      else if (area < 16384) stats.areaLt16k++;
      else stats.areaGte16k++;
      const layerIndex = reqLayerIndex[r]!;
      const gf = layers[layerIndex]!.gpuFilter!;
      gpuFilterCache.set(gf, { slot, gen: slot.gen, width: region.w, height: region.h });
      slots.set(layerIndex, slot);
    }
    stats.copyCpuMs = performance.now() - tCopy;
    stats.totalCpuMs = performance.now() - t0;
    return { slots, stats };
  };

  const render = (layers: BitmapLayer[], frame: FrameContext): void => {
    const width = frame.width || options.canvas.width;
    const height = frame.height || options.canvas.height;
    if (width <= 0 || height <= 0) return;

    const frameData = new Float32Array(4);
    frameData[0] = width;
    frameData[1] = height;
    queue.writeBuffer(frameUniformBuffer, 0, frameData.buffer, 0, 16);

    const colorAttachment: GPURenderPassColorAttachment = {
      view: context.getCurrentTexture().createView(),
      clearValue: { r: 0, g: 0, b: 0, a: 0 },
      loadOp: "clear",
      storeOp: "store",
    };
    const encoder = device.createCommandEncoder();
    const frameId = frameCounter++;
    // GPU filter pre-pass: fill/blur/punch on the GPU, results copied into the
    // atlas texture. Must precede beginRenderPass (copyBufferToTexture is an
    // encoder op that cannot run inside a render pass).
    const gpuFilterRun = runGpuFilters(encoder, layers, frameId);
    const gpuSlots = gpuFilterRun.slots;

    const pass = encoder.beginRenderPass({ colorAttachments: [colorAttachment] });
    pass.setPipeline(pipeline);
    pass.setVertexBuffer(0, vertexBuffer);
    pass.setBindGroup(0, frameBindGroup);
    pass.setViewport(0, 0, width, height, 0, 1);

    let drawCalls = 0;
    let uploads = 0;

    ensureDrawCapacity(layers.length);
    let drawCount = 0;
    for (let i = 0; i < layers.length; i++) {
      const layer = layers[i]!;
      if (!layer.bitmap || layer.width <= 0 || layer.height <= 0) continue;

      const x = Math.round(layer.originX);
      const y = Math.round(layer.originY);
      const w = layer.width;
      const h = layer.height;
      if (w <= 0 || h <= 0) continue;

      let slot: AtlasSlot;
      if (layer.gpuFilter) {
        const s = gpuSlots.get(i);
        if (!s) continue; // group didn't produce this source; skip (should not happen)
        slot = s;
      } else {
        const cached = cache.get(layer.bitmap);
        if (
          cached &&
          cached.width === w &&
          cached.height === h &&
          cached.stride === layer.stride &&
          !cached.slot.free &&
          cached.slot.gen === cached.gen
        ) {
          slot = cached.slot;
          allocator.touch(slot, frameId);
        } else {
          slot = allocator.allocate(w, h, frameId);
          ensurePageResources();
          cache.set(layer.bitmap, { slot, gen: slot.gen, width: w, height: h, stride: layer.stride });
          uploadMask(layer, slot.pageIndex, slot.x, slot.y);
          uploads++;
        }
      }

      const color = layer.color;
      const page = pages[slot.pageIndex]!;
      const base = drawCount * 16;
      drawDataCpu[base + 0] = x;
      drawDataCpu[base + 1] = y;
      drawDataCpu[base + 2] = w;
      drawDataCpu[base + 3] = h;
      drawDataCpu[base + 4] = color[0] / 255;
      drawDataCpu[base + 5] = color[1] / 255;
      drawDataCpu[base + 6] = color[2] / 255;
      drawDataCpu[base + 7] = color[3] / 255;
      drawDataCpu[base + 8] = slot.x / page.width;
      drawDataCpu[base + 9] = slot.y / page.height;
      drawDataCpu[base + 10] = w / page.width;
      drawDataCpu[base + 11] = h / page.height;
      if (layer.gpuFilter && layer.clip?.type === "rect" && !layer.clip.inverse) {
        // libass applies integer rect clips to the final filtered pixels. The
        // CPU path crops that final bitmap; the GPU path keeps the full
        // filtered atlas slot and clips the composite draw in screen space.
        drawDataCpu[base + 12] = layer.clip.x0;
        drawDataCpu[base + 13] = layer.clip.y0;
        drawDataCpu[base + 14] = layer.clip.x1;
        drawDataCpu[base + 15] = layer.clip.y1;
      } else {
        drawDataCpu[base + 12] = -1_000_000_000;
        drawDataCpu[base + 13] = -1_000_000_000;
        drawDataCpu[base + 14] = 1_000_000_000;
        drawDataCpu[base + 15] = 1_000_000_000;
      }
      drawPagesCpu[drawCount] = slot.pageIndex;
      drawCount++;
    }

    if (drawCount > 0) {
      queue.writeBuffer(
        drawStorageBuffer,
        0,
        drawDataCpu.buffer,
        0,
        drawCount * drawStride,
      );
      let runStart = 0;
      while (runStart < drawCount) {
        const pageIndex = drawPagesCpu[runStart]!;
        let runEnd = runStart + 1;
        while (runEnd < drawCount && drawPagesCpu[runEnd] === pageIndex) runEnd++;
        const page = pages[pageIndex]!;
        pass.setBindGroup(1, page.bindGroup);
        pass.draw(6, runEnd - runStart, 0, runStart);
        drawCalls++;
        runStart = runEnd;
      }
    }

    pass.end();
    queue.submit([encoder.finish()]);
    lastStats = { drawCalls, uploads, atlasPages: pages.length, gpuFilter: gpuFilterRun.stats };
  };

  const resize = (width: number, height: number, dpr?: number): void => {
    const scale = dpr && dpr > 0 ? dpr : 1;
    const w = Math.max(1, Math.round(width * scale));
    const h = Math.max(1, Math.round(height * scale));
    configure(w, h);
  };

  configure(options.canvas.width || 1, options.canvas.height || 1);

  // GPU-resident filter path: register a provider so the core raster path defers
  // qualifying blur/punch work to the GPU. Default ON for a successfully
  // initialized WebGPU backend; only registered here, so CPU/WebGL/Bun never
  // see a provider and stay byte-identical.
  if (gpuFiltersEnabled) {
    setGpuFilterProvider({
      computeBlurDims: computeGpuBlurDims,
      // Mask clips have an exact batched shader path, but routing beastars'
      // clipped layers through it regressed composite p95 badly. Keep the
      // capability unadvertised until the mask transport/staging cost is solved.
    });
  }

  return {
    kind: "webgpu",
    resize,
    render,
    dispose: () => {
      if (gpuFiltersEnabled) setGpuFilterProvider(null);
      filterEngine?.dispose();
      device.destroy?.();
    },
    stats: () => lastStats,
  };
}
