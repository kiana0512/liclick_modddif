import * as THREE from 'three';
import type { ViewportRuntime } from '@/stores/sceneStore';
import { getBoundingBoxForObject, getMaxDimension } from './boundingBoxUtils';
import type { ModelBoundingBox } from '@/types/model';

const WORLD_UP = new THREE.Vector3(0, 1, 0);

export type CameraFitOptions = {
  direction?: THREE.Vector3;
  up?: THREE.Vector3;
  padding?: number;
};

function fitCameraToBoundingBoxFromDirection(
  runtime: ViewportRuntime,
  boundingBox: ModelBoundingBox,
  options: CameraFitOptions,
) {
  const camera = runtime.camera;
  if (!(camera instanceof THREE.PerspectiveCamera || camera instanceof THREE.OrthographicCamera)) return;

  const center = new THREE.Vector3().fromArray(boundingBox.center);
  const halfSize = new THREE.Vector3().fromArray(boundingBox.size).multiplyScalar(0.5);
  const radius = Math.max(getMaxDimension(boundingBox), 1);
  const direction = options.direction?.clone().normalize() ?? new THREE.Vector3(0, 0, 1);
  const requestedUp = options.up?.clone().normalize() ?? new THREE.Vector3(0, 1, 0);
  const right = new THREE.Vector3().crossVectors(requestedUp, direction);
  if (right.lengthSq() < 0.000001) right.crossVectors(new THREE.Vector3(0, 0, 1), direction);
  if (right.lengthSq() < 0.000001) right.crossVectors(new THREE.Vector3(1, 0, 0), direction);
  right.normalize();
  const up = new THREE.Vector3().crossVectors(direction, right).normalize();
  const halfWidth = Math.max(
    Math.abs(right.x) * halfSize.x + Math.abs(right.y) * halfSize.y + Math.abs(right.z) * halfSize.z,
    0.001,
  );
  const halfHeight = Math.max(
    Math.abs(up.x) * halfSize.x + Math.abs(up.y) * halfSize.y + Math.abs(up.z) * halfSize.z,
    0.001,
  );
  const halfDepth =
    Math.abs(direction.x) * halfSize.x +
    Math.abs(direction.y) * halfSize.y +
    Math.abs(direction.z) * halfSize.z;
  const padding = Math.max(options.padding ?? 1.15, 1);
  let distance: number;

  if (camera instanceof THREE.PerspectiveCamera) {
    const tanHalfVerticalFov = Math.tan(THREE.MathUtils.degToRad(camera.fov) * 0.5);
    const tanHalfHorizontalFov = tanHalfVerticalFov * Math.max(camera.aspect, 0.001);
    distance =
      halfDepth +
      Math.max(halfHeight / tanHalfVerticalFov, halfWidth / tanHalfHorizontalFov) * padding;
  } else {
    const viewWidth = Math.max(camera.right - camera.left, 1);
    const viewHeight = Math.max(camera.top - camera.bottom, 1);
    camera.zoom = Math.min(
      viewWidth / (halfWidth * 2 * padding),
      viewHeight / (halfHeight * 2 * padding),
    );
    distance = halfDepth + radius * 2.4;
  }

  camera.position.copy(center).addScaledVector(direction, Math.max(distance, 0.1));
  camera.up.copy(up);
  camera.near = 0.01;
  camera.far = Math.max(distance + halfDepth + radius * 6, 100);
  camera.lookAt(center);
  camera.updateProjectionMatrix();
  camera.updateMatrixWorld(true);
  runtime.controls?.target.copy(center);
  runtime.controls?.update();
}

export function fitCameraToBoundingBox(
  runtime: ViewportRuntime,
  boundingBox: ModelBoundingBox,
  options: CameraFitOptions = {},
) {
  if (options.direction) {
    fitCameraToBoundingBoxFromDirection(runtime, boundingBox, options);
    return;
  }
  const center = new THREE.Vector3().fromArray(boundingBox.center);
  const radius = Math.max(getMaxDimension(boundingBox), 1);

  runtime.camera.position.set(center.x + radius * 1.15, center.y + radius * 0.82, center.z + radius * 1.45);
  // Orbiting across a pole intentionally rotates camera.up to keep navigation
  // continuous. A later auto-fit changes the viewing direction completely, so
  // carrying that old up vector across the fit introduces an arbitrary roll.
  runtime.camera.up.copy(WORLD_UP);
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

export function fitCameraToObject(
  runtime: ViewportRuntime,
  object: THREE.Object3D,
  options: CameraFitOptions = {},
) {
  fitCameraToBoundingBox(runtime, getBoundingBoxForObject(object), options);
}
