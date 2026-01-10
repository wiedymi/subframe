export const WEBGPU_SHADER_SOURCE = `
struct Frame {
  viewport: vec2<f32>,
  _pad: vec2<f32>,
}

@group(0) @binding(0) var<uniform> uFrame: Frame;
struct Draw {
  rect: vec4<f32>,
  color: vec4<f32>,
  uvRect: vec4<f32>,
}

@group(1) @binding(0) var<storage, read> uDraws: array<Draw>;
@group(1) @binding(1) var uSampler: sampler;
@group(1) @binding(2) var uMask: texture_2d<f32>;

struct VSOut {
  @builtin(position) position: vec4<f32>,
  @location(0) uv: vec2<f32>,
  @location(1) color: vec4<f32>,
}

@vertex
fn vs(
  @location(0) aPos: vec2<f32>,
  @location(1) aUv: vec2<f32>,
  @builtin(instance_index) instance: u32,
) -> VSOut {
  let draw = uDraws[instance];
  var out: VSOut;
  let pos = draw.rect.xy + aPos * draw.rect.zw;
  let clip = vec2<f32>(
    (pos.x / uFrame.viewport.x) * 2.0 - 1.0,
    1.0 - (pos.y / uFrame.viewport.y) * 2.0
  );
  out.position = vec4<f32>(clip, 0.0, 1.0);
  out.uv = draw.uvRect.xy + aUv * draw.uvRect.zw;
  out.color = draw.color;
  return out;
}

@fragment
fn fs(in: VSOut) -> @location(0) vec4<f32> {
  let mask = textureSample(uMask, uSampler, in.uv).r;
  let alpha = in.color.a * mask;
  return vec4<f32>(in.color.rgb * alpha, alpha);
}
`;
