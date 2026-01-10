export const VERTEX_SHADER_SOURCE_WEBGL1 = `
attribute vec2 aPos;
attribute vec2 aUv;
uniform vec2 uViewport;
uniform vec4 uRect;
uniform vec4 uUvRect;
varying vec2 vUv;

void main() {
  vec2 pos = uRect.xy + aPos * uRect.zw;
  vec2 clip = vec2(
    (pos.x / uViewport.x) * 2.0 - 1.0,
    1.0 - (pos.y / uViewport.y) * 2.0
  );
  gl_Position = vec4(clip, 0.0, 1.0);
  vUv = uUvRect.xy + aUv * uUvRect.zw;
}
`;

export const VERTEX_SHADER_SOURCE_WEBGL2 = `#version 300 es
in vec2 aPos;
in vec2 aUv;
uniform vec2 uViewport;
uniform vec4 uRect;
uniform vec4 uUvRect;
out vec2 vUv;

void main() {
  vec2 pos = uRect.xy + aPos * uRect.zw;
  vec2 clip = vec2(
    (pos.x / uViewport.x) * 2.0 - 1.0,
    1.0 - (pos.y / uViewport.y) * 2.0
  );
  gl_Position = vec4(clip, 0.0, 1.0);
  vUv = uUvRect.xy + aUv * uUvRect.zw;
}
`;

export const FRAGMENT_SHADER_SOURCE_WEBGL1 = `
precision mediump float;
uniform sampler2D uMask;
uniform vec4 uColor;
varying vec2 vUv;

void main() {
  float mask = texture2D(uMask, vUv).a;
  float alpha = uColor.a * mask;
  gl_FragColor = vec4(uColor.rgb * alpha, alpha);
}
`;

export const FRAGMENT_SHADER_SOURCE_WEBGL2 = `#version 300 es
precision mediump float;
uniform sampler2D uMask;
uniform vec4 uColor;
in vec2 vUv;
out vec4 outColor;

void main() {
  float mask = texture(uMask, vUv).r;
  float alpha = uColor.a * mask;
  outColor = vec4(uColor.rgb * alpha, alpha);
}
`;
