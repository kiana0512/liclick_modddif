import * as THREE from 'three';

const viewDirection = new THREE.Vector3();

/** View-aligned brush axes transported onto the hit plane for UV fallbacks.
 * The GPU path projects the circular screen footprint directly. These axes
 * are its local differential, rather than a circle in the surface tangent plane.
 */
export function computeViewAlignedSurfaceTangents(
  normal: THREE.Vector3,
  point: THREE.Vector3,
  camera: THREE.Camera,
  axisX: THREE.Vector3,
  axisY: THREE.Vector3,
) {
  if (camera.projectionMatrix.elements[15] === 0) {
    viewDirection.setFromMatrixPosition(camera.matrixWorld).sub(point).normalize();
  } else {
    viewDirection.setFromMatrixColumn(camera.matrixWorld, 2).normalize();
  }
  const facing = normal.dot(viewDirection);
  if (!Number.isFinite(facing) || Math.abs(facing) < 1e-4) return false;
  axisX.setFromMatrixColumn(camera.matrixWorld, 0).normalize();
  axisY.setFromMatrixColumn(camera.matrixWorld, 1).normalize();
  axisX.addScaledVector(viewDirection, -normal.dot(axisX) / facing);
  axisY.addScaledVector(viewDirection, -normal.dot(axisY) / facing);
  return true;
}
