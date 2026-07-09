import * as THREE from 'three';
import type { SerializedCamera } from '@/types/capture';

export function serializeCamera(camera: THREE.Camera, aspect: number, target: THREE.Vector3): SerializedCamera {
  camera.updateMatrixWorld(true);
  const type = camera instanceof THREE.OrthographicCamera ? 'orthographic' : 'perspective';

  return {
    type,
    projection: type,
    position: [camera.position.x, camera.position.y, camera.position.z],
    quaternion: [camera.quaternion.x, camera.quaternion.y, camera.quaternion.z, camera.quaternion.w],
    target: [target.x, target.y, target.z],
    near: camera instanceof THREE.PerspectiveCamera || camera instanceof THREE.OrthographicCamera ? camera.near : 0.1,
    far: camera instanceof THREE.PerspectiveCamera || camera instanceof THREE.OrthographicCamera ? camera.far : 100,
    fov: camera instanceof THREE.PerspectiveCamera ? camera.fov : undefined,
    zoom: camera instanceof THREE.PerspectiveCamera || camera instanceof THREE.OrthographicCamera ? camera.zoom : 1,
    projectionMatrix: camera.projectionMatrix.toArray(),
    matrixWorld: camera.matrixWorld.toArray(),
    viewMatrix: camera.matrixWorldInverse.toArray(),
    aspect,
  };
}

export function applySerializedCamera(camera: THREE.Camera, snapshot: SerializedCamera) {
  camera.position.fromArray(snapshot.position);
  camera.quaternion.fromArray(snapshot.quaternion);

  if (camera instanceof THREE.PerspectiveCamera) {
    camera.near = snapshot.near;
    camera.far = snapshot.far;
    camera.fov = snapshot.fov ?? camera.fov;
    camera.zoom = snapshot.zoom;
    camera.updateProjectionMatrix();
  }

  if (camera instanceof THREE.OrthographicCamera) {
    camera.near = snapshot.near;
    camera.far = snapshot.far;
    camera.zoom = snapshot.zoom;
    camera.updateProjectionMatrix();
  }

  camera.updateMatrixWorld(true);
}
