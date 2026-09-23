import * as THREE from 'three';

// ALG-LR-014 v2: clear supported stroke pixels, independently of color feather strength.
export const SELECTION_CONSUMPTION_VERSION = 2;

export type SelectionPixelPatch = { offset: number; before: Uint8Array; after: Uint8Array };

/** Keep only changed scanline spans in history, not two complete 2048² images. */
export function diffSelectionPixels(before: Uint8Array, after: Uint8Array, width: number) {
  if (before.length !== after.length || before.length % (width * 4) !== 0)
    throw new Error('Selection snapshot dimensions differ.');
  const patches: SelectionPixelPatch[] = [];
  const stride = width * 4;
  for (let row = 0; row < before.length; row += stride) {
    let first = 0;
    while (first < stride && before[row + first] === after[row + first]) first++;
    if (first === stride) continue;
    let last = stride - 1;
    while (last > first && before[row + last] === after[row + last]) last--;
    first -= first % 4;
    last = Math.min(stride, (Math.floor(last / 4) + 1) * 4);
    const offset = row + first;
    patches.push({
      offset,
      before: before.slice(offset, row + last),
      after: after.slice(offset, row + last),
    });
  }
  return patches;
}

export function applySelectionPixelPatches(
  pixels: Uint8Array,
  patches: SelectionPixelPatch[],
  side: 'before' | 'after',
) {
  for (const patch of patches) pixels.set(patch[side], patch.offset);
}

export function selectionPixelsHaveContent(pixels: Uint8Array, inverted: boolean) {
  // Inverted selection also includes UV islands not previously touched.
  if (inverted) return true;
  for (let i = 0; i < pixels.length; i += 4) {
    if (pixels[i] > 2 || pixels[i + 1] > 2) return true;
  }
  return false;
}

const materials = new WeakMap<THREE.ShaderMaterial, THREE.ShaderMaterial>();

/** Reuse the literal repaint alpha calculation, including source alpha, depth,
 * facing and inward crossfade. Only raster coordinates and output channels differ.
 * Borrowed uniforms/textures/geometries are never disposed by this pass. */
export function getSelectionConsumptionMaterial(source: THREE.ShaderMaterial) {
  const cached = materials.get(source);
  if (cached) return cached;
  const entry = /void main\(\)\s*\{/;
  if (
    !entry.test(source.vertexShader) ||
    !entry.test(source.fragmentShader) ||
    !source.uniforms.transparentProjectionOnly ||
    !source.uniforms.projectorMatrix
  )
    throw new Error('Selection consumption requires a literal projected repaint material.');
  const material = new THREE.ShaderMaterial({
    uniforms: { ...source.uniforms, consumptionStrokeMap: { value: null }, consumptionUsesUv: { value: 0 } },
    vertexShader:
      source.vertexShader.replace(entry, 'void repaintVertex() {') +
      `
      void main() {
        repaintVertex();
        gl_Position = vec4(uv * 2.0 - 1.0, 0.0, 1.0);
      }
    `,
    fragmentShader:
      source.fragmentShader.replace(entry, 'void repaintFragment() {') +
      `
      uniform sampler2D consumptionStrokeMap;
      uniform float consumptionUsesUv;
      void main() {
        if (consumptionUsesUv < 0.5) repaintFragment();
        vec4 capturePosition = objectMatrixDelta * vec4(vWorldPosition, 1.0);
        vec4 clip = projectorMatrix * capturePosition;
        vec2 strokeUv = clip.xy / max(clip.w, 0.0001) * 0.5 + 0.5;
        strokeUv.y = 1.0 - strokeUv.y;
        float strokeAlpha = texture2D(consumptionStrokeMap, mix(strokeUv, vec2(vUv.x, 1.0 - vUv.y), consumptionUsesUv)).a;
        float alpha = consumptionUsesUv > 0.5 ? strokeAlpha : gl_FragColor.a * step(0.0039, strokeAlpha);
        if (alpha <= 0.01) discard;
        alpha = 1.0;
        vec3 normal = normalize(objectNormalDelta * vWorldNormal);
        float front = step(0.0, dot(normal, projectorPosition - capturePosition.xyz));
        gl_FragColor = vec4(alpha * front, alpha * (1.0 - front), alpha, alpha);
      }
    `,
    defines: { ...source.defines },
    transparent: true,
    depthTest: false,
    depthWrite: false,
    side: THREE.DoubleSide,
    toneMapped: false,
    blending: THREE.CustomBlending,
    blendEquation: THREE.AddEquation,
  });
  materials.set(source, material);
  source.addEventListener('dispose', () => {
    material.dispose();
    materials.delete(source);
  });
  return material;
}

/** One GPU UV pass at pointer-up. Fragment rejection leaves every unpainted
 * texel intact; RGB sided coverage prevents clearing the reverse face. */
export function consumeSelectionMask(input: {
  renderer: THREE.WebGLRenderer;
  camera: THREE.Camera;
  meshes: THREE.Mesh[];
  material: THREE.ShaderMaterial;
  stroke: HTMLCanvasElement;
  strokeSpace?: 'projection' | 'uv';
  target: THREE.WebGLRenderTarget;
  inverted: boolean;
}) {
  const { renderer, target } = input;
  const material = getSelectionConsumptionMaterial(input.material);
  const strokeTexture = new THREE.CanvasTexture(input.stroke);
  // Source/projector masks use top-left coordinates throughout this pipeline.
  strokeTexture.flipY = false;
  strokeTexture.generateMipmaps = false;
  strokeTexture.minFilter = THREE.LinearFilter;
  strokeTexture.magFilter = THREE.LinearFilter;
  material.uniforms.consumptionStrokeMap.value = strokeTexture;
  material.uniforms.consumptionUsesUv.value = input.strokeSpace === 'uv' ? 1 : 0;
  material.blendSrc = input.inverted ? THREE.OneMinusDstColorFactor : THREE.ZeroFactor;
  material.blendDst = input.inverted ? THREE.OneFactor : THREE.OneMinusSrcColorFactor;
  const scene = new THREE.Scene();
  for (const source of input.meshes) {
    if (!source.geometry.getAttribute('uv')) continue;
    source.updateWorldMatrix(true, false);
    const mesh = new THREE.Mesh(source.geometry, material);
    mesh.matrixAutoUpdate = false;
    mesh.matrix.copy(source.matrixWorld);
    mesh.frustumCulled = false;
    scene.add(mesh);
  }
  const oldTarget = renderer.getRenderTarget();
  const oldAutoClear = renderer.autoClear;
  try {
    renderer.autoClear = false;
    renderer.setRenderTarget(target);
    renderer.render(scene, input.camera);
  } finally {
    renderer.setRenderTarget(oldTarget);
    renderer.autoClear = oldAutoClear;
    material.uniforms.consumptionStrokeMap.value = null;
    strokeTexture.dispose();
    scene.clear();
  }
}
