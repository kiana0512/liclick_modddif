import * as THREE from 'three';

type ViewCamera = THREE.PerspectiveCamera | THREE.OrthographicCamera;

/** ALG-VIEW-PROJECTION-001 v1.0.0: preserve scale at the orbit target plane. */
export function switchCameraProjection(source: ViewCamera, destination: ViewCamera, target: THREE.Vector3) {
  if (source === destination) return;
  const distance = source.position.distanceTo(target);
  // Matrix Y scale includes both the field of view/frustum and camera zoom.
  const height = 2 * (source instanceof THREE.PerspectiveCamera ? distance : 1) / source.projectionMatrix.elements[5];
  if (!Number.isFinite(height) || height <= 0) return;

  destination.position.copy(source.position);
  destination.quaternion.copy(source.quaternion);
  destination.up.copy(source.up);
  if (destination instanceof THREE.OrthographicCamera) {
    destination.zoom = (destination.top - destination.bottom) / height;
  } else {
    const nextDistance = height * destination.projectionMatrix.elements[5] / 2;
    destination.position.copy(target).addScaledVector(source.getWorldDirection(new THREE.Vector3()), -nextDistance);
  }
  const nextDistance = destination.position.distanceTo(target);
  destination.near = Math.min(source.near, 0.01, Math.max(nextDistance * 0.01, 1e-6));
  destination.far = Math.max(source.far + Math.max(nextDistance - distance, 0), 100, nextDistance * 4);
  destination.updateProjectionMatrix();
  destination.updateMatrixWorld(true);
}
