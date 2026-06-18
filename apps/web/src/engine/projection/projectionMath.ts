import * as THREE from 'three';
import type { SerializedCamera } from '@/types/capture';
import type { ProjectionMatrixBundle } from './projectionTypes';

export function buildProjectionMatrixBundle(camera: SerializedCamera): ProjectionMatrixBundle {
  const projectionMatrix = new THREE.Matrix4().fromArray(camera.projectionMatrix);
  const matrixWorld = new THREE.Matrix4().fromArray(camera.matrixWorld);
  const viewMatrix = matrixWorld.clone().invert();
  const projectorMatrix = projectionMatrix.clone().multiply(viewMatrix);

  return {
    viewMatrix,
    projectionMatrix,
    projectorMatrix,
  };
}

export function projectWorldPointToUv(
  worldPoint: [number, number, number],
  bundle: ProjectionMatrixBundle,
) {
  const point = new THREE.Vector4(worldPoint[0], worldPoint[1], worldPoint[2], 1);
  point.applyMatrix4(bundle.projectorMatrix);
  if (point.w === 0) return undefined;

  const ndcX = point.x / point.w;
  const ndcY = point.y / point.w;
  const ndcZ = point.z / point.w;
  if (Math.abs(ndcX) > 1 || Math.abs(ndcY) > 1 || ndcZ < -1 || ndcZ > 1) return undefined;

  return [(ndcX + 1) * 0.5, (ndcY + 1) * 0.5] as const;
}
