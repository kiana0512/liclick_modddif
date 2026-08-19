import { captureColor } from './captureColor';
import { captureDepth } from './captureDepth';
import { captureMask } from './captureMask';
import { captureNormal } from './captureNormal';
import type {
  CaptureCurrentViewRequest,
  CaptureColorPreview,
  CaptureNormalPreview,
  CapturePassRequest,
} from './captureTypes';
import {
  applyTargetOnlyMaterial,
  cloneCameraForCaptureAspect,
  renderSceneToPngUrl,
} from './renderTargetUtils';
import { serializeCamera } from '@/engine/projection/ProjectionCamera';
import { createClayModelMaterial } from '@/engine/materials/clayModelMaterial';
import { useProjectStore } from '@/stores/projectStore';
import { useSceneStore } from '@/stores/sceneStore';
import type { Capture } from '@/types/capture';
import { createId } from '@/utils/id';
import { waitForBrowserPaint } from '@/utils/browserScheduling';
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
    right,
    up,
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
    if (
      object.userData.liclickRestorePlaceholder ||
      object.userData.liclickViewportHelper ||
      object.userData.liclickPaintOverlay ||
      object.userData.liclickSelectionGlow ||
      object.userData.liclickWireframeOverlay
    )
      return;
    box.expandByObject(object);
    found = true;
  });
  if (!found || box.isEmpty()) return undefined;
  return box;
}

function waitForViewportFrame() {
  return waitForBrowserPaint();
}

/**
 * Copies the authored camera synchronously at a user-action boundary. Deferred
 * GPU passes can then share this immutable view while the live camera remains
 * free to orbit.
 */
export function snapshotCurrentCaptureCamera(aspect = 1) {
  const viewport = useSceneStore.getState().viewport;
  if (!viewport) throw new Error('视口尚未准备完成，请稍后重试。');
  const safeAspect = Number.isFinite(aspect) && aspect > 0 ? aspect : 1;
  return {
    camera: cloneCameraForCaptureAspect(viewport.camera, safeAspect),
    aspect: safeAspect,
    target: viewport.controls?.target?.clone() ?? new THREE.Vector3(),
  };
}

async function getTargetBoundsWhenReady(scene: THREE.Scene, objectId: string) {
  // Switching objects updates the Zustand selection before React Three Fiber has
  // necessarily attached the new model group to the viewport scene. Wait through
  // the short reconciliation window instead of capturing with the previous ID.
  for (let attempt = 0; attempt < 180; attempt += 1) {
    const targetBounds = getTargetBounds(scene, objectId);
    if (targetBounds) return targetBounds;
    await waitForViewportFrame();
  }
  throw new Error('当前选中的模型尚未进入视口，请切换模型后稍等片刻再试。');
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
  viewDirection?: THREE.Vector3,
  viewUp?: THREE.Vector3,
) {
  const direction =
    viewDirection?.clone().normalize() ?? getViewDirection(sourceCamera, controlsTarget);
  const upSource = viewUp?.clone().normalize() ?? sourceCamera.up;
  const frame = getViewFrame(box, direction, upSource);
  const center = frame.center;
  const safeFillRatio = THREE.MathUtils.clamp(fillRatio, 0.2, 0.98);

  if (sourceCamera instanceof THREE.OrthographicCamera) {
    const halfHeight = Math.max(frame.halfHeight, frame.halfWidth / aspect) / safeFillRatio;
    const halfWidth = halfHeight * aspect;
    const camera = new THREE.OrthographicCamera(-halfWidth, halfWidth, halfHeight, -halfHeight);
    camera.position.copy(center).add(direction.multiplyScalar(frame.halfDepth + halfHeight * 2));
    camera.up.copy(upSource);
    camera.near = 0.01;
    camera.far = Math.max(frame.halfDepth * 8 + halfHeight * 4, 100);
    camera.zoom = 1;
    camera.lookAt(center);
    camera.updateProjectionMatrix();
    camera.updateMatrixWorld(true);
    return { camera, target: center.clone() };
  }

  const sourcePerspective =
    sourceCamera instanceof THREE.PerspectiveCamera ? sourceCamera : undefined;
  const fov = sourcePerspective?.fov ?? 35;
  const zoom = sourcePerspective?.zoom ?? 1;
  const fovRad = THREE.MathUtils.degToRad(
    sourcePerspective?.getEffectiveFOV() ?? fov,
  );
  const horizontalFovRad = 2 * Math.atan(Math.tan(fovRad * 0.5) * aspect);
  const tanHalfVerticalFov = Math.max(Math.tan(fovRad * 0.5), 0.0001);
  const tanHalfHorizontalFov = Math.max(Math.tan(horizontalFovRad * 0.5), 0.0001);

  // Fit every depth-aware corner instead of fitting only the box width/height.
  // A corner closer to the camera occupies more screen space; ignoring that
  // perspective term made deep/asymmetric models touch or cross a capture edge.
  let distance = 0.001;
  for (const corner of getBoxCorners(box)) {
    const offset = corner.sub(center);
    const towardCamera = offset.dot(frame.direction);
    distance = Math.max(
      distance,
      towardCamera + Math.abs(offset.dot(frame.up)) / (tanHalfVerticalFov * safeFillRatio),
      towardCamera +
        Math.abs(offset.dot(frame.right)) / (tanHalfHorizontalFov * safeFillRatio),
    );
  }
  const camera = new THREE.PerspectiveCamera(fov, aspect);
  camera.position.copy(center).add(direction.multiplyScalar(distance));
  camera.up.copy(upSource);
  camera.zoom = zoom;
  camera.near = Math.max(0.01, distance - frame.halfDepth * 3);
  camera.far = Math.max(distance + frame.halfDepth * 5, 100);
  camera.lookAt(center);
  camera.updateProjectionMatrix();
  camera.updateMatrixWorld(true);
  return { camera, target: center.clone() };
}

function vectorFromTuple(tuple?: [number, number, number]) {
  return tuple ? new THREE.Vector3(tuple[0], tuple[1], tuple[2]) : undefined;
}

async function resolveCaptureCamera(request: CaptureCurrentViewRequest, aspect: number) {
  const viewport = useSceneStore.getState().viewport;
  if (!viewport) throw new Error('视口尚未准备完成，请稍后重试。');

  const sourceCamera = request.cameraSnapshot?.camera ?? viewport.camera;
  let captureCamera = cloneCameraForCaptureAspect(sourceCamera, aspect);
  let captureTarget =
    request.cameraSnapshot?.target?.clone() ??
    viewport.controls?.target?.clone() ??
    new THREE.Vector3();

  if (request.framing === 'fit-object') {
    const targetBounds = await getTargetBoundsWhenReady(viewport.scene, request.objectId);
    const fitted = createFitObjectCamera(
      sourceCamera,
      targetBounds,
      aspect,
      request.fillRatio ?? defaultFillRatio,
      request.cameraSnapshot?.target ?? viewport.controls?.target,
      vectorFromTuple(request.viewDirection),
      vectorFromTuple(request.viewUp),
    );
    captureCamera = fitted.camera;
    captureTarget = fitted.target;
  }

  return { viewport, captureCamera, captureTarget };
}

async function captureClayTarget(passRequest: CapturePassRequest) {
  const restore = applyTargetOnlyMaterial(
    passRequest.scene,
    passRequest.objectId,
    () => createClayModelMaterial(),
  );
  try {
    return {
      url: await renderSceneToPngUrl(
        {
          ...passRequest,
          clearColor: '#f7f7f3',
          clearAlpha: 1,
        },
        { applyDisplayTransform: true, onRenderSubmitted: restore },
      ),
      warnings: [],
    };
  } finally {
    restore();
  }
}

async function captureTargetOnly(passRequest: CapturePassRequest) {
  const restore = applyTargetOnlyMaterial(passRequest.scene, passRequest.objectId);
  try {
    return {
      url: await renderSceneToPngUrl(
        {
          ...passRequest,
          clearColor: '#eeeeec',
          clearAlpha: 1,
        },
        { applyDisplayTransform: true, onRenderSubmitted: restore },
      ),
      warnings: [],
    };
  } finally {
    restore();
  }
}

function createFlatTargetCaptureMaterial(sourceMaterial: THREE.Material) {
  if (
    sourceMaterial instanceof THREE.ShaderMaterial &&
    sourceMaterial.uniforms.previewLightingEnabled
  ) {
    const material = sourceMaterial.clone();
    material.name = `${sourceMaterial.name || sourceMaterial.type}:FlatCapture`;
    material.uniforms.previewLightingEnabled.value = 0;
    // No renderer exposure is applied to this asset capture. Neutralize the
    // legacy rendered-colour compensation too, otherwise a user's PBR exposure
    // setting would still darken/brighten the supposedly flat reference.
    if (material.uniforms.previewExposure) material.uniforms.previewExposure.value = 1;
    if (material.uniforms.normalPreviewEnabled) material.uniforms.normalPreviewEnabled.value = 0;
    if (material.uniforms.wirePreviewEnabled) material.uniforms.wirePreviewEnabled.value = 0;
    // Capture albedo, not the viewport presentation. The returned image will be
    // sampled as an sRGB BaseColor and receive the viewport transform once.
    material.toneMapped = false;
    material.uniformsNeedUpdate = true;
    material.needsUpdate = true;
    return material;
  }

  const source = sourceMaterial as THREE.Material & {
    color?: THREE.Color;
    map?: THREE.Texture | null;
    alphaMap?: THREE.Texture | null;
    vertexColors?: boolean;
  };
  const material = new THREE.MeshBasicMaterial({
    color: source.color?.clone() ?? new THREE.Color('#ffffff'),
    map: source.map ?? null,
    alphaMap: source.alphaMap ?? null,
    transparent: sourceMaterial.transparent,
    opacity: sourceMaterial.opacity,
    alphaTest: sourceMaterial.alphaTest,
    side: sourceMaterial.side,
    depthTest: sourceMaterial.depthTest,
    depthWrite: sourceMaterial.depthWrite,
    vertexColors: source.vertexColors ?? false,
  });
  material.name = `${sourceMaterial.name || sourceMaterial.type}:FlatCapture`;
  material.blending = sourceMaterial.blending;
  material.blendSrc = sourceMaterial.blendSrc;
  material.blendDst = sourceMaterial.blendDst;
  material.blendEquation = sourceMaterial.blendEquation;
  material.premultipliedAlpha = sourceMaterial.premultipliedAlpha;
  material.polygonOffset = sourceMaterial.polygonOffset;
  material.polygonOffsetFactor = sourceMaterial.polygonOffsetFactor;
  material.polygonOffsetUnits = sourceMaterial.polygonOffsetUnits;
  material.toneMapped = false;
  return material;
}

async function captureFlatTarget(passRequest: CapturePassRequest) {
  const temporaryMaterials = new Set<THREE.Material>();
  const restore = applyTargetOnlyMaterial(passRequest.scene, passRequest.objectId, (source) => {
    const material = createFlatTargetCaptureMaterial(source);
    temporaryMaterials.add(material);
    return material;
  });
  try {
    return {
      url: await renderSceneToPngUrl(
        {
          ...passRequest,
          clearColor: '#eeeeec',
          clearAlpha: 1,
        },
        // The render target's sRGB encoding is the texture asset encoding. Do
        // not bake exposure/tone mapping here: the preview shader applies that
        // presentation transform after the generated image is painted back.
        { applyDisplayTransform: false, onRenderSubmitted: restore },
      ),
      warnings: [],
    };
  } finally {
    restore();
    temporaryMaterials.forEach((material) => material.dispose());
  }
}

/**
 * Captures only the current color presentation. Unlike captureCurrentView this
 * does not render mask, normal or depth passes and does not archive another
 * project capture, so the third ModelView input adds only one GPU readback.
 */
export async function captureCurrentColorPreview(
  request: CaptureCurrentViewRequest,
): Promise<CaptureColorPreview> {
  const size = Math.min(request.resolution, maxCaptureSize);
  const warnings: string[] = [];
  if (request.resolution > maxCaptureSize) {
    warnings.push(
      'Large reference capture was limited to 2048px in this browser MVP to avoid freezing the viewport.',
    );
  }
  const aspect = Number.isFinite(request.aspect) && (request.aspect ?? 0) > 0 ? request.aspect! : 1;
  const width = aspect >= 1 ? size : Math.max(1, Math.round(size * aspect));
  const height = aspect >= 1 ? Math.max(1, Math.round(size / aspect)) : size;
  const { viewport, captureCamera } = await resolveCaptureCamera(request, aspect);
  const passRequest: CapturePassRequest = {
    gl: viewport.gl,
    scene: viewport.scene,
    camera: captureCamera,
    objectId: request.objectId,
    width,
    height,
  };
  const color =
    request.colorMode === 'clay-target'
      ? await captureClayTarget(passRequest)
      : request.colorMode === 'flat-target'
        ? await captureFlatTarget(passRequest)
        : request.colorMode === 'target-only'
          ? await captureTargetOnly(passRequest)
          : await captureColor(passRequest);
  return {
    width,
    height,
    colorUrl: color.url,
    warnings: [...warnings, ...color.warnings],
  };
}

export async function captureCurrentView(request: CaptureCurrentViewRequest): Promise<Capture> {
  const size = Math.min(request.resolution, maxCaptureSize);
  const warnings: string[] = [];
  if (request.resolution > maxCaptureSize) {
    warnings.push(
      'Large reference capture was limited to 2048px in this browser MVP to avoid freezing the viewport.',
    );
  }

  const aspect = Number.isFinite(request.aspect) && (request.aspect ?? 0) > 0 ? request.aspect! : 1;
  const width = aspect >= 1 ? size : Math.max(1, Math.round(size * aspect));
  const height = aspect >= 1 ? Math.max(1, Math.round(size / aspect)) : size;
  const { viewport, captureCamera, captureTarget } = await resolveCaptureCamera(request, aspect);

  const passRequest: CapturePassRequest = {
    gl: viewport.gl,
    scene: viewport.scene,
    camera: captureCamera,
    objectId: request.objectId,
    width,
    height,
  };

  const color =
    request.colorMode === 'clay-target'
      ? await captureClayTarget(passRequest)
      : request.colorMode === 'flat-target'
        ? await captureFlatTarget(passRequest)
      : request.colorMode === 'target-only'
        ? await captureTargetOnly(passRequest)
        : await captureColor(passRequest);
  // Preserve all four exact passes and their resolution, while returning one
  // presentation frame between GPU submissions so camera interaction and the
  // progress UI remain responsive during local repaint generation.
  await waitForViewportFrame();
  const mask = await captureMask(passRequest);
  await waitForViewportFrame();
  const normal = await captureNormal(passRequest);
  await waitForViewportFrame();
  const depth = await captureDepth(passRequest);

  const capture: Capture = {
    id: createId('capture'),
    objectId: request.objectId,
    camera: serializeCamera(captureCamera, aspect, captureTarget),
    width,
    height,
    colorUrl: color.url,
    maskUrl: mask.url,
    normalUrl: normal.url,
    depthUrl: depth.url,
    depthEncoding: 'linear-view',
    createdAt: new Date().toISOString(),
    warnings: [
      ...warnings,
      ...color.warnings,
      ...mask.warnings,
      ...normal.warnings,
      ...depth.warnings,
    ],
  };

  useProjectStore.getState().addCapture(capture);
  console.info('[Liclick 3D Texture] Capture current view:', capture);
  return capture;
}

export async function captureCurrentNormalPreview(
  request: CaptureCurrentViewRequest,
): Promise<CaptureNormalPreview> {
  const size = Math.min(request.resolution, 1024);
  const aspect = Number.isFinite(request.aspect) && (request.aspect ?? 0) > 0 ? request.aspect! : 1;
  const width = aspect >= 1 ? size : Math.max(1, Math.round(size * aspect));
  const height = aspect >= 1 ? Math.max(1, Math.round(size / aspect)) : size;
  const { viewport, captureCamera, captureTarget } = await resolveCaptureCamera(request, aspect);
  const passRequest: CapturePassRequest = {
    gl: viewport.gl,
    scene: viewport.scene,
    camera: captureCamera,
    objectId: request.objectId,
    width,
    height,
  };
  const normal = await captureNormal(passRequest, { space: 'world' });
  return {
    id: createId('normal-preview'),
    objectId: request.objectId,
    camera: serializeCamera(captureCamera, aspect, captureTarget),
    width,
    height,
    normalUrl: normal.url,
    createdAt: new Date().toISOString(),
    warnings: normal.warnings,
  };
}
