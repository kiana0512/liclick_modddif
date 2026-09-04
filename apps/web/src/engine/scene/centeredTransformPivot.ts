import * as THREE from 'three';

export type CenteredTransformSnapshot = {
  objectWorld: THREE.Matrix4;
  pivotWorldInverse: THREE.Matrix4;
};

const boundsScratch = new THREE.Box3();
const centerScratch = new THREE.Vector3();
const quaternionScratch = new THREE.Quaternion();
const scaleScratch = new THREE.Vector3();
const pivotWorldScratch = new THREE.Matrix4();
const parentWorldInverseScratch = new THREE.Matrix4();
const objectLocalScratch = new THREE.Matrix4();

export function alignTransformPivotToObjectCenter(
  object: THREE.Object3D,
  pivot: THREE.Object3D,
) {
  object.updateWorldMatrix(true, true);
  boundsScratch.setFromObject(object);
  if (boundsScratch.isEmpty()) object.getWorldPosition(centerScratch);
  else boundsScratch.getCenter(centerScratch);

  object.matrixWorld.decompose(new THREE.Vector3(), quaternionScratch, scaleScratch);
  pivotWorldScratch.compose(centerScratch, quaternionScratch, scaleScratch);
  if (pivot.parent) {
    pivot.parent.updateWorldMatrix(true, false);
    parentWorldInverseScratch.copy(pivot.parent.matrixWorld).invert();
    pivotWorldScratch.premultiply(parentWorldInverseScratch);
  }
  pivotWorldScratch.decompose(pivot.position, pivot.quaternion, pivot.scale);
  pivot.updateMatrix();
  pivot.updateWorldMatrix(true, false);
  return centerScratch.clone();
}

export function captureCenteredTransform(
  object: THREE.Object3D,
  pivot: THREE.Object3D,
): CenteredTransformSnapshot {
  object.updateWorldMatrix(true, true);
  pivot.updateWorldMatrix(true, false);
  return {
    objectWorld: object.matrixWorld.clone(),
    pivotWorldInverse: pivot.matrixWorld.clone().invert(),
  };
}

export function applyCenteredTransform(
  object: THREE.Object3D,
  pivot: THREE.Object3D,
  snapshot: CenteredTransformSnapshot,
) {
  pivot.updateWorldMatrix(true, false);
  objectLocalScratch
    .multiplyMatrices(pivot.matrixWorld, snapshot.pivotWorldInverse)
    .multiply(snapshot.objectWorld);
  if (object.parent) {
    object.parent.updateWorldMatrix(true, false);
    parentWorldInverseScratch.copy(object.parent.matrixWorld).invert();
    objectLocalScratch.premultiply(parentWorldInverseScratch);
  }
  objectLocalScratch.decompose(object.position, object.quaternion, object.scale);
  object.updateMatrix();
  object.updateWorldMatrix(true, true);
}
