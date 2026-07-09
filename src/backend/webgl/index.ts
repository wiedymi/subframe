import type { BitmapLayer, FrameContext } from "../../core/data/types";
import type { CompositorBackend, CompositorStats } from "../types";
import { AtlasAllocator, type AtlasSlot } from "../atlas-allocator";
import {
  FRAGMENT_SHADER_SOURCE_WEBGL1,
  FRAGMENT_SHADER_SOURCE_WEBGL2,
  VERTEX_SHADER_SOURCE_WEBGL1,
  VERTEX_SHADER_SOURCE_WEBGL2,
} from "./shaders";

export type WebGLBackendOptions = {
  canvas: HTMLCanvasElement;
  preferWebGL2?: boolean;
  powerPreference?: "default" | "high-performance" | "low-power";
  atlasSize?: number;
  atlasPadding?: number;
};

type GLContext = WebGLRenderingContext | WebGL2RenderingContext;

function isSharedBacked(view: Uint8Array): boolean {
  return typeof SharedArrayBuffer !== "undefined" && view.buffer instanceof SharedArrayBuffer;
}

type GLResources = {
  gl: GLContext;
  isWebGL2: boolean;
  program: WebGLProgram;
  buffer: WebGLBuffer;
  attribPos: number;
  attribUv: number;
  uniformViewport: WebGLUniformLocation;
  uniformRect: WebGLUniformLocation;
  uniformUvRect: WebGLUniformLocation;
  uniformColor: WebGLUniformLocation;
  uniformMask: WebGLUniformLocation;
};

function createShader(gl: GLContext, type: number, source: string): WebGLShader {
  const shader = gl.createShader(type);
  if (!shader) throw new Error("WebGL: failed to create shader");
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(shader) || "unknown error";
    gl.deleteShader(shader);
    throw new Error(`WebGL: shader compile failed: ${log}`);
  }
  return shader;
}

function createProgram(gl: GLContext, vsSource: string, fsSource: string): WebGLProgram {
  const vs = createShader(gl, gl.VERTEX_SHADER, vsSource);
  const fs = createShader(gl, gl.FRAGMENT_SHADER, fsSource);
  const program = gl.createProgram();
  if (!program) throw new Error("WebGL: failed to create program");
  gl.attachShader(program, vs);
  gl.attachShader(program, fs);
  gl.linkProgram(program);
  gl.deleteShader(vs);
  gl.deleteShader(fs);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    const log = gl.getProgramInfoLog(program) || "unknown error";
    gl.deleteProgram(program);
    throw new Error(`WebGL: program link failed: ${log}`);
  }
  return program;
}

function initGL(options: WebGLBackendOptions): GLResources {
  const { canvas, preferWebGL2, powerPreference } = options;
  let gl: GLContext | null = null;
  let isWebGL2 = false;

  if (preferWebGL2) {
    gl = canvas.getContext("webgl2", {
      alpha: true,
      premultipliedAlpha: true,
      antialias: false,
      powerPreference,
    }) as WebGL2RenderingContext | null;
    if (gl) isWebGL2 = true;
  }
  if (!gl) {
    gl = canvas.getContext("webgl", {
      alpha: true,
      premultipliedAlpha: true,
      antialias: false,
      powerPreference,
    }) as WebGLRenderingContext | null;
  }
  if (!gl) throw new Error("WebGL: context creation failed");

  const program = createProgram(
    gl,
    isWebGL2 ? VERTEX_SHADER_SOURCE_WEBGL2 : VERTEX_SHADER_SOURCE_WEBGL1,
    isWebGL2 ? FRAGMENT_SHADER_SOURCE_WEBGL2 : FRAGMENT_SHADER_SOURCE_WEBGL1,
  );

  const buffer = gl.createBuffer();
  if (!buffer) throw new Error("WebGL: failed to create buffer");

  gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
  const quad = new Float32Array([
    0, 0, 0, 0,
    1, 0, 1, 0,
    0, 1, 0, 1,
    0, 1, 0, 1,
    1, 0, 1, 0,
    1, 1, 1, 1,
  ]);
  gl.bufferData(gl.ARRAY_BUFFER, quad, gl.STATIC_DRAW);

  gl.useProgram(program);
  const attribPos = gl.getAttribLocation(program, "aPos");
  const attribUv = gl.getAttribLocation(program, "aUv");
  const uniformViewport = gl.getUniformLocation(program, "uViewport");
  const uniformRect = gl.getUniformLocation(program, "uRect");
  const uniformUvRect = gl.getUniformLocation(program, "uUvRect");
  const uniformColor = gl.getUniformLocation(program, "uColor");
  const uniformMask = gl.getUniformLocation(program, "uMask");

  if (
    attribPos < 0 ||
    attribUv < 0 ||
    !uniformViewport ||
    !uniformRect ||
    !uniformUvRect ||
    !uniformColor ||
    !uniformMask
  ) {
    throw new Error("WebGL: failed to resolve shader locations");
  }

  gl.enableVertexAttribArray(attribPos);
  gl.enableVertexAttribArray(attribUv);
  gl.vertexAttribPointer(attribPos, 2, gl.FLOAT, false, 16, 0);
  gl.vertexAttribPointer(attribUv, 2, gl.FLOAT, false, 16, 8);

  gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);

  gl.disable(gl.DEPTH_TEST);
  gl.disable(gl.CULL_FACE);
  gl.enable(gl.BLEND);
  gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);

  gl.uniform1i(uniformMask, 0);

  return {
    gl,
    isWebGL2,
    program,
    buffer,
    attribPos,
    attribUv,
    uniformViewport,
    uniformRect,
    uniformUvRect,
    uniformColor,
    uniformMask,
  };
}

export function createWebGLBackend(options: WebGLBackendOptions): CompositorBackend {
  const resources = initGL(options);
  const { gl, isWebGL2 } = resources;
  const atlasSize = Math.max(256, options.atlasSize ?? 2048);
  const atlasPadding = Math.max(0, options.atlasPadding ?? 1);
  const allocator = new AtlasAllocator({ pageSize: atlasSize, padding: atlasPadding });
  const pageTextures: Array<{
    texture: WebGLTexture;
    width: number;
    height: number;
  }> = [];
  const cache = new WeakMap<Uint8Array, {
    slot: AtlasSlot;
    gen: number;
    width: number;
    height: number;
    stride: number;
  }>();
  let viewportW = options.canvas.width;
  let viewportH = options.canvas.height;
  let scratch: Uint8Array | null = null;
  let scratchSize = 0;
  let frameCounter = 0;
  let lastStats: CompositorStats = { drawCalls: 0, uploads: 0, atlasPages: 0 };

  const ensureScratch = (size: number): Uint8Array => {
    if (!scratch || scratchSize < size) {
      scratch = new Uint8Array(size);
      scratchSize = size;
    }
    return scratch;
  };

  const createPage = (width: number, height: number) => {
    const texture = gl.createTexture();
    if (!texture) throw new Error("WebGL: failed to create texture");
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    if (isWebGL2) {
      const gl2 = gl as WebGL2RenderingContext;
      gl2.texImage2D(
        gl2.TEXTURE_2D,
        0,
        gl2.R8,
        width,
        height,
        0,
        gl2.RED,
        gl2.UNSIGNED_BYTE,
        null,
      );
    } else {
      gl.texImage2D(
        gl.TEXTURE_2D,
        0,
        gl.ALPHA,
        width,
        height,
        0,
        gl.ALPHA,
        gl.UNSIGNED_BYTE,
        null,
      );
    }
    return { texture, width, height };
  };

  const ensurePageTextures = (): void => {
    for (let i = pageTextures.length; i < allocator.pages.length; i++) {
      const pg = allocator.pages[i]!;
      pageTextures.push(createPage(pg.width, pg.height));
    }
  };

  const uploadMask = (
    layer: BitmapLayer,
    pageIndex: number,
    x: number,
    y: number,
  ): void => {
    const { width, height, stride, bitmap } = layer;
    const page = pageTextures[pageIndex]!;
    gl.bindTexture(gl.TEXTURE_2D, page.texture);
    // Some WebGL implementations reject SharedArrayBuffer-backed ArrayBufferViews
    // for texSubImage2D. Keep SAB transport zero-copy through the core and copy
    // only at this backend upload choke point when necessary.
    const shared = isSharedBacked(bitmap);
    if (isWebGL2) {
      const gl2 = gl as WebGL2RenderingContext;
      if (shared) {
        const tight = ensureScratch(width * height);
        for (let row = 0; row < height; row++) {
          const srcRow = row * stride;
          const dstRow = row * width;
          tight.set(bitmap.subarray(srcRow, srcRow + width), dstRow);
        }
        gl2.texSubImage2D(
          gl2.TEXTURE_2D,
          0,
          x,
          y,
          width,
          height,
          gl2.RED,
          gl2.UNSIGNED_BYTE,
          tight,
        );
        return;
      }
      gl2.pixelStorei(gl2.UNPACK_ROW_LENGTH, stride);
      gl2.texSubImage2D(
        gl2.TEXTURE_2D,
        0,
        x,
        y,
        width,
        height,
        gl2.RED,
        gl2.UNSIGNED_BYTE,
        bitmap,
      );
      gl2.pixelStorei(gl2.UNPACK_ROW_LENGTH, 0);
      return;
    }

    let data: Uint8Array = bitmap;
    if (stride !== width || shared) {
      const tight = ensureScratch(width * height);
      for (let row = 0; row < height; row++) {
        const srcRow = row * stride;
        const dstRow = row * width;
        tight.set(bitmap.subarray(srcRow, srcRow + width), dstRow);
      }
      data = tight;
    }
    gl.texSubImage2D(
      gl.TEXTURE_2D,
      0,
      x,
      y,
      width,
      height,
      gl.ALPHA,
      gl.UNSIGNED_BYTE,
      data,
    );
  };

  const render = (layers: BitmapLayer[], frame: FrameContext): void => {
    const width = frame.width || viewportW || options.canvas.width;
    const height = frame.height || viewportH || options.canvas.height;
    if (width <= 0 || height <= 0) return;

    gl.useProgram(resources.program);
    gl.bindBuffer(gl.ARRAY_BUFFER, resources.buffer);
    gl.activeTexture(gl.TEXTURE0);

    gl.viewport(0, 0, width, height);
    gl.uniform2f(resources.uniformViewport, width, height);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);

    let drawCalls = 0;
    let uploads = 0;
    let lastTexture: WebGLTexture | null = null;
    const frameId = frameCounter++;

    for (let i = 0; i < layers.length; i++) {
      const layer = layers[i]!;
      if (!layer.bitmap || layer.width <= 0 || layer.height <= 0) continue;

      const x = Math.round(layer.originX);
      const y = Math.round(layer.originY);
      const w = layer.width;
      const h = layer.height;
      if (w <= 0 || h <= 0) continue;

      const cached = cache.get(layer.bitmap);
      let slot: AtlasSlot;
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
        ensurePageTextures();
        cache.set(layer.bitmap, { slot, gen: slot.gen, width: w, height: h, stride: layer.stride });
        uploadMask(layer, slot.pageIndex, slot.x, slot.y);
        uploads++;
      }
      const page = pageTextures[slot.pageIndex]!;
      if (page.texture !== lastTexture) {
        gl.bindTexture(gl.TEXTURE_2D, page.texture);
        lastTexture = page.texture;
      }
      gl.uniform4f(
        resources.uniformUvRect,
        slot.x / page.width,
        slot.y / page.height,
        w / page.width,
        h / page.height,
      );

      const color = layer.color;
      gl.uniform4f(
        resources.uniformColor,
        color[0] / 255,
        color[1] / 255,
        color[2] / 255,
        color[3] / 255,
      );
      gl.uniform4f(resources.uniformRect, x, y, w, h);

      gl.drawArrays(gl.TRIANGLES, 0, 6);
      drawCalls++;
    }

    lastStats = { drawCalls, uploads, atlasPages: pageTextures.length };
  };

  const resize = (width: number, height: number, dpr?: number): void => {
    const scale = dpr && dpr > 0 ? dpr : 1;
    const w = Math.max(1, Math.round(width * scale));
    const h = Math.max(1, Math.round(height * scale));
    viewportW = w;
    viewportH = h;
    if (options.canvas.width !== w) options.canvas.width = w;
    if (options.canvas.height !== h) options.canvas.height = h;
    gl.viewport(0, 0, w, h);
  };

  const dispose = (): void => {
    for (let i = 0; i < pageTextures.length; i++) {
      gl.deleteTexture(pageTextures[i]!.texture);
    }
    gl.deleteBuffer(resources.buffer);
    gl.deleteProgram(resources.program);
  };

  return {
    kind: "webgl",
    resize,
    render,
    dispose,
    stats: () => lastStats,
  };
}
