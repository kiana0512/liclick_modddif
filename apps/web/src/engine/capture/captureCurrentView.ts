import { captureColor } from './captureColor';
import { captureDepth } from './captureDepth';
import { captureMask } from './captureMask';
import { captureNormal } from './captureNormal';
import type { CaptureCurrentViewRequest, CapturePassRequest } from './captureTypes';
import { applyTargetOnlyMaterial, renderSceneToDataUrl } from './renderTargetUtils';
import { serializeCamera } from '@/engine/projection/ProjectionCamera';
import { useProjectStore } from '@/stores/projectStore';
import { useSceneStore } from '@/stores/sceneStore';
import type { Capture } from '@/types/capture';
import { createId } from '@/utils/id';
import * as THREE from 'three';

const maxCaptureSize = 2048;
const defaultFillRatio = 0.96;

function getBoxCorners(box: THREE.Box3) {
  return [
    new THREE.Vector3(box.min.x, box.min.y, box.min.z),
    new THREE.Vector3(box.min.x, box.min.y, box.max.z),
    new THREE.Vector3(box.min.x, box.max.y, box.min.z),
    new THREE.Vector3(box.min.x, box.max.y, box.max.z),
    new THREE.Vector3(box.max.x, box.min.y, box.min.z),
    new THREE.Vector3(box.max.x, box.min.y, box.max.z),
    new THREE.Vector3(box.max.x, box.max.y, box.min.z),
    new THREE.Vector3(box.max.x, box.max.y, box.max.z),
  ];
}

function getViewFrame(box: THREE.Box3, viewDirection: THREE.Vector3, sourceUp: THREE.Vector3) {
  const center = new THREE.Vector3();
  box.getCenter(center);
  const direction = viewDirection.clone().normalize();
  let right = sourceUp.clone().cross(direction);
  if (right.lengthSq() < 0.0001) right = new THREE.Vector3(1, 0, 0).cross(direction);
  right.normalize();
  const up = direction.clone().cross(right).normalize();

  let halfWidth = 0;
  let halfHeight = 0;
  let halfDepth = 0;
  for (const corner of getBoxCorners(box)) {
    const offset = corner.sub(center);
    halfWidth = Math.max(halfWidth, Math.abs(offset.dot(right)));
    halfHeight = Math.max(halfHeight, Math.abs(offset.dot(up)));
    halfDepth = Math.max(halfDepth, Math.abs(offset.dot(direction)));
  }

  return {
    center,
    direction,
    halfWidth: Math.max(halfWidth, 0.001),
    halfHeight: Math.max(halfHeight, 0.001),
    halfDepth: Math.max(halfDepth, 0.001),
  };
}

function getTargetBounds(scene: THREE.Scene, objectId: string) {
  const box = new THREE.Box3();
  let found = false;
  scene.updateMatrixWorld(true);
  scene.traverse((object) => {
    if (!(object instanceof THREE.Mesh)) return;
    if (object.userData.liclickObjectId !== objectId) return;
    box.expandByObject(object);
    found = true;
  });
  if (!found || box.isEmpty()) return undefined;
  return box;
}

function getViewDirection(camera: THREE.Camera, target?: THREE.Vector3) {
  const direction = new THREE.Vector3();
  if (target) {
    direction.copy(camera.position).sub(target);
  }
  if (direction.lengthSq() < 0.0001) {
    camera.getWorldDirection(direction).multiplyScalar(-1);
  }
  if (direction.lengthSq() < 0.0001) {
    direction.set(1, 0.65, 1);
  }
  return direction.normalize();
}

function createFitObjectCamera(
  sourceCamera: THREE.Camera,
  box: THREE.Box3,
  aspect: number,
  fillRatio: number,
  controlsTarget?: THREE.Vector3,
) {
  const direction = getViewDirection(sourceCamera, controlsTarget);
  const frame = getViewFrame(box, direction, sourceCamera.up);
  const center = frame.center;
  const safeFillRatio = THREE.MathUtils.clamp(fillRatio, 0.2, 0.98);

  if (sourceCamera instanceof THREE.OrthographicCamera) {
    const halfHeight = Math.max(frame.halfHeight, frame.halfWidth / aspect) / safeFillRatio;
    const halfWidth = halfHeight * aspect;
    const camera = new THREE.OrthographicCamera(-halfWidth, halfWidth, halfHeight, -halfHeight);
    camera.position.copy(center).add(direction.multiplyScalar(frame.halfDepth + halfHeight * 2));
    camera.up.copy(sourceCamera.up);
    camera.near = 0.01;
    camera.far = Math.max(frame.halfDepth * 8 + halfHeight * 4, 100);
    camera.zoom = 1;
    camera.lookAt(center);
    camera.updateProjectionMatrix();
    camera.updateMatrixWorld(true);
    return { camera, target: center.clone() };
  }

  const sourcePerspective = sourceCamera instanceof THREE.PerspectiveCamera ? sourceCamera : undefined;
  const fov = sourcePerspective?.fov ?? 35;
  const fovRad = THREE.MathUtils.degToRad(fov);
  const horizontalFovRad = 2 * Math.atan(Math.tan(fovRad * 0.5) * aspect);
  const distance = Math.max(
    frame.halfHeight / Math.tan(fovRad * 0.5),
    frame.halfWidth / Math.tan(horizontalFovRad * 0.5),
  ) / safeFillRatio;
  const camera = new THREE.PerspectiveCamera(fov, aspect);
  camera.position.copy(center).add(direction.multiplyScalar(distance));
  camera.up.copy(sourceCamera.up);
  camera.near = Math.max(0.01, distance - frame.halfDepth * 3);
  camera.far = Math.max(distance + frame.halfDepth * 5, 100);
  camera.lookAt(center);
  camera.updateProjectionMatrix();
  camera.updateMatrixWorld(true);
  return { camera, target: center.clone() };
}

async function captureClayTarget(passRequest: CapturePassRequest) {
  const restore = applyTargetOnlyMaterial(
    passRequest.scene,
    passRequest.objectId,
    () =>
      new THREE.MeshStandardMaterial({
        color: '#f4f4f0',
        roughness: 0.82,
        metalness: 0,
      }),
  );
  try {
    return {
      url: renderSceneToDataUrl({
        ...passRequest,
        clearColor: '#f7f7f3',
        clearAlpha: 1,
      }),
      warnings: [],
    };
  } finally {
    restore();
  }
}

export async function captureCurrentView(request: CaptureCurrentViewRequest): Promise<Capture> {
  const viewport = useSceneStore.getState().viewport;
  if (!viewport) throw new Error('Viewport is not ready yet.');

  const size = Math.min(request.resolution, maxCaptureSize);
  const warnings: string[] = [];
  if (request.resolution > maxCaptureSize) {
    warnings.push('Large reference capture was limited to 2048px in this browser MVP to avoid freezing the viewport.');
  }

  const aspect = 1;
  let captureCamera = viewport.camera;
  let captureTarget = viewport.controls?.target?.clone() ?? new THREE.Vector3();

  if (request.framing === 'fit-object') {
    const targetBounds = getTargetBounds(viewport.scene, request.objectId);
    if (!targetBounds) throw new Error('Could not find the selected model for fitted capture.');
    const fitted = createFitObjectCamera(
      viewport.camera,
      targetBounds,
      aspect,
      request.fillRatio ?? defaultFillRatio,
      viewport.controls?.target,
    );
    captureCamera = fitted.camera;
    captureTarget = fitted.target;
  }

  const passRequest: CapturePassRequest = {
    gl: viewport.gl,
    scene: viewport.scene,
    camera: captureCamera,
    objectId: request.objectId,
    width: size,
    height: size,
  };

  const [color, mask, normal, depth] = await Promise.all([
    request.colorMode === 'clay-target' ? captureClayTarget(passRequest) : captureColor(passRequest),
    captureMask(passRequest),
    captureNormal(passRequest),
    captureDepth(passRequest),
  ]);

  const capture: Capture = {
    id: createId('capture'),
    objectId: request.objectId,
    camera: serializeCamera(captureCamera, aspect, captureTarget),
    width: size,
    height: size,
    colorUrl: color.url,
    maskUrl: mask.url,
    normalUrl: normal.url,
    depthUrl: depth.url,
    createdAt: new Date().toISOString(),
    warnings: [...warnings, ...color.warnings, ...mask.warnings, ...normal.warnings, ...depth.warnings],
  };

  useProjectStore.getState().addCapture(capture);
  console.info('[Liclick 3D Texture] Capture current view:', capture);
  return capture;
}
