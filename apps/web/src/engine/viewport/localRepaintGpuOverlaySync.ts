import * as THREE from 'three';
import type { ProjectionPreviewLighting } from '@/engine/projection/projectionTypes';

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
  opacity?: number;
  strength?: number;
  hue?: number;
  saturation?: number;
  lightness?: number;
};

export function isLocalRepaintOverlayVisible(displayMode: string, layerVisible: boolean) {
  return layerVisible && (displayMode === 'pbr' || displayMode === 'flat');
}

export function syncLocalRepaintGpuOverlayLighting(
  overlay: Pick<LocalRepaintGpuOverlayBinding, 'material'>,
  lighting: ProjectionPreviewLighting,
) {
  const uniforms = overlay.material.uniforms;
  let updated = false;
  const syncNumber = (name: string, value: number) => {
    const uniform = uniforms[name];
    if (!uniform || uniform.value === value) return;
    uniform.value = value;
    updated = true;
  };
  syncNumber('previewLightingEnabled', lighting.enabled ? 1 : 0);
  syncNumber('previewExposure', lighting.exposure);
  syncNumber('ambientLightIntensity', lighting.ambientIntensity);
  syncNumber('keyLightIntensity', lighting.keyLightIntensity);
  const direction = uniforms.keyLightDirection?.value;
  if (direction instanceof THREE.Vector3) {
    const [x, y, z] = lighting.keyLightDirection;
    if (direction.x !== x || direction.y !== y || direction.z !== z) {
      direction.set(x, y, z);
      updated = true;
    }
  }
  // Demand-driven rendering can reuse the same linked program across display
  // modes. Mark its uniforms dirty explicitly so PBR -> Flat cannot draw one
  // more frame with the previous lighting state.
  if (updated) overlay.material.uniformsNeedUpdate = true;
  return updated;
}

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
  const expectedOpacity = input.visible ? (input.opacity ?? 1) : 0;
  if (opacity && opacity.value !== expectedOpacity) {
    opacity.value = expectedOpacity;
    repaired = true;
  }

  const syncNumber = (name: string, value: number) => {
    const uniform = overlay.material.uniforms[name];
    if (!uniform || uniform.value === value) return;
    uniform.value = value;
    repaired = true;
  };
  syncNumber('layerStrength', input.strength ?? 1);
  syncNumber('hueShift', input.hue ?? 0);
  syncNumber('saturationShift', input.saturation ?? 0);
  syncNumber('lightnessShift', input.lightness ?? 0);

  if (repaired) overlay.material.uniformsNeedUpdate = true;

  return repaired;
}
