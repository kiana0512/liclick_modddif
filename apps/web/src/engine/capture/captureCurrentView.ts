import { captureColor } from './captureColor';
import { fitGeometryCapture, verifyTightCapture } from './tightCaptureFraming';
export { frameGenerationCapture } from './generationFraming';
import { flushLiveUvCommits } from '@/engine/projection/liveProjectedCanvasTextureRegistry';
import { waitForResidentUvPresentation } from '@/engine/projection/residentUvPresentation';
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
  isCaptureTargetMesh,
  cloneCameraForCaptureAspect,
  renderSceneToPngUrl,
} from './renderTargetUtils';
import { serializeCamera } from '@/engine/projection/ProjectionCamera';
import { createClayModelMaterial } from '@/engine/materials/clayModelMaterial';
import { useProjectStore } from '@/stores/projectStore';
import { useSceneStore, type ViewportRuntime } from '@/stores/sceneStore';
import { withIsolatedNormalCapture } from './isolatedNormalCapture';
import type { Capture } from '@/types/capture';
import { createId } from '@/utils/id';
import { waitForBrowserPaint } from '@/utils/browserScheduling';
import * as THREE from 'three';

const maxCaptureSize = 2048;
const defaultFillRatio = 0.96;
// Local-repaint structure/reference frames are pixel-authoritative inputs for
// the remote edit. Keep their real 2K detail; renderSceneToPngUrl already
// submits the target in 512px tiles and yields between GPU work, so a low-res
// render followed by worker upscaling is both unnecessary and visibly blurry.
const localRepaintInteractiveCaptureSize = maxCaptureSize;

function getBoxCorners(box: THREE.Box3) {
  const corners: THREE.Vector3[] = [];
  for (const x of [box.min.x, box.max.x])
    for (const y of [box.min.y, box.max.y])
      for (const z of [box.min.z, box.max.z]) corners.push(new THREE.Vector3(x, y, z));
  return corners;
}

function getViewFrame(box: THREE.Box3, viewDirection: THREE.Vector3, sourceUp: THREE.Vector3) {
  const center = new THREE.Vector3();
  box.getCenter(center);
  const direction = viewDirection.clone().normalize();
  let right = sourceUp.clone().cross(direction);
  if (right.lengthSq() < 0.0001) right = new THREE.Vector3(1, 0, 0).cross(direction);
  right.normalize();
  const up = direction.clone().cross(right).normalize();

  const halfSize = box.getSize(new THREE.Vector3()).multiplyScalar(0.5);
  const span = (axis: THREE.Vector3) => Math.max(0.001,
    halfSize.x * Math.abs(axis.x) + halfSize.y * Math.abs(axis.y) + halfSize.z * Math.abs(axis.z));

  return {
    center,
    direction,
    right,
    up,
    halfWidth: span(right),
    halfHeight: span(up),
    halfDepth: span(direction),
  };
}

export function getTargetBounds(scene: THREE.Scene, objectId: string) {
  const box = new THREE.Box3();
  scene.updateMatrixWorld(true);
  scene.traverse((object) => {
    if (!isCaptureTargetMesh(object, objectId)) return;
    box.expandByObject(object);
  });
  if (box.isEmpty()) return undefined;
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

async function getTargetBoundsWhenReady(scene: THREE.Scene, objectId: string, signal?: AbortSignal) {
  // Switching objects updates the Zustand selection before React Three Fiber has
  // necessarily attached the new model group to the viewport scene. Wait through
  // the short reconciliation window instead of capturing with the previous ID.
  for (let attempt = 0; attempt < 180; attempt += 1) {
    signal?.throwIfAborted();
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

export function createFitObjectCamera(
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

  let camera: THREE.PerspectiveCamera | THREE.OrthographicCamera;
  if (sourceCamera instanceof THREE.OrthographicCamera) {
    const halfHeight = Math.max(frame.halfHeight, frame.halfWidth / aspect) / safeFillRatio;
    const halfWidth = halfHeight * aspect;
    camera = new THREE.OrthographicCamera(-halfWidth, halfWidth, halfHeight, -halfHeight);
    camera.position.copy(center).add(direction.multiplyScalar(frame.halfDepth + halfHeight * 2));
    camera.near = 0.01;
    camera.far = Math.max(frame.halfDepth * 8 + halfHeight * 4, 100);
    camera.zoom = 1;
  } else {
    const sourcePerspective =
      sourceCamera instanceof THREE.PerspectiveCamera ? sourceCamera : undefined;
    const fov = sourcePerspective?.fov ?? 35;
    const zoom = sourcePerspective?.zoom ?? 1;
    const fovRad = THREE.MathUtils.degToRad(sourcePerspective?.getEffectiveFOV() ?? fov);
    const tanHalfVerticalFov = Math.max(Math.tan(fovRad * 0.5), 0.0001);
    const tanHalfHorizontalFov = Math.max(Math.tan(fovRad * 0.5) * aspect, 0.0001);

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
        towardCamera + Math.abs(offset.dot(frame.right)) / (tanHalfHorizontalFov * safeFillRatio),
      );
    }
    camera = new THREE.PerspectiveCamera(fov, aspect);
    camera.position.copy(center).add(direction.multiplyScalar(distance));
    camera.zoom = zoom;
    camera.near = Math.max(0.01, distance - frame.halfDepth * 3);
    camera.far = Math.max(distance + frame.halfDepth * 5, 100);
  }
  camera.up.copy(upSource);
  camera.lookAt(center);
  camera.updateProjectionMatrix();
  camera.updateMatrixWorld(true);
  return { camera, target: center.clone() };
}

export function vectorFromTuple(tuple?: [number, number, number]) {
  return tuple ? new THREE.Vector3(...tuple) : undefined;
}

async function resolveCaptureCamera(request: CaptureCurrentViewRequest, aspect: number, isolated?: ViewportRuntime) {
  const viewport = isolated ?? useSceneStore.getState().viewport;
  if (!viewport) throw new Error('视口尚未准备完成，请稍后重试。');

  const sourceCamera = request.cameraSnapshot?.camera ?? viewport.camera;
  let captureCamera = cloneCameraForCaptureAspect(sourceCamera, aspect);
  let captureTarget =
    request.cameraSnapshot?.target?.clone() ??
    viewport.controls?.target?.clone() ??
    new THREE.Vector3();

  if (request.framing === 'fit-object' && !request.cameraSnapshot) {
    const targetBounds = await getTargetBoundsWhenReady(viewport.scene, request.objectId, request.signal);
    const fallback = createFitObjectCamera(
      sourceCamera,
      targetBounds,
      aspect,
      request.fillRatio ?? defaultFillRatio,
      viewport.controls?.target,
      vectorFromTuple(request.viewDirection),
      vectorFromTuple(request.viewUp),
    );
    const candidate = await fitGeometryCapture(viewport.scene, request.objectId, fallback, aspect, request.signal);
    const fitted = await verifyTightCapture(viewport, request.objectId, candidate, fallback, aspect, request.signal);
    captureCamera = fitted.camera;
    captureTarget = fitted.target;
  }

  return { viewport, captureCamera, captureTarget };
}

async function captureClayTarget(
  passRequest: CapturePassRequest,
  encodedSize?: { width: number; height: number },
) {
  const captureMaterial = createClayModelMaterial();
  try {
    return {
      url: await renderSceneToPngUrl(
        {
          ...passRequest,
          clearColor: '#f7f7f3',
          clearAlpha: 1,
        },
        {
          applyDisplayTransform: true,
          // Keep the exact 2K ModelView input, but submit it in bounded GPU
          // tiles so the visible viewport receives a frame between capture
          // chunks. Total capture work stays equivalent without a multi-second
          // main-thread/GPU presentation stall on button 2.
          tileSize: 512,
          performancePhasePrefix: 'button2-white-model',
          encodedWidth: encodedSize?.width,
          encodedHeight: encodedSize?.height,
          // Restrict the scene only for the exact offscreen draw. Restoring
          // before every inter-tile browser frame keeps the live background,
          // grid and helpers continuously visible during snapshot preparation.
          prepareScene: () =>
            applyTargetOnlyMaterial(passRequest.scene, passRequest.objectId, () => captureMaterial),
        },
      ),
      warnings: [],
    };
  } finally {
    captureMaterial.dispose();
  }
}

/**
 * Keeps the authored viewport on one canonical white-model presentation while
 * a batch of offscreen capture passes temporarily swaps mask/normal/depth
 * materials. Every inner pass restores to this stable material before yielding
 * a browser frame, so the user never sees the diagnostic capture channels.
 */
export async function withStableClayTargetPresentation<T>(
  objectId: string,
  task: () => Promise<T>,
) {
  const sceneState = useSceneStore.getState();
  if (!sceneState.viewport) throw new Error('视口尚未准备完成，请稍后重试。');
  const previousPresentationObjectId = sceneState.transientWhitePresentationObjectId;
  sceneState.setTransientWhitePresentationObject(objectId);
  try {
    // Let SceneRoot publish the canonical white membrane before the first
    // detached GPU pass. Unlike a direct material snapshot/restore, this
    // renderer-only override allows layer eye/opacity edits to keep updating
    // their authoritative stores without restoring stale materials afterward.
    for (let frame = 0; frame < 12; frame += 1) {
      await waitForViewportFrame();
      const model = useSceneStore
        .getState()
        .importedModels.find((candidate) => candidate.objectId === objectId);
      if (!model) continue;
      let hasMaterial = false;
      let presentsOnlyWhiteMembrane = true;
      model.group.traverse((child) => {
        if (!(child instanceof THREE.Mesh) || child.userData.liclickPaintOverlay) return;
        hasMaterial = true;
        const materials = Array.isArray(child.material) ? child.material : [child.material];
        presentsOnlyWhiteMembrane &&= materials.every(
          (material) => material.name === 'LiclickWhiteMembranePreview',
        );
      });
      if (hasMaterial && presentsOnlyWhiteMembrane) break;
    }
    return await task();
  } finally {
    const currentState = useSceneStore.getState();
    if (currentState.transientWhitePresentationObjectId === objectId) {
      currentState.setTransientWhitePresentationObject(previousPresentationObjectId);
    }
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

function hideAuthoringOverlaysForPreviewCapture(scene: THREE.Scene) {
  const visibility = new Map<THREE.Object3D, boolean>();
  scene.traverse((object) => {
    if (
      !object.userData.liclickPaintOverlay &&
      !object.userData.liclickSelectionGlow &&
      !object.userData.liclickWireframeOverlay &&
      object.name !== 'Liclick Live Inpaint Screen Preview'
    )
      return;
    visibility.set(object, object.visible);
    object.visible = false;
  });
  return () => visibility.forEach((visible, object) => (object.visible = visible));
}

async function captureCleanViewportPreview(
  passRequest: CapturePassRequest,
  encodedSize?: { width: number; height: number },
) {
  return {
    url: await renderSceneToPngUrl(passRequest, {
      applyDisplayTransform: true,
      tileSize: 512,
      performancePhasePrefix: 'prompt-polish-preview',
      encodedWidth: encodedSize?.width,
      encodedHeight: encodedSize?.height,
      // Hide only authoring overlays for the exact offscreen draw. Restoring
      // after every tile prevents the visible viewport from flashing while the
      // captured image retains its real materials, lighting and background.
      prepareScene: () => hideAuthoringOverlaysForPreviewCapture(passRequest.scene),
    }),
    warnings: [],
  };
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

function prepareFlatTargetCapture(
  passRequest: CapturePassRequest,
  options: { forceEmptyProjectionHatch?: boolean } = {},
) {
  const temporaryMaterials = new Set<THREE.Material>();
  const mutatedShaderMaterials = new Set<THREE.ShaderMaterial>();
  const restoreUniforms: Array<() => void> = [];
  const restoreScene = applyTargetOnlyMaterial(
    passRequest.scene,
    passRequest.objectId,
    (source) => {
      // The authored projection/UV material is already resident and compiled in
      // the viewport. Cloning it here creates a brand-new shader program and can
      // block Chromium's main/GPU threads for several seconds on button 2. Flat
      // capture only changes presentation uniforms, so borrow the resident
      // program for this single submitted draw and restore its values immediately
      // afterwards. Camera and model matrices remain the frozen click snapshot.
      if (source instanceof THREE.ShaderMaterial && source.uniforms.previewLightingEnabled) {
        if (!mutatedShaderMaterials.has(source)) {
          mutatedShaderMaterials.add(source);
          const previousValues = new Map<string, unknown>();
          const uniformOverrides: Array<readonly [string, number]> = [
            ['previewLightingEnabled', 0],
            ['previewExposure', 1],
            ['normalPreviewEnabled', 0],
            ['wirePreviewEnabled', 0],
          ];
          // Hatch is viewport-only. Mode 2 also writes true coverage into alpha.
          uniformOverrides.push(['showEmptyProjectionHatch', options.forceEmptyProjectionHatch ? 2 : 0]);
          for (const [name, value] of uniformOverrides) {
            const uniform = source.uniforms[name];
            if (!uniform) continue;
            previousValues.set(name, uniform.value);
            uniform.value = value;
          }
          source.uniformsNeedUpdate = true;
          restoreUniforms.push(() => {
            previousValues.forEach((value, name) => {
              const uniform = source.uniforms[name];
              if (uniform) uniform.value = value;
            });
            source.uniformsNeedUpdate = true;
          });
        }
        return source;
      }
      const material = createFlatTargetCaptureMaterial(source);
      // Coverage capture must distinguish an untextured material from a valid
      // white texture. Write zero coverage, but keep depth/occlusion intact.
      if (options.forceEmptyProjectionHatch && material instanceof THREE.MeshBasicMaterial &&
          !material.map && !material.vertexColors) {
        material.opacity = 0;
        material.transparent = false;
        material.blending = THREE.NoBlending;
        material.alphaTest = 0;
      }
      temporaryMaterials.add(material);
      return material;
    },
  );
  let restored = false;
  return () => {
    if (restored) return;
    restored = true;
    restoreScene();
    restoreUniforms.forEach((restoreUniform) => restoreUniform());
    temporaryMaterials.forEach((material) => material.dispose());
  };
}

async function captureFlatTarget(
  passRequest: CapturePassRequest,
  encodedSize?: { width: number; height: number },
  options: { forceEmptyProjectionHatch?: boolean } = {},
) {
  await waitForResidentUvPresentation(passRequest.scene, passRequest.objectId);
  // CAPTURE-MATERIAL-ISOLATION v1.0.0: never retain presentation mutations
  // across a browser-paint yield. Reject an interrupted snapshot rather than
  // encode tiles from different material generations into one GPT guide.
  const sourceMaterials = new Map<THREE.Mesh, THREE.Material[]>();
  const sourceUvMaps = new Map<THREE.Material, unknown[]>();
  passRequest.scene.traverse((object) => {
    if (object instanceof THREE.Mesh && object.userData.liclickObjectId === passRequest.objectId) {
      sourceMaterials.set(
        object,
        Array.isArray(object.material) ? [...object.material] : [object.material],
      );
      for (const material of sourceMaterials.get(object)!) {
        if (material instanceof THREE.ShaderMaterial && material.userData.liclickResidentUvProjectionLayers)
          sourceUvMaps.set(material, ['baseMap', 'uvOverlayMap', 'liveUvOverlayMap'].map(name => material.uniforms[name]?.value));
      }
    }
  });
  const prepareScene = () => {
    for (const [mesh, expected] of sourceMaterials) {
      const current = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      if (
        current.length !== expected.length ||
        current.some((material, index) => material !== expected[index])
      ) {
        throw new Error('模型材质在截图期间发生变化，请等待预览稳定后重试。');
      }
      for (const material of current) {
        if (sourceUvMaps.has(material) && material instanceof THREE.ShaderMaterial &&
            sourceUvMaps.get(material)!.some((texture, index) =>
              texture !== material.uniforms[['baseMap', 'uvOverlayMap', 'liveUvOverlayMap'][index]]?.value))
          throw new Error('UV 预览在截图期间发生变化，请重试。');
      }
    }
    return prepareFlatTargetCapture(passRequest, options);
  };
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
      {
        applyDisplayTransform: false,
        tileSize: 512,
        performancePhasePrefix: 'button2-viewport-reference',
        encodedWidth: encodedSize?.width,
        encodedHeight: encodedSize?.height,
        prepareScene,
      },
    ),
    warnings: [],
  };
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
  const interactiveWidth = Math.min(width, localRepaintInteractiveCaptureSize);
  const interactiveHeight = Math.min(height, localRepaintInteractiveCaptureSize);
  const color =
    request.colorMode === 'clay-target'
      ? await captureClayTarget(
          { ...passRequest, width: interactiveWidth, height: interactiveHeight },
          { width, height },
        )
      : request.colorMode === 'flat-target' || request.colorMode === 'flat-target-coverage'
        ? await captureFlatTarget(
            { ...passRequest, width: interactiveWidth, height: interactiveHeight },
            { width, height },
            { forceEmptyProjectionHatch: request.colorMode === 'flat-target-coverage' },
          )
        : request.colorMode === 'viewport-clean'
          ? await captureCleanViewportPreview(
              { ...passRequest, width: interactiveWidth, height: interactiveHeight },
              { width, height },
            )
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

/**
 * Captures the one current-effect colour pass needed by ModelView local repaint
 * and archives the already camera-aligned paint mask. Auxiliary depth is
 * deliberately separate so it can run while the remote request is in flight
 * instead of blocking the Generate button behind mask/normal/depth readbacks.
 */
export async function captureCurrentLocalRepaintView(
  request: CaptureCurrentViewRequest,
  maskUrl: string,
  options: { archive?: boolean } = {},
): Promise<Capture> {
  await flushLiveUvCommits();
  const size = Math.min(request.resolution, maxCaptureSize);
  const aspect = Number.isFinite(request.aspect) && (request.aspect ?? 0) > 0 ? request.aspect! : 1;
  const width = aspect >= 1 ? size : Math.max(1, Math.round(size * aspect));
  const height = aspect >= 1 ? Math.max(1, Math.round(size / aspect)) : size;
  const { viewport, captureCamera, captureTarget } = await resolveCaptureCamera(request, aspect);
  const interactiveWidth = Math.min(width, localRepaintInteractiveCaptureSize);
  const interactiveHeight = Math.min(height, localRepaintInteractiveCaptureSize);
  const passRequest: CapturePassRequest = {
    gl: viewport.gl,
    scene: viewport.scene,
    camera: captureCamera,
    objectId: request.objectId,
    width: interactiveWidth,
    height: interactiveHeight,
  };
  const color =
    request.colorMode === 'flat-target' || request.colorMode === 'flat-target-coverage'
      ? await captureFlatTarget(passRequest, { width, height }, {
          forceEmptyProjectionHatch: request.colorMode === 'flat-target-coverage',
        })
      : await captureClayTarget(passRequest, { width, height });
  const capture: Capture = {
    id: createId('capture'),
    objectId: request.objectId,
    camera: serializeCamera(captureCamera, aspect, captureTarget),
    width,
    height,
    colorUrl: color.url,
    maskUrl,
    createdAt: new Date().toISOString(),
    warnings: color.warnings,
  };
  if (options.archive !== false) useProjectStore.getState().addCapture(capture);
  return capture;
}

export async function captureCurrentDepthPreview(request: CaptureCurrentViewRequest, maxResolution = 1024) {
  const size = Math.min(request.resolution, maxResolution, 2048);
  const aspect = Number.isFinite(request.aspect) && (request.aspect ?? 0) > 0 ? request.aspect! : 1;
  const width = aspect >= 1 ? size : Math.max(1, Math.round(size * aspect));
  const height = aspect >= 1 ? Math.max(1, Math.round(size / aspect)) : size;
  const { viewport, captureCamera } = await resolveCaptureCamera(request, aspect);
  const depth = await captureDepth({
    gl: viewport.gl,
    scene: viewport.scene,
    camera: captureCamera,
    objectId: request.objectId,
    width,
    height,
  });
  return { depthUrl: depth.url, depthEncoding: 'linear-view' as const, warnings: depth.warnings };
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
  return captureNormalView(request, Math.min(request.resolution, 1024), false);
}

/** Full-resolution geometry guidance; independent of the lightweight UI preview. */
export async function captureCurrentNormalGuide(
  request: CaptureCurrentViewRequest,
): Promise<CaptureNormalPreview> {
  return captureNormalView(request, request.resolution, true);
}

async function captureNormalView(request: CaptureCurrentViewRequest, size: number, geometryGuide: boolean) {
  const source = useSceneStore.getState().viewport;
  return withIsolatedNormalCapture(source, async (isolated) => {
  const aspect = Number.isFinite(request.aspect) && (request.aspect ?? 0) > 0 ? request.aspect! : 1;
  const width = aspect >= 1 ? size : Math.max(1, Math.round(size * aspect));
  const height = aspect >= 1 ? Math.max(1, Math.round(size / aspect)) : size;
  const { viewport, captureCamera, captureTarget } = await resolveCaptureCamera(request, aspect, isolated);
  request.signal?.throwIfAborted();
  const passRequest: CapturePassRequest = {
    gl: viewport.gl,
    scene: viewport.scene,
    camera: captureCamera,
    objectId: request.objectId,
    width,
    height,
    ...(geometryGuide ? { clearAlpha: 0 } : {}),
  };
  const normal = await captureNormal(passRequest, { space: geometryGuide ? 'view' : 'world', geometryGuide });
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
  }, {
    signal: request.signal,
    beforeClone: source ? () => getTargetBoundsWhenReady(source.scene, request.objectId, request.signal) : undefined,
  });
}
