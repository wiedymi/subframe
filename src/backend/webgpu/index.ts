import type { BitmapLayer, FrameContext } from "../../core/data/types";
import type { CompositorBackend, CompositorStats } from "../types";
import { WEBGPU_SHADER_SOURCE } from "./shaders";

export type WebGPUBackendOptions = {
  canvas: HTMLCanvasElement;
  powerPreference?: "low-power" | "high-performance";
  atlasSize?: number;
  atlasPadding?: number;
};

const VERTEX_DATA = new Float32Array([
  0, 0, 0, 0,
  1, 0, 1, 0,
  0, 1, 0, 1,
  0, 1, 0, 1,
  1, 0, 1, 0,
  1, 1, 1, 1,
]);

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
  const drawStride = 48;
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

  const pages: Array<{
    texture: GPUTexture;
    view: GPUTextureView;
    width: number;
    height: number;
    cursorX: number;
    cursorY: number;
    rowH: number;
    bindGroup: GPUBindGroup;
  }> = [];
  const cache = new WeakMap<Uint8Array, {
    pageIndex: number;
    x: number;
    y: number;
    width: number;
    height: number;
    stride: number;
  }>();

  let scratch: Uint8Array | null = null;
  let scratchSize = 0;
  let lastStats: CompositorStats = { drawCalls: 0, uploads: 0, atlasPages: 0 };
  let drawDataCpu = new Float32Array(12);
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
      cursorX: 0,
      cursorY: 0,
      rowH: 0,
      bindGroup,
    };
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
    drawDataCpu = new Float32Array(drawCapacity * 12);
    drawPagesCpu = new Int32Array(drawCapacity);
    rebuildPageBindGroups();
  };

  const allocate = (width: number, height: number) => {
    const w = width;
    const h = height;
    for (let i = 0; i < pages.length; i++) {
      const page = pages[i]!;
      let x = page.cursorX;
      let y = page.cursorY;
      if (x + w > page.width) {
        x = 0;
        y = page.cursorY + page.rowH + atlasPadding;
      }
      if (y + h > page.height) continue;
      page.cursorX = x + w + atlasPadding;
      page.cursorY = y;
      page.rowH = Math.max(page.rowH, h);
      return { pageIndex: i, x, y };
    }
    const pageWidth = Math.max(atlasSize, width);
    const pageHeight = Math.max(atlasSize, height);
    const page = createPage(pageWidth, pageHeight);
    pages.push(page);
    page.cursorX = width + atlasPadding;
    page.cursorY = 0;
    page.rowH = height;
    return { pageIndex: pages.length - 1, x: 0, y: 0 };
  };

  const ensureScratch = (size: number): Uint8Array => {
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

      let entry = cache.get(layer.bitmap);
      if (!entry || entry.width !== w || entry.height !== h || entry.stride !== layer.stride) {
        const placement = allocate(w, h);
        entry = {
          pageIndex: placement.pageIndex,
          x: placement.x,
          y: placement.y,
          width: w,
          height: h,
          stride: layer.stride,
        };
        cache.set(layer.bitmap, entry);
        uploadMask(layer, entry.pageIndex, entry.x, entry.y);
        uploads++;
      }

      const color = layer.color;
      const page = pages[entry.pageIndex]!;
      const base = drawCount * 12;
      drawDataCpu[base + 0] = x;
      drawDataCpu[base + 1] = y;
      drawDataCpu[base + 2] = w;
      drawDataCpu[base + 3] = h;
      drawDataCpu[base + 4] = color[0] / 255;
      drawDataCpu[base + 5] = color[1] / 255;
      drawDataCpu[base + 6] = color[2] / 255;
      drawDataCpu[base + 7] = color[3] / 255;
      drawDataCpu[base + 8] = entry.x / page.width;
      drawDataCpu[base + 9] = entry.y / page.height;
      drawDataCpu[base + 10] = entry.width / page.width;
      drawDataCpu[base + 11] = entry.height / page.height;
      drawPagesCpu[drawCount] = entry.pageIndex;
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
    lastStats = { drawCalls, uploads, atlasPages: pages.length };
  };

  const resize = (width: number, height: number, dpr?: number): void => {
    const scale = dpr && dpr > 0 ? dpr : 1;
    const w = Math.max(1, Math.round(width * scale));
    const h = Math.max(1, Math.round(height * scale));
    configure(w, h);
  };

  configure(options.canvas.width || 1, options.canvas.height || 1);

  return {
    kind: "webgpu",
    resize,
    render,
    dispose: () => device.destroy?.(),
    stats: () => lastStats,
  };
}
