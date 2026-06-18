import * as THREE from 'three';
import type { ProjectionLayerInput } from './projectionTypes';

export function createProjectedLayerMaterial(_input: ProjectionLayerInput): THREE.MeshStandardMaterial {
  // TODO: Replace with a shader material that samples projected texture with camera matrices.
  return new THREE.MeshStandardMaterial({
    color: '#d8b4fe',
    roughness: 0.55,
    metalness: 0.05,
  });
}
