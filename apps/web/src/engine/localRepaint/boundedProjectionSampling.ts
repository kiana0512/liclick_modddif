// ALG-LR-UV-PAINT v1.3.0. Source filtering must not expand capture authorization.
// Keep mip filtering in the opaque interior; resolve partially transparent
// footprints at native resolution in premultiplied space, then return straight RGB.
const sampling = `
vec4 repaintCore(sampler2D map, vec2 uv) {
  ivec2 size = textureSize(map, 0);
  ivec2 p = ivec2(floor(uv * vec2(size)));
  if (any(lessThan(p, ivec2(0))) || any(greaterThanEqual(p, size))) return vec4(0.0);
  return texelFetch(map, p, 0);
}
vec4 repaintPremultiplied(sampler2D map, ivec2 p, ivec2 size) {
  vec4 c = texelFetch(map, clamp(p, ivec2(0), size - 1), 0);
  return vec4(c.rgb * c.a, c.a);
}
vec4 repaintSource(sampler2D map, vec2 uv) {
  vec4 filtered = texture2D(map, uv);
  vec4 core = repaintCore(map, uv);
  if (core.a <= 0.0039) return vec4(0.0);
  if (filtered.a >= 0.999) return vec4(filtered.rgb, min(core.a, filtered.a));
  ivec2 size = textureSize(map, 0);
  vec2 p = uv * vec2(size) - 0.5;
  ivec2 base = ivec2(floor(p));
  vec2 f = fract(p);
  vec4 c = mix(
    mix(repaintPremultiplied(map, base, size), repaintPremultiplied(map, base + ivec2(1, 0), size), f.x),
    mix(repaintPremultiplied(map, base + ivec2(0, 1), size), repaintPremultiplied(map, base + ivec2(1, 1), size), f.x), f.y);
  return vec4(c.rgb / max(c.a, 0.000001), min(core.a, c.a));
}
vec4 repaintMask(sampler2D map, vec2 uv) {
  vec4 filtered = texture2D(map, uv);
  vec4 core = repaintCore(map, uv);
  vec3 luma = vec3(0.299, 0.587, 0.114);
  return vec4(vec3(1.0), min(dot(core.rgb, luma) * core.a, dot(filtered.rgb, luma) * filtered.a));
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
    .replace(color, 'repaintSource(projectedMap, uv)')
    .replace(mask, 'repaintMask(maskMap, maskUv)');
}
