// TypeScript 7 includes WebGPU interfaces in lib.dom but not the runtime
// constant objects exposed by browsers.
declare const GPUBufferUsage: {
  readonly MAP_READ: number;
  readonly COPY_SRC: number;
  readonly COPY_DST: number;
  readonly VERTEX: number;
  readonly UNIFORM: number;
  readonly STORAGE: number;
  readonly QUERY_RESOLVE: number;
};

declare const GPUColorWrite: { readonly ALL: number };
declare const GPUMapMode: { readonly READ: number };
declare const GPUShaderStage: {
  readonly VERTEX: number;
  readonly FRAGMENT: number;
  readonly COMPUTE: number;
};
declare const GPUTextureUsage: {
  readonly COPY_DST: number;
  readonly TEXTURE_BINDING: number;
};
