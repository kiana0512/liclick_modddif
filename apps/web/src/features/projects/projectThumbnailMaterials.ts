import * as THREE from 'three';

type NeutralMaterialState = {
  material: THREE.MeshStandardMaterial;
  emissive: THREE.Color;
  emissiveIntensity: number;
};

/**
 * Selection is represented by a slight purple emissive tint on an otherwise
 * untextured clay material. Project thumbnails hide selection UI, so remove
 * that tint without replacing material instances or touching textured maps.
 */
export function neutralizeUntexturedThumbnailMaterials(roots: THREE.Object3D[]) {
  const states: NeutralMaterialState[] = [];
  const visited = new Set<THREE.Material>();

  for (const root of roots) {
    root.traverse((object) => {
      if (!(object instanceof THREE.Mesh)) return;
      const materials = Array.isArray(object.material) ? object.material : [object.material];
      for (const material of materials) {
        if (visited.has(material)) continue;
        visited.add(material);
        if (
          !(material instanceof THREE.MeshStandardMaterial) ||
          material.map ||
          material.emissiveMap
        ) {
          continue;
        }
        states.push({
          material,
          emissive: material.emissive.clone(),
          emissiveIntensity: material.emissiveIntensity,
        });
        material.emissive.set(0x000000);
        material.emissiveIntensity = 0;
      }
    });
  }

  return () => {
    for (const state of states) {
      state.material.emissive.copy(state.emissive);
      state.material.emissiveIntensity = state.emissiveIntensity;
    }
  };
}
