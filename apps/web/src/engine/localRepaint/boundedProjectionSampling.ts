// ALG-LR-UV-PAINT v1.3.0. Source filtering must not expand capture authorization.
// Keep mip filtering in the opaque interior; resolve partially transparent
// footprints at native resolution in premultiplied space, then return straight RGB.
const sampling = `
vec4 rC(sampler2D m, vec2 u) {
  ivec2 s = textureSize(m, 0), p = ivec2(floor(u * vec2(s)));
  if (any(lessThan(p, ivec2(0))) || any(greaterThanEqual(p, s))) return vec4(0.0);
  return texelFetch(m, p, 0);
}
vec4 rP(sampler2D m, ivec2 p, ivec2 s) {
  vec4 c = texelFetch(m, clamp(p, ivec2(0), s - 1), 0);
  return vec4(c.rgb * c.a, c.a);
}
vec4 rS(sampler2D m, vec2 u) {
  vec4 f = texture2D(m, u), c = rC(m, u);
  if (c.a <= 0.0039) return vec4(0.0);
  if (f.a >= 0.999) return vec4(f.rgb, min(c.a, f.a));
  ivec2 s = textureSize(m, 0);
  vec2 p = u * vec2(s) - 0.5, q = fract(p);
  ivec2 b = ivec2(floor(p));
  vec4 x = mix(mix(rP(m, b, s), rP(m, b + ivec2(1, 0), s), q.x),
    mix(rP(m, b + ivec2(0, 1), s), rP(m, b + ivec2(1, 1), s), q.x), q.y);
  return vec4(x.rgb / max(x.a, 0.000001), min(c.a, x.a));
}
vec4 rM(sampler2D m, vec2 u) {
  vec4 f = texture2D(m, u), c = rC(m, u);
  return vec4(vec3(1.0), min(dot(c.rgb, vec3(0.299, 0.587, 0.114)) * c.a,
    dot(f.rgb, vec3(0.299, 0.587, 0.114)) * f.a));
}
`;

export function boundRepaintProjectionSampling(fragment: string) {
  const color = 'texture2D(projectedMap, uv)';
  const mask = 'texture2D(maskMap, maskUv)';
  // Constant-color capture materials have no image footprint to constrain.
  if (!fragment.includes(color) && !fragment.includes(mask)) return fragment;
  if (!fragment.includes(color) || !fragment.includes(mask))
    throw new Error('局部重绘取色边界未能绑定，已停止回贴。');
  // Insert after uniforms/functions so the shader's precision preamble stays first.
  return fragment.replace('void main()', `${sampling}\nvoid main()`)
    .replace(color, 'rS(projectedMap, uv)')
    .replace(mask, 'rM(maskMap, maskUv)');
}
