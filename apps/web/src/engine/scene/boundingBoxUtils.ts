import * as THREE from 'three';
import type { ModelBoundingBox } from '@/types/model';

export function tupleFromVector(vector: THREE.Vector3): [number, number, number] {
  return [vector.x, vector.y, vector.z];
}

export function getBoundingBoxForObject(object: THREE.Object3D): ModelBoundingBox {
  object.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(object);
  const center = new THREE.Vector3();
  const size = new THREE.Vector3();
  box.getCenter(center);
  box.getSize(size);

  return {
    min: tupleFromVector(box.min),
    max: tupleFromVector(box.max),
    center: tupleFromVector(center),
    size: tupleFromVector(size),
  };
}

export function getMaxDimension(boundingBox: ModelBoundingBox) {
  return Math.max(boundingBox.size[0], boundingBox.size[1], boundingBox.size[2]);
}
