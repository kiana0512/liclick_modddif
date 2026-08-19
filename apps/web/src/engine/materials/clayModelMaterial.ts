import * as THREE from 'three';

/**
 * Canonical Li3D white-model appearance.
 *
 * Keep every texture-empty viewport, capture and model preview on this single
 * sculpting-style material so switching workflows never changes the model from
 * neutral white to blue-grey or beige.
 */
export const CLAY_MODEL_COLOR = '#f0f1ee';
export const CLAY_MODEL_ROUGHNESS = 0.78;
export const CLAY_MODEL_METALNESS = 0;

export function createClayModelMaterial(
  parameters: THREE.MeshStandardMaterialParameters = {},
) {
  return new THREE.MeshStandardMaterial({
    color: CLAY_MODEL_COLOR,
    roughness: CLAY_MODEL_ROUGHNESS,
    metalness: CLAY_MODEL_METALNESS,
    emissive: '#000000',
    emissiveIntensity: 0,
    ...parameters,
  });
}
