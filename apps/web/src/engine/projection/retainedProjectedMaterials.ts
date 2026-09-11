import * as THREE from 'three';
import {
  disposeGeneratedMaterialTree,
  updateProjectedLayerStackMaterial,
} from './ProjectedLayerMaterial';
import type { ProjectionLayerStackInput } from './projectionTypes';
import { isResidentProjectedMaterial } from './projectedMaterialIdentity';

// ALG-PROJ-007: keep the last single and multi-layer representations separately.
// A single-layer factory has different coverage semantics; requesting it must
// not destroy the full stack needed by the next eye-open. These are detached,
// already-built materials, never preloaded hidden assets or new GPU copies.
export class RetainedProjectedMaterials {
  private materials = new Map<boolean, THREE.ShaderMaterial>();

  retain(material: THREE.Material | THREE.Material[]) {
    if (Array.isArray(material)) {
      for (const entry of new Set(material)) this.retain(entry);
      return;
    }
    if (!(material instanceof THREE.ShaderMaterial) || !isResidentProjectedMaterial(material)) {
      disposeGeneratedMaterialTree(material);
      return;
    }
    const single = material.userData.liclickProjectedLayerStackState?.bindings?.length === 1;
    const previous = this.materials.get(single);
    if (previous && previous !== material) disposeGeneratedMaterialTree(previous);
    this.materials.set(single, material);
  }

  take(input: ProjectionLayerStackInput) {
    const single = input.layers.length === 1;
    const material = this.materials.get(single);
    if (!material) return;
    this.materials.delete(single);
    if (updateProjectedLayerStackMaterial(material, input)) return material;
    // Changed source/camera/order/sampler contracts must use the original
    // factory. Do not retain an incompatible revision indefinitely.
    disposeGeneratedMaterialTree(material);
  }

  dispose() {
    for (const material of this.materials.values()) disposeGeneratedMaterialTree(material);
    this.materials.clear();
  }
}
