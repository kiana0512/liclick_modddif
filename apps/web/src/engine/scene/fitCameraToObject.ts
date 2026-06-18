import * as THREE from 'three';
import type { ViewportRuntime } from '@/stores/sceneStore';
import { getBoundingBoxForObject, getMaxDimension } from './boundingBoxUtils';

export function fitCameraToObject(runtime: ViewportRuntime, object: THREE.Object3D) {
  const boundingBox = getBoundingBoxForObject(object);
  const center = new THREE.Vector3().fromArray(boundingBox.center);
  const radius = Math.max(getMaxDimension(boundingBox), 1);

  runtime.camera.position.set(center.x + radius * 1.15, center.y + radius * 0.82, center.z + radius * 1.45);
  runtime.camera.lookAt(center);

  if (runtime.camera instanceof THREE.PerspectiveCamera) {
    runtime.camera.near = 0.01;
    runtime.camera.far = Math.max(radius * 12, 100);
    runtime.camera.updateProjectionMatrix();
  }

  if (runtime.camera instanceof THREE.OrthographicCamera) {
    runtime.camera.near = 0.01;
    runtime.camera.far = Math.max(radius * 12, 100);
    runtime.camera.zoom = 90;
    runtime.camera.updateProjectionMatrix();
  }

  runtime.controls?.target.copy(center);
  runtime.controls?.update();
}
