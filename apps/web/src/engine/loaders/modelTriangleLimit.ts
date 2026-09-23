import * as THREE from 'three';

export const TEXTURE_MODEL_TRIANGLE_LIMIT = 2_000_000;
export const AUTO_UV_MODEL_TRIANGLE_LIMIT = 70_000;
export const IMPORT_DECIMATE_THRESHOLD = 1_500_000;
export const IMPORT_DECIMATE_TARGET = 200_000;

export function countModelTriangles(root: THREE.Object3D) {
  let triangles = 0;
  root.traverse((child) => {
    const mesh = child as THREE.Mesh;
    if (!mesh.isMesh) return;
    const position = mesh.geometry?.getAttribute('position');
    if (!position) return;
    triangles += Math.floor((mesh.geometry.getIndex()?.count ?? position.count) / 3);
  });
  return triangles;
}

export function modelTriangleLimitMessage(limit: number, actual: number) {
  const limitLabel = limit === AUTO_UV_MODEL_TRIANGLE_LIMIT ? '7 万' : '200 万';
  return `不支持 ${limitLabel}面以上的模型。当前模型约 ${actual.toLocaleString('zh-CN')} 面。`;
}

export function assertModelTriangleLimit(
  root: THREE.Object3D,
  limit: number,
) {
  const triangles = countModelTriangles(root);
  if (triangles > limit) throw new Error(modelTriangleLimitMessage(limit, triangles));
  return triangles;
}

export function disposeRejectedModel(root: THREE.Object3D) {
  const disposedGeometries = new Set<THREE.BufferGeometry>();
  const disposedMaterials = new Set<THREE.Material>();
  const disposedTextures = new Set<THREE.Texture>();
  root.traverse((child) => {
    const mesh = child as THREE.Mesh;
    if (!mesh.isMesh) return;
    if (!disposedGeometries.has(mesh.geometry)) {
      disposedGeometries.add(mesh.geometry);
      mesh.geometry.dispose();
    }
    const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    materials.forEach((material) => {
      if (!material || disposedMaterials.has(material)) return;
      disposedMaterials.add(material);
      Object.values(material).forEach((value) => {
        if (!(value instanceof THREE.Texture) || disposedTextures.has(value)) return;
        disposedTextures.add(value);
        value.dispose();
      });
      material.dispose();
    });
  });
}
