import * as THREE from 'three';

// PROJECTED-SELECTION-PREVIEW/0.1.0: isolated, opt-in visual prototype.
// Not wired into editor persistence/capture. Textures are borrowed; callers
// retain immutable stroke/depth snapshots and dispose them after the material.
export const PROJECTED_SELECTION_PREVIEW_CAPACITY = 4;
export type ProjectedSelectionStroke = {
  mask: THREE.Texture;
  depth: THREE.DepthTexture;
  projector: THREE.Matrix4;
  position: THREE.Vector3;
  operation: 'add' | 'subtract';
};

export function createProjectedSelectionPreview() {
  const capacity = PROJECTED_SELECTION_PREVIEW_CAPACITY;
  const material = new THREE.ShaderMaterial({
    uniforms: {
      count: { value: 0 },
      inverted: { value: 0 },
      masks: { value: Array<THREE.Texture | null>(capacity).fill(null) },
      depths: { value: Array<THREE.DepthTexture | null>(capacity).fill(null) },
      projectors: { value: Array.from({ length: capacity }, () => new THREE.Matrix4()) },
      positions: { value: Array.from({ length: capacity }, () => new THREE.Vector3()) },
      depthSizes: { value: Array.from({ length: capacity }, () => new THREE.Vector2(1, 1)) },
      operations: { value: new Float32Array(capacity) },
      stripeColor: { value: new THREE.Color('#ac2f0d') },
      stripeOpacity: { value: 0.94 },
      fillOpacity: { value: 0.16 },
    },
    vertexShader: `
      varying vec3 worldPoint;
      varying vec3 worldFacing;
      void main() {
        worldPoint = (modelMatrix * vec4(position, 1.0)).xyz;
        worldFacing = normalize(mat3(modelMatrix) * normal);
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: `
      uniform int count;
      uniform float inverted;
      uniform sampler2D masks[${capacity}];
      uniform sampler2D depths[${capacity}];
      uniform mat4 projectors[${capacity}];
      uniform vec3 positions[${capacity}];
      uniform vec2 depthSizes[${capacity}];
      uniform float operations[${capacity}];
      uniform vec3 stripeColor;
      uniform float stripeOpacity;
      uniform float fillOpacity;
      varying vec3 worldPoint;
      varying vec3 worldFacing;
      void main() {
        float coverage = 0.0;
        float viewerFacing = dot(worldFacing, cameraPosition - worldPoint);
        ${Array.from({ length: capacity }, (_, i) => `
        if (count > ${i}) {
          vec4 clip = projectors[${i}] * vec4(worldPoint, 1.0);
          vec3 ndc = clip.xyz / max(clip.w, 0.0001);
          vec3 dx = dFdx(ndc), dy = dFdy(ndc);
          float determinant = dx.x * dy.y - dy.x * dx.y;
          if (clip.w > 0.0001 && dot(worldFacing, positions[${i}] - worldPoint) * viewerFacing >= 0.0) {
            if (max(max(abs(ndc.x), abs(ndc.y)), abs(ndc.z)) <= 1.0) {
              vec2 screenUv = ndc.xy * 0.5 + 0.5;
              float depth = texture2D(depths[${i}], screenUv).r;
              // Compare at the depth texel's actual sample centre. Comparing
              // a sloping receiver to a different point creates stipple after
              // orbiting, even with no UV sampling. Do not widen depth epsilon.
              vec2 sampleUv = (floor(screenUv * depthSizes[${i}]) + 0.5) / depthSizes[${i}];
              vec2 slope = abs(determinant) > 0.000000000001
                ? vec2(dx.z * dy.y - dy.z * dx.y, dy.z * dx.x - dx.z * dy.x) / determinant
                : vec2(0.0);
              float receiverDepth = ndc.z * 0.5 + 0.5 + dot(slope, sampleUv - screenUv);
              if (depth < 0.999999 && receiverDepth <= depth + 0.00002) {
                vec4 sampleMask = texture2D(masks[${i}], vec2(screenUv.x, 1.0 - screenUv.y));
                float alpha = max(sampleMask.r, max(sampleMask.g, sampleMask.b)) * sampleMask.a;
                coverage = operations[${i}] > 0.0 ? alpha + coverage * (1.0 - alpha) : coverage * (1.0 - alpha);
              }
            }
          }
        }`).join('\n')}
        if (inverted > 0.5) coverage = 1.0 - coverage;
        if (coverage <= 0.01) discard;
        float stripe = 1.0 - step(7.0, mod(gl_FragCoord.x + gl_FragCoord.y, 14.0));
        // Match the current editor overlay depth policy for the A/B test.
        gl_FragDepthEXT = clamp(gl_FragCoord.z - 0.00008, 0.0, 1.0);
        gl_FragColor = vec4(stripeColor, mix(fillOpacity, stripeOpacity, stripe) * coverage);
      }
    `,
    transparent: true,
    depthTest: true,
    depthWrite: false,
    polygonOffset: true,
    polygonOffsetFactor: -16,
    polygonOffsetUnits: -16,
    side: THREE.DoubleSide,
    toneMapped: false,
  });
  material.forceSinglePass = true;
  return {
    material,
    setStrokes(strokes: readonly ProjectedSelectionStroke[], inverted = false) {
      if (strokes.length > capacity) throw new Error('Projection preview prototype supports at most four stroke snapshots.');
      if (strokes.some(stroke => !stroke.depth?.isDepthTexture || !stroke.mask?.isTexture)) {
        throw new Error('Projection preview requires both mask and captured depth.');
      }
      const u = material.uniforms;
      for (let i = 0; i < capacity; i++) {
        const stroke = strokes[i];
        u.masks.value[i] = stroke?.mask ?? null;
        u.depths.value[i] = stroke?.depth ?? null;
        if (stroke) {
          u.projectors.value[i].copy(stroke.projector);
          u.positions.value[i].copy(stroke.position);
          u.depthSizes.value[i].set(stroke.depth.image.width, stroke.depth.image.height);
          u.operations.value[i] = stroke.operation === 'add' ? 1 : -1;
        }
      }
      u.count.value = strokes.length;
      u.inverted.value = inverted ? 1 : 0;
    },
    dispose() { material.dispose(); },
  };
}
