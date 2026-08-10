import * as THREE from 'three';

export type LocalRepaintGpuOverlayBinding = {
  material: THREE.ShaderMaterial;
  root: THREE.Object3D;
  meshes: THREE.Mesh[];
};

export type LocalRepaintGpuOverlaySyncInput = {
  modelGroup: THREE.Object3D;
  sourceTexture?: THREE.Texture;
  maskTexture: THREE.Texture;
  visible: boolean;
};

/**
 * Keeps the latency-sensitive repaint overlay attached to the current model and
 * sampling the current live textures. Both live registries use stable URLs, so
 * a canvas/image replacement can otherwise leave an already compiled material
 * pointing at the disposed texture that previously owned that URL.
 */
export function syncLocalRepaintGpuOverlayBinding(
  overlay: LocalRepaintGpuOverlayBinding,
  input: LocalRepaintGpuOverlaySyncInput,
) {
  let repaired = false;

  if (overlay.root.parent !== input.modelGroup) {
    input.modelGroup.add(overlay.root);
    repaired = true;
  }
  for (const mesh of overlay.meshes) {
    if (mesh.parent === overlay.root) continue;
    overlay.root.add(mesh);
    repaired = true;
  }

  const projectedMap = overlay.material.uniforms.projectedMap;
  if (input.sourceTexture && projectedMap?.value !== input.sourceTexture) {
    projectedMap.value = input.sourceTexture;
    input.sourceTexture.needsUpdate = true;
    repaired = true;
  }
  const maskMap = overlay.material.uniforms.maskMap;
  if (maskMap?.value !== input.maskTexture) {
    maskMap.value = input.maskTexture;
    input.maskTexture.needsUpdate = true;
    repaired = true;
  }

  if (overlay.root.visible !== input.visible) {
    overlay.root.visible = input.visible;
    repaired = true;
  }
  for (const mesh of overlay.meshes) {
    if (mesh.visible === input.visible) continue;
    mesh.visible = input.visible;
    repaired = true;
  }
  const opacity = overlay.material.uniforms.layerOpacity;
  const expectedOpacity = input.visible ? 1 : 0;
  if (opacity && opacity.value !== expectedOpacity) {
    opacity.value = expectedOpacity;
    repaired = true;
  }

  return repaired;
}
