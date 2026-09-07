import {
  startTransition,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type SyntheticEvent,
} from 'react';
import { createPortal } from 'react-dom';
import { Download, LoaderCircle, Plus } from 'lucide-react';
import * as THREE from 'three';
import { BottomToolDock } from '@/components/editor/BottomToolDock';
import { ExportMenu, type ExportActionId } from '@/components/editor/ExportMenu';
import { TextureOnboardingTour } from '@/components/editor/TextureOnboardingTour';
import { PhotoshopEditSessionPanel } from '@/features/photoshop/PhotoshopEditSessionPanel';
import {
  frontProjectThumbnailCapture,
  getFrontProjectThumbnailCameraFrame,
  getContainedImageDrawRect,
  getProjectThumbnailFraming,
  withProjectThumbnailVersion,
  withProjectThumbnailPbrMode,
} from '@/features/projects/projectThumbnailPolicy';
import { neutralizeUntexturedThumbnailMaterials } from '@/features/projects/projectThumbnailMaterials';
import { getProjectThumbnailCaptureModels } from '@/engine/scene/progressiveModelPolicy';
import {
  closePhotoshopSession,
  createPhotoshopSession,
  launchPhotoshop,
  openPhotoshopSession,
  subscribePhotoshopSession,
  syncPhotoshopSession,
  uploadPhotoshopSessionSource,
  type PhotoshopSession,
} from '@/features/photoshop/photoshopBridgeClient';
import {
  LocalRepaintDialog,
  type LocalRepaintGenerateInput,
} from '@/components/localRepaint/LocalRepaintDialog';
import {
  AutoBakeProgressBar,
  type AutoBakeProgress,
} from '@/components/panels/AutoBakeProgressBar';
import {
  GeneratePanel,
  type GeneratePanelTaskState,
  type LocalImageGenerationSettledResult,
} from '@/components/panels/GeneratePanel';
import { LayerAdjustmentsPanel } from '@/components/panels/LayerAdjustmentsPanel';
import { LayersPanel, LayersPanelActions } from '@/components/panels/LayersPanel';
import { ObjectTransformPanel } from '@/components/panels/ObjectTransformPanel';
import { ObjectsPanel, ObjectsPanelActions } from '@/components/panels/ObjectsPanel';
import { ReferenceImagePicker } from '@/components/panels/ReferenceImagePicker';
import {
  ReferenceImportDialog,
  type ReferenceImportRole,
} from '@/components/panels/ReferenceImportDialog';
import { ViewportPanel } from '@/components/panels/ViewportPanel';
import { Button } from '@/components/ui/Button';
import { WorkspaceModeShell } from '@/components/workspace/WorkspaceModeShell';
import { useWorkspaceLayoutStore } from '@/components/workspace/workspaceLayoutStore';
import type { WorkspacePanelDefinition } from '@/components/workspace/workspacePanelTypes';
import { applyBakedTextureToObject } from '@/engine/bake/applyBakedTexture';
import { bakeVisibleProjectedLayersToTexture } from '@/engine/bake/bakeProjectedLayerToTexture';
import { getProjectedLayerStackSignature } from '@/engine/bake/layerStackCache';
import { resolveImageAssetUrl } from '@/engine/bake/imageSampler';
import {
  buildContentAwareRepairMask,
  buildContentAwareSurfaceTopology,
  CONTENT_AWARE_REPAIR_REQUEST_EVENT,
  createVisibleSurfaceCompletionPolicy,
  runSurfaceAwareRepair,
  type ContentAwareRepairRequestDetail,
} from '@/engine/contentAware';
import {
  readContentAwareProjectionBake,
  writeContentAwareProjectionBake,
} from '@/engine/contentAware/projectionBakeCache';
import {
  clearDebugUvBakeMethod,
  getDebugUvBakeStatus,
  setDebugGpuCoverageValidation,
  setDebugGpuProjectedImageUvFlipY,
  setDebugUvBakeMethod,
  setDebugUvBakeVerbose,
} from '@/engine/bake/uvBakeDebugControls';
import {
  getLiveProjectedTextureBlob,
  getLiveProjectedTextureSourceState,
  isLiveProjectedCanvasUrl,
} from '@/engine/projection/liveProjectedCanvasTextureRegistry';
import {
  createProjectionMaskedImage,
  prewarmMaskedProjectedImageWorker,
} from '@/engine/projection/createMaskedProjectedImage';
import { isLocalRepaintProjectedLayer } from '@/engine/bake/projectedOverlayComposition';
import {
  createFlatPreviewMaterial,
  disposeGeneratedMaterialTree,
  prewarmProjectedLayerTextureSources,
  syncProjectedLayerMaterialProjection,
} from '@/engine/projection/ProjectedLayerMaterial';
import { loadModelFromFile, loadModelFromUrl } from '@/engine/loaders/loadModelFromFile';
import {
  assertModelTriangleLimit,
  disposeRejectedModel,
  TEXTURE_MODEL_TRIANGLE_LIMIT,
} from '@/engine/loaders/modelTriangleLimit';
import {
  getModelImportBatchProgress,
  isModelImportProgressIndeterminate,
  type ModelImportPhase,
  type ModelImportProgressEvent,
} from '@/engine/loaders/modelImportProgress';
import { getImportedBaseColorTextureUrl } from '@/engine/loaders/modelLoadUtils';
import { OBJECT_RUNTIME_RESTORE_REQUEST_EVENT } from '@/engine/history/objectDeletionTransaction';
import { getReusableProjectModels } from '@/engine/loaders/projectModelRestoreReuse';
import { placeImportedModelBesideScene } from '@/engine/scene/placeImportedModelBesideScene';
import { getBoundingBoxForObject } from '@/engine/scene/boundingBoxUtils';
import {
  compositeRgbaUnderInPlace,
  getMergeUvPostprocessOptions,
  getRgbaAlphaCoverageRatio,
  isContentAwareUvUnderlay,
  isFlattenableUvMergeSource,
  UV_MERGE_COMPOSITION_VERSION,
} from '@/engine/layers/mergeUvComposition';
import {
  compositeRgbaUrlUnderWithWebGpu,
  releaseWebGpuRgbaCompositeResources,
  type WebGpuRgbaCompositeMetrics,
} from '@/engine/performance/webGpuRgbaComposite';
import { compareUvLayersForComposition } from '@/engine/layers/uvLayerComposition';
import {
  applyAlphaFromMask,
  blobToDataUrl,
  compositeUsingMask,
  contentAwareFillMaskedPixels,
  dataUrlToBlob,
  imageDataToBlob,
  resizeImageData,
  restoreProtectedPixels,
  urlToImageData,
} from '@/engine/localRepaint/imageUtils';
import {
  buildEditMask,
  buildProtectMask,
  computeMaskBoundingBox,
  createEmptyMask,
  createFullMask,
  expandRect,
  featherMask,
  maskToBlob,
} from '@/engine/localRepaint/maskUtils';
import { buildLocalRepaintPrompt } from '@/engine/localRepaint/promptBuilder';
import {
  getLocalRepaintSeamMode,
  setLocalRepaintSeamMode,
  type LocalRepaintSeamMode,
} from '@/engine/localRepaint/seamHarmonizationMode';
import { harmonizeLocalRepaintInWorker } from '@/engine/localRepaint/seamHarmonizationWorker';
import { ensureLocalRepaintSessionLayer, restoreLocalRepaintLayerSelection } from '@/engine/localRepaint/sessionLayer';
import { resolveLocalRepaintBackgroundPrewarmDisposition } from '@/engine/localRepaint/backgroundPrewarmPolicy';
import {
  createLocalRepaintActivationRequest,
  localRepaintActivationRequestMatches,
  selectPreferredLocalRepaintGeneration,
  type LocalRepaintActivationRequest,
} from '@/engine/localRepaint/activationRequestPolicy';
import {
  getLocalRepaintSessionSnapshot,
  isLocalRepaintPreparationInFlight,
  LOCAL_REPAINT_INTERACTIVE_STATE_EVENT,
  requestLocalRepaintSessionActivation,
  type LocalRepaintInteractiveStateDetail,
} from '@/engine/localRepaint/localRepaintInteractiveState';
import {
  generationBelongsToObject,
  normalizeLocalRepaintObjectBindings,
} from '@/engine/localRepaint/objectBinding';
import {
  prewarmPreviewTextures,
  releasePreviewTexture,
} from '@/engine/viewport/previewTextureCache';
import { shouldFocusImportedModelAfterImport } from '@/engine/viewport/cameraFramingPolicy';
import type { ModelLoadResult } from '@/engine/loaders/modelImportTypes';
import { focusCameraOrbitOnObjectId, setCameraToObjectView } from '@/engine/scene/transformActions';
import { applySerializedCamera, serializeCamera } from '@/engine/projection/ProjectionCamera';
import { ViewportCanvas } from '@/engine/viewport/ViewportCanvas';
import {
  isViewportInteractionBusy,
  subscribeViewportInteraction,
} from '@/engine/viewport/viewportInteractionState';
import {
  markPerformanceEvent,
  startPerformanceSpan,
} from '@/engine/performance/performanceTimeline';
import type { HeavyTaskContext } from '@/engine/performance/heavyTaskScheduler';
import { useEngineSession } from '@/engine/session/engineSessionContext';
import {
  cancelEngineHeavyTasks,
  scheduleEngineHeavyTask,
} from '@/engine/session/engineTaskScheduler';
import { WorkflowModuleSwitcher } from '@/features/workflow/WorkflowModuleSwitcher';
import {
  findMergedUvBakeLayer,
  isBakeMergeModelReady,
  resolveBakeUvMergePlan,
  selectBakeBaseColor,
} from '@/features/workflow/selectBakeBaseColor';
import { EditorShell } from '@/layouts/EditorShell';
import { importProjectJson } from '@/services/projectService';
import {
  isCurrentEditorProjectLoad,
  isEditorProjectServerReady,
  shouldLoadEditorProjectRoute,
  type EditorProjectLoadToken,
} from '@/services/editorProjectRouteLoad';
import { replaceBakeHighSnapshot } from '@/services/bakeHighSnapshot';
import {
  getLatestPipelineStageRevision,
  markDownstreamPipelineRevisionsStale,
  publishPipelineRevision,
} from '@/services/projectPipeline';
import { liclickImageEditProvider } from '@/services/imageEditProvider';
import { resolveLiclickAuthStrategy } from '@/services/liclickAuthStrategy';
import { isCloudBuild } from '@/platform/runtimeCapabilities';
import { hasTrackedModuleAction, trackModuleActionOnce } from '@/services/telemetryClient';
import {
  LatestProjectSaveExecutor,
  ProjectSaveCoordinator,
} from '@/services/projectSaveCoordinator';
import {
  fileToDataUrl,
  getWorkspaceHealth,
  isTrustedGenerationWorkspaceAssetUrl,
  isLegacyWorkspaceAssetUrl,
  isWorkspaceAssetUrl,
  loadProject as loadWorkspaceProject,
  readWorkspaceAssetBlob,
  renameProject as renameWorkspaceProject,
  saveBlobAsset,
  saveDataUrlAsset,
  saveRemoteUrlAsset,
  saveProject as saveWorkspaceProject,
  urlToBlob,
  urlToDataUrl,
  WorkspaceApiError,
} from '@/services/workspaceApiClient';
import { useGenerationStore } from '@/stores/generationStore';
import { useAuthStore } from '@/stores/authStore';
import { useLocalRepaintStore } from '@/stores/localRepaintStore';
import { useEditorHistoryStore } from '@/stores/editorHistoryStore';
import { useT } from '@/stores/i18nStore';
import { useLayerStore } from '@/stores/layerStore';
import { IMMEDIATE_PROJECT_SAVE_EVENT, useProjectStore } from '@/stores/projectStore';
import { useReferenceStore } from '@/stores/referenceStore';
import {
  MAX_PAINT_MASK_BRUSH_SIZE,
  MIN_PAINT_MASK_BRUSH_SIZE,
  useSceneStore,
} from '@/stores/sceneStore';
import { useSettingsStore } from '@/stores/settingsStore';
import { shortcutMatches, type ShortcutActionId } from '@/stores/shortcutStore';
import { useToastStore } from '@/stores/toastStore';
import { runPaintMaskHistoryAction } from '@/engine/paint/paintMaskHistoryActions';
import { getEraserTargetPolicy } from '@/engine/paint/eraserTargetPolicy';
import type { BakeProgress, BakeReport, UvBakeResolution } from '@/engine/bake/uvBakeTypes';
import type { LocalRepaintRuntime, MaskBitmap, Rect } from '@/types/localRepaint';
import type { SerializedCamera } from '@/types/capture';
import type { Generation } from '@/types/generation';
import type { Layer } from '@/types/layer';
import type { SceneObject } from '@/types/model';
import type { Project, ReferenceImage, TextureBakeHandoff } from '@/types/project';
import { getRegisteredObjectUrlBlob } from '@/utils/blobUrlRegistry';
import { encodeRgbaPngBlob, encodeRgbaPngObjectUrl } from '@/utils/encodeRgbaPng';
import { generationBelongsToProject } from '@/utils/generationIdentity';
import { createId } from '@/utils/id';
import { waitForBrowserIdle, waitForBrowserPaint } from '@/utils/browserScheduling';
import { mapWithConcurrency } from '@/utils/mapWithConcurrency';

type EditorPageProps = {
  projectId: string;
  onBack: () => void;
  onOpenRetopology: () => void;
  onOpenUv: () => void;
  onOpenBake: (handoff?: TextureBakeHandoff) => void;
  autoOpenBake?: boolean;
  pendingBakeHandoff?: TextureBakeHandoff;
  showOnboarding?: boolean;
  isActive?: boolean;
};

type ProjectSaveRequest = {
  snapshot: Project;
  editVersion: number;
};

type WorkspaceServerSaveResult = Awaited<ReturnType<typeof saveWorkspaceProject>> & {
  savedLatestSnapshot: boolean;
};

declare global {
  interface Window {
    LiclickUvDebug?: {
      help: () => string[];
      status: typeof getDebugUvBakeStatus;
      useDefault: () => ReturnType<typeof getDebugUvBakeStatus>;
      useCpu: (options?: { ttlMs?: number }) => ReturnType<typeof getDebugUvBakeStatus>;
      useGpu: (options?: { ttlMs?: number }) => ReturnType<typeof getDebugUvBakeStatus>;
      setVerbose: (enabled?: boolean) => ReturnType<typeof getDebugUvBakeStatus>;
      setCoverageValidation: (enabled?: boolean) => ReturnType<typeof getDebugUvBakeStatus>;
      setGpuProjectedImageUvFlipY: (enabled?: boolean) => ReturnType<typeof getDebugUvBakeStatus>;
      compare: (options?: unknown) => Promise<unknown>;
      uvGradient: (options?: unknown) => Promise<unknown>;
    };
  }
}

const resolutionToSize = {
  '1K': 1024,
  '2K': 2048,
  '4K': 4096,
  '8K': 8192,
} as const;

const LARGE_DATA_URL_ASSET_UPLOAD_THRESHOLD = 256 * 1024;
const PROJECT_THUMBNAIL_BACKGROUND = '#333333';
const CONTENT_AWARE_UV_MAX_RESOLUTION = 2048;
const EDITOR_TASK_LOCKED_SHORTCUTS = [
  'project.save',
  'history.undo',
  'history.redo',
  'scene.arrange',
  'scene.select',
  'scene.translate',
  'scene.rotate',
  'scene.scale',
  'texture.clearMask',
  'texture.duplicateLayer',
  'texture.invertMask',
  'texture.newLayer',
  'texture.moveLayerUp',
  'texture.moveLayerDown',
  'texture.showAllLayers',
  'texture.toggleLayer',
  'texture.select',
  'texture.eraser',
  'texture.brushSmaller',
  'texture.brushLarger',
  'texture.maskAdd',
  'texture.maskSubtract',
  'texture.localRepaint',
  'image.move',
  'image.select',
  'image.brush',
  'image.eraser',
  'image.fill',
  'image.picker',
  'image.brushSmaller',
  'image.brushLarger',
  'image.hardnessSofter',
  'image.hardnessHarder',
  'repaint.brush',
  'repaint.eraser',
  'repaint.brushSmaller',
  'repaint.brushLarger',
] satisfies ShortcutActionId[];

const EDITOR_SNAPSHOT_LOCKED_SHORTCUTS = [
  'history.undo',
  'history.redo',
  'scene.arrange',
  'scene.translate',
  'scene.rotate',
  'scene.scale',
  'texture.clearMask',
  'texture.invertMask',
  'texture.eraser',
  'texture.brushSmaller',
  'texture.brushLarger',
  'texture.maskAdd',
  'texture.maskSubtract',
  'texture.localRepaint',
  'image.move',
  'image.brush',
  'image.eraser',
  'image.fill',
  'repaint.brush',
  'repaint.eraser',
] satisfies ShortcutActionId[];

type ReusableProjectionBakePurpose = 'merge-uv' | 'content-aware-repair';

type ReusableProjectionBakeEntry = {
  signature: string;
  imageData: ImageData;
  report: BakeReport;
};

function compareProjectedLayersForDeterministicBake(left: Layer, right: Layer) {
  const orderDelta = right.order - left.order;
  if (orderDelta !== 0) return orderDelta;
  return left.id.localeCompare(right.id);
}

function createReusableProjectionBakeSignature(input: {
  purpose: ReusableProjectionBakePurpose;
  projectId?: string;
  objectId: string;
  resolution: UvBakeResolution;
  group: THREE.Object3D;
  layers: Layer[];
  optionSignature: string;
}) {
  input.group.updateMatrixWorld(true);
  const normalizedLayers = [...input.layers].sort(compareProjectedLayersForDeterministicBake);
  // `getProjectedLayerStackSignature` includes every visual layer setting and
  // live-canvas revision. Append the exact transient asset URLs as well: blob
  // URLs are deliberately omitted from the persistent cache signature, but are
  // safe and necessary for this short-lived editor-session cache.
  const stackSignature = getProjectedLayerStackSignature(
    input.projectId,
    input.objectId,
    input.resolution,
    normalizedLayers,
    {
      method: 'gpu',
      outputAlpha: 'transparent',
      enableDilation: false,
      dilationPixels: 0,
    },
  );
  const exactAssets = normalizedLayers
    .map(
      (layer) =>
        `${layer.id}:${layer.contentRevision ?? 0}:${layer.imageUrl ?? ''}:${layer.maskUrl ?? ''}:${layer.depthUrl ?? ''}:${layer.normalUrl ?? ''}:${layer.depthEncoding ?? ''}`,
    )
    .join('|');
  return [
    'editor-projection-bake-cache-v8',
    input.purpose,
    stackSignature,
    input.group.matrixWorld.elements.join(','),
    JSON.stringify(getDebugUvBakeStatus()),
    input.optionSignature,
    exactAssets,
  ].join('||');
}

function cloneProjectionBakeImageData(imageData: ImageData) {
  return new ImageData(new Uint8ClampedArray(imageData.data), imageData.width, imageData.height);
}

async function waitForBackgroundModelUpgrade(timeoutMs = 900) {
  while (isViewportInteractionBusy()) {
    if (document.visibilityState === 'hidden') return;
    await waitForBrowserPaint();
  }
  await waitForBrowserIdle(timeoutMs);
}

function getPlaceholderBoundingBox(object: SceneObject): ModelLoadResult['boundingBox'] {
  if (object.boundingBox) return object.boundingBox;
  const center = object.transform.position;
  const size = object.transform.scale.map((value) => Math.max(Math.abs(value), 0.4)) as [
    number,
    number,
    number,
  ];
  const halfSize = size.map((value) => value / 2) as [number, number, number];
  return {
    min: [center[0] - halfSize[0], center[1] - halfSize[1], center[2] - halfSize[2]],
    max: [center[0] + halfSize[0], center[1] + halfSize[1], center[2] + halfSize[2]],
    center: [...center],
    size,
  };
}

function createProjectModelBoundsPlaceholder(object: SceneObject): ModelLoadResult {
  const boundingBox = getPlaceholderBoundingBox(object);
  const group = new THREE.Group();
  group.name = `${object.name} loading bounds`;
  group.userData.liclickObjectId = object.id;
  group.userData.liclickRestorePlaceholder = true;
  const geometry = new THREE.BoxGeometry(
    Math.max(boundingBox.size[0], 0.02),
    Math.max(boundingBox.size[1], 0.02),
    Math.max(boundingBox.size[2], 0.02),
  );
  const material = new THREE.MeshStandardMaterial({
    color: '#777777',
    roughness: 0.96,
    metalness: 0,
    transparent: true,
    opacity: 0.72,
    depthWrite: true,
  });
  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = `${object.name} bounds`;
  mesh.position.fromArray(boundingBox.center);
  mesh.userData.liclickObjectId = object.id;
  mesh.userData.liclickRestorePlaceholder = true;
  mesh.raycast = () => undefined;
  group.add(mesh);
  group.updateMatrixWorld(true);
  const format = object.format === 'primitive' ? 'glb' : object.format;
  const importNormalizationTransform = object.importNormalizationTransform ?? {
    position: [0, 0, 0],
    scale: [1, 1, 1],
    targetMaxDimension: Math.max(...boundingBox.size),
    grounded: false,
    normalized: false,
  };
  return {
    objectId: object.id,
    name: object.name,
    format,
    group,
    sourceFileName: object.name,
    objectUrl: object.sourcePath,
    materialSlots: object.materialSlots.map((slot) => slot.name),
    uvSets: object.uvSets,
    boundingBox,
    originalBoundingBox: object.originalBoundingBox ?? boundingBox,
    importNormalizationTransform,
    childMeshCount: 1,
    warnings: object.warnings ?? [],
    restoreStage: 'bounds',
  };
}

function disposeProjectModelBoundsPlaceholder(model: ModelLoadResult | undefined) {
  if (!model || model.restoreStage !== 'bounds') return;
  model.group.traverse((child) => {
    if (!(child instanceof THREE.Mesh)) return;
    child.geometry.dispose();
    const materials = Array.isArray(child.material) ? child.material : [child.material];
    materials.forEach((material) => material.dispose());
  });
  model.group.removeFromParent();
}

function prepareProjectRestoreOutline(model: ModelLoadResult) {
  const outlineMaterial = createFlatPreviewMaterial(undefined, false);
  const disposedMaterials = new Set<THREE.Material | THREE.Material[]>();
  model.group.traverse((child) => {
    if (!(child instanceof THREE.Mesh) || child.userData.liclickPaintOverlay) return;
    const previousMaterial = child.material;
    child.material = outlineMaterial;
    if (previousMaterial === outlineMaterial || disposedMaterials.has(previousMaterial)) return;
    disposedMaterials.add(previousMaterial);
    disposeGeneratedMaterialTree(previousMaterial);
  });
  model.group.userData.liclickRestoreOutlinePrepared = true;
  return model;
}

function startProjectModelSourcePrefetch(
  objects: SceneObject[],
  getFileName: (object: SceneObject) => string,
  concurrency = 3,
) {
  const deferred = new Map<
    string,
    {
      promise: Promise<ArrayBuffer | undefined>;
      resolve: (value: ArrayBuffer | undefined) => void;
    }
  >();
  objects.forEach((object) => {
    let resolve!: (value: ArrayBuffer | undefined) => void;
    const promise = new Promise<ArrayBuffer | undefined>((nextResolve) => {
      resolve = nextResolve;
    });
    deferred.set(object.id, { promise, resolve });
  });

  let cursor = 0;
  const worker = async () => {
    while (cursor < objects.length) {
      const object = objects[cursor];
      cursor += 1;
      const entry = deferred.get(object.id);
      if (!entry) continue;
      const fileName = getFileName(object);
      if (!/\.(glb|fbx|obj)$/i.test(fileName) || !object.sourcePath) {
        entry.resolve(undefined);
        continue;
      }
      try {
        const response = await fetch(object.sourcePath);
        entry.resolve(response.ok ? await response.arrayBuffer() : undefined);
      } catch {
        entry.resolve(undefined);
      }
    }
  };
  const workerCount = Math.min(Math.max(1, concurrency), objects.length);
  for (let index = 0; index < workerCount; index += 1) void worker();
  return new Map([...deferred].map(([objectId, entry]) => [objectId, entry.promise]));
}

function isLocalRepaintGeneration(generation: Generation) {
  return generation.metadata.workflow === 'local-repaint';
}

function getLocalRepaintAuthoringMaskUrl(generation: Generation, fallback?: string) {
  const authoredMaskUrl = generation.metadata.authoredMaskUrl;
  if (typeof authoredMaskUrl === 'string' && authoredMaskUrl.length > 0) return authoredMaskUrl;
  const legacyMaskUrl = generation.metadata.maskUrl;
  return typeof legacyMaskUrl === 'string' && legacyMaskUrl.length > 0 ? legacyMaskUrl : fallback;
}

function getGenerationObjectMatrixWorld(generation: Generation) {
  const value = generation.metadata.objectMatrixWorld;
  if (!Array.isArray(value) || value.length !== 16) return undefined;
  return value.every((item) => typeof item === 'number') ? value : undefined;
}

function getGenerationCaptureCamera(generation: Generation) {
  const value = generation.metadata.captureCamera;
  if (!value || typeof value !== 'object') return undefined;
  const camera = value as Partial<SerializedCamera>;
  if (
    (camera.type !== 'perspective' && camera.type !== 'orthographic') ||
    !Array.isArray(camera.position) ||
    camera.position.length !== 3 ||
    !Array.isArray(camera.quaternion) ||
    camera.quaternion.length !== 4 ||
    !Array.isArray(camera.target) ||
    camera.target.length !== 3 ||
    !Array.isArray(camera.projectionMatrix) ||
    camera.projectionMatrix.length !== 16 ||
    !Array.isArray(camera.matrixWorld) ||
    camera.matrixWorld.length !== 16 ||
    !Array.isArray(camera.viewMatrix) ||
    camera.viewMatrix.length !== 16
  )
    return undefined;
  return camera as SerializedCamera;
}

function isLocalRepaintProjectionLayer(layer: Layer) {
  return isLocalRepaintProjectedLayer(layer);
}

function isLocalRepaintLayer(layer: Layer) {
  return (
    layer.id.startsWith('local-repaint-') ||
    (layer.type === 'uv' && Boolean(layer.renderedColor)) ||
    layer.role === 'local-repaint-overlay' ||
    layer.role === 'local-repaint-draft' ||
    (layer.imageUrl ?? '').includes('surface-edit:local-repaint')
  );
}

function isContentAwareRepairLayer(layer: Layer) {
  return (
    layer.role === 'content-aware-underlay' ||
    layer.generationId === 'texture-map-content-aware-repair' ||
    layer.id.startsWith('content-aware-projected-repair') ||
    layer.id.startsWith('content-aware-uv-repair')
  );
}

function isMatchingLocalRepaintProjectionLayer(
  layer: Layer,
  generationId: string | undefined,
  captureId: string | undefined,
  objectId: string,
  targetLayerId: string | undefined,
) {
  if (!isLocalRepaintProjectionLayer(layer)) return false;
  if (targetLayerId) return layer.replacementTargetLayerId === targetLayerId;
  if (generationId) return layer.generationId === generationId;
  if (captureId) return layer.captureId === captureId;
  return layer.objectId === objectId;
}

function collapseLocalRepaintProjectionLayers(
  layers: Layer[],
  generationId: string | undefined,
  captureId: string | undefined,
  objectId: string,
  targetLayerId: string | undefined,
) {
  let keptLocalRepaintLayer = false;
  return layers.filter((layer) => {
    if (
      !isMatchingLocalRepaintProjectionLayer(
        layer,
        generationId,
        captureId,
        objectId,
        targetLayerId,
      )
    )
      return true;
    if (keptLocalRepaintLayer) return false;
    keptLocalRepaintLayer = true;
    return true;
  });
}

function isLocalRepaintDestinationLayer(
  layer: Layer | undefined,
  objectId: string,
): layer is Layer & { type: 'uv' } {
  if (!layer || layer.type !== 'uv' || layer.objectId !== objectId) return false;
  if (!layer.imageUrl) return true;
  return layer.role === 'local-repaint-overlay';
}

function findNormalMapTexture(model?: ModelLoadResult) {
  let normalMap: THREE.Texture | undefined;
  model?.group.traverse((object) => {
    if (normalMap || !(object instanceof THREE.Mesh)) return;
    const materials = Array.isArray(object.material) ? object.material : [object.material];
    for (const material of materials) {
      const candidate = (material as THREE.Material & { normalMap?: THREE.Texture }).normalMap;
      if (candidate) {
        normalMap = candidate;
        return;
      }
    }
  });
  return normalMap;
}

function canRecordTurntableInBrowser() {
  return typeof MediaRecorder !== 'undefined' && typeof HTMLCanvasElement !== 'undefined';
}

function getLocalRepaintFeatherRadius(mask: MaskBitmap) {
  const bounds = computeMaskBoundingBox(mask);
  if (!bounds) return 0;
  const minSide = Math.min(bounds.w, bounds.h);
  if (minSide <= 48) return 1;
  if (minSide <= 120) return 2;
  return 3;
}

function getLocalRepaintProvider(runtime: LocalRepaintRuntime) {
  const raw = runtime.providerRaw;
  if (!raw || typeof raw !== 'object' || !('provider' in raw)) return undefined;
  const provider = (raw as { provider?: unknown }).provider;
  return typeof provider === 'string' ? provider : undefined;
}

function isLocalContentAwareRuntime(runtime: LocalRepaintRuntime) {
  return getLocalRepaintProvider(runtime)?.includes('local-content-aware-fill') ?? false;
}

function buildLocalRepaintPatchMask(runtime: LocalRepaintRuntime, sourcePatch: ImageData) {
  const patchMask = createEmptyMask(sourcePatch.width, sourcePatch.height);
  const editMask = runtime.editMask;
  if (editMask && isLocalContentAwareRuntime(runtime)) {
    for (let index = 0; index < patchMask.data.length; index += 1) {
      patchMask.data[index] =
        (runtime.objectMask.data[index] ?? 0) > 0 && (editMask.data[index] ?? 0) > 0 ? 255 : 0;
    }
    return patchMask;
  }
  for (let index = 0; index < patchMask.data.length; index += 1) {
    if ((runtime.objectMask.data[index] ?? 0) === 0) continue;
    if (editMask && (editMask.data[index] ?? 0) === 0) continue;
    const offset = index * 4;
    const changed =
      Math.abs(sourcePatch.data[offset] - runtime.workingImageData.data[offset]) +
      Math.abs(sourcePatch.data[offset + 1] - runtime.workingImageData.data[offset + 1]) +
      Math.abs(sourcePatch.data[offset + 2] - runtime.workingImageData.data[offset + 2]);
    if (changed > 8) patchMask.data[index] = 255;
  }

  const featheredMask = featherMask(patchMask, getLocalRepaintFeatherRadius(patchMask));
  for (let index = 0; index < featheredMask.data.length; index += 1) {
    featheredMask.data[index] = Math.min(
      featheredMask.data[index] ?? 0,
      runtime.objectMask.data[index] ?? 0,
    );
  }
  return featheredMask;
}

type PersistedLocalRepaintRuntime = {
  version: 1;
  id: string;
  projectId: string;
  mode: LocalRepaintRuntime['mode'];
  targetName: string;
  targetLayerId?: string;
  cameraState?: SerializedCamera;
  workingImageUrl: string;
  objectMaskUrl: string;
  initialUserMaskUrl?: string;
  holeMaskUrl: string;
  editMaskUrl?: string;
  protectMaskUrl?: string;
  roiRect?: Rect;
  mergedImageUrl?: string;
  previewUrl?: string;
  editJobId?: string;
  taskId?: string;
  status: LocalRepaintRuntime['status'];
  error?: string;
  startedAt?: string;
};

function localRepaintPersistenceKey(projectId: string) {
  return `liclick-local-repaint-runtime-v1:${projectId}`;
}

async function maskToDataUrl(mask: MaskBitmap) {
  return blobToDataUrl(await maskToBlob(mask));
}

async function dataUrlToMask(url: string): Promise<MaskBitmap> {
  const imageData = await urlToImageData(url);
  const data = new Uint8ClampedArray(imageData.width * imageData.height);
  for (let index = 0; index < data.length; index += 1) {
    data[index] = imageData.data[index * 4] > 8 ? 255 : 0;
  }
  return { width: imageData.width, height: imageData.height, data };
}

async function imageDataToPersistedDataUrl(imageData: ImageData) {
  return blobToDataUrl(await imageDataToBlob(imageData));
}

async function persistLocalRepaintRuntime(runtime: LocalRepaintRuntime) {
  if (!runtime.projectId || typeof window === 'undefined') return;
  const payload: PersistedLocalRepaintRuntime = {
    version: 1,
    id: runtime.id,
    projectId: runtime.projectId,
    mode: runtime.mode,
    targetName: runtime.targetName,
    targetLayerId: runtime.targetLayerId,
    cameraState: runtime.cameraState,
    workingImageUrl: runtime.workingImageUrl,
    objectMaskUrl: await maskToDataUrl(runtime.objectMask),
    initialUserMaskUrl: runtime.initialUserMask
      ? await maskToDataUrl(runtime.initialUserMask)
      : undefined,
    holeMaskUrl: await maskToDataUrl(runtime.holeMask),
    editMaskUrl: runtime.editMask ? await maskToDataUrl(runtime.editMask) : undefined,
    protectMaskUrl: runtime.protectMask ? await maskToDataUrl(runtime.protectMask) : undefined,
    roiRect: runtime.roiRect,
    mergedImageUrl: runtime.mergedImageData
      ? await imageDataToPersistedDataUrl(runtime.mergedImageData)
      : undefined,
    previewUrl: runtime.previewUrl,
    editJobId: runtime.editJobId,
    taskId: runtime.taskId,
    status: runtime.status,
    error: runtime.error,
    startedAt: runtime.startedAt,
  };
  try {
    window.localStorage.setItem(
      localRepaintPersistenceKey(runtime.projectId),
      JSON.stringify(payload),
    );
  } catch (error) {
    console.warn('[Liclick 3D Texture] Could not persist local repaint runtime.', error);
  }
}

function clearPersistedLocalRepaintRuntime(projectId: string) {
  if (typeof window === 'undefined') return;
  window.localStorage.removeItem(localRepaintPersistenceKey(projectId));
}

function composeThumbnailBackground(sourceCanvas: HTMLCanvasElement) {
  const targetCanvas = document.createElement('canvas');
  targetCanvas.width = sourceCanvas.width;
  targetCanvas.height = sourceCanvas.height;
  const targetContext = targetCanvas.getContext('2d');
  if (!targetContext) return sourceCanvas;
  targetContext.fillStyle = PROJECT_THUMBNAIL_BACKGROUND;
  targetContext.fillRect(0, 0, targetCanvas.width, targetCanvas.height);
  targetContext.drawImage(sourceCanvas, 0, 0);
  return targetCanvas;
}

function cropThumbnailToVisibleContent(sourceCanvas: HTMLCanvasElement, fillRatio = 0.8) {
  const sourceContext = sourceCanvas.getContext('2d', { willReadFrequently: true });
  if (!sourceContext) return sourceCanvas;
  const { width, height } = sourceCanvas;
  const imageData = sourceContext.getImageData(0, 0, width, height);
  const data = imageData.data;
  let left = width;
  let top = height;
  let right = -1;
  let bottom = -1;

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const offset = (y * width + x) * 4;
      const alpha = data[offset + 3];
      if (alpha <= 8) continue;
      left = Math.min(left, x);
      top = Math.min(top, y);
      right = Math.max(right, x);
      bottom = Math.max(bottom, y);
    }
  }

  if (right < left || bottom < top) return sourceCanvas;
  const margin = Math.round(Math.min(width, height) * 0.06);
  left = Math.max(0, left - margin);
  top = Math.max(0, top - margin);
  right = Math.min(width - 1, right + margin);
  bottom = Math.min(height - 1, bottom + margin);

  const cropWidth = right - left + 1;
  const cropHeight = bottom - top + 1;

  const targetCanvas = document.createElement('canvas');
  targetCanvas.width = width;
  targetCanvas.height = height;
  const targetContext = targetCanvas.getContext('2d');
  if (!targetContext) return sourceCanvas;
  targetContext.fillStyle = PROJECT_THUMBNAIL_BACKGROUND;
  targetContext.fillRect(0, 0, width, height);
  targetContext.imageSmoothingEnabled = true;
  targetContext.imageSmoothingQuality = 'high';

  const scale = Math.min(width / cropWidth, height / cropHeight) * fillRatio;
  const drawWidth = cropWidth * scale;
  const drawHeight = cropHeight * scale;
  targetContext.drawImage(
    sourceCanvas,
    left,
    top,
    cropWidth,
    cropHeight,
    (width - drawWidth) / 2,
    (height - drawHeight) / 2,
    drawWidth,
    drawHeight,
  );
  return targetCanvas;
}

function matchCameraProjectionToRenderAspect(
  camera: THREE.Camera,
  aspect: number,
  sourceProjectionMatrix?: number[],
) {
  if (!Number.isFinite(aspect) || aspect <= 0) return;

  if (camera instanceof THREE.PerspectiveCamera) {
    camera.aspect = aspect;
    camera.updateProjectionMatrix();
    return;
  }

  if (!(camera instanceof THREE.OrthographicCamera)) return;

  const source =
    sourceProjectionMatrix?.length === 16
      ? sourceProjectionMatrix
      : camera.projectionMatrix.toArray();
  const scaleX = source[0];
  const scaleY = source[5];
  const hasUsableProjection =
    Math.abs(scaleX) > Number.EPSILON && Math.abs(scaleY) > Number.EPSILON;
  const effectiveHalfHeight = hasUsableProjection
    ? 1 / Math.abs(scaleY)
    : Math.abs(camera.top - camera.bottom) / Math.max(2 * camera.zoom, Number.EPSILON);
  const centerX = hasUsableProjection ? -source[12] / scaleX : (camera.left + camera.right) / 2;
  const centerY = hasUsableProjection ? -source[13] / scaleY : (camera.top + camera.bottom) / 2;
  const baseHalfHeight = effectiveHalfHeight * camera.zoom;
  const baseHalfWidth = baseHalfHeight * aspect;

  camera.left = centerX - baseHalfWidth;
  camera.right = centerX + baseHalfWidth;
  camera.top = centerY + baseHalfHeight;
  camera.bottom = centerY - baseHalfHeight;
  camera.updateProjectionMatrix();
}

async function restorePersistedLocalRepaintRuntime(
  projectId: string,
): Promise<LocalRepaintRuntime | undefined> {
  if (typeof window === 'undefined') return undefined;
  const raw = window.localStorage.getItem(localRepaintPersistenceKey(projectId));
  if (!raw) return undefined;
  try {
    const payload = JSON.parse(raw) as PersistedLocalRepaintRuntime;
    if (payload.version !== 1 || payload.projectId !== projectId) return undefined;
    const workingImageData = await urlToImageData(payload.workingImageUrl);
    const mergedImageUrl =
      payload.mergedImageUrl ??
      (payload.status === 'preview_ready' ? payload.previewUrl : undefined);
    return {
      id: payload.id,
      projectId,
      mode: payload.mode,
      targetName: payload.targetName,
      targetLayerId: payload.targetLayerId,
      cameraState: payload.cameraState,
      workingImageUrl: payload.workingImageUrl,
      workingImageData,
      objectMask: await dataUrlToMask(payload.objectMaskUrl),
      initialUserMask: payload.initialUserMaskUrl
        ? await dataUrlToMask(payload.initialUserMaskUrl)
        : undefined,
      holeMask: await dataUrlToMask(payload.holeMaskUrl),
      editMask: payload.editMaskUrl ? await dataUrlToMask(payload.editMaskUrl) : undefined,
      protectMask: payload.protectMaskUrl ? await dataUrlToMask(payload.protectMaskUrl) : undefined,
      roiRect: payload.roiRect,
      mergedImageData: mergedImageUrl ? await urlToImageData(mergedImageUrl) : undefined,
      previewUrl: payload.previewUrl,
      editJobId: payload.editJobId,
      taskId: payload.taskId,
      status: payload.status,
      error: payload.error,
      startedAt: payload.startedAt,
    };
  } catch {
    clearPersistedLocalRepaintRuntime(projectId);
    return undefined;
  }
}

// Autosave snapshots retain live registry URLs so painting can keep updating
// the same GPU canvas. Cache the durable asset produced for each exact canvas
// revision; otherwise every unchanged autosave encodes and uploads it again.
const persistedLiveProjectedAssetByRevision = new Map<string, string>();
const persistedProjectAssetBySlot = new Map<string, Map<string, string>>();

function rememberPersistedProjectAsset(slotKey: string, sourceUrl: string, assetUrl: string) {
  const slot = persistedProjectAssetBySlot.get(slotKey) ?? new Map<string, string>();
  slot.set(sourceUrl, assetUrl);
  while (slot.size > 8) slot.delete(slot.keys().next().value as string);
  persistedProjectAssetBySlot.set(slotKey, slot);
  while (persistedProjectAssetBySlot.size > 512) {
    const oldestKey = persistedProjectAssetBySlot.keys().next().value as string | undefined;
    if (!oldestKey) break;
    persistedProjectAssetBySlot.delete(oldestKey);
  }
  return assetUrl;
}

export function EditorPage({
  projectId,
  onBack,
  onOpenRetopology,
  onOpenUv,
  onOpenBake,
  autoOpenBake = false,
  pendingBakeHandoff,
  showOnboarding = false,
  isActive = true,
}: EditorPageProps) {
  const engineSession = useEngineSession();
  const modelInputRef = useRef<HTMLInputElement>(null);
  const projectInputRef = useRef<HTMLInputElement>(null);
  const loadedProjectIdRef = useRef<string>();
  const routeProjectLoadRevisionRef = useRef(0);
  const restoredModelKeyRef = useRef<string>();
  const modelRestoreRequestRef = useRef(0);
  const restoreProjectModelRef = useRef<(project: Project) => Promise<void>>(async () => {});
  const hydratedProjectVersionRef = useRef<string>();
  const skipProjectStoreSyncRef = useRef({
    layers: false,
    generations: false,
    references: false,
  });
  const autosaveDueHandlerRef = useRef<() => void>(() => undefined);
  const autosaveCoordinatorRef = useRef<ProjectSaveCoordinator>();
  if (!autosaveCoordinatorRef.current) {
    autosaveCoordinatorRef.current = new ProjectSaveCoordinator(() =>
      autosaveDueHandlerRef.current(),
    );
  }
  const manualSaveHandlerRef = useRef<() => void>(() => undefined);
  const immediateSaveHandlerRef = useRef<() => void>(() => undefined);
  const flushProjectLayerSyncRef = useRef<() => void>(() => undefined);
  const manualSaveRunningRef = useRef(false);
  const pendingImmediateSaveRef = useRef(false);
  const workspaceSaveExecutorRef = useRef<
    LatestProjectSaveExecutor<ProjectSaveRequest, WorkspaceServerSaveResult>
  >();
  const backNavigationPendingRef = useRef(false);
  const manualBakeRunningRef = useRef(false);
  const manualBakeProgressTimerRef = useRef<number>();
  const automaticBakeEntryRef = useRef<string>();
  const modelImportRunningRef = useRef(false);
  const modelImportRevisionRef = useRef(0);
  const modelImportProgressTimerRef = useRef<number>();
  const contentAwareRepairRunningRef = useRef(false);
  const contentAwareRepairAbortControllerRef = useRef<AbortController>();
  const contentAwareTopologyPrewarmRef = useRef<{
    key: string;
    root: THREE.Object3D;
    promise: ReturnType<typeof buildContentAwareSurfaceTopology>;
  }>();
  const contentAwareRepairTaskTokenRef = useRef<symbol>();
  const saveStatusOperationRef = useRef(0);
  // Keep at most one pristine projection composite per workflow (64 MiB for
  // 4K merge + 16 MiB for 2K repair). Reads are cloned before UV underlays are
  // applied, so later compositing can never corrupt the reusable source.
  const reusableProjectionBakeCacheRef = useRef(
    new Map<ReusableProjectionBakePurpose, ReusableProjectionBakeEntry>(),
  );
  const localRepaintProjectionImageCacheRef = useRef(
    new Map<
      string,
      Promise<{
        imageUrl: string;
        persistentImageUrl: string;
        rawImageUrl: string;
        seamMode: LocalRepaintSeamMode;
        seamHarmonizationVersion?: number;
      }>
    >(),
  );
  const localRepaintToolRequestRevisionRef = useRef(0);
  const localRepaintObjectScopeRef = useRef<string>();
  const preferredLocalRepaintGenerationIdRef = useRef<string>();
  const pendingLocalRepaintBackgroundGenerationIdRef = useRef<string>();
  const localRepaintGpuPrepareRequestedKeyRef = useRef<string>();
  const pendingLocalRepaintActivationRequestRef = useRef<LocalRepaintActivationRequest>();
  const [saveStatus, setSaveStatus] = useState<'idle' | 'saving' | 'saved' | 'failed' | 'offline'>(
    'idle',
  );
  const [autosaveRetryToken, setAutosaveRetryToken] = useState(0);
  const [routeProjectStatus, setRouteProjectStatus] = useState<'idle' | 'loading' | 'missing'>(
    'idle',
  );
  const [serverReadyProjectId, setServerReadyProjectId] = useState<string>();
  const [publishingToRetopology, setPublishingToRetopology] = useState(false);
  const publishingToBakeRef = useRef(false);
  const [publishingToBake, setPublishingToBake] = useState(false);

  function beginSaveStatusOperation() {
    const operation = ++saveStatusOperationRef.current;
    setSaveStatus('saving');
    return operation;
  }

  function finishSaveStatusOperation(
    operation: number,
    status: 'idle' | 'saved' | 'failed' | 'offline',
  ) {
    if (saveStatusOperationRef.current === operation) setSaveStatus(status);
  }
  const [manualBakeProgress, setManualBakeProgress] = useState<AutoBakeProgress | undefined>();
  const [modelImportBusy, setModelImportBusy] = useState(false);
  const [layerAdjustmentsOpen, setLayerAdjustmentsOpen] = useState(false);
  const [localImageGenerationRequestKey, setLocalImageGenerationRequestKey] = useState(0);
  const [localImageGenerationRequested, setLocalImageGenerationRequested] = useState(false);
  const [
    localRepaintGenerationSettledAwaitingUnlock,
    setLocalRepaintGenerationSettledAwaitingUnlock,
  ] = useState(false);
  const [localRepaintActivationQueued, setLocalRepaintActivationQueued] = useState(false);
  const [localRepaintInteractiveState, setLocalRepaintInteractiveState] =
    useState<LocalRepaintInteractiveStateDetail>();
  const [localImageGenerationSuccessKey, setLocalImageGenerationSuccessKey] = useState(0);
  const [cancelActiveGenerationRequestKey, setCancelActiveGenerationRequestKey] = useState(0);
  const [generatePanelTaskState, setGeneratePanelTaskState] = useState<GeneratePanelTaskState>({
    running: false,
    snapshotPreparing: false,
  });
  const [contentAwareRepairRunning, setContentAwareRepairRunning] = useState(false);
  const [contentAwareRepairTaskActive, setContentAwareRepairTaskActive] = useState(false);
  const [contentAwareRepairCancelling, setContentAwareRepairCancelling] = useState(false);
  const [modelImportProgress, setModelImportProgress] = useState<AutoBakeProgress | undefined>();
  const [pendingReferenceImport, setPendingReferenceImport] = useState<ReferenceImage[]>();
  const [photoshopEditSession, setPhotoshopEditSession] = useState<PhotoshopSession>();
  const [photoshopEditBusy, setPhotoshopEditBusy] = useState(false);
  const photoshopEditSessionRef = useRef<PhotoshopSession>();
  const photoshopEditLayerSnapshotRef = useRef<Layer>();
  const photoshopEditUnsubscribeRef = useRef<() => void>();
  const photoshopEditRevisionRef = useRef(0);
  const photoshopProjectSyncHeldRef = useRef(false);
  const suppressProjectLayerSyncRef = useRef(0);
  const restoredHistoryProjectIdRef = useRef<string>();
  const localRepaintRuntime = useLocalRepaintStore((state) => state.runtime);
  const localRepaintVisible = useLocalRepaintStore((state) => state.visible);
  const openLocalRepaintRuntime = useLocalRepaintStore((state) => state.openRuntime);
  const showLocalRepaint = useLocalRepaintStore((state) => state.show);
  const hideLocalRepaint = useLocalRepaintStore((state) => state.hide);
  const updateLocalRepaintRuntime = useLocalRepaintStore((state) => state.updateRuntime);
  const clearLocalRepaintRuntime = useLocalRepaintStore((state) => state.clearRuntime);
  const setLocalRepaintAbortController = useLocalRepaintStore(
    (state) => state.setActiveAbortController,
  );
  const project = useProjectStore((state) => state.projects.find((item) => item.id === projectId));
  const projectEditVersion = useProjectStore((state) => state.editVersions[projectId] ?? 0);
  const replaceCurrentProject = useProjectStore((state) => state.replaceCurrentProject);
  const updateCurrentProject = useProjectStore((state) => state.updateCurrentProject);
  const updateProjectById = useProjectStore((state) => state.updateProjectById);
  const setObjects = useSceneStore((state) => state.setObjects);
  const objects = useSceneStore((state) => state.objects);
  const setImportedModel = useSceneStore((state) => state.setImportedModel);
  const restoreImportedModels = useSceneStore((state) => state.restoreImportedModels);
  const setImportedModelRestoreStage = useSceneStore((state) => state.setImportedModelRestoreStage);
  const clearImportedModel = useSceneStore((state) => state.clearImportedModel);
  const importedModel = useSceneStore((state) => state.importedModel);
  const viewport = useSceneStore((state) => state.viewport);
  const importSettings = useSceneStore((state) => state.importSettings);
  const transformMode = useSceneStore((state) => state.transformMode);
  const setTransformMode = useSceneStore((state) => state.setTransformMode);
  const paintTool = useSceneStore((state) => state.paintTool);
  const setPaintTool = useSceneStore((state) => state.setPaintTool);
  const paintMaskDataUrl = useSceneStore((state) => state.paintMaskDataUrl);
  const setLocalRepaintProjectionSource = useSceneStore(
    (state) => state.setLocalRepaintProjectionSource,
  );
  const selectedObjectId = useSceneStore((state) => state.selectedObjectId);
  const progressiveModelStageSignature = useSceneStore((state) =>
    state.importedModels
      .map((model) => `${model.objectId}:${model.restoreStage ?? 'full'}`)
      .join('|'),
  );

  useEffect(() => {
    if (!selectedObjectId || importedModel?.objectId !== selectedObjectId) return undefined;
    if (importedModel.restoreStage !== 'proxy') return undefined;

    let cancelled = false;
    const selectedGroup = importedModel.group;
    const promoteSelectedModel = async () => {
      // SELECTED-MODEL-EXACT-PRIORITY v1.0.0: do not block the state
      // transition on a complete 4K prewarm. SceneRoot now keeps the ready
      // 512px proxy atomically until its full-stage texture is GPU-resident.
      // Waiting here meant one rejected or contended prewarm left the selected
      // model in proxy stage forever, while also making 005 repeatedly appear
      // white during the attempted handoff.
      await new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()));
      await new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()));
      const sceneState = useSceneStore.getState();
      const currentModel = sceneState.importedModels.find(
        (model) => model.objectId === selectedObjectId,
      );
      if (
        cancelled ||
        sceneState.selectedObjectId !== selectedObjectId ||
        currentModel?.group !== selectedGroup ||
        currentModel.restoreStage !== 'proxy'
      ) {
        return;
      }
      setImportedModelRestoreStage(selectedObjectId, 'full');
      document.body.dataset.textureRestoreModelFull = '1';
      document.body.dataset.textureRestoreModelFullMs = performance.now().toFixed(1);
    };
    void promoteSelectedModel();
    return () => {
      cancelled = true;
    };
  }, [
    importedModel?.group,
    importedModel?.objectId,
    importedModel?.restoreStage,
    selectedObjectId,
    setImportedModelRestoreStage,
  ]);

  useEffect(() => {
    const sceneState = useSceneStore.getState();
    if (
      sceneState.importedModels.length === 0 ||
      sceneState.importedModels.some(
        (model) =>
          (model.restoreStage === 'bounds' && model.group.userData.liclickRestoreFailed !== true) ||
          model.restoreStage === 'outline',
      )
    ) {
      return undefined;
    }
    const candidate = sceneState.importedModels.find(
      (model) => model.restoreStage === 'proxy' && model.objectId !== sceneState.selectedObjectId,
    );
    if (!candidate) return undefined;

    let cancelled = false;
    const upgradeProxyInBackground = async () => {
      await waitForBackgroundModelUpgrade();
      if (cancelled || isViewportInteractionBusy()) return;
      const exactVisibleUvUrls = useLayerStore
        .getState()
        .layers.filter(
          (layer) =>
            layer.type === 'uv' &&
            layer.visible &&
            Boolean(layer.imageUrl) &&
            (!layer.objectId || layer.objectId === candidate.objectId),
        )
        .flatMap((layer) => (layer.imageUrl ? [layer.imageUrl] : []));
      if (exactVisibleUvUrls.length > 0) await prewarmPreviewTextures(exactVisibleUvUrls);
      const latestScene = useSceneStore.getState();
      const latestCandidate = latestScene.importedModels.find(
        (model) => model.objectId === candidate.objectId,
      );
      if (
        cancelled ||
        latestScene.selectedObjectId === candidate.objectId ||
        latestCandidate?.group !== candidate.group ||
        latestCandidate.restoreStage !== 'proxy'
      ) {
        return;
      }
      setImportedModelRestoreStage(candidate.objectId, 'full');
      document.body.dataset.backgroundFullMaterialObjectId = candidate.objectId;
    };
    void upgradeProxyInBackground();
    return () => {
      cancelled = true;
    };
  }, [progressiveModelStageSignature, setImportedModelRestoreStage]);

  useEffect(() => {
    const activeObjectId = selectedObjectId ?? importedModel?.objectId;
    const nextScope = `${projectId}:${activeObjectId ?? ''}`;
    if (localRepaintObjectScopeRef.current === nextScope) return;
    localRepaintObjectScopeRef.current = nextScope;

    const sceneState = useSceneStore.getState();
    if (
      !sceneState.localRepaintProjectionSource &&
      !sceneState.localRepaintPreviewLayer &&
      !sceneState.paintMaskHasContent
    )
      return;
    // The live projection source and mask are renderer-owned session state.
    // They cannot follow a project/model switch even when a legacy layer lacks
    // objectId, otherwise that old image is painted onto every later model.
    localRepaintToolRequestRevisionRef.current += 1;
    pendingLocalRepaintBackgroundGenerationIdRef.current = undefined;
    localRepaintGpuPrepareRequestedKeyRef.current = undefined;
    pendingLocalRepaintActivationRequestRef.current = undefined;
    setLocalRepaintActivationQueued(false);
    setLocalRepaintGenerationSettledAwaitingUnlock(false);
    sceneState.setLocalRepaintProjectionSource(undefined);
    sceneState.setLocalRepaintPreviewLayer(undefined);
    sceneState.setLocalRepaintGenerationPresentationActive(false);
    sceneState.setPaintTool('none');
    sceneState.clearPaintMask();
  }, [importedModel?.objectId, projectId, selectedObjectId]);

  const setLayers = useLayerStore((state) => state.setLayers);
  const setActiveLayer = useLayerStore((state) => state.setActiveLayer);
  const activeProjectedLayerId = useLayerStore((state) => state.activeProjectedLayerId);
  const updateLayerImage = useLayerStore((state) => state.updateLayerImage);
  const addUvLayer = useLayerStore((state) => state.addUvLayer);
  const updateLayer = useLayerStore((state) => state.updateLayer);
  const mergeLayersIntoUvLayer = useLayerStore((state) => state.mergeLayersIntoUvLayer);
  const generations = useGenerationStore((state) => state.generations);
  const setGenerations = useGenerationStore((state) => state.setGenerations);
  const setProjectGenerationsById = useProjectStore((state) => state.setProjectGenerationsById);
  const setProjectLayers = useProjectStore((state) => state.setProjectLayers);
  const setProjectReferences = useProjectStore((state) => state.setProjectReferences);
  const references = useReferenceStore((state) => state.references);
  const setReferences = useReferenceStore((state) => state.setReferences);
  const addReferences = useReferenceStore((state) => state.addReferences);
  const setSelectedReferences = useReferenceStore((state) => state.setSelectedReferences);
  const resolution = useSettingsStore((state) => state.resolution);

  // Surface connectivity is invariant while the model geometry is unchanged.
  // Build it cooperatively as soon as the restored model becomes idle instead
  // of charging the six-second topology cost to the user's repair click.
  useEffect(() => {
    if (!importedModel) return;
    const repairResolution = Math.min(
      resolutionToSize[resolution],
      CONTENT_AWARE_UV_MAX_RESOLUTION,
    );
    const key = `${projectId}:${importedModel.objectId}:${repairResolution}`;
    let cancelled = false;
    let idleId: number | undefined;
    let timeoutId: number | undefined;
    const prewarm = () => {
      if (
        cancelled ||
        (contentAwareTopologyPrewarmRef.current?.key === key &&
          contentAwareTopologyPrewarmRef.current.root === importedModel.group)
      )
        return;
      // Atomic model reveal temporarily hides the imported hierarchy. Building
      // an `includeInvisible:false` topology during that window cached a
      // partial graph (and changed the repair checksum between cold runs).
      // Wait for this exact object to be fully revealed before caching it.
      if (
        document.body.dataset.atomicModelRevealStatus !== 'ready' ||
        document.body.dataset.atomicModelRevealObjectId !== importedModel.objectId
      ) {
        timeoutId = window.setTimeout(prewarm, 100);
        return;
      }
      const startedAt = performance.now();
      const promise = buildContentAwareSurfaceTopology(
        importedModel.group,
        repairResolution,
        repairResolution,
        {
          includeInvisible: false,
          includeSeamLinks: true,
          seamBandPixels: 1,
          minimumSeamNormalDot: 0.72,
          yieldIntervalMs: 4,
        },
      );
      const prewarmRoot = importedModel.group;
      contentAwareTopologyPrewarmRef.current = { key, root: prewarmRoot, promise };
      void promise
        .then(() => {
          if (
            contentAwareTopologyPrewarmRef.current?.key !== key ||
            contentAwareTopologyPrewarmRef.current.root !== prewarmRoot
          )
            return;
          document.body.dataset.contentAwareTopologyPrewarm = 'ready';
          document.body.dataset.contentAwareTopologyPrewarmMs = (
            performance.now() - startedAt
          ).toFixed(1);
        })
        .catch((error) => {
          if (
            contentAwareTopologyPrewarmRef.current?.key === key &&
            contentAwareTopologyPrewarmRef.current.root === prewarmRoot
          ) {
            contentAwareTopologyPrewarmRef.current = undefined;
          }
          console.warn('[Liclick Content Aware] Topology prewarm failed.', error);
        });
    };
    if (typeof window.requestIdleCallback === 'function') {
      idleId = window.requestIdleCallback(prewarm, { timeout: 1_500 });
    } else {
      timeoutId = window.setTimeout(prewarm, 250);
    }
    return () => {
      cancelled = true;
      if (idleId !== undefined) window.cancelIdleCallback(idleId);
      if (timeoutId !== undefined) window.clearTimeout(timeoutId);
    };
  }, [importedModel, projectId, resolution]);

  const pushToast = useToastStore((state) => state.pushToast);
  const authStatus = useAuthStore((state) => state.status);
  const authenticatedUserId = useAuthStore((state) => state.user?.id);
  const t = useT();
  const workspacePanels = useWorkspaceLayoutStore((state) => state.panels);
  const workspaceMode = useWorkspaceLayoutStore((state) => state.mode);
  const setPanelCollapsed = useWorkspaceLayoutStore((state) => state.setPanelCollapsed);
  const showPanel = useWorkspaceLayoutStore((state) => state.showPanel);
  const undo = useEditorHistoryStore((state) => state.undo);
  const redo = useEditorHistoryStore((state) => state.redo);
  const captureHistory = useEditorHistoryStore((state) => state.capture);
  const restorePersistedHistory = useEditorHistoryStore((state) => state.restorePersisted);
  const canUndo = useEditorHistoryStore((state) => state.past.length > 0);
  const canRedo = useEditorHistoryStore((state) => state.future.length > 0);
  // EditorPage owns the whole workspace shell. Subscribing it to the complete
  // layer array made every eye toggle and every generated projector reconcile
  // the full route. Subscribe only to the few layer values this shell renders;
  // the viewport and layer panel keep their own fine-grained subscriptions.
  const activeLayer = useLayerStore((state) =>
    state.layers.find((layer) => layer.id === activeProjectedLayerId),
  );
  const localRepaintGenerationReady = useMemo(() => {
    const preferredObjectId = selectedObjectId ?? importedModel?.objectId;
    return generations.some(
      (generation) =>
        generation.status === 'succeeded' &&
        Boolean(generation.resultUrl) &&
        isLocalRepaintGeneration(generation) &&
        (!generation.metadata.projectId || generation.metadata.projectId === projectId) &&
        generationBelongsToObject(generation, preferredObjectId, project?.captures ?? []),
    );
  }, [generations, importedModel?.objectId, project?.captures, projectId, selectedObjectId]);
  const localRepaintInteractiveReady = useMemo(
    () =>
      localRepaintInteractiveState?.status === 'ready' &&
      generations.some(
        (generation) =>
          generation.id === localRepaintInteractiveState.generationId &&
          generation.status === 'succeeded' &&
          Boolean(generation.resultUrl),
      ),
    [generations, localRepaintInteractiveState],
  );
  const localImageGenerationStoreRunning = useMemo(() => {
    const preferredObjectId = selectedObjectId ?? importedModel?.objectId;
    return generations.some(
      (generation) =>
        (generation.status === 'queued' || generation.status === 'running') &&
        isLocalRepaintGeneration(generation) &&
        (!generation.metadata.projectId || generation.metadata.projectId === projectId) &&
        generationBelongsToObject(generation, preferredObjectId, project?.captures ?? []),
    );
  }, [generations, importedModel?.objectId, project?.captures, projectId, selectedObjectId]);
  const localImageGenerationRunning =
    localImageGenerationRequested || localImageGenerationStoreRunning;

  useEffect(() => {
    if (
      !localImageGenerationRequested ||
      localImageGenerationStoreRunning ||
      generatePanelTaskState.running
    ) {
      return undefined;
    }

    // `localImageGenerationRequested` bridges the toolbar click to the panel.
    // If the panel/request is remounted or a timed-out submission has already
    // been removed, that bridge can otherwise outlive every real task and keep
    // the whole editor exclusively locked. Give a fresh click time to enter
    // the panel, then release only a request with no backing activity.
    const orphanedRequestTimeout = window.setTimeout(() => {
      const hasBackingGeneration = useGenerationStore
        .getState()
        .generations.some(
          (generation) =>
            (generation.status === 'queued' || generation.status === 'running') &&
            isLocalRepaintGeneration(generation) &&
            (!generation.metadata.projectId || generation.metadata.projectId === projectId),
        );
      if (!hasBackingGeneration) {
        useSceneStore.getState().setLocalRepaintGenerationPresentationActive(false);
        setLocalImageGenerationRequested(false);
        pushToast({
          tone: 'warning',
          title: '已解除异常任务锁',
          description: '局部生图任务未成功进入后台，请重新生成。',
          dedupeKey: 'orphaned-local-generation-lock-released',
        });
      }
    }, 5_000);
    return () => window.clearTimeout(orphanedRequestTimeout);
  }, [
    generatePanelTaskState.running,
    localImageGenerationRequested,
    localImageGenerationStoreRunning,
    projectId,
    pushToast,
  ]);

  const projectGenerationRunning = useMemo(
    () =>
      generations.some((generation) => {
        if (generation.status !== 'queued' && generation.status !== 'running') return false;
        // 局部重绘仍允许用户查看和编辑画布；这里只阻止重复提交生图任务。
        if (isLocalRepaintGeneration(generation)) return false;
        const generationProjectId = generation.metadata.projectId;
        return typeof generationProjectId !== 'string' || generationProjectId === projectId;
      }),
    [generations, projectId],
  );
  const generationConflictLocked =
    localImageGenerationRunning || projectGenerationRunning || generatePanelTaskState.running;
  // 局部生图和内容识别修补都依赖当前模型与遮罩快照，运行期间保持
  // 编辑器互斥，避免用户继续变更后把结果写回到错误的项目状态。
  const editorTaskRunning = localImageGenerationRunning || contentAwareRepairRunning;
  const snapshotPreparationLocked = generatePanelTaskState.snapshotPreparing;
  const modelMutationLocked = editorTaskRunning || generationConflictLocked;
  const generationOperationLocked = modelMutationLocked;
  const editorToolsLocked = editorTaskRunning || snapshotPreparationLocked;
  const canQueueLocalRepaintActivation =
    (localRepaintGenerationReady || localRepaintGenerationSettledAwaitingUnlock) &&
    (localImageGenerationRunning ||
      localRepaintGenerationSettledAwaitingUnlock ||
      (localRepaintGenerationReady && !localRepaintInteractiveReady)) &&
    !contentAwareRepairRunning &&
    !projectGenerationRunning &&
    !snapshotPreparationLocked;
  const showGenerationConflict = useCallback((_action = '当前操作') => {
    setCancelActiveGenerationRequestKey((key) => key + 1);
  }, []);
  const notifyEditorTaskRunning = useCallback(
    (action = '当前操作') => {
      if (generationConflictLocked) {
        showGenerationConflict(action);
        return;
      }
      pushToast({
        tone: 'info',
        title: '任务正在运行',
        description: contentAwareRepairRunning
          ? '正在进行内容识别补缝，完成前仅支持预览。'
          : snapshotPreparationLocked
            ? '正在准备多视角快照，模型变换和绘画会在快照完成后自动解锁。'
            : '生成任务仍绑定当前模型，暂不能删除、替换模型或启动另一项生成任务。',
        dedupeKey: 'editor-task-preview-only',
      });
    },
    [
      contentAwareRepairRunning,
      generationConflictLocked,
      pushToast,
      showGenerationConflict,
      snapshotPreparationLocked,
    ],
  );

  useEffect(() => {
    if (!generationConflictLocked) return undefined;
    const warnBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', warnBeforeUnload);
    return () => window.removeEventListener('beforeunload', warnBeforeUnload);
  }, [generationConflictLocked]);

  const handleLockedEditorInteraction = useCallback(
    (event: SyntheticEvent<HTMLElement>) => {
      if (!editorTaskRunning) return;
      const target = event.target as HTMLElement;
      if (!target.closest('button, input, select, textarea, a, label, [role="button"]')) return;
      if (target.closest('[data-task-preview-allowed="true"]')) return;
      event.preventDefault();
      event.stopPropagation();
      notifyEditorTaskRunning();
    },
    [editorTaskRunning, notifyEditorTaskRunning],
  );

  useEffect(() => {
    if (!editorToolsLocked) return;
    const sceneState = useSceneStore.getState();
    if (sceneState.paintTool !== 'none') sceneState.setPaintTool('none');
    if (sceneState.transformMode !== 'select') sceneState.setTransformMode('select');
  }, [editorToolsLocked]);

  useEffect(() => {
    if (!editorTaskRunning && !snapshotPreparationLocked && !modelMutationLocked) return;

    const activeElement = document.activeElement;
    if (
      activeElement instanceof HTMLElement &&
      (activeElement.matches('input, textarea, select') || activeElement.isContentEditable)
    ) {
      activeElement.blur();
    }

    const handleTaskLockedShortcut = (event: KeyboardEvent) => {
      const target = event.target;
      if (
        target instanceof HTMLInputElement ||
        target instanceof HTMLTextAreaElement ||
        target instanceof HTMLSelectElement ||
        (target instanceof HTMLElement && target.isContentEditable)
      ) {
        return;
      }

      const blocked =
        (modelMutationLocked && (event.key === 'Delete' || event.key === 'Backspace')) ||
        (editorTaskRunning &&
          EDITOR_TASK_LOCKED_SHORTCUTS.some((actionId) => shortcutMatches(event, actionId))) ||
        (snapshotPreparationLocked &&
          EDITOR_SNAPSHOT_LOCKED_SHORTCUTS.some((actionId) => shortcutMatches(event, actionId)));
      if (!blocked) return;

      event.preventDefault();
      event.stopImmediatePropagation();
      notifyEditorTaskRunning();
    };

    document.addEventListener('keydown', handleTaskLockedShortcut, true);
    return () => document.removeEventListener('keydown', handleTaskLockedShortcut, true);
  }, [editorTaskRunning, modelMutationLocked, notifyEditorTaskRunning, snapshotPreparationLocked]);
  const activeBakedTexture = project?.bakedTextures.find(
    (texture) => texture.id === activeLayer?.bakedTextureId,
  );
  const activeColorTextureUrl =
    activeLayer?.type === 'uv' && activeLayer.imageUrl
      ? activeLayer.imageUrl
      : activeBakedTexture?.imageUrl;
  const currentTextureObjectId = selectedObjectId ?? importedModel?.objectId;
  const currentObjectBaseColorIdentity = useLayerStore((state) => {
    const source = selectBakeBaseColor(
      project ? { layers: state.layers, bakedTextures: project.bakedTextures } : undefined,
      currentTextureObjectId,
    );
    return source ? `${source.name}\u0000${source.imageUrl}` : '';
  });
  const currentObjectBaseColor = useMemo(() => {
    if (!currentObjectBaseColorIdentity) return undefined;
    const separator = currentObjectBaseColorIdentity.indexOf('\u0000');
    return {
      name: currentObjectBaseColorIdentity.slice(0, separator),
      imageUrl: currentObjectBaseColorIdentity.slice(separator + 1),
    };
  }, [currentObjectBaseColorIdentity]);
  const normalLayer = useLayerStore((state) =>
    state.layers.find(
      (layer) =>
        layer.type === 'normal' &&
        Boolean(layer.imageUrl) &&
        (!selectedObjectId || !layer.objectId || layer.objectId === selectedObjectId),
    ),
  );
  const normalMapTexture = findNormalMapTexture(importedModel);

  useEffect(() => {
    contentAwareRepairAbortControllerRef.current?.abort();
    contentAwareRepairAbortControllerRef.current = undefined;
    contentAwareRepairTaskTokenRef.current = undefined;
    contentAwareRepairRunningRef.current = false;
    setContentAwareRepairRunning(false);
    setContentAwareRepairTaskActive(false);
    setContentAwareRepairCancelling(false);
    setGeneratePanelTaskState({ running: false, snapshotPreparing: false });
    reusableProjectionBakeCacheRef.current.clear();
    setRouteProjectStatus('idle');
    setServerReadyProjectId(undefined);
    delete document.body.dataset.atomicModelRevealPainted;
    delete document.body.dataset.atomicModelRevealPaintedObjectId;
    restoredHistoryProjectIdRef.current = undefined;
    hydratedProjectVersionRef.current = undefined;
    restoredModelKeyRef.current = undefined;
    modelRestoreRequestRef.current += 1;
    routeProjectLoadRevisionRef.current += 1;
    modelImportRevisionRef.current += 1;
    window.clearTimeout(modelImportProgressTimerRef.current);
    setModelImportBusy(modelImportRunningRef.current);
    setModelImportProgress(undefined);
  }, [authenticatedUserId, authStatus, projectId]);

  useEffect(
    () => () => {
      window.clearTimeout(manualBakeProgressTimerRef.current);
      window.clearTimeout(modelImportProgressTimerRef.current);
      modelImportRevisionRef.current += 1;
      modelImportRunningRef.current = false;
      contentAwareRepairAbortControllerRef.current?.abort();
      contentAwareRepairAbortControllerRef.current = undefined;
      contentAwareRepairTaskTokenRef.current = undefined;
      contentAwareRepairRunningRef.current = false;
      reusableProjectionBakeCacheRef.current.clear();
    },
    [],
  );

  useEffect(() => {
    // Merge UV can include a local-repaint projection. Load its alpha worker
    // during idle editor time, not in the S4/user click frame.
    prewarmMaskedProjectedImageWorker();
  }, []);

  useEffect(() => {
    if (authStatus === 'checking') return;
    if (!shouldLoadEditorProjectRoute(projectId)) return;
    const token: EditorProjectLoadToken = {
      projectId,
      revision: routeProjectLoadRevisionRef.current + 1,
    };
    routeProjectLoadRevisionRef.current = token.revision;
    setRouteProjectStatus('loading');
    void loadWorkspaceProject(projectId)
      .then((result) => {
        if (
          !isCurrentEditorProjectLoad({
            token,
            currentRevision: routeProjectLoadRevisionRef.current,
            currentRouteProjectId: projectId,
            resultProjectId: result.project.id,
          })
        )
          return;
        loadedProjectIdRef.current = result.project.id;
        replaceCurrentProject(result.project);
        hydrateProjectStores(result.project);
        setServerReadyProjectId(result.project.id);
        setRouteProjectStatus('idle');
      })
      .catch((error) => {
        if (token.revision !== routeProjectLoadRevisionRef.current || token.projectId !== projectId)
          return;
        setRouteProjectStatus('missing');
        console.error('[Liclick 3D Texture] Project load failed in background:', error);
      });
    return () => {
      if (routeProjectLoadRevisionRef.current === token.revision) {
        routeProjectLoadRevisionRef.current += 1;
      }
    };
    // hydrateProjectStores is intentionally not a dependency; this effect is authoritative per route id.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authenticatedUserId, authStatus, projectId, pushToast, replaceCurrentProject, t]);

  useEffect(() => {
    if (serverReadyProjectId !== projectId) return undefined;
    const initialLayers = useLayerStore.getState().layers;
    if (skipProjectStoreSyncRef.current.layers) {
      skipProjectStoreSyncRef.current.layers = false;
    } else {
      const storedProject = useProjectStore
        .getState()
        .projects.find((item) => item.id === projectId);
      if (
        import.meta.hot &&
        initialLayers.length === 0 &&
        (storedProject?.layers.length ?? 0) > 0
      ) {
        setLayers(storedProject!.layers);
      }
    }

    let pendingLayers: Layer[] | undefined;
    let syncTimer: number | undefined;
    const scheduleSync = () => {
      if (syncTimer !== undefined || !pendingLayers) return;
      syncTimer = window.setTimeout(flushSync, 220);
    };
    const flushSync = (force = false) => {
      syncTimer = undefined;
      if (!pendingLayers) return;
      const interactionReserved =
        isViewportInteractionBusy(420) ||
        document.body.dataset.perfAutoOrbit === '1' ||
        document.body.dataset.perfSimulatedViewportInteraction === '1' ||
        document.body.dataset.perfScenarioMeasuring === '1';
      if (
        (!force && interactionReserved) ||
        document.body.dataset.perfSuppressProjectLayerSync === '1' ||
        suppressProjectLayerSyncRef.current > 0
      ) {
        scheduleSync();
        return;
      }
      const layersToSync = pendingLayers;
      pendingLayers = undefined;
      // Project snapshots and saves already read the authoritative layer store.
      // Only mark the project dirty here; mirroring the whole array caused the
      // 6k-line route to rerender for every eye/projector update.
      const projectState = useProjectStore.getState();
      const currentProject = projectState.projects.find((item) => item.id === projectId);
      // Some paint paths already mirrored this exact array into ProjectStore and
      // advanced editVersion. Do not advance it a second time after a save.
      if (currentProject && currentProject.layers !== layersToSync) {
        projectState.markProjectEdited(projectId);
      }
    };
    const flushBeforeSave = () => flushSync(true);
    flushProjectLayerSyncRef.current = flushBeforeSave;
    const unsubscribeLayers = useLayerStore.subscribe((state, previousState) => {
      if (state.layers === previousState.layers) return;
      // A performance transaction restores the original array before releasing
      // its read-only lock. Neither the temporary mutation nor that restore is
      // a user edit, so never leave either one queued for a later autosave.
      if (document.body.dataset.perfSuppressProjectLayerSync === '1') {
        pendingLayers = undefined;
        if (syncTimer !== undefined) {
          window.clearTimeout(syncTimer);
          syncTimer = undefined;
        }
        return;
      }
      pendingLayers = state.layers;
      scheduleSync();
    });
    const unsubscribeInteraction = subscribeViewportInteraction(scheduleSync);
    return () => {
      unsubscribeLayers();
      unsubscribeInteraction();
      if (syncTimer !== undefined) window.clearTimeout(syncTimer);
      if (flushProjectLayerSyncRef.current === flushBeforeSave) {
        flushProjectLayerSyncRef.current = () => undefined;
      }
    };
  }, [projectId, serverReadyProjectId, setLayers]);

  useEffect(() => {
    void objects;
  }, [objects]);

  useEffect(() => {
    if (serverReadyProjectId !== projectId) return;
    if (skipProjectStoreSyncRef.current.generations) {
      skipProjectStoreSyncRef.current.generations = false;
      return;
    }
    setProjectGenerationsById(
      projectId,
      generations.filter((generation) => generationBelongsToProject(generation, projectId)),
    );
  }, [generations, projectId, serverReadyProjectId, setProjectGenerationsById]);

  useEffect(() => {
    if (serverReadyProjectId !== projectId) return;
    if (skipProjectStoreSyncRef.current.references) {
      skipProjectStoreSyncRef.current.references = false;
      return;
    }
    setProjectReferences(references);
  }, [projectId, references, serverReadyProjectId, setProjectReferences]);

  const layerPanelOwnerRef = useRef(activeLayer?.objectId);
  useEffect(() => {
    if (!activeProjectedLayerId) return;
    const previousOwner = layerPanelOwnerRef.current;
    layerPanelOwnerRef.current = activeLayer?.objectId;
    // Restoring another model's active row is not an explicit panel-open intent.
    if (previousOwner !== activeLayer?.objectId) return;
    showPanel('layers');
    setPanelCollapsed('layers', false);
  }, [activeProjectedLayerId, activeLayer?.objectId, setPanelCollapsed, showPanel]);

  useEffect(() => {
    function handleManualSaveShortcut(event: KeyboardEvent) {
      if (document.querySelector('[data-shortcut-dialog]')) return;
      if (!shortcutMatches(event, 'project.save')) return;
      event.preventDefault();
      if (editorTaskRunning) {
        notifyEditorTaskRunning();
        event.stopImmediatePropagation();
        return;
      }
      manualSaveHandlerRef.current();
    }
    window.addEventListener('keydown', handleManualSaveShortcut);
    return () => window.removeEventListener('keydown', handleManualSaveShortcut);
  }, [editorTaskRunning, notifyEditorTaskRunning]);

  useEffect(() => {
    const handleImmediateSave = () => immediateSaveHandlerRef.current();
    window.addEventListener(IMMEDIATE_PROJECT_SAVE_EVENT, handleImmediateSave);
    return () => window.removeEventListener(IMMEDIATE_PROJECT_SAVE_EVENT, handleImmediateSave);
  }, []);

  useEffect(() => {
    function handleUndoRedo(event: KeyboardEvent) {
      if (document.querySelector('[data-shortcut-dialog]')) return;
      if (document.querySelector('[data-editor-shortcut-scope]')) return;
      const eventTarget = event.target instanceof Element ? event.target : null;
      if (
        eventTarget?.closest('input, textarea, select, [contenteditable="true"], [role="textbox"]')
      ) {
        return;
      }
      if (shortcutMatches(event, 'history.undo')) {
        event.preventDefault();
        if (editorTaskRunning) {
          notifyEditorTaskRunning();
          event.stopImmediatePropagation();
          return;
        }
        undo();
      } else if (shortcutMatches(event, 'history.redo')) {
        event.preventDefault();
        if (editorTaskRunning) {
          notifyEditorTaskRunning();
          event.stopImmediatePropagation();
          return;
        }
        redo();
      }
    }
    window.addEventListener('keydown', handleUndoRedo);
    return () => window.removeEventListener('keydown', handleUndoRedo);
  }, [editorTaskRunning, notifyEditorTaskRunning, redo, undo]);

  autosaveDueHandlerRef.current = () => {
    const currentProject = useProjectStore.getState().getCurrentProject();
    if (
      !currentProject ||
      currentProject.id !== projectId ||
      currentProject.workspaceMode !== 'local-server' ||
      !currentProject.dirty ||
      serverReadyProjectId !== currentProject.id
    ) {
      return;
    }
    const viewportBusy =
      isViewportInteractionBusy(1_200) ||
      document.body.dataset.perfAutoOrbit === '1' ||
      document.body.dataset.perfSimulatedViewportInteraction === '1';
    if (
      suppressProjectLayerSyncRef.current > 0 ||
      document.body.dataset.perfSuppressProjectLayerSync === '1' ||
      viewportBusy
    ) {
      autosaveCoordinatorRef.current?.retryAfter();
      return;
    }
    const request = getProjectSaveRequest({ refreshThumbnail: false });
    if (!request) return;
    const saveStatusOperation = beginSaveStatusOperation();
    void saveToWorkspaceServer(request)
      .then((result) => {
        if (result.savedLatestSnapshot) {
          finishSaveStatusOperation(saveStatusOperation, 'saved');
          return;
        }
        // Edits made while assets were uploading must remain dirty and get a
        // follow-up save instead of being incorrectly marked as persisted.
        finishSaveStatusOperation(saveStatusOperation, 'idle');
        setAutosaveRetryToken((token) => token + 1);
      })
      .catch(async (error) => {
        const authRequired = error instanceof WorkspaceApiError && error.status === 401;
        const saveConflict = error instanceof WorkspaceApiError && error.status === 409;
        const retryableConflict = Boolean(
          saveConflict &&
          (error.message.includes('stale project snapshot') ||
            error.message.includes('still uploading')),
        );
        const blockedEmptySave = saveConflict && !retryableConflict;
        if (retryableConflict) {
          finishSaveStatusOperation(saveStatusOperation, 'idle');
          setAutosaveRetryToken((token) => token + 1);
          return;
        }
        const workspaceOnline =
          !authRequired && !blockedEmptySave
            ? await getWorkspaceHealth().then(
                () => true,
                () => false,
              )
            : false;
        finishSaveStatusOperation(
          saveStatusOperation,
          blockedEmptySave ? 'idle' : workspaceOnline ? 'failed' : 'offline',
        );
        if (workspaceOnline && !authRequired && !blockedEmptySave) {
          console.error('[Liclick 3D Texture] Workspace autosave failed.', error);
          return;
        }
        pushToast({
          tone: 'warning',
          title: authRequired
            ? '需要飞书登录'
            : blockedEmptySave
              ? '已阻止异常空项目保存'
              : workspaceOnline
                ? '保存失败'
                : 'Local workspace server is not running.',
          description: authRequired
            ? '当前工程的模型、参考图、图层和生成记录需要登录后才能保存到你的用户工作区。'
            : blockedEmptySave
              ? '当前页面尝试把已有模型/图层保存为空项目，已被项目服务拦截。请刷新项目重新加载。'
              : workspaceOnline
                ? error instanceof Error
                  ? error.message
                  : '本地工作区在线，但项目保存没有完成。'
                : undefined,
          dedupeKey: authRequired
            ? 'workspace-auth-required-editor-save'
            : blockedEmptySave
              ? 'workspace-empty-scene-save-blocked'
              : workspaceOnline
                ? 'workspace-editor-save-failed'
                : 'workspace-server-offline',
        });
      });
  };

  useEffect(() => {
    const coordinator = autosaveCoordinatorRef.current;
    if (
      project &&
      project.workspaceMode === 'local-server' &&
      project.dirty &&
      serverReadyProjectId === project.id
    ) {
      setSaveStatus((status) => (status === 'saving' ? status : 'idle'));
      coordinator?.scheduleEdit();
    } else {
      coordinator?.cancel();
    }
  }, [
    autosaveRetryToken,
    projectEditVersion,
    project?.dirty,
    project?.id,
    project?.workspaceMode,
    pushToast,
    serverReadyProjectId,
  ]);

  useEffect(
    () => () => {
      autosaveCoordinatorRef.current?.dispose();
    },
    [],
  );

  const offlineRetryProjectId = project?.id;
  const offlineRetryProjectDirty = project?.dirty;
  const offlineRetryWorkspaceMode = project?.workspaceMode;
  useEffect(() => {
    if (
      !offlineRetryProjectId ||
      offlineRetryWorkspaceMode !== 'local-server' ||
      saveStatus !== 'offline'
    )
      return;
    let cancelled = false;
    let retryTimer: number | undefined;
    const checkWorkspace = async () => {
      try {
        await getWorkspaceHealth();
        if (cancelled) return;
        setSaveStatus(offlineRetryProjectDirty ? 'idle' : 'saved');
        if (offlineRetryProjectDirty) setAutosaveRetryToken((token) => token + 1);
      } catch {
        if (!cancelled) retryTimer = window.setTimeout(checkWorkspace, 10_000);
      }
    };
    void checkWorkspace();
    return () => {
      cancelled = true;
      if (retryTimer !== undefined) window.clearTimeout(retryTimer);
    };
  }, [offlineRetryProjectDirty, offlineRetryProjectId, offlineRetryWorkspaceMode, saveStatus]);

  function getProjectSnapshot(options: { refreshThumbnail?: boolean } = {}): Project | undefined {
    const latestProject = useProjectStore.getState().getCurrentProject();
    const snapshotProject = latestProject?.id === projectId ? latestProject : project;
    if (!snapshotProject) return undefined;
    return {
      ...snapshotProject,
      thumbnail:
        options.refreshThumbnail === false
          ? snapshotProject.thumbnail
          : (getStandardProjectThumbnailDataUrl() ?? snapshotProject.thumbnail),
      objects: useSceneStore.getState().objects,
      layers: useLayerStore.getState().layers,
      generations: useGenerationStore
        .getState()
        .generations.filter((generation) => generationBelongsToProject(generation, projectId)),
      captures: snapshotProject.captures,
      bakedTextures: snapshotProject.bakedTextures,
      references: useReferenceStore.getState().references,
      updatedAt: new Date().toISOString(),
    };
  }

  function getProjectSaveRequest(
    options: { refreshThumbnail?: boolean } = {},
  ): ProjectSaveRequest | undefined {
    // Capture the edit version only after delayed layer visibility/paint state
    // has been promoted to the project dirty/version state.
    flushProjectLayerSyncRef.current();
    const snapshot = getProjectSnapshot(options);
    if (!snapshot) return undefined;
    return {
      snapshot,
      editVersion: useProjectStore.getState().getProjectEditVersion(snapshot.id),
    };
  }

  function getViewportThumbnailDataUrl(
    options: {
      camera?: SerializedCamera;
      width?: number;
      height?: number;
      cropVisibleContent?: boolean;
      visibleContentFill?: number;
      matchCameraToRenderAspect?: boolean;
      imageFit?: 'cover' | 'contain';
      preserveViewportComposition?: boolean;
    } = {},
  ) {
    const viewportRuntime = useSceneStore.getState().viewport;
    if (!viewportRuntime) return undefined;
    const canvas = viewportRuntime.gl.domElement;
    if (!canvas || canvas.width === 0 || canvas.height === 0) return undefined;
    const hiddenHelpers: Array<{ object: THREE.Object3D; visible: boolean }> = [];
    const previousCamera = getCurrentCameraSnapshot();
    const previousTarget = viewportRuntime.controls?.target.clone();
    const previousBackground = viewportRuntime.scene.background;
    const previousClearColor = new THREE.Color();
    viewportRuntime.gl.getClearColor(previousClearColor);
    const previousClearAlpha = viewportRuntime.gl.getClearAlpha();
    const renderCamera = options.matchCameraToRenderAspect
      ? options.camera?.type === 'perspective'
        ? new THREE.PerspectiveCamera(
            options.camera.fov ?? 45,
            options.width && options.height
              ? options.width / options.height
              : options.camera.aspect,
            options.camera.near,
            options.camera.far,
          )
        : options.camera?.type === 'orthographic' &&
            !(viewportRuntime.camera instanceof THREE.OrthographicCamera)
          ? new THREE.OrthographicCamera(-1, 1, 1, -1, options.camera.near, options.camera.far)
          : viewportRuntime.camera.clone()
      : viewportRuntime.camera;
    let restoreRenderSize: (() => void) | undefined;
    try {
      if (options.width && options.height && !options.preserveViewportComposition)
        restoreRenderSize = prepareViewportRenderSize(options.width, options.height);
      if (options.camera) {
        applySerializedCamera(renderCamera, options.camera);
        if (options.camera.matrixWorld?.length === 16) {
          renderCamera.matrixWorld.fromArray(options.camera.matrixWorld);
          renderCamera.matrixWorld.decompose(
            renderCamera.position,
            renderCamera.quaternion,
            renderCamera.scale,
          );
          renderCamera.matrixWorldInverse.copy(renderCamera.matrixWorld).invert();
        }
        if (options.camera.projectionMatrix?.length === 16 && !options.matchCameraToRenderAspect) {
          renderCamera.projectionMatrix.fromArray(options.camera.projectionMatrix);
          renderCamera.projectionMatrixInverse.copy(renderCamera.projectionMatrix).invert();
        }
        renderCamera.updateMatrixWorld(true);
      }
      if (options.matchCameraToRenderAspect && options.width && options.height) {
        matchCameraProjectionToRenderAspect(
          renderCamera,
          options.width / options.height,
          options.camera?.projectionMatrix ?? previousCamera?.projectionMatrix,
        );
      }
      viewportRuntime.scene.traverse((object) => {
        if (
          !object.userData.liclickViewportHelper &&
          !object.userData.liclickPaintOverlay &&
          !object.userData.liclickSelectionGlow
        ) {
          return;
        }
        hiddenHelpers.push({ object, visible: object.visible });
        object.visible = false;
      });
      viewportRuntime.scene.background = null;
      viewportRuntime.gl.setClearColor(0x000000, 0);
      viewportRuntime.gl.render(viewportRuntime.scene, renderCamera);
      const thumbnailCanvas = document.createElement('canvas');
      thumbnailCanvas.width = options.width ?? 640;
      thumbnailCanvas.height = options.height ?? 420;
      const context = thumbnailCanvas.getContext('2d', { willReadFrequently: true });
      if (!context) return undefined;

      context.imageSmoothingEnabled = true;
      context.imageSmoothingQuality = 'high';
      if (options.imageFit === 'contain') {
        const drawRect = getContainedImageDrawRect(
          canvas.width,
          canvas.height,
          thumbnailCanvas.width,
          thumbnailCanvas.height,
        );
        context.drawImage(
          canvas,
          0,
          0,
          canvas.width,
          canvas.height,
          drawRect.x,
          drawRect.y,
          drawRect.width,
          drawRect.height,
        );
      } else {
        const sourceAspect = canvas.width / canvas.height;
        const targetAspect = thumbnailCanvas.width / thumbnailCanvas.height;
        let sourceX = 0;
        let sourceY = 0;
        let sourceWidth = canvas.width;
        let sourceHeight = canvas.height;
        if (sourceAspect > targetAspect) {
          sourceWidth = Math.round(canvas.height * targetAspect);
          sourceX = Math.round((canvas.width - sourceWidth) / 2);
        } else if (sourceAspect < targetAspect) {
          sourceHeight = Math.round(canvas.width / targetAspect);
          sourceY = Math.round((canvas.height - sourceHeight) / 2);
        }

        context.drawImage(
          canvas,
          sourceX,
          sourceY,
          sourceWidth,
          sourceHeight,
          0,
          0,
          thumbnailCanvas.width,
          thumbnailCanvas.height,
        );
      }
      if (options.camera) {
        const sample = context.getImageData(
          0,
          0,
          thumbnailCanvas.width,
          thumbnailCanvas.height,
        ).data;
        let visibleSamples = 0;
        const stride = Math.max(4, Math.floor(sample.length / 4000 / 4) * 4);
        for (let offset = 0; offset < sample.length; offset += stride) {
          if (sample[offset + 3] > 8) visibleSamples += 1;
          if (visibleSamples > 16) break;
        }
        if (visibleSamples <= 16) return undefined;
      }
      const contentCanvas = options.cropVisibleContent
        ? cropThumbnailToVisibleContent(thumbnailCanvas, options.visibleContentFill)
        : thumbnailCanvas;
      const outputCanvas = composeThumbnailBackground(contentCanvas);
      return outputCanvas.toDataURL('image/png');
    } catch (error) {
      console.warn('[Liclick 3D Texture] Project thumbnail capture failed:', error);
      return undefined;
    } finally {
      for (const { object, visible } of hiddenHelpers) {
        object.visible = visible;
      }
      viewportRuntime.scene.background = previousBackground;
      viewportRuntime.gl.setClearColor(previousClearColor, previousClearAlpha);
      restoreRenderSize?.();
      if (previousCamera) {
        applySerializedCamera(viewportRuntime.camera, previousCamera);
        if (previousCamera.projectionMatrix?.length === 16) {
          viewportRuntime.camera.projectionMatrix.fromArray(previousCamera.projectionMatrix);
          viewportRuntime.camera.projectionMatrixInverse
            .copy(viewportRuntime.camera.projectionMatrix)
            .invert();
        }
        viewportRuntime.controls?.target.copy(
          previousTarget ?? new THREE.Vector3(...previousCamera.target),
        );
        viewportRuntime.controls?.update();
      }
      viewportRuntime.gl.render(viewportRuntime.scene, viewportRuntime.camera);
    }
  }

  function getStandardProjectThumbnailDataUrl() {
    const sceneState = useSceneStore.getState();
    const models = getProjectThumbnailCaptureModels(sceneState.importedModels);
    const viewportRuntime = sceneState.viewport;
    if (!viewportRuntime || models.length === 0) return getViewportThumbnailDataUrl();

    const framing = getProjectThumbnailFraming(
      models.map((model) => getBoundingBoxForObject(model.group)),
    );
    if (!framing) return getViewportThumbnailDataUrl();
    const captureStartedAt = performance.now();
    document.body.dataset.projectThumbnailCaptureCount = String(
      Number(document.body.dataset.projectThumbnailCaptureCount ?? '0') + 1,
    );
    document.body.dataset.projectThumbnailCapturePhase =
      document.body.dataset.perfViewportStressPhase ?? 'explicit';

    const cameraFrame = getFrontProjectThumbnailCameraFrame(framing.bounds);
    const camera = new THREE.PerspectiveCamera(
      cameraFrame.fov,
      cameraFrame.aspect,
      cameraFrame.near,
      cameraFrame.far,
    );
    const target = new THREE.Vector3(...cameraFrame.target);
    camera.position.fromArray(cameraFrame.position);
    camera.up.set(0, 1, 0);
    camera.lookAt(target);
    camera.updateProjectionMatrix();
    camera.updateMatrixWorld(true);

    const originalModelStates = models.map((model) => ({
      group: model.group,
      parent: model.group.parent,
      siblingIndex: model.group.parent?.children.indexOf(model.group) ?? -1,
      position: model.group.position.clone(),
      quaternion: model.group.quaternion.clone(),
      scale: model.group.scale.clone(),
      visible: model.group.visible,
    }));
    let restoreNeutralMaterials: () => void = () => undefined;

    return withProjectThumbnailPbrMode(sceneState.displayMode, sceneState.setDisplayMode, () => {
      try {
        for (const model of models) {
          if (!viewportRuntime.scene.getObjectById(model.group.id)) {
            viewportRuntime.scene.attach(model.group);
          }
          model.group.visible = true;
          model.group.updateMatrixWorld(true);
          syncProjectedLayerMaterialProjection(model.group);
        }
        restoreNeutralMaterials = neutralizeUntexturedThumbnailMaterials(
          models.map((model) => model.group),
        );

        return getViewportThumbnailDataUrl({
          ...frontProjectThumbnailCapture,
          camera: serializeCamera(camera, cameraFrame.aspect, target),
        });
      } finally {
        restoreNeutralMaterials();
        for (const state of originalModelStates) {
          if (state.group.parent !== state.parent) {
            state.group.removeFromParent();
            if (state.parent) {
              state.parent.add(state.group);
              if (state.siblingIndex >= 0) {
                const currentIndex = state.parent.children.indexOf(state.group);
                state.parent.children.splice(currentIndex, 1);
                state.parent.children.splice(
                  Math.min(state.siblingIndex, state.parent.children.length),
                  0,
                  state.group,
                );
              }
            }
          }
          state.group.position.copy(state.position);
          state.group.quaternion.copy(state.quaternion);
          state.group.scale.copy(state.scale);
          state.group.visible = state.visible;
          state.group.updateMatrixWorld(true);
          syncProjectedLayerMaterialProjection(state.group);
        }
        viewportRuntime.gl.render(viewportRuntime.scene, viewportRuntime.camera);
        document.body.dataset.projectThumbnailCaptureDurationMs = (
          performance.now() - captureStartedAt
        ).toFixed(1);
      }
    });
  }

  const getCurrentCameraSnapshot = useCallback(() => {
    const viewportRuntime = useSceneStore.getState().viewport;
    if (!viewportRuntime) return undefined;
    const camera = viewportRuntime.camera;
    camera.updateMatrixWorld(true);
    const target = viewportRuntime.controls?.target ?? new THREE.Vector3();
    const cameraType: SerializedCamera['type'] =
      camera instanceof THREE.OrthographicCamera ? 'orthographic' : 'perspective';
    const near =
      camera instanceof THREE.PerspectiveCamera || camera instanceof THREE.OrthographicCamera
        ? camera.near
        : 0.1;
    const far =
      camera instanceof THREE.PerspectiveCamera || camera instanceof THREE.OrthographicCamera
        ? camera.far
        : 1000;
    const zoom =
      camera instanceof THREE.PerspectiveCamera || camera instanceof THREE.OrthographicCamera
        ? camera.zoom
        : 1;
    return {
      type: cameraType,
      projection: cameraType,
      position: camera.position.toArray() as [number, number, number],
      quaternion: camera.quaternion.toArray() as [number, number, number, number],
      target: target.toArray() as [number, number, number],
      near,
      far,
      fov: camera instanceof THREE.PerspectiveCamera ? camera.fov : undefined,
      zoom,
      projectionMatrix: camera.projectionMatrix.toArray(),
      matrixWorld: camera.matrixWorld.toArray(),
      viewMatrix: camera.matrixWorldInverse.toArray(),
      aspect: camera instanceof THREE.PerspectiveCamera ? camera.aspect : 1,
    };
  }, []);

  const prepareViewportRenderSize = useCallback((width: number, height: number) => {
    const viewportRuntime = useSceneStore.getState().viewport;
    if (!viewportRuntime) return undefined;
    const renderer = viewportRuntime.gl;
    const camera = viewportRuntime.camera;
    const previousPixelRatio = renderer.getPixelRatio();
    const previousSize = renderer.getSize(new THREE.Vector2());
    const previousViewport = renderer.getViewport(new THREE.Vector4());
    const previousScissor = renderer.getScissor(new THREE.Vector4());
    const previousScissorTest = renderer.getScissorTest();
    const previousAspect = camera instanceof THREE.PerspectiveCamera ? camera.aspect : undefined;

    renderer.setPixelRatio(1);
    renderer.setSize(width, height, false);
    renderer.setViewport(0, 0, width, height);
    renderer.setScissorTest(false);
    if (camera instanceof THREE.PerspectiveCamera) {
      camera.aspect = width / height;
      camera.updateProjectionMatrix();
    }

    return () => {
      renderer.setPixelRatio(previousPixelRatio);
      renderer.setSize(previousSize.x, previousSize.y, false);
      renderer.setViewport(previousViewport);
      renderer.setScissor(previousScissor);
      renderer.setScissorTest(previousScissorTest);
      if (camera instanceof THREE.PerspectiveCamera && previousAspect !== undefined) {
        camera.aspect = previousAspect;
        camera.updateProjectionMatrix();
      }
    };
  }, []);

  async function referenceIdsToBlobs(referenceIds: string[]) {
    const selected = references.filter((reference) => referenceIds.includes(reference.id));
    return Promise.all(
      selected.map(async (reference) => {
        const response = await fetch(reference.url, { credentials: 'omit' });
        if (!response.ok) throw new Error(`Could not load reference image: ${response.status}`);
        return response.blob();
      }),
    );
  }

  async function imageDataToDataUrl(imageData: ImageData) {
    return blobToDataUrl(await imageDataToBlob(imageData));
  }

  function ensureMaskContent(mask: MaskBitmap) {
    return mask.data.some((value) => value > 0);
  }

  const persistLayerImage = useCallback(
    async (
      imageData: ImageData,
      filename: string,
      options: { preserveTransparentRgb?: boolean } = {},
    ) => {
      const blob = options.preserveTransparentRgb
        ? await encodeRgbaPngBlob(imageData.width, imageData.height, imageData.data)
        : await imageDataToBlob(imageData);
      if (project?.workspaceMode === 'local-server') {
        const saved = await saveBlobAsset({
          projectId: project.id,
          category: 'layers',
          blob,
          filename,
        });
        return saved.asset.url;
      }
      return blobToDataUrl(blob);
    },
    [project],
  );

  // Do not render synchronous 2048² project thumbnails from background edit
  // timers. Those callbacks changed the live camera, rendered the full scene,
  // read it back and PNG-encoded it on the UI thread; one callback measured
  // 133 ms during otherwise frame-perfect viewport stress. Final-quality
  // thumbnails are still generated at explicit save/navigation boundaries.

  function getImageSize(url: string) {
    return new Promise<{ width: number; height: number }>((resolve) => {
      const image = new window.Image();
      image.onload = () => resolve({ width: image.naturalWidth, height: image.naturalHeight });
      image.onerror = () => resolve({ width: 0, height: 0 });
      image.src = url;
    });
  }

  function getObjectFileName(object: SceneObject) {
    const sourcePath = object.sourcePath?.split('?')[0].split('#')[0];
    const fromPath = sourcePath?.split('/').pop();
    const supportedExtension = /\.(?:glb|gltf|fbx|obj)$/i;
    if (fromPath && supportedExtension.test(fromPath)) return fromPath;
    if (supportedExtension.test(object.name)) return object.name;
    if (['glb', 'gltf', 'fbx', 'obj'].includes(object.format)) {
      return `${fromPath || object.name}.${object.format}`;
    }
    return fromPath || object.name;
  }

  function getProjectHydrationVersion(projectToHydrate: Project) {
    return [
      projectToHydrate.id,
      projectToHydrate.updatedAt,
      projectToHydrate.objects.length,
      projectToHydrate.layers.length,
      projectToHydrate.generations.length,
      projectToHydrate.references.length,
    ].join(':');
  }

  function hydrateProjectStores(projectToHydrate: Project) {
    const hydrationVersion = getProjectHydrationVersion(projectToHydrate);
    if (hydratedProjectVersionRef.current === hydrationVersion) return;
    hydratedProjectVersionRef.current = hydrationVersion;
    skipProjectStoreSyncRef.current.layers = true;
    skipProjectStoreSyncRef.current.generations = true;
    skipProjectStoreSyncRef.current.references = true;
    setObjects(
      projectToHydrate.objects.filter((object) => object.format !== 'primitive'),
      projectToHydrate.activeObjectId,
    );
    const normalizedLocalRepaintLayers = normalizeLocalRepaintObjectBindings({
      layers: projectToHydrate.layers,
      generations: projectToHydrate.generations,
      captures: projectToHydrate.captures,
    }).layers;
    setLayers(normalizedLocalRepaintLayers);
    const visibleTextureLayers = normalizedLocalRepaintLayers.filter(
      (layer) => layer.visible && Boolean(layer.imageUrl),
    );
    document.body.dataset.textureRestoreHydrated = '1';
    document.body.dataset.textureRestoreHydratedMs = performance.now().toFixed(1);
    document.body.dataset.textureRestoreExpectedLayers = String(visibleTextureLayers.length);
    document.body.dataset.textureRestoreExpectedUvLayers = String(
      visibleTextureLayers.filter((layer) => layer.type === 'uv').length,
    );
    document.body.dataset.textureRestoreExpectedProjectedLayers = String(
      visibleTextureLayers.filter((layer) => layer.type === 'projected').length,
    );
    document.body.dataset.textureRestoreExpectedLocalRepaintLayers = String(
      visibleTextureLayers.filter(
        (layer) =>
          isLocalRepaintLayer(layer) ||
          Boolean(layer.localRepaintSourceUrl || layer.localRepaintMaskUrl),
      ).length,
    );
    // Start UV decode as soon as project JSON arrives, in parallel with model
    // download/parse. SceneRoot consumes the same shared promises and textures,
    // so this is real work pulled forward rather than a duplicate preload.
    void prewarmPreviewTextures(
      visibleTextureLayers
        .filter((layer) => layer.type === 'uv')
        .flatMap((layer) => (layer.imageUrl ? [layer.imageUrl] : [])),
      { maxSize: 512 },
    );
    const projectedPrewarmObjectId =
      projectToHydrate.activeObjectId ?? projectToHydrate.objects[0]?.id;
    const projectedPrewarmLayers = normalizedLocalRepaintLayers.filter(
      (layer) =>
        layer.type === 'projected' &&
        Boolean(layer.imageUrl) &&
        (!layer.objectId || layer.objectId === projectedPrewarmObjectId),
    );
    const projectedPrewarmStartedAt = performance.now();
    void prewarmProjectedLayerTextureSources(projectedPrewarmLayers).then(() => {
      document.body.dataset.textureRestoreProjectedSourcePrewarmCount = String(
        projectedPrewarmLayers.length,
      );
      document.body.dataset.textureRestoreProjectedSourcePrewarmMs = (
        performance.now() - projectedPrewarmStartedAt
      ).toFixed(1);
    });
    setGenerations(projectToHydrate.generations, projectToHydrate.id);
    const recoveredProjectGenerations = useGenerationStore
      .getState()
      .generations.filter((generation) =>
        generationBelongsToProject(generation, projectToHydrate.id),
      );
    const generationStateSignature = (items: Generation[]) =>
      JSON.stringify(
        items.map((generation) => ({
          id: generation.id,
          status: generation.status,
          resultUrl: generation.resultUrl,
          captureId: generation.captureId,
          clientGenerationId: generation.metadata.clientGenerationId,
          serverJobId: generation.metadata.serverJobId,
          interrupted: generation.metadata.interrupted,
        })),
      );
    if (
      generationStateSignature(recoveredProjectGenerations) !==
      generationStateSignature(projectToHydrate.generations)
    ) {
      // Persist recovery immediately in the in-memory project. The normal
      // autosave that starts after hydration then removes the zombie task from
      // the workspace server as well, so later restarts stay unlocked.
      setProjectGenerationsById(projectToHydrate.id, recoveredProjectGenerations);
    }
    setReferences(projectToHydrate.references);
    void restoreProjectModel(projectToHydrate).then(() => {
      if (restoredHistoryProjectIdRef.current === projectToHydrate.id) return;
      restorePersistedHistory(projectToHydrate.id);
      restoredHistoryProjectIdRef.current = projectToHydrate.id;
    });
  }

  function applySavedObjectToLoadedModel(
    loaded: Awaited<ReturnType<typeof loadModelFromUrl>>,
    object: SceneObject,
  ) {
    loaded.root.name = object.name;
    loaded.root.userData.liclickObjectId = object.id;
    loaded.root.traverse((child) => {
      child.userData.liclickObjectId = object.id;
    });
    loaded.root.position.set(...object.transform.position);
    loaded.root.rotation.set(...object.transform.rotation);
    loaded.root.scale.set(...object.transform.scale);
    loaded.root.updateMatrixWorld(true);
    return {
      ...loaded.result,
      objectId: object.id,
      name: object.name,
      sourceFileName: getObjectFileName(object),
      objectUrl: object.sourcePath,
      format: loaded.result.format,
      group: loaded.root,
      materialSlots: object.materialSlots.map((slot) => slot.name),
      uvSets: object.uvSets,
      boundingBox: object.boundingBox ?? loaded.result.boundingBox,
      originalBoundingBox: object.originalBoundingBox ?? loaded.result.originalBoundingBox,
      importNormalizationTransform:
        object.importNormalizationTransform ?? loaded.result.importNormalizationTransform,
      childMeshCount: object.childMeshCount ?? loaded.result.childMeshCount,
      warnings: object.warnings ?? loaded.result.warnings,
    };
  }

  function isPersistableRemoteAssetUrl(url: string) {
    if (isTrustedGenerationWorkspaceAssetUrl(url)) return true;
    try {
      const parsed = new URL(url);
      return (
        parsed.protocol === 'https:' &&
        new Set([
          'ai-assets.lilithgames.com',
          'tsh-aiteam-prod-all.oss-accelerate.aliyuncs.com',
        ]).has(parsed.hostname)
      );
    } catch {
      return false;
    }
  }

  async function restoreProjectModel(projectToRestore: Project) {
    const objects = projectToRestore.objects.filter(
      (item) => item.format !== 'primitive' && item.sourcePath,
    );
    if (objects.length === 0) {
      modelRestoreRequestRef.current += 1;
      clearImportedModel();
      return;
    }
    const modelKey = `${projectToRestore.id}:${objects.map((object) => `${object.id}:${object.sourcePath}`).join('|')}`;
    if (restoredModelKeyRef.current === modelKey) return;
    restoredModelKeyRef.current = modelKey;
    const restorableObjects = objects.filter(
      (object) => object.sourcePath && /^(https?:|blob:|data:)/.test(object.sourcePath),
    );
    const skippedObjects = objects.filter(
      (object) => !object.sourcePath || !/^(https?:|blob:|data:)/.test(object.sourcePath),
    );
    if (skippedObjects.length > 0) {
      console.warn(
        '[Liclick 3D Texture] Some project models were skipped during background restore:',
        skippedObjects.map((object) => object.name),
      );
    }
    if (restorableObjects.length === 0) return;
    const reusableModels = getReusableProjectModels(
      restorableObjects,
      useSceneStore.getState().importedModels,
    );
    if (reusableModels) {
      const activeObjectId = projectToRestore.activeObjectId ?? restorableObjects[0]?.id;
      reusableModels.forEach((model) => {
        model.group.userData.liclickProjectId = projectToRestore.id;
      });
      restoreImportedModels(reusableModels, activeObjectId);
      if (reusableModels.some((model) => model.restoreStage === 'full')) {
        document.body.dataset.textureRestoreModelFull = '1';
        document.body.dataset.textureRestoreModelFullMs = performance.now().toFixed(1);
      }
      document.body.dataset.textureRestoreModelReuse = '1';
      return;
    }
    document.body.dataset.textureRestoreModelReuse = '0';
    const restoreRequest = ++modelRestoreRequestRef.current;
    const activeObjectId = projectToRestore.activeObjectId ?? restorableObjects[0]?.id;
    const prioritizedObjects = activeObjectId
      ? [
          ...restorableObjects.filter((object) => object.id === activeObjectId),
          ...restorableObjects.filter((object) => object.id !== activeObjectId),
        ]
      : restorableObjects;
    const sourcePrefetchByObjectId = startProjectModelSourcePrefetch(
      prioritizedObjects,
      getObjectFileName,
    );
    const restoredModelByObjectId = new Map<string, ModelLoadResult>(
      restorableObjects.map((object) => [object.id, createProjectModelBoundsPlaceholder(object)]),
    );
    const publishRestoreProgress = () => {
      if (restoreRequest !== modelRestoreRequestRef.current) return;
      restoreImportedModels(
        restorableObjects.flatMap((object) => {
          const model = restoredModelByObjectId.get(object.id);
          return model ? [model] : [];
        }),
        activeObjectId,
      );
    };
    publishRestoreProgress();

    async function loadRestoredModel(object: SceneObject) {
      try {
        const sourceBuffer = await sourcePrefetchByObjectId.get(object.id);
        // Geometry is the first meaningful viewport content after a hard
        // refresh. Give React one paint for the editor chrome, then parse it
        // immediately; the previous 800 ms idle gate left a visibly empty
        // viewport before doing the same unavoidable parse work. Texture
        // decoding, shader warmup and secondary models remain idle-queued.
        await waitForBrowserPaint();
        if (restoreRequest !== modelRestoreRequestRef.current) {
          return { object, cancelled: true as const };
        }
        const loaded = await loadModelFromUrl({
          sourceUrl: object.sourcePath!,
          fileName: getObjectFileName(object),
          sourceBuffer,
          normalizeOptions: {
            normalize: object.importNormalizationTransform?.normalized ?? true,
            ground: object.importNormalizationTransform?.grounded ?? true,
            targetMaxDimension: object.importNormalizationTransform?.targetMaxDimension ?? 3,
          },
        });
        loaded.root.userData.liclickProjectId = projectToRestore.id;
        return {
          object,
          model: prepareProjectRestoreOutline({
            ...applySavedObjectToLoadedModel(loaded, object),
            // Always admit parsed geometry through the lightweight outline
            // stage first. Publishing the active FBX with its original material
            // stack made Chromium upload/compile those temporary assets in the
            // same frame that the exact 4K UV became ready (measured 500ms+).
            // The final textured stage is still atomic and pixel-identical; the
            // queue below waits for its exact UV upload before flipping stages.
            restoreStage: 'outline' as const,
          }),
        };
      } catch (error) {
        return { object, error };
      }
    }

    const allResults: Array<Awaited<ReturnType<typeof loadRestoredModel>>> = [];
    // Model downloads run concurrently, but parsing is admitted one model at a
    // time. Each parsed model replaces its bounds with a cached 512px material
    // proxy. Exact textures upgrade independently after the full scene becomes
    // usable, while selecting an object immediately promotes that object first.
    for (const object of prioritizedObjects) {
      if (restoreRequest !== modelRestoreRequestRef.current) return;
      const result = await loadRestoredModel(object);
      if (restoreRequest !== modelRestoreRequestRef.current) return;
      if ('cancelled' in result) return;
      allResults.push(result);
      const placeholder = restoredModelByObjectId.get(result.object.id);
      if (!result.model) {
        if (placeholder) {
          placeholder.group.userData.liclickRestoreFailed = true;
          restoredModelByObjectId.set(result.object.id, {
            ...placeholder,
            warnings: [...placeholder.warnings, '模型源文件加载失败，已保留场景占位。'],
          });
        }
        publishRestoreProgress();
        continue;
      }
      restoredModelByObjectId.set(result.object.id, {
        ...result.model,
        restoreStage: 'proxy',
      });
      publishRestoreProgress();
      window.requestAnimationFrame(() => disposeProjectModelBoundsPlaceholder(placeholder));
    }
    if (restoreRequest !== modelRestoreRequestRef.current) return;

    const failedResults = allResults.filter((result) => result.error);
    if (failedResults.length > 0) {
      failedResults.forEach((result) => {
        console.error(
          `[Liclick 3D Texture] Restore model failed: ${result.object.name}`,
          result.error,
        );
      });
    }
  }
  restoreProjectModelRef.current = restoreProjectModel;

  useEffect(() => {
    const restoreMissingObjectRuntime = () => {
      const currentProject = useProjectStore.getState().getCurrentProject();
      if (!currentProject || currentProject.id !== projectId) return;
      // Undo normally republishes the retained Three.js group synchronously.
      // Reset the dedupe key only for the fallback path where that runtime
      // instance is no longer available and the durable source must be loaded.
      restoredModelKeyRef.current = undefined;
      void restoreProjectModelRef.current(currentProject);
    };
    window.addEventListener(OBJECT_RUNTIME_RESTORE_REQUEST_EVENT, restoreMissingObjectRuntime);
    return () =>
      window.removeEventListener(OBJECT_RUNTIME_RESTORE_REQUEST_EVENT, restoreMissingObjectRuntime);
  }, [projectId]);

  async function persistAssetUrl(
    projectId: string,
    url: string | undefined,
    category: 'models' | 'references' | 'captures' | 'generations' | 'layers' | 'baked',
    filename: string,
  ) {
    const assetSlotKey = [projectId, category, filename].join('|');
    const cachedAssetUrl = url
      ? persistedProjectAssetBySlot.get(assetSlotKey)?.get(url)
      : undefined;
    if (cachedAssetUrl) return cachedAssetUrl;
    const rememberAsset = (assetUrl: string) =>
      url ? rememberPersistedProjectAsset(assetSlotKey, url, assetUrl) : assetUrl;
    const saveDataUrlWithFallback = async (dataUrl: string) => {
      const preferBlob = dataUrl.length > LARGE_DATA_URL_ASSET_UPLOAD_THRESHOLD;
      const asDataUrl = () => saveDataUrlAsset({ projectId, category, dataUrl, filename });
      const asBlob = () =>
        saveBlobAsset({ projectId, category, blob: dataUrlToBlob(dataUrl), filename });
      try {
        return preferBlob ? await asBlob() : await asDataUrl();
      } catch (firstError) {
        try {
          return preferBlob ? await asDataUrl() : await asBlob();
        } catch (secondError) {
          const firstMessage = firstError instanceof Error ? firstError.message : 'Unknown error';
          const secondMessage =
            secondError instanceof Error ? secondError.message : 'Unknown error';
          throw new Error(`binary/json upload both failed: ${firstMessage}; ${secondMessage}`);
        }
      }
    };
    try {
      if (!url) return url;
      if (isWorkspaceAssetUrl(url)) {
        const resolvedWorkspaceUrl = new URL(url, window.location.href);
        const integratedLoopbackAsset =
          resolvedWorkspaceUrl.origin === window.location.origin &&
          ['127.0.0.1', 'localhost', '::1', '[::1]'].includes(
            resolvedWorkspaceUrl.hostname,
          );
        // The production-shaped 4517 bundle uses cloud aliases, but its
        // same-origin /workspace files are already durable local assets. Do
        // not migrate hundreds of them through upload routes on first save.
        if (
          !isCloudBuild ||
          !isLegacyWorkspaceAssetUrl(url) ||
          integratedLoopbackAsset
        ) {
          return url;
        }
        const result = await saveBlobAsset({
          projectId,
          category,
          blob: await readWorkspaceAssetBlob(url),
          filename,
        });
        return rememberAsset(result.asset.url);
      }
      if (url.startsWith('http')) {
        if (!isPersistableRemoteAssetUrl(url)) return url;
        try {
          const result = await saveRemoteUrlAsset({ projectId, category, url, filename });
          return rememberAsset(result.asset.url);
        } catch (serverDownloadError) {
          // Some managed desktop environments allow the signed image in the
          // browser but block direct Node egress. Download it in the renderer
          // and upload the bytes to the local workspace as a durable fallback.
          try {
            const result = await saveBlobAsset({
              projectId,
              category,
              blob: await urlToBlob(url),
              filename,
            });
            return rememberAsset(result.asset.url);
          } catch (browserDownloadError) {
            const serverMessage =
              serverDownloadError instanceof Error
                ? serverDownloadError.message
                : 'server download failed';
            const browserMessage =
              browserDownloadError instanceof Error
                ? browserDownloadError.message
                : 'browser download failed';
            throw new Error(`${serverMessage}; renderer fallback: ${browserMessage}`);
          }
        }
      }
      if (url.startsWith('blob:')) {
        const blob = getRegisteredObjectUrlBlob(url);
        if (blob) {
          const result = await saveBlobAsset({ projectId, category, blob, filename });
          return rememberAsset(result.asset.url);
        }
      }
      if (!url.startsWith('data:') && !url.startsWith('blob:')) return url;
      const dataUrl = url.startsWith('data:') ? url : await urlToDataUrl(url);
      const result = await saveDataUrlWithFallback(dataUrl);
      return rememberAsset(result.asset.url);
    } catch (error) {
      throw new Error(
        `保存资源失败 ${category}/${filename}: ${error instanceof Error ? error.message : 'Unknown error'}`,
      );
    }
  }

  async function prepareProjectForWorkspaceSave(snapshot: Project) {
    const projectForSave: Project = structuredClone({
      ...snapshot,
      currentMode: useWorkspaceLayoutStore.getState().mode,
      activeObjectId: useSceneStore.getState().selectedObjectId,
      activeLayerId: useLayerStore.getState().activeProjectedLayerId,
      workspaceVersion: snapshot.workspaceVersion ?? '0.6.0',
      workspaceMode: 'local-server',
    });

    const persistOptionalAsset = async (
      url: string | undefined,
      category: 'references' | 'captures' | 'generations' | 'layers' | 'baked',
      filename: string,
      fallback = url,
    ) => {
      try {
        if (url && isLiveProjectedCanvasUrl(url)) {
          const assetSlotKey = [projectForSave.id, category, filename].join('|');
          const cachedSourceAssetUrl = persistedProjectAssetBySlot.get(assetSlotKey)?.get(url);
          const liveState = getLiveProjectedTextureSourceState(url);
          if (!liveState) {
            if (cachedSourceAssetUrl) return cachedSourceAssetUrl;
            throw new Error(
              'The live projected asset was released before it could be persisted.',
            );
          }
          const revisionCacheKey = liveState
            ? [projectForSave.id, category, filename, url, liveState.revision].join('|')
            : undefined;
          const cachedAssetUrl = revisionCacheKey
            ? persistedLiveProjectedAssetByRevision.get(revisionCacheKey)
            : undefined;
          if (cachedAssetUrl) {
            return rememberPersistedProjectAsset(assetSlotKey, url, cachedAssetUrl);
          }
          const blobPromise = getLiveProjectedTextureBlob(url);
          if (!blobPromise) {
            if (cachedSourceAssetUrl) return cachedSourceAssetUrl;
            throw new Error('The live projected asset could not be encoded for persistence.');
          }
          const result = await saveBlobAsset({
            projectId: projectForSave.id,
            category,
            blob: await blobPromise,
            filename,
          });
          if (revisionCacheKey) {
            persistedLiveProjectedAssetByRevision.set(revisionCacheKey, result.asset.url);
            while (persistedLiveProjectedAssetByRevision.size > 256) {
              const oldestKey = persistedLiveProjectedAssetByRevision.keys().next().value as
                | string
                | undefined;
              if (!oldestKey) break;
              persistedLiveProjectedAssetByRevision.delete(oldestKey);
            }
          }
          return rememberPersistedProjectAsset(assetSlotKey, url, result.asset.url);
        }
        return await persistAssetUrl(projectForSave.id, url, category, filename);
      } catch (error) {
        // A runtime registry URL is never a durable project asset. If its
        // backing texture disappeared before encoding, fail this save instead
        // of committing a project revision that cannot be reopened.
        if (url && isLiveProjectedCanvasUrl(url)) throw error;
        console.warn(
          `[Liclick 3D Texture] Skipping unavailable optional asset ${category}/${filename}.`,
          error,
        );
        return fallback;
      }
    };
    const persistenceTasks: Array<() => Promise<void>> = [];
    for (const object of projectForSave.objects) {
      persistenceTasks.push(async () => {
        object.sourcePath = await persistAssetUrl(
          projectForSave.id,
          object.sourcePath,
          'models',
          object.name,
        );
      });
    }
    for (const reference of projectForSave.references) {
      persistenceTasks.push(async () => {
        reference.url =
          (await persistOptionalAsset(reference.url, 'references', reference.name)) ??
          reference.url;
      });
    }
    for (const capture of projectForSave.captures) {
      persistenceTasks.push(async () => {
        capture.colorUrl =
          (await persistOptionalAsset(capture.colorUrl, 'captures', `${capture.id}-color.png`)) ??
          capture.colorUrl;
      });
      persistenceTasks.push(async () => {
        capture.maskUrl =
          (await persistOptionalAsset(capture.maskUrl, 'captures', `${capture.id}-mask.png`)) ??
          capture.maskUrl;
      });
      persistenceTasks.push(async () => {
        capture.depthUrl = await persistOptionalAsset(
          capture.depthUrl,
          'captures',
          `${capture.id}-depth.png`,
        );
      });
      persistenceTasks.push(async () => {
        capture.normalUrl = await persistOptionalAsset(
          capture.normalUrl,
          'captures',
          `${capture.id}-normal.png`,
        );
      });
    }
    for (const generation of projectForSave.generations) {
      persistenceTasks.push(async () => {
        generation.resultUrl =
          (await persistOptionalAsset(
            generation.resultUrl,
            'generations',
            `${generation.id}.png`,
          )) ?? generation.resultUrl;
      });
    }
    for (const layer of projectForSave.layers) {
      // Canonical layer URLs are resolved by the workspace loader and updated by
      // live editing. The dedicated repaint metadata may still be a stale
      // relative/previous-server URL after reopening an older project.
      const persistedImageSource = layer.imageUrl ?? layer.localRepaintSourceUrl;
      const persistedMaskSource = layer.maskUrl ?? layer.localRepaintMaskUrl;
      const persistedLocalRepaintMaskSource = layer.localRepaintMaskUrl;
      persistenceTasks.push(async () => {
        layer.imageUrl =
          (await persistOptionalAsset(persistedImageSource, 'layers', `${layer.id}.png`)) ??
          persistedImageSource;
      });
      persistenceTasks.push(async () => {
        layer.maskUrl = await persistOptionalAsset(
          persistedMaskSource,
          'layers',
          `${layer.id}-mask.png`,
          undefined,
        );
      });
      persistenceTasks.push(async () => {
        layer.localRepaintMaskUrl = await persistOptionalAsset(
          persistedLocalRepaintMaskSource,
          'layers',
          `${layer.id}-local-repaint-authored-mask.png`,
          undefined,
        );
      });
      persistenceTasks.push(async () => {
        layer.depthUrl = await persistOptionalAsset(
          layer.depthUrl,
          'layers',
          `${layer.id}-depth.png`,
          undefined,
        );
      });
      persistenceTasks.push(async () => {
        layer.renderedColorMaskUrl = await persistOptionalAsset(
          layer.renderedColorMaskUrl,
          'layers',
          `${layer.id}-rendered-color-mask.png`,
          undefined,
        );
      });
    }
    for (const bakedTexture of projectForSave.bakedTextures) {
      persistenceTasks.push(async () => {
        bakedTexture.imageUrl =
          (await persistOptionalAsset(bakedTexture.imageUrl, 'baked', `${bakedTexture.id}.png`)) ??
          bakedTexture.imageUrl;
      });
    }
    persistenceTasks.push(async () => {
      projectForSave.thumbnail =
        (await persistOptionalAsset(
          projectForSave.thumbnail,
          'captures',
          'project-thumbnail.png',
        )) ?? projectForSave.thumbnail;
    });

    // Asset contents and filenames are unchanged; only independent I/O is
    // bounded-parallel so a project with many images does not save serially.
    await mapWithConcurrency(persistenceTasks, 3, (task) => task());
    projectForSave.layers.forEach((layer) => {
      if (!layer.localRepaintSourceUrl && !layer.localRepaintMaskUrl) return;
      layer.localRepaintSourceUrl = layer.imageUrl;
    });

    return projectForSave;
  }

  async function performWorkspaceServerSave({ snapshot, editVersion }: ProjectSaveRequest) {
    const projectForSave = await prepareProjectForWorkspaceSave(snapshot);
    // Preserve WorkspaceApiError so callers can distinguish a harmless stale
    // snapshot race from authentication and real persistence failures.
    const result = await saveWorkspaceProject(projectForSave);
    const savedLatestSnapshot = useProjectStore.getState().completeProjectSaveById(
      snapshot.id,
      editVersion,
      {
        workspaceMode: 'local-server',
        workspaceName: result.slug,
        lastSavedAt: result.project.lastSavedAt,
        assetManifest: result.project.assetManifest,
        revision: result.project.revision,
      },
      result.project.thumbnail
        ? {
            thumbnail: withProjectThumbnailVersion(
              result.project.thumbnail,
              result.project.updatedAt,
            ),
          }
        : undefined,
    );
    return { ...result, savedLatestSnapshot };
  }

  function saveToWorkspaceServer(request: ProjectSaveRequest) {
    if (!workspaceSaveExecutorRef.current) {
      workspaceSaveExecutorRef.current = new LatestProjectSaveExecutor((nextRequest) =>
        performWorkspaceServerSave(nextRequest),
      );
    }
    return workspaceSaveExecutorRef.current.enqueue(request);
  }

  async function handleManualSave(showSuccessToast = true) {
    if (manualSaveRunningRef.current) {
      if (!showSuccessToast) pendingImmediateSaveRef.current = true;
      return;
    }
    if (backNavigationPendingRef.current) return;
    const currentProject = useProjectStore.getState().getCurrentProject();
    if (!currentProject || (!isCloudBuild && currentProject.workspaceMode !== 'local-server')) {
      pushToast({
        tone: 'warning',
        title: '当前项目没有连接本地工作区',
        description: '请先从项目主页创建或打开本地项目。',
        dedupeKey: 'manual-save-workspace-unavailable',
      });
      return;
    }
    if (serverReadyProjectId !== currentProject.id) {
      pushToast({
        tone: 'warning',
        title: '项目仍在加载',
        description: '完整的模型、图层和贴图加载完成前不会保存，请稍后重试。',
        dedupeKey: 'manual-save-project-loading',
      });
      return;
    }
    // Saving project state must not wait for a synchronous WebGL readback and
    // PNG encode. Thumbnail refresh remains an explicit navigation/import task.
    const request = getProjectSaveRequest({ refreshThumbnail: false });
    if (!request) return;

    manualSaveRunningRef.current = true;
    autosaveCoordinatorRef.current?.cancel();
    const saveStatusOperation = beginSaveStatusOperation();
    try {
      let result = await saveToWorkspaceServer(request);
      if (!result.savedLatestSnapshot) {
        const latestRequest = getProjectSaveRequest({ refreshThumbnail: false });
        if (latestRequest) result = await saveToWorkspaceServer(latestRequest);
      }
      if (result.savedLatestSnapshot) {
        finishSaveStatusOperation(saveStatusOperation, 'saved');
        if (showSuccessToast)
          pushToast({
            tone: 'success',
            title: '项目已保存',
            description: 'Ctrl+S',
            dedupeKey: 'manual-project-save-success',
          });
      } else {
        finishSaveStatusOperation(saveStatusOperation, 'idle');
        setAutosaveRetryToken((token) => token + 1);
      }
    } catch (error) {
      let reportedError = error;
      const staleSnapshot =
        error instanceof WorkspaceApiError &&
        error.status === 409 &&
        (error.code === 'PROJECT_REVISION_CONFLICT' ||
          error.message.includes('stale project snapshot'));
      if (staleSnapshot) {
        const latestRequest = getProjectSaveRequest({ refreshThumbnail: false });
        if (latestRequest) {
          try {
            const result = await saveToWorkspaceServer(latestRequest);
            finishSaveStatusOperation(
              saveStatusOperation,
              result.savedLatestSnapshot ? 'saved' : 'idle',
            );
            if (!result.savedLatestSnapshot) {
              setAutosaveRetryToken((token) => token + 1);
            }
            return;
          } catch (retryError) {
            const supersededAgain =
              retryError instanceof WorkspaceApiError &&
              retryError.status === 409 &&
              (retryError.code === 'PROJECT_REVISION_CONFLICT' ||
                retryError.message.includes('stale project snapshot'));
            if (supersededAgain) {
              // Another module saved an even newer snapshot while this retry
              // was uploading assets. Keep the editor retryable instead of
              // presenting a false permanent failure; autosave reads all
              // current stores again on its next pass.
              finishSaveStatusOperation(saveStatusOperation, 'idle');
              setAutosaveRetryToken((token) => token + 1);
              return;
            }
            reportedError = retryError;
          }
        }
      }
      finishSaveStatusOperation(saveStatusOperation, 'failed');
      console.error('[Liclick 3D Texture] Manual workspace save failed.', reportedError);
    } finally {
      manualSaveRunningRef.current = false;
      if (pendingImmediateSaveRef.current) {
        pendingImmediateSaveRef.current = false;
        void handleManualSave(false);
      }
    }
  }

  manualSaveHandlerRef.current = () => {
    void handleManualSave();
  };
  immediateSaveHandlerRef.current = () => {
    void handleManualSave(false);
  };

  async function handleRenameProject(nextName: string) {
    if (!project) return;
    const trimmedName = nextName.trim();
    if (!trimmedName || trimmedName === project.name) return;

    if (project.workspaceMode !== 'local-server') {
      updateProjectById(project.id, { name: trimmedName });
      return;
    }

    try {
      const result = await renameWorkspaceProject(project.id, trimmedName, project.revision?.id);
      updateProjectById(project.id, {
        name: result.project.name,
        workspaceName: result.project.workspaceName,
        updatedAt: result.project.updatedAt,
        revision: result.project.revision,
      });
    } catch (error) {
      pushToast({
        tone: 'error',
        title: t('workspaceActionFailed'),
        description: error instanceof Error ? error.message : t('renameProject'),
        dedupeKey: `rename-project:${project.id}`,
      });
      throw error;
    }
  }

  function handleBackToProjects() {
    if (generationConflictLocked) {
      showGenerationConflict('返回项目列表');
      return;
    }
    if (backNavigationPendingRef.current) return;
    const currentProject = useProjectStore.getState().getCurrentProject();
    if (!currentProject || currentProject.workspaceMode !== 'local-server') {
      onBack();
      return;
    }
    if (serverReadyProjectId !== currentProject.id) {
      onBack();
      return;
    }

    backNavigationPendingRef.current = true;
    autosaveCoordinatorRef.current?.cancel();
    const thumbnail = getStandardProjectThumbnailDataUrl();
    if (thumbnail) updateCurrentProject({ thumbnail });
    const request = getProjectSaveRequest();
    if (!request) {
      backNavigationPendingRef.current = false;
      onBack();
      return;
    }

    setSaveStatus('saving');

    // Navigation must never wait for asset uploads. The request keeps running
    // after this screen unmounts, and a second pass captures any state that
    // changed while the first snapshot was being persisted.
    onBack();
    void (async () => {
      try {
        let result = await saveToWorkspaceServer({
          ...request,
          snapshot: {
            ...request.snapshot,
            thumbnail: thumbnail ?? request.snapshot.thumbnail,
          },
        });
        if (!result.savedLatestSnapshot) {
          const latestRequest = getProjectSaveRequest();
          if (latestRequest) result = await saveToWorkspaceServer(latestRequest);
        }
        setSaveStatus(result.savedLatestSnapshot ? 'saved' : 'idle');
      } catch (error) {
        setSaveStatus('failed');
        console.error('[Liclick 3D Texture] Background workspace save failed.', error);
      } finally {
        backNavigationPendingRef.current = false;
      }
    })();
  }

  function getBakeProgressDetail(progress: BakeProgress) {
    const percent = Math.round(progress.progress * 100);
    const triangleDetail =
      progress.totalTriangles && progress.processedTriangles !== undefined
        ? ` · ${progress.processedTriangles}/${progress.totalTriangles} ${t('autoBakeTriangles')}`
        : '';
    const layerDetail =
      progress.layerCount && progress.layerName
        ? ` · ${progress.layerIndex === undefined ? 1 : progress.layerIndex + 1}/${progress.layerCount} ${progress.layerName}`
        : progress.layerName
          ? ` · ${progress.layerName}`
          : '';
    const phaseLabel =
      progress.phase === 'loading-assets'
        ? t('autoBakeLoadingAssets')
        : progress.phase === 'rasterizing'
          ? t('autoBakeRasterizing')
          : progress.phase === 'compositing'
            ? t('autoBakeCompositing')
            : progress.phase === 'encoding'
              ? t('autoBakeEncoding')
              : progress.phase === 'applying'
                ? t('autoBakeApplying')
                : t('autoBakePersisting');
    return `${phaseLabel} ${percent}%${layerDetail}${triangleDetail}`;
  }

  function updateManualBakeProgress(progress: BakeProgress) {
    setManualBakeProgress({
      title: t('autoBake'),
      detail: getBakeProgressDetail(progress),
      progress: progress.progress,
    });
  }

  function updateExportBakeProgress(progress: BakeProgress) {
    setManualBakeProgress({
      title: t('exportPreparingUvTexture'),
      detail: getBakeProgressDetail(progress),
      progress: progress.progress,
    });
  }

  useEffect(() => {
    const api: NonNullable<Window['LiclickUvDebug']> = {
      help: () => [
        'LiclickUvDebug.status()',
        'LiclickUvDebug.useDefault() // production default: GPU UV bake + CPU fallback',
        'LiclickUvDebug.useGpu() // force GPU UV bake for 10 minutes',
        'LiclickUvDebug.useGpu({ ttlMs: 60000 }) // force GPU for 60 seconds',
        'LiclickUvDebug.useCpu() // force CPU golden path for 10 minutes',
        'LiclickUvDebug.useCpu({ ttlMs: 60000 }) // force CPU golden path for 60 seconds',
        'LiclickUvDebug.setVerbose(true) // print CPU/GPU mesh and matrix diagnostics',
        'LiclickUvDebug.setCoverageValidation(true) // enable normal runtime CPU/GPU coverage validation',
        'LiclickUvDebug.setGpuProjectedImageUvFlipY(true) // GPU default: flip projected image/mask/depth sampling Y',
        'LiclickUvDebug.setGpuProjectedImageUvFlipY(false) // debug only: reproduce the old unflipped GPU input sampling',
        'await LiclickUvDebug.compare({ resolution: 512, download: true }) // CPU/GPU/diff PNG + metrics for top visible projected layer',
        'await LiclickUvDebug.compare({ resolution: 1024, allVisible: true, logProgress: true }) // compare the full visible projected stack',
        'await LiclickUvDebug.compare({ resolution: 1024, allVisible: true, eachLayer: true, download: true }) // isolate every projected layer',
        "await LiclickUvDebug.compare({ resolution: 1024, gpuCompositeMode: 'cpu-parity', download: true }) // production default: GPU sampling + CPU golden composition",
        "await LiclickUvDebug.compare({ resolution: 1024, gpuCompositeMode: 'quality-depth', download: true }) // debug legacy GPU max-quality winner mode",
        "await LiclickUvDebug.compare({ resolution: 1024, gpuCompositeMode: 'quality-alpha', download: true }) // test quality as alpha, still order-blended",
        "await LiclickUvDebug.compare({ resolution: 1024, gpuCompositeMode: 'coverage-alpha', download: true }) // reproduce the old GPU coverage/order blend",
        'await LiclickUvDebug.compare({ resolution: 1024, gpuProjectedImageUvFlipY: false, download: true }) // debug only: reproduce old unflipped GPU input sampling',
        'await LiclickUvDebug.compare({ resolution: 1024, gpuInputTextureFlipY: false, download: true }) // reproduce the old bottom-left anchored crop/scale input orientation',
        'await LiclickUvDebug.compare({ resolution: 1024, ignoreMask: true, ignoreDepth: true, enableBackfaceCulling: false, download: true }) // isolate UV/projector math from rejection gates',
        'await LiclickUvDebug.uvGradient({ resolution: 1024, download: true }) // verify UV-space render target scale/crop without projected images',
      ],
      status: getDebugUvBakeStatus,
      useDefault: () => {
        clearDebugUvBakeMethod();
        setDebugUvBakeVerbose(false);
        setDebugGpuCoverageValidation(false);
        setDebugGpuProjectedImageUvFlipY(true);
        const status = getDebugUvBakeStatus();
        console.info('[Liclick UV Debug] Production GPU bake defaults restored.', status);
        return status;
      },
      useCpu: (options = {}) => {
        setDebugUvBakeMethod('cpu', { ttlMs: options.ttlMs ?? 10 * 60 * 1000 });
        setDebugUvBakeVerbose(true);
        const status = getDebugUvBakeStatus();
        console.info('[Liclick UV Debug] CPU golden path override enabled.', status);
        return status;
      },
      useGpu: (options = {}) => {
        setDebugUvBakeMethod('gpu', { ttlMs: options.ttlMs ?? 10 * 60 * 1000 });
        setDebugUvBakeVerbose(true);
        setDebugGpuProjectedImageUvFlipY(true);
        const status = getDebugUvBakeStatus();
        console.info('[Liclick UV Debug] GPU UV bake override enabled.', status);
        return status;
      },
      setVerbose: (enabled = true) => {
        setDebugUvBakeVerbose(enabled);
        const status = getDebugUvBakeStatus();
        console.info('[Liclick UV Debug] Verbose UV bake logs updated.', status);
        return status;
      },
      setCoverageValidation: (enabled = true) => {
        setDebugGpuCoverageValidation(enabled);
        const status = getDebugUvBakeStatus();
        console.info('[Liclick UV Debug] Runtime GPU coverage validation updated.', status);
        return status;
      },
      setGpuProjectedImageUvFlipY: (enabled = true) => {
        setDebugGpuProjectedImageUvFlipY(enabled);
        const status = getDebugUvBakeStatus();
        console.info('[Liclick UV Debug] GPU projected image/mask/depth UV flipY updated.', status);
        return status;
      },
      compare: async (options) => {
        const { debugCompareCpuGpuUvBake } = await import('@/engine/bake/uvBakeDebugCompare');
        return debugCompareCpuGpuUvBake(options ?? {});
      },
      uvGradient: async (options) => {
        const { debugCompareCpuGpuUvGradient } = await import('@/engine/bake/uvBakeDebugCompare');
        return debugCompareCpuGpuUvGradient(options ?? {});
      },
    };
    window.LiclickUvDebug = api;
    console.info('[Liclick UV Debug] Console API ready. Run LiclickUvDebug.help() for commands.');
    return () => {
      if (window.LiclickUvDebug === api) delete window.LiclickUvDebug;
    };
  }, []);

  async function persistManualBakedTexture(textureId: string, imageUrl: string, imageBlob?: Blob) {
    if (!project || project.workspaceMode !== 'local-server') return imageUrl;
    const filename = `${textureId}.png`;
    const result = imageBlob
      ? await saveBlobAsset({ projectId: project.id, category: 'baked', blob: imageBlob, filename })
      : imageUrl.startsWith('http')
        ? await saveRemoteUrlAsset({
            projectId: project.id,
            category: 'baked',
            url: imageUrl,
            filename,
          })
        : await saveDataUrlAsset({
            projectId: project.id,
            category: 'baked',
            dataUrl: imageUrl.startsWith('data:') ? imageUrl : await urlToDataUrl(imageUrl),
            filename,
          });
    return result.asset.url;
  }

  async function handleImportModel(
    file: File,
    resourceFiles: File[] = [],
    onProgress?: (event: ModelImportProgressEvent, detail?: string) => void,
    isCurrentImport: () => boolean = () => true,
  ) {
    try {
      onProgress?.({ phase: 'preparing', phaseProgress: 0 });
      const parsedModel = await loadModelFromFile(
        file,
        {
          normalize: importSettings.normalizeOnImport,
          ground: importSettings.groundOnImport,
          targetMaxDimension: 3,
        },
        resourceFiles,
        (event) => onProgress?.(event),
      );
      try {
        assertModelTriangleLimit(parsedModel.root, TEXTURE_MODEL_TRIANGLE_LIMIT);
      } catch (limitError) {
        disposeRejectedModel(parsedModel.root);
        if (parsedModel.sourceUrl.startsWith('blob:')) URL.revokeObjectURL(parsedModel.sourceUrl);
        throw limitError;
      }
      const loaded = placeImportedModelBesideScene(
        parsedModel,
        useSceneStore.getState().importedModels,
      );
      if (!isCurrentImport()) return false;
      let object = loaded.object;
      onProgress?.({ phase: 'materials' }, t('modelImportMaterials'));
      const importedBaseColorUrl = await getImportedBaseColorTextureUrl(loaded.result.group);
      if (!isCurrentImport()) return false;
      onProgress?.({ phase: 'materials', phaseProgress: 1 }, t('modelImportMaterials'));
      if (project?.workspaceMode === 'local-server') {
        onProgress?.({ phase: 'persisting' }, t('modelImportSavingFile'));
        try {
          const saved = await saveBlobAsset({
            projectId: project.id,
            category: 'models',
            blob: file,
            filename: `${object.id}-${file.name}`,
            onProgress: ({ loadedBytes, totalBytes }) =>
              onProgress?.(
                { phase: 'persisting', loadedBytes, totalBytes },
                t('modelImportSavingFile'),
              ),
          });
          object = { ...object, sourcePath: saved.asset.url };
        } catch (saveError) {
          if (saveError instanceof WorkspaceApiError && saveError.status === 401) {
            pushToast({
              tone: 'warning',
              title: '需要飞书登录',
              description: '模型已临时导入到当前视图，但登录前不能保存到服务器项目。',
              dedupeKey: 'model-import-auth-required',
            });
          } else {
            throw saveError;
          }
        }
      }
      if (!isCurrentImport()) return false;
      onProgress?.({ phase: 'persisting', phaseProgress: 1 }, t('modelImportSavingFile'));
      onProgress?.({ phase: 'registering', phaseProgress: 0.15 }, t('modelImportAddingToScene'));
      setImportedModel(loaded.result, object);
      if (shouldFocusImportedModelAfterImport(useWorkspaceLayoutStore.getState().mode)) {
        focusCameraOrbitOnObjectId(object.id);
      }
      if (importedBaseColorUrl) {
        addUvLayer({
          name: 'Base texture',
          imageUrl: importedBaseColorUrl,
          objectId: object.id,
          role: 'base-color',
        });
      }
      updateCurrentProject({
        objects: useSceneStore.getState().objects,
        layers: useLayerStore.getState().layers,
        activeObjectId: object.id,
      });
      onProgress?.({ phase: 'registering', phaseProgress: 0.55 }, t('modelImportSavingProject'));
      if (project?.workspaceMode === 'local-server') {
        const importedProjectRequest = getProjectSaveRequest({ refreshThumbnail: false });
        if (importedProjectRequest) {
          setSaveStatus('saving');
          try {
            const result = await saveToWorkspaceServer(importedProjectRequest);
            if (result.savedLatestSnapshot) {
              setSaveStatus('saved');
            } else {
              setSaveStatus('idle');
              setAutosaveRetryToken((token) => token + 1);
            }
          } catch (saveError) {
            setSaveStatus('failed');
            pushToast({
              tone: 'warning',
              title: '模型已导入，但工程保存失败',
              description:
                saveError instanceof Error ? saveError.message : '请确认工作区服务在线后再保存。',
              dedupeKey: `model-import-save-failed:${object.id}`,
            });
          }
        }
      }
      if (!isCurrentImport()) return false;
      onProgress?.({ phase: 'registering', phaseProgress: 0.9 }, t('modelImportSavingProject'));
      if (loaded.result.warnings.length > 0) {
        pushToast({
          tone: 'warning',
          title: `${loaded.result.sourceFileName} ${t('modelImportComplete')}`,
          description: loaded.result.warnings[0],
          dedupeKey: `model-import-warning:${object.id}`,
        });
      }
      onProgress?.({ phase: 'complete', phaseProgress: 1 }, t('modelImportComplete'));
      return true;
    } catch (error) {
      if (!isCurrentImport()) return false;
      console.error('[Liclick 3D Texture] Import model failed:', error);
      pushToast({
        tone: 'error',
        title: 'Import failed',
        description: error instanceof Error ? error.message : 'The model could not be loaded.',
      });
      return false;
    }
  }

  async function handleImportModels(files: File[]) {
    if (modelMutationLocked) {
      notifyEditorTaskRunning();
      return;
    }
    const modelFiles = files.filter((file) => /\.(glb|gltf|fbx|obj)$/i.test(file.name));
    const resourceFiles = files.filter((file) => !modelFiles.includes(file));
    if (modelFiles.length === 0 || modelImportRunningRef.current) return;

    const phaseDetails: Record<ModelImportPhase, string> = {
      preparing: t('modelImportPreparing'),
      reading: t('modelImportReading'),
      parsing: t('modelImportParsing'),
      materials: t('modelImportMaterials'),
      persisting: t('modelImportSavingFile'),
      registering: t('modelImportAddingToScene'),
      complete: t('modelImportComplete'),
    };
    const revision = modelImportRevisionRef.current + 1;
    modelImportRevisionRef.current = revision;
    modelImportRunningRef.current = true;
    setModelImportBusy(true);
    window.clearTimeout(modelImportProgressTimerRef.current);
    setModelImportProgress(undefined);

    const isCurrentImport = () => modelImportRevisionRef.current === revision;
    const reportProgress = (
      fileIndex: number,
      file: File,
      event: ModelImportProgressEvent,
      detail = phaseDetails[event.phase],
    ) => {
      if (!isCurrentImport()) return;
      const nextProgress = getModelImportBatchProgress(fileIndex, modelFiles.length, event);
      setModelImportProgress((current) => ({
        title: event.phase === 'complete' ? t('modelImportComplete') : t('importingModel'),
        detail: `${fileIndex + 1}/${modelFiles.length} · ${file.name} · ${detail}`,
        progress: Math.max(current?.progress ?? 0, nextProgress),
        indeterminate: isModelImportProgressIndeterminate(event),
      }));
    };

    let loadedFileCount = 0;
    try {
      for (const [fileIndex, file] of modelFiles.entries()) {
        if (!isCurrentImport()) break;
        reportProgress(fileIndex, file, { phase: 'preparing', phaseProgress: 0 });
        const loaded = await handleImportModel(
          file,
          resourceFiles,
          (event, detail) => reportProgress(fileIndex, file, event, detail),
          isCurrentImport,
        );
        if (loaded) loadedFileCount += 1;
      }
      if (isCurrentImport() && loadedFileCount > 0) {
        const lastFile = modelFiles[modelFiles.length - 1];
        reportProgress(
          modelFiles.length - 1,
          lastFile,
          { phase: 'complete', phaseProgress: 1 },
          t('modelImportComplete'),
        );
        pushToast({
          tone: loadedFileCount === modelFiles.length ? 'success' : 'warning',
          title: t('modelImportComplete'),
          description:
            modelFiles.length === 1
              ? `${lastFile.name} ${t('modelImportLoadedIntoScene')}`
              : t('modelImportBatchComplete')
                  .replace('{loaded}', String(loadedFileCount))
                  .replace('{total}', String(modelFiles.length)),
          dedupeKey: `model-import-complete:${revision}`,
        });
        modelImportProgressTimerRef.current = window.setTimeout(() => {
          if (modelImportRevisionRef.current === revision) setModelImportProgress(undefined);
        }, 1800);
      }
    } finally {
      modelImportRunningRef.current = false;
      setModelImportBusy(false);
      if (modelInputRef.current) modelInputRef.current.value = '';
    }
  }

  async function handleImportReferenceImages(files: File[], sourceUrls: string[] = []) {
    if (editorTaskRunning) {
      notifyEditorTaskRunning();
      return;
    }
    const imageFiles = files.filter(
      (file) => file.type.startsWith('image/') || /\.(png|jpe?g|webp)$/i.test(file.name),
    );
    if (imageFiles.length === 0 && sourceUrls.length === 0) return;
    try {
      // Start every FileReader while the drop event still owns valid temporary
      // file handles. Reading sequentially can make later virtual files expire.
      const fileResults = await Promise.allSettled(
        imageFiles.map(async (file, index): Promise<ReferenceImage> => {
          const url = await fileToDataUrl(file);
          const size = await getImageSize(url);
          if (!size.width || !size.height) throw new Error(`无法读取图片：${file.name}`);
          return {
            id: createId('reference'),
            name: file.name || `Reference ${index + 1}`,
            url,
            width: size.width,
            height: size.height,
            isPrimary: true,
          };
        }),
      );
      const importedReferences = fileResults.flatMap((result) =>
        result.status === 'fulfilled' ? [result.value] : [],
      );
      const failedFileCount = fileResults.length - importedReferences.length;
      const fallbackLimit = imageFiles.length === 0 ? sourceUrls.length : failedFileCount;
      let recoveredFallbackCount = 0;

      for (const [index, sourceUrl] of sourceUrls.entries()) {
        if (recoveredFallbackCount >= fallbackLimit) break;
        try {
          let url = sourceUrl;
          if (!url.startsWith('data:image/')) {
            try {
              url = await urlToDataUrl(url);
            } catch {
              // A remote image can still be displayed and persisted even when
              // its server does not allow a browser-side CORS fetch.
            }
          }
          const size = await getImageSize(url);
          if (!size.width || !size.height) continue;
          const sourceName = (() => {
            if (sourceUrl.startsWith('data:') || sourceUrl.startsWith('blob:')) return undefined;
            try {
              return decodeURIComponent(new URL(sourceUrl).pathname.split('/').pop() || '');
            } catch {
              return undefined;
            }
          })();
          importedReferences.push({
            id: createId('reference'),
            name: sourceName || `Reference ${imageFiles.length + index + 1}`,
            url,
            width: size.width,
            height: size.height,
            isPrimary: true,
          });
          recoveredFallbackCount += 1;
        } catch {
          // Continue through alternative drag payloads from the same source.
        }
      }

      if (importedReferences.length === 0) {
        const firstFailure = fileResults.find(
          (result): result is PromiseRejectedResult => result.status === 'rejected',
        );
        throw (
          firstFailure?.reason ?? new Error('拖入的图片临时文件已失效，请先保存到本地后重新拖入。')
        );
      }
      setPendingReferenceImport(importedReferences);
      if (failedFileCount > recoveredFallbackCount) {
        pushToast({
          tone: 'warning',
          title: '部分参考图未能导入',
          description: `已导入 ${importedReferences.length} 张，${failedFileCount - recoveredFallbackCount} 张临时文件已失效。`,
        });
      }
    } catch (error) {
      console.error('[Liclick 3D Texture] Import references failed:', error);
      pushToast({
        tone: 'error',
        title: '参考图导入失败',
        description: error instanceof Error ? error.message : '图片文件无法读取。',
      });
    }
  }

  function confirmReferenceImageImport(role: ReferenceImportRole) {
    if (!pendingReferenceImport?.length) return;
    if (generationConflictLocked) {
      showGenerationConflict('导入参考图');
      return;
    }
    const classifiedReferences = pendingReferenceImport.map((reference, index) => ({
      ...reference,
      isPrimary: index === 0,
      referenceGroupId: createId('reference-group'),
      referenceRole: role,
      referenceSource: 'uploaded' as const,
    }));
    addReferences(
      classifiedReferences,
      classifiedReferences.length > 1 ? 'clear-all' : 'select-new',
    );
    setSelectedReferences([classifiedReferences[0].id]);
    setProjectReferences(useReferenceStore.getState().references);
    setPendingReferenceImport(undefined);
    window.dispatchEvent(new Event(IMMEDIATE_PROJECT_SAVE_EVENT));
    pushToast({
      tone: 'success',
      title: role === 'single-view' ? '已传入单视图' : '已传入多视图',
      description: `已添加 ${classifiedReferences.length} 张参考图。`,
    });
  }

  async function handleLoadProject(file: File) {
    try {
      const importedProject = await importProjectJson(file);
      loadedProjectIdRef.current = importedProject.id;
      replaceCurrentProject(importedProject);
      setObjects(importedProject.objects, importedProject.activeObjectId);
      setLayers(importedProject.layers);
      setGenerations(importedProject.generations, importedProject.id);
      setReferences(importedProject.references);
      pushToast({
        tone: 'success',
        title: 'Project loaded',
        description: 'Basic metadata, references, captures, generations, and layers were restored.',
      });
    } catch (error) {
      console.error('[Liclick 3D Texture] Load project failed:', error);
      pushToast({
        tone: 'error',
        title: 'Invalid project file',
        description: error instanceof Error ? error.message : 'Could not read this project JSON.',
      });
    } finally {
      if (projectInputRef.current) projectInputRef.current.value = '';
    }
  }

  function getWorkspaceLabel() {
    if (!project) return undefined;
    if (saveStatus === 'saving') return 'Saving...';
    if (saveStatus === 'failed') return 'Save failed';
    if (saveStatus === 'offline') return 'Offline';
    if (project.dirty) return 'Unsaved';
    return 'Saved';
  }

  async function autoMergeUvAndExportBaseColor() {
    if (!project || !importedModel) throw new Error(t('importModelFirst'));
    const objectId = selectedObjectId ?? importedModel.objectId;
    const mergePlan = resolveBakeUvMergePlan(useLayerStore.getState().layers, objectId);
    let colorTextureUrl: string | undefined;

    if (mergePlan.action === 'merge') {
      const mergedLayer = await mergeLayersToUvLayer(
        mergePlan.sourceLayerIds,
        mergePlan.baseUvLayerId,
        {
          objectId,
          suppressErrorToast: true,
          throwOnError: true,
        },
      );
      colorTextureUrl = mergedLayer && 'imageUrl' in mergedLayer ? mergedLayer.imageUrl : undefined;
      if (!colorTextureUrl) throw new Error('UV 合并已取消，未导出颜色贴图。');
    } else if (mergePlan.action === 'reuse') {
      colorTextureUrl = mergePlan.mergedLayer.imageUrl;
    } else {
      colorTextureUrl = currentObjectBaseColor?.imageUrl;
    }

    if (!colorTextureUrl) {
      throw new Error('当前模型没有可合并或导出的颜色图层。');
    }
    const currentProject =
      useProjectStore.getState().projects.find((item) => item.id === project.id) ?? project;
    const { exportTextureUrl } = await import('@/engine/export/exportTexture');
    await exportTextureUrl(currentProject, colorTextureUrl, 'basecolor');
  }

  function handleExportBaseColorDownload() {
    void runExportAction(t('exporting'), autoMergeUvAndExportBaseColor);
  }

  const restoreExistingLocalRepaintSession = useCallback(() => {
    const runtime = useLocalRepaintStore.getState().runtime;
    if (!runtime || runtime.projectId !== projectId || runtime.status === 'idle') return false;
    showLocalRepaint();
    const isReady = runtime.status === 'preview_ready';
    const isSubmitting = runtime.status === 'submitting';
    pushToast({
      tone: runtime.status === 'error' ? 'warning' : 'info',
      title: isReady ? '局部重绘结果已返回' : isSubmitting ? '局部重绘正在生成' : '已恢复局部重绘',
      description: isReady
        ? '已恢复上一次进入局部重绘时的视角和结果，可以预览或应用。'
        : isSubmitting
          ? '当前任务仍在等待莉刻返回，已为你恢复生成界面。'
          : (runtime.error ?? '已恢复上一次局部重绘状态。'),
      dedupeKey: `local-repaint-restore:${runtime.id}:${runtime.status}`,
    });
    return true;
  }, [projectId, pushToast, showLocalRepaint]);

  async function openLayerLocalRepaint(layer: Layer) {
    if (restoreExistingLocalRepaintSession()) return;
    if (layer.type !== 'projected' || !layer.imageUrl) {
      pushToast({
        tone: 'warning',
        title: t('localRepaintUnavailable'),
        description: t('selectProjectedLayerHelp'),
      });
      return;
    }
    try {
      const workingImageData = await urlToImageData(layer.imageUrl);
      openLocalRepaintRuntime({
        id: createId('local-repaint'),
        projectId,
        mode: 'edit_layer_image',
        targetName: layer.name,
        targetLayerId: layer.id,
        cameraState: layer.camera ?? getCurrentCameraSnapshot() ?? undefined,
        workingImageUrl: await imageDataToDataUrl(workingImageData),
        workingImageData,
        objectMask: createFullMask(workingImageData.width, workingImageData.height),
        holeMask: createEmptyMask(workingImageData.width, workingImageData.height),
        status: 'idle',
      });
    } catch (error) {
      pushToast({
        tone: 'error',
        title: t('localRepaintFailed'),
        description: error instanceof Error ? error.message : t('localRepaintFailedHelp'),
      });
    }
  }

  async function persistEditedLayerDataUrl(
    targetLayer: Layer,
    dataUrl: string,
    filename = `${targetLayer.id}.png`,
  ) {
    if (!project || project.workspaceMode !== 'local-server') return dataUrl;
    try {
      const saved = await saveDataUrlAsset({
        projectId: project.id,
        category: 'layers',
        dataUrl,
        filename,
      });
      return saved.asset.url;
    } catch (error) {
      if (error instanceof WorkspaceApiError && error.status === 401) {
        pushToast({
          tone: 'warning',
          title: '需要飞书登录',
          description: '编辑结果已临时应用到当前页面，登录前不能保存到服务器项目。',
          dedupeKey: 'layer-image-edit-auth-required',
        });
        return dataUrl;
      }
      throw error;
    }
  }

  async function replaceLayerImage(layer: Layer, file: File) {
    if (layer.type !== 'projected' && layer.type !== 'uv') return;
    try {
      captureHistory(`替换图层图片：${layer.name}`);
      const dataUrl = await fileToDataUrl(file);
      const imageUrl = await persistEditedLayerDataUrl(layer, dataUrl, `${layer.id}-${file.name}`);
      updateLayerImage(layer.id, imageUrl);
      setProjectLayers(useLayerStore.getState().layers);
      pushToast({
        tone: 'success',
        title: t('layerImageReplaced'),
        description:
          layer.type === 'uv' ? t('imageEditUvAppliedHelp') : t('projectionPreservedHelp'),
      });
    } catch (error) {
      pushToast({
        tone: 'error',
        title: t('replaceLayerImageFailed'),
        description: error instanceof Error ? error.message : t('autoBakeFailedHelp'),
      });
    }
  }

  function holdPhotoshopPreviewProjectSync() {
    if (photoshopProjectSyncHeldRef.current) return;
    suppressProjectLayerSyncRef.current += 1;
    photoshopProjectSyncHeldRef.current = true;
  }

  function releasePhotoshopPreviewProjectSync() {
    if (!photoshopProjectSyncHeldRef.current) return;
    suppressProjectLayerSyncRef.current = Math.max(0, suppressProjectLayerSyncRef.current - 1);
    photoshopProjectSyncHeldRef.current = false;
  }

  function clearPhotoshopEditSession() {
    photoshopEditUnsubscribeRef.current?.();
    photoshopEditUnsubscribeRef.current = undefined;
    photoshopEditSessionRef.current = undefined;
    photoshopEditLayerSnapshotRef.current = undefined;
    photoshopEditRevisionRef.current = 0;
    setPhotoshopEditSession(undefined);
  }

  function receivePhotoshopSession(nextSession: PhotoshopSession) {
    photoshopEditSessionRef.current = nextSession;
    setPhotoshopEditSession(nextSession);
    const snapshot = photoshopEditLayerSnapshotRef.current;
    if (
      !snapshot ||
      !nextSession.latestImageUrl ||
      nextSession.latestRevision <= photoshopEditRevisionRef.current
    ) {
      return;
    }
    photoshopEditRevisionRef.current = nextSession.latestRevision;
    const current = useLayerStore.getState().layers.find((layer) => layer.id === snapshot.id);
    updateLayer(snapshot.id, {
      imageUrl: nextSession.latestImageUrl,
      contentRevision: Math.max((current?.contentRevision ?? 0) + 1, nextSession.latestRevision),
    });
  }

  // Photoshop/DCC launch is intentionally detached from the zero-install browser
  // release. Keep the implementation available for the deferred integration
  // without exposing a local-component action in the production UI.
  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- deferred PS/DCC integration
  async function openLayerImageEdit(layer: Layer) {
    if (photoshopEditSessionRef.current) {
      pushToast({
        tone: 'warning',
        title: 'Photoshop 编辑会话正在运行',
        description: '请先应用或放弃当前 Photoshop 编辑，再打开其他图层。',
        dedupeKey: 'photoshop-session-already-open',
      });
      return;
    }
    if (!project || !layer.imageUrl || (layer.type !== 'projected' && layer.type !== 'uv')) return;
    setPhotoshopEditBusy(true);
    let createdSession: PhotoshopSession | undefined;
    try {
      const registeredBlob = getRegisteredObjectUrlBlob(layer.imageUrl);
      const sourceBlob: Blob =
        registeredBlob ??
        (await fetch(layer.imageUrl)
          .then((response) => {
            if (!response.ok) throw new Error(`无法读取图层图片（${response.status}）。`);
            return response.blob();
          })
          .then((blob) => blob));
      createdSession = await createPhotoshopSession({
        projectId: project.id,
        layerId: layer.id,
        layerName: layer.name,
        layerType: layer.type,
      });
      photoshopEditLayerSnapshotRef.current = { ...layer };
      photoshopEditSessionRef.current = createdSession;
      photoshopEditRevisionRef.current = 0;
      holdPhotoshopPreviewProjectSync();
      setPhotoshopEditSession(createdSession);
      photoshopEditUnsubscribeRef.current = subscribePhotoshopSession(
        createdSession,
        receivePhotoshopSession,
      );
      const uploaded = await uploadPhotoshopSessionSource(createdSession, sourceBlob);
      receivePhotoshopSession(uploaded);
      receivePhotoshopSession(await openPhotoshopSession(uploaded));
    } catch (error) {
      if (createdSession) void closePhotoshopSession(createdSession).catch(() => undefined);
      releasePhotoshopPreviewProjectSync();
      clearPhotoshopEditSession();
      pushToast({
        tone: 'error',
        title: '无法启动 Photoshop 编辑',
        description: error instanceof Error ? error.message : 'Photoshop 本地桥接启动失败。',
      });
    } finally {
      setPhotoshopEditBusy(false);
    }
  }

  async function handlePhotoshopSyncNow() {
    const session = photoshopEditSessionRef.current;
    if (!session) return;
    try {
      receivePhotoshopSession(await syncPhotoshopSession(session));
    } catch (error) {
      pushToast({
        tone: 'error',
        title: 'Photoshop 同步失败',
        description: error instanceof Error ? error.message : '无法请求 Photoshop 导出纹理。',
      });
    }
  }

  async function handlePhotoshopApply() {
    const session = photoshopEditSessionRef.current;
    const snapshot = photoshopEditLayerSnapshotRef.current;
    if (!session?.latestImageUrl || !snapshot || !project) return;
    setPhotoshopEditBusy(true);
    try {
      const response = await fetch(session.latestImageUrl);
      if (!response.ok) throw new Error(`无法读取 Photoshop 同步结果（${response.status}）。`);
      const imageBlob = await response.blob();
      const saved = await saveBlobAsset({
        projectId: project.id,
        category: 'layers',
        blob: imageBlob,
        filename: `${snapshot.id}-photoshop-${session.latestRevision}.png`,
      });
      updateLayer(snapshot.id, snapshot);
      captureHistory(`应用 Photoshop 编辑：${snapshot.name}`);
      releasePhotoshopPreviewProjectSync();
      updateLayer(snapshot.id, {
        imageUrl: saved.asset.url,
        contentRevision: Math.max((snapshot.contentRevision ?? 0) + 1, session.latestRevision),
        needsRebake: snapshot.isBaked ? true : snapshot.needsRebake,
      });
      setProjectLayers(useLayerStore.getState().layers);
      await closePhotoshopSession(session).catch(() => undefined);
      clearPhotoshopEditSession();
      pushToast({
        tone: 'success',
        title: 'Photoshop 纹理已应用',
        description:
          snapshot.type === 'uv' ? t('imageEditUvAppliedHelp') : t('projectionPreservedHelp'),
      });
    } catch (error) {
      pushToast({
        tone: 'error',
        title: '无法应用 Photoshop 纹理',
        description: error instanceof Error ? error.message : '保存 Photoshop 编辑结果失败。',
      });
    } finally {
      setPhotoshopEditBusy(false);
    }
  }

  function handlePhotoshopCancel() {
    const session = photoshopEditSessionRef.current;
    const snapshot = photoshopEditLayerSnapshotRef.current;
    if (snapshot) updateLayer(snapshot.id, snapshot);
    releasePhotoshopPreviewProjectSync();
    if (snapshot) setProjectLayers(useLayerStore.getState().layers);
    if (session) void closePhotoshopSession(session).catch(() => undefined);
    clearPhotoshopEditSession();
  }

  async function handlePhotoshopLaunch() {
    try {
      await launchPhotoshop();
    } catch (error) {
      pushToast({
        tone: 'error',
        title: '无法启动 Photoshop',
        description:
          error instanceof Error ? error.message : '请在启动器高级设置中选择 Photoshop。',
      });
    }
  }

  const completeLocalRepaintRuntime = useCallback(
    async (
      runtime: LocalRepaintRuntime,
      outputImage: Blob,
      raw?: unknown,
    ): Promise<LocalRepaintRuntime> => {
      if (!runtime.roiRect || !runtime.editMask || !runtime.protectMask) {
        throw new Error('局部重绘恢复上下文不完整，请重新生成。');
      }
      const editedImage = await urlToImageData(await blobToDataUrl(outputImage));
      const source = runtime.workingImageData;
      const editedFrame =
        editedImage.width === source.width && editedImage.height === source.height
          ? editedImage
          : resizeImageData(editedImage, source.width, source.height);
      const editedFull = editedFrame;
      const featheredMask = featherMask(
        runtime.editMask,
        getLocalRepaintFeatherRadius(runtime.editMask),
      );
      const composited = compositeUsingMask(source, editedFull, featheredMask);
      const restored = restoreProtectedPixels(source, composited, runtime.protectMask);
      const previewUrl = await imageDataToDataUrl(restored);
      return {
        ...runtime,
        mergedImageData: restored,
        previewUrl,
        providerRaw: raw,
        status: 'preview_ready',
        error: undefined,
        requestId: undefined,
      };
    },
    [],
  );

  async function generateLocalRepaint(input: LocalRepaintGenerateInput) {
    if (!localRepaintRuntime) throw new Error(t('localRepaintUnavailable'));
    const authState = useAuthStore.getState();
    const providerStatus = authState.providerStatus ?? (await authState.refreshProviderStatus());
    const authStrategy = resolveLiclickAuthStrategy(providerStatus);
    if (authStrategy === 'unresolved') {
      throw new Error('无法确认当前登录方式，请刷新页面或重新登录后再试。');
    }
    const source = localRepaintRuntime.workingImageData;
    const editMask =
      input.preparedEditMask ??
      (localRepaintRuntime.mode === 'edit_layer_image'
        ? input.userMask
        : buildEditMask(input.userMask, localRepaintRuntime.holeMask, {
            includeBlankArea: input.includeBlankArea,
            dilationRadius: input.limitToBlankAndSelection ? 0 : 8,
          }));
    if (!ensureMaskContent(editMask)) throw new Error(t('localRepaintMaskMissing'));
    const protectMask =
      input.preparedProtectMask ??
      (input.preserveUnmaskedArea
        ? buildProtectMask(localRepaintRuntime.objectMask, editMask)
        : createEmptyMask(source.width, source.height));
    const bbox = input.preparedBbox ?? computeMaskBoundingBox(editMask);
    if (!bbox) throw new Error(t('localRepaintMaskMissing'));
    const roiRect = expandRect(bbox, 32, { width: source.width, height: source.height });
    const prompt = buildLocalRepaintPrompt({
      userPrompt: input.prompt,
      mode: localRepaintRuntime.mode,
      preserveUnmaskedArea: input.preserveUnmaskedArea,
      includeBlankArea: input.includeBlankArea,
      limitToBlankAndSelection: input.limitToBlankAndSelection,
      language: 'zh',
    });
    const referencesForEdit = await referenceIdsToBlobs(input.selectedReferenceIds);
    const requestId = createId('local-repaint-request');
    const abortController = new AbortController();
    setLocalRepaintAbortController(abortController);
    const submittingRuntime: LocalRepaintRuntime = {
      ...localRepaintRuntime,
      status: 'submitting',
      error: undefined,
      previewUrl: undefined,
      mergedImageData: undefined,
      editMask,
      protectMask,
      roiRect,
      requestId,
      startedAt: new Date().toISOString(),
    };
    updateLocalRepaintRuntime(submittingRuntime);
    let acceptedJobId: string | undefined;
    try {
      const job = await liclickImageEditProvider.startEditImage({
        clientEditId: requestId,
        projectId,
        image: await imageDataToBlob(source),
        mask: await maskToBlob(editMask),
        prompt,
        references: referencesForEdit,
        mode: 'local_repaint',
        strength: 1,
        signal: abortController.signal,
        extra: {
          roi: roiRect,
          preserve_unmasked: input.preserveUnmaskedArea,
          include_blank_area: input.includeBlankArea,
          limit_to_blank_and_selection: input.limitToBlankAndSelection,
          workflow: localRepaintRuntime.mode,
        },
      });
      if (abortController.signal.aborted) {
        throw new Error('局部重绘任务已终止。');
      }
      acceptedJobId = job.id;
      trackModuleActionOnce('local_repaint', 'start', acceptedJobId);
      const runtimeWithJob: LocalRepaintRuntime = {
        ...submittingRuntime,
        editJobId: job.id,
        taskId: job.taskId,
      };
      if (job.status === 'succeeded' && job.outputImage) {
        const completed = await completeLocalRepaintRuntime(
          runtimeWithJob,
          job.outputImage,
          job.raw,
        );
        updateLocalRepaintRuntime(completed);
        await persistLocalRepaintRuntime(completed);
        trackModuleActionOnce('local_repaint', 'complete', acceptedJobId);
        return { previewUrl: completed.previewUrl ?? '' };
      }
      updateLocalRepaintRuntime(runtimeWithJob);
      await persistLocalRepaintRuntime(runtimeWithJob);
      return { previewUrl: '' };
    } catch (error) {
      const wasAborted = abortController.signal.aborted;
      const message = wasAborted
        ? '已终止当前局部重绘任务。'
        : error instanceof Error
          ? error.message
          : t('localRepaintFailed');
      const current = useLocalRepaintStore.getState().runtime;
      if (current?.requestId === requestId) {
        const failedRuntime: LocalRepaintRuntime = {
          ...current,
          status: wasAborted ? 'cancelled' : 'error',
          error: message,
          requestId: undefined,
        };
        updateLocalRepaintRuntime(failedRuntime);
        await persistLocalRepaintRuntime(failedRuntime);
      }
      if (
        !wasAborted &&
        acceptedJobId &&
        hasTrackedModuleAction('local_repaint', 'start', acceptedJobId)
      ) {
        trackModuleActionOnce('local_repaint', 'fail', acceptedJobId);
      }
      throw new Error(message);
    } finally {
      if (useLocalRepaintStore.getState().activeAbortController === abortController) {
        setLocalRepaintAbortController(undefined);
      }
    }
  }

  async function fillLocalRepaintContentAware(input: LocalRepaintGenerateInput) {
    if (!localRepaintRuntime) throw new Error(t('localRepaintUnavailable'));
    const source = localRepaintRuntime.workingImageData;
    const editMask =
      input.preparedEditMask ??
      (localRepaintRuntime.mode === 'edit_layer_image'
        ? input.userMask
        : buildEditMask(input.userMask, localRepaintRuntime.holeMask, {
            includeBlankArea: input.includeBlankArea,
            dilationRadius: input.limitToBlankAndSelection ? 0 : 8,
          }));
    if (!ensureMaskContent(editMask)) throw new Error(t('localRepaintMaskMissing'));
    const protectMask =
      input.preparedProtectMask ??
      (input.preserveUnmaskedArea
        ? buildProtectMask(localRepaintRuntime.objectMask, editMask)
        : createEmptyMask(source.width, source.height));
    const bbox = input.preparedBbox ?? computeMaskBoundingBox(editMask);
    if (!bbox) throw new Error(t('localRepaintMaskMissing'));
    const roiRect = expandRect(bbox, 32, { width: source.width, height: source.height });
    const filled = contentAwareFillMaskedPixels(source, editMask, localRepaintRuntime.objectMask, {
      searchRadius: Math.max(16, Math.min(48, Math.ceil(Math.max(roiRect.w, roiRect.h) * 0.2))),
      iterations: 2,
    });
    const composited = compositeUsingMask(source, filled, editMask);
    const restored = restoreProtectedPixels(source, composited, protectMask);
    const previewUrl = await imageDataToDataUrl(restored);
    const completed: LocalRepaintRuntime = {
      ...localRepaintRuntime,
      status: 'preview_ready',
      error: undefined,
      requestId: undefined,
      editMask,
      protectMask,
      roiRect,
      mergedImageData: restored,
      previewUrl,
      providerRaw: { provider: 'local-content-aware-fill' },
    };
    updateLocalRepaintRuntime(completed);
    await persistLocalRepaintRuntime(completed);
    pushToast({
      tone: 'success',
      title: t('contentAwareFillComplete'),
      description: t('contentAwareFillCompleteHelp'),
      dedupeKey: `local-content-aware-fill:${completed.id}`,
    });
    return { previewUrl };
  }

  async function bakePatchToUvRepairLayer(runtime: LocalRepaintRuntime) {
    if (!project || !importedModel) throw new Error(t('importModelFirst'));
    const cameraState = runtime.cameraState ?? getCurrentCameraSnapshot();
    if (!cameraState) throw new Error(t('viewportUnavailable'));
    const sourcePatch = runtime.mergedImageData ?? runtime.workingImageData;
    const patchMask = buildLocalRepaintPatchMask(runtime, sourcePatch);
    const patchImage = applyAlphaFromMask(sourcePatch, patchMask, 12);
    const patchBlob = await imageDataToBlob(patchImage);
    const patchUrl = await blobToDataUrl(patchBlob);
    const objectId = selectedObjectId ?? importedModel.objectId;
    importedModel.group.updateMatrixWorld(true);
    const tempLayer: Layer = {
      id: createId('local-repaint-patch'),
      name: 'Local repaint UV patch',
      type: 'projected',
      imageUrl: patchUrl,
      objectId,
      objectMatrixWorld: importedModel.group.matrixWorld.toArray(),
      camera: cameraState,
      renderedColor: true,
      visible: true,
      opacity: 1,
      strength: 1,
      blendMode: 'normal',
      adjustments: { hue: 0, saturation: 0, lightness: 0 },
      order: -1,
      createdAt: new Date().toISOString(),
    };
    const previousLayers = useLayerStore.getState().layers;
    const releaseProjectLayerSyncSuppression = () => {
      suppressProjectLayerSyncRef.current = Math.max(0, suppressProjectLayerSyncRef.current - 1);
    };
    suppressProjectLayerSyncRef.current += 1;
    setLayers([tempLayer, ...previousLayers]);
    try {
      const bakeResult = await bakeVisibleProjectedLayersToTexture({
        objectId,
        layerIds: [tempLayer.id],
        resolution: resolutionToSize[resolution],
        enableBackfaceCulling: true,
        // This becomes a persistent UV repair layer. Run the same seam padding
        // as every other production UV bake so UV-island boundaries cannot show
        // transparent cracks after the projected preview is removed.
        enableDilation: true,
        dilationPixels: 4,
        outputAlpha: 'transparent',
        commitToProject: false,
        markSourceLayersBaked: false,
        preferBlobOutput: project.workspaceMode === 'local-server',
        onProgress: updateManualBakeProgress,
      });
      let imageUrl = bakeResult.imageUrl;
      if (project.workspaceMode === 'local-server') {
        imageUrl = await persistManualBakedTexture(
          bakeResult.bakedTexture.id,
          bakeResult.imageUrl,
          bakeResult.imageBlob,
        );
        if (imageUrl !== bakeResult.imageUrl) {
          updateCurrentProject({
            bakedTextures: (
              useProjectStore.getState().getCurrentProject()?.bakedTextures ?? project.bakedTextures
            ).map((item) =>
              item.id === bakeResult.bakedTexture.id ? { ...item, imageUrl } : item,
            ),
          });
        }
      }
      // Do not remove the projected patch until the exact UV replacement has
      // decoded and completed its full striped GPU upload.
      const previewResults = await prewarmPreviewTextures([imageUrl]);
      if (!previewResults.some((result) => result.status === 'fulfilled')) {
        throw new Error('UV repair texture prewarm failed; the projected patch was preserved.');
      }
      setLayers(previousLayers);
      releaseProjectLayerSyncSuppression();
      const uvLayer = addUvLayer({
        name: 'UV Repair Layer',
        imageUrl,
        objectId,
        role: 'local-repaint-overlay',
      });
      updateLayer(uvLayer.id, { isBaked: false, needsRebake: false });
      await applyBakedTextureToObject(importedModel.group, imageUrl);
      return uvLayer;
    } catch (error) {
      setLayers(previousLayers);
      releaseProjectLayerSyncSuppression();
      throw error;
    }
  }

  const addUvContentAwareRepairLayer = useCallback(
    async (
      imageData: ImageData,
      objectId: string,
      temporary = false,
      signal?: AbortSignal,
      silentForeground = false,
    ) => {
      const layerId = createId('content-aware-uv-repair');
      const imageUrl = temporary
        ? await blobToDataUrl(
            await encodeRgbaPngBlob(imageData.width, imageData.height, imageData.data),
          )
        : await persistLayerImage(imageData, `${layerId}.png`, {
            preserveTransparentRgb: true,
          });
      if (signal?.aborted) {
        if (imageUrl.startsWith('blob:')) URL.revokeObjectURL(imageUrl);
        throw new DOMException('Content-aware repair was superseded.', 'AbortError');
      }
      const currentLayers = useLayerStore.getState().layers;
      const previousRepairCount = currentLayers.filter(
        (layer) =>
          isContentAwareRepairLayer(layer) && (!layer.objectId || layer.objectId === objectId),
      ).length;
      const passNumber = previousRepairCount + 1;
      const layer: Layer = {
        id: layerId,
        name: `${t('contentAwareRepair')} ${passNumber}`,
        type: 'uv',
        role: 'content-aware-underlay',
        imageUrl,
        objectId,
        generationId: 'texture-map-content-aware-repair',
        visible: true,
        opacity: 1,
        strength: 1,
        blendMode: 'normal',
        adjustments: { hue: 0, saturation: 0, lightness: 0 },
        // The layer list is top-to-bottom. Every sparse delta pass is appended
        // below the previous pass so each round remains independently visible.
        order: currentLayers.length,
        createdAt: new Date().toISOString(),
      };
      if (!silentForeground) {
        setManualBakeProgress({
          title: t('contentAwareRepair'),
          detail: '修补结果已生成，正在分帧上传完整纹理到 GPU',
          progress: 0.985,
        });
      }
      const previewResults = await prewarmPreviewTextures([imageUrl]);
      const previewReady = previewResults.some((result) => result.status === 'fulfilled');
      if (!previewReady) {
        throw new Error('内容识别修补纹理未能完成 GPU 预热；未发布不完整图层。');
      }
      if (signal?.aborted) {
        releasePreviewTexture(imageUrl);
        if (imageUrl.startsWith('blob:')) URL.revokeObjectURL(imageUrl);
        throw new DOMException('Content-aware repair was superseded.', 'AbortError');
      }
      // Atomic publish: the visible eye and sampler weight are committed only
      // after the exact sparse PNG has decoded and finished its striped upload.
      // This prevents both the first-frame white fallback and a permanently
      // invisible result that used to recover only after toggling the eye.
      // Re-read at the atomic boundary. Eye/mode changes made while the PNG was
      // encoding or uploading are authoritative and must never be overwritten
      // by the stale snapshot used to calculate the pass number.
      const publishLayers = useLayerStore.getState().layers;
      setLayers([...publishLayers, { ...layer, order: publishLayers.length }]);
      setActiveLayer(layer.id);
      document.body.dataset.contentAwareAtomicPublish = JSON.stringify({
        layerId,
        textureReady: true,
        eyeVisible: true,
        publishedAt: performance.now(),
      });
      return layer;
    },
    [persistLayerImage, setActiveLayer, setLayers, t],
  );

  async function acceptLocalRepaint({ continueEditing }: { continueEditing: boolean }) {
    const runtime = localRepaintRuntime;
    if (!runtime?.mergedImageData) return;
    captureHistory(
      runtime.mode === 'edit_layer_image' ? '应用图层局部重绘' : '应用局部重绘 UV 修复',
    );
    try {
      if (runtime.mode === 'edit_layer_image' && runtime.targetLayerId) {
        const imageUrl = runtime.previewUrl ?? (await imageDataToDataUrl(runtime.mergedImageData));
        updateLayerImage(runtime.targetLayerId, imageUrl);
        setProjectLayers(useLayerStore.getState().layers);
        pushToast({
          tone: 'success',
          title: t('localRepaintApplied'),
          description: t('projectionPreservedHelp'),
        });
      } else {
        const uvLayer = await bakePatchToUvRepairLayer(runtime);
        setProjectLayers(useLayerStore.getState().layers);
        pushToast({
          tone: 'success',
          title: t('localRepaintApplied'),
          description: `${t('uvRepairLayerCreated')}: ${uvLayer.name}`,
        });
      }
      if (continueEditing) {
        const nextImageData = runtime.mergedImageData;
        if (runtime.projectId) clearPersistedLocalRepaintRuntime(runtime.projectId);
        updateLocalRepaintRuntime({
          ...runtime,
          workingImageUrl: await imageDataToDataUrl(nextImageData),
          workingImageData: nextImageData,
          mergedImageData: undefined,
          previewUrl: undefined,
          providerRaw: undefined,
          status: 'idle',
          error: undefined,
        });
      } else {
        if (runtime.projectId) clearPersistedLocalRepaintRuntime(runtime.projectId);
        clearLocalRepaintRuntime();
      }
    } catch (error) {
      pushToast({
        tone: 'error',
        title: t('localRepaintFailed'),
        description: error instanceof Error ? error.message : t('localRepaintFailedHelp'),
      });
    }
  }

  function cancelLocalRepaintDialog() {
    const runtime = useLocalRepaintStore.getState().runtime;
    if (runtime?.status === 'submitting') {
      hideLocalRepaint();
      pushToast({
        tone: 'info',
        title: '局部重绘仍在生成',
        description: '窗口已隐藏，重新打开局部重绘可继续查看当前任务状态。',
        dedupeKey: `local-repaint-hidden:${runtime.id}`,
      });
      return;
    }
    if (runtime?.projectId) clearPersistedLocalRepaintRuntime(runtime.projectId);
    clearLocalRepaintRuntime();
  }

  function abortLocalRepaint() {
    const { runtime, activeAbortController } = useLocalRepaintStore.getState();
    if (!runtime || runtime.status !== 'submitting') return;
    activeAbortController?.abort();
    if (runtime.projectId) clearPersistedLocalRepaintRuntime(runtime.projectId);
    updateLocalRepaintRuntime({
      status: 'cancelled',
      error: '已终止当前局部重绘任务。',
      requestId: undefined,
    });
    setLocalRepaintAbortController(undefined);
    pushToast({
      tone: 'info',
      title: '已终止局部重绘',
      description: '本地已停止等待莉刻返回结果，可以重新生成。',
      dedupeKey: `local-repaint-aborted:${runtime.id}`,
    });
    if (runtime.editJobId || runtime.taskId) {
      void liclickImageEditProvider
        .cancelEditImageJob(runtime.editJobId ?? runtime.taskId!)
        .catch((error) => {
          console.warn('[Liclick 3D Texture] Could not cancel remote local repaint job:', error);
        });
    }
  }

  useEffect(() => {
    if (localRepaintRuntime?.projectId === projectId) return undefined;
    let cancelled = false;
    void restorePersistedLocalRepaintRuntime(projectId).then((runtime) => {
      if (cancelled || !runtime) return;
      openLocalRepaintRuntime(runtime);
      console.info(
        '[Liclick 3D Texture] Restored local repaint state in background:',
        runtime.status,
      );
    });
    return () => {
      cancelled = true;
    };
  }, [localRepaintRuntime?.projectId, openLocalRepaintRuntime, projectId]);

  useEffect(() => {
    const runtime = localRepaintRuntime;
    if (!runtime || runtime.status !== 'submitting' || !runtime.editJobId) return undefined;
    let cancelled = false;
    let timeoutId: number | undefined;

    async function pollLocalRepaintJob() {
      if (!runtime?.editJobId) return;
      try {
        const result = await liclickImageEditProvider.getEditImageJob(runtime.editJobId);
        if (cancelled) return;
        if (result.status === 'succeeded' && result.outputImage) {
          const latest = useLocalRepaintStore.getState().runtime;
          if (!latest || latest.id !== runtime.id) return;
          const completed = await completeLocalRepaintRuntime(
            {
              ...latest,
              taskId: result.taskId ?? latest.taskId,
            },
            result.outputImage,
            result.raw,
          );
          updateLocalRepaintRuntime(completed);
          await persistLocalRepaintRuntime(completed);
          if (hasTrackedModuleAction('local_repaint', 'start', runtime.editJobId)) {
            trackModuleActionOnce('local_repaint', 'complete', runtime.editJobId);
          }
          pushToast({
            tone: 'success',
            title: '局部重绘完成',
            description: '莉刻已返回结果，可以预览并应用。',
            dedupeKey: `local-repaint-completed:${completed.id}`,
          });
          return;
        }
        if (result.status === 'failed') {
          const failedRuntime = {
            ...runtime,
            status: 'error' as const,
            taskId: result.taskId ?? runtime.taskId,
            error: result.error ?? '莉刻局部重绘任务失败。',
            requestId: undefined,
          };
          updateLocalRepaintRuntime(failedRuntime);
          await persistLocalRepaintRuntime(failedRuntime);
          if (hasTrackedModuleAction('local_repaint', 'start', runtime.editJobId)) {
            trackModuleActionOnce('local_repaint', 'fail', runtime.editJobId);
          }
          return;
        }
        const runningRuntime = {
          ...runtime,
          taskId: result.taskId ?? runtime.taskId,
          status: 'submitting' as const,
        };
        updateLocalRepaintRuntime(runningRuntime);
        await persistLocalRepaintRuntime(runningRuntime);
      } catch (error) {
        const message = error instanceof Error ? error.message : '';
        if (message.includes('Edit image job not found') && runtime.taskId) {
          const fallbackRuntime = { ...runtime, editJobId: runtime.taskId };
          updateLocalRepaintRuntime(fallbackRuntime);
          await persistLocalRepaintRuntime(fallbackRuntime);
        }
      }
      if (!cancelled) timeoutId = window.setTimeout(pollLocalRepaintJob, 3500);
    }

    void pollLocalRepaintJob();
    return () => {
      cancelled = true;
      if (timeoutId) window.clearTimeout(timeoutId);
    };
  }, [completeLocalRepaintRuntime, localRepaintRuntime, pushToast, updateLocalRepaintRuntime]);

  async function executeMergeLayersToUvLayer(
    layerIds: string[],
    blankUvLayerId?: string,
    options?: {
      benchmarkOnly?: boolean;
      objectId?: string;
      suppressErrorToast?: boolean;
      taskContext?: HeavyTaskContext;
      throwOnError?: boolean;
    },
  ) {
    const currentImportedModel = useSceneStore.getState().importedModel;
    if (!project || !currentImportedModel) {
      pushToast({ tone: 'error', title: t('autoBakeFailed'), description: t('importModelFirst') });
      return;
    }
    const objectId = options?.objectId ?? selectedObjectId ?? currentImportedModel.objectId;
    const currentLayers = useLayerStore.getState().layers;
    const baseUvLayer = blankUvLayerId
      ? currentLayers.find(
          (layer) =>
            layer.id === blankUvLayerId &&
            layer.type === 'uv' &&
            Boolean(layer.imageUrl) &&
            (!layer.objectId || layer.objectId === objectId),
        )
      : undefined;
    const selectedLayers = layerIds
      .map((layerId) => currentLayers.find((item) => item.id === layerId))
      .filter((layer): layer is Layer => Boolean(layer && layer.id !== blankUvLayerId));
    const projectedLayers = selectedLayers.filter((layer): layer is Layer =>
      Boolean(
        layer.type === 'projected' &&
        layer.imageUrl &&
        layer.camera &&
        (!layer.objectId || layer.objectId === objectId),
      ),
    );
    const selectedUvSourceLayers = selectedLayers.filter(
      (layer) =>
        isFlattenableUvMergeSource(layer) && (!layer.objectId || layer.objectId === objectId),
    );
    const selectedUvLayers = [
      ...(baseUvLayer ? [baseUvLayer] : []),
      ...selectedUvSourceLayers,
    ].sort((left, right) => {
      // Repair is always a sparse underlay, irrespective of incidental list
      // order. Ordinary merged UV color stays above it, while new projection
      // pixels remain the front-most authored result.
      const underlayOrder =
        Number(isContentAwareUvUnderlay(left)) - Number(isContentAwareUvUnderlay(right));
      if (underlayOrder !== 0) return underlayOrder;
      return compareUvLayersForComposition(left, right, 'top-to-bottom');
    });
    const projectedLayerIds = projectedLayers.map((layer) => layer.id);
    const selectedUvLayerIds = selectedUvSourceLayers.map((layer) => layer.id);
    const consumedLayerIds = [...projectedLayerIds, ...selectedUvLayerIds];
    if (projectedLayerIds.length === 0 && !baseUvLayer) {
      pushToast({ tone: 'warning', title: t('mergeNoProjectedLayers') });
      return;
    }
    const mergeStartedAt = performance.now();
    const benchmarkOnly = options?.benchmarkOnly === true;
    let gpuBakeDurationMs = 0;
    let readbackDurationMs = 0;
    let uvCompositeDurationMs = 0;
    let pngEncodeDurationMs = 0;
    let previewPrewarmDurationMs = 0;
    let previewPrewarmReady = false;
    const webGpuComposite = {
      enabled:
        typeof window !== 'undefined' &&
        new URLSearchParams(window.location.search).get('webGpuUv') !== '0',
      abEnabled:
        typeof window !== 'undefined' &&
        new URLSearchParams(window.location.search).get('perfWebGpuAb') === '1',
      dispatches: 0,
      fallbackCount: 0,
      uploadMs: 0,
      computeMs: 0,
      readbackMs: 0,
      totalMs: 0,
      byteMismatches: 0,
      maximumByteDelta: 0,
      chunkMb: 0,
      firstMismatch: undefined as
        | { byteOffset: number; expectedRgba: number[]; actualRgba: number[] }
        | undefined,
    };
    const bakeResolution = resolutionToSize[resolution];
    const finishMergeSpan = startPerformanceSpan('uv-merge', 'merge-layers-to-uv', {
      requestedLayerCount: layerIds.length,
      projectedLayerCount: projectedLayers.length,
      uvLayerCount: selectedUvLayers.length,
      resolution: bakeResolution,
    });
    if (!benchmarkOnly) {
      captureHistory(
        blankUvLayerId ? '合并选中投影图层到空 UV 图层' : '合并选中投影图层为 UV 图层',
      );
    }
    manualBakeRunningRef.current = true;
    setManualBakeProgress({
      title: t('mergeSelectedLayersToUvLayer'),
      detail: t('autoBakePreparing'),
      progress: 0.02,
    });
    try {
      // Local repaint masks are editable in-memory canvases. Flatten them into
      // source alpha before UV rasterization so the baked result cannot silently
      // fall back to projecting the complete ComfyUI frame when a mask texture
      // is unavailable. Other projected layers keep their normal mask path.
      const layersToBake = await Promise.all(
        projectedLayers.map(async (layer) =>
          isLocalRepaintProjectionLayer(layer) && layer.maskUrl
            ? {
                ...layer,
                imageUrl: await createProjectionMaskedImage(layer.imageUrl, layer.maskUrl),
                maskUrl: undefined,
                // This temporary source has already flattened the brush mask
                // into alpha. Preserve that authored alpha during the bake.
                ignoreSourceAlpha: false,
              }
            : layer,
        ),
      );
      const postprocess = getMergeUvPostprocessOptions(bakeResolution);
      const projectionBakeSignature = createReusableProjectionBakeSignature({
        purpose: 'merge-uv',
        projectId: project.id,
        objectId,
        resolution: bakeResolution,
        group: currentImportedModel.group,
        layers: layersToBake,
        optionSignature: [
          `gutter:${postprocess.uvIslandGutterPixels}`,
          `interior:${postprocess.uvInteriorHolePixels}`,
          `coverage:${postprocess.uvCoverageGapPixels}`,
          `seam:${postprocess.uvSeamRepairPixels}`,
          'coverage-confidence:0',
        ].join('|'),
      });
      const reusableProjectionBake = reusableProjectionBakeCacheRef.current.get('merge-uv');
      const projectionBakeCacheHit = reusableProjectionBake?.signature === projectionBakeSignature;
      document.body.dataset.perfProjectionBakeCache = projectionBakeCacheHit
        ? 'merge-uv-hit'
        : 'merge-uv-miss';
      markPerformanceEvent('uv-merge', 'gpu-bake-start', {
        layerCount: layersToBake.length,
        resolution: bakeResolution,
        cacheHit: projectionBakeCacheHit,
      });
      const gpuBakeStartedAt = performance.now();
      const bakeResult =
        layersToBake.length > 0 && !projectionBakeCacheHit
          ? await bakeVisibleProjectedLayersToTexture({
              objectId,
              transientLayers: layersToBake,
              resolution: bakeResolution,
              enableBackfaceCulling: true,
              // Keep unrestricted atlas dilation disabled. The restored repair
              // remains constrained to model UV topology, paired geometry seams
              // and the small alpha-bearing gutter outside UV islands.
              enableDilation: false,
              dilationPixels: 0,
              uvIslandGutterPixels: postprocess.uvIslandGutterPixels,
              uvInteriorHolePixels: postprocess.uvInteriorHolePixels,
              uvCoverageGapPixels: postprocess.uvCoverageGapPixels,
              repairMissingUvSeams: true,
              uvSeamRepairPixels: postprocess.uvSeamRepairPixels,
              outputAlpha: 'transparent',
              commitToProject: false,
              markSourceLayersBaked: false,
              skipImageEncoding: true,
              // The CPU-parity bake already returns the authoritative straight
              // RGBA bytes consumed below. Writing the same 64 MiB into a
              // throwaway canvas caused a 450ms main-thread frame.
              skipCanvasUpload: true,
              onProgress: updateManualBakeProgress,
            })
          : undefined;
      if (options?.taskContext?.signal.aborted) {
        throw new DOMException('UV merge was superseded.', 'AbortError');
      }
      gpuBakeDurationMs = performance.now() - gpuBakeStartedAt;
      markPerformanceEvent('uv-merge', 'gpu-bake-complete', {
        durationMs: performance.now() - mergeStartedAt,
        coverageRatio:
          bakeResult?.report.coverageRatio ?? reusableProjectionBake?.report.coverageRatio,
        cacheHit: projectionBakeCacheHit,
      });

      const outputCanvas = bakeResult?.canvas ?? document.createElement('canvas');
      if (!bakeResult) {
        outputCanvas.width = bakeResolution;
        outputCanvas.height = bakeResolution;
      }
      const readbackStartedAt = performance.now();
      let mergedImageData = projectionBakeCacheHit
        ? cloneProjectionBakeImageData(reusableProjectionBake.imageData)
        : bakeResult?.imageData;
      if (!mergedImageData) {
        const outputContext = outputCanvas.getContext('2d', { willReadFrequently: true });
        if (!outputContext) throw new Error('Could not create merged UV canvas.');
        mergedImageData = outputContext.getImageData(0, 0, bakeResolution, bakeResolution);
      }
      if (layersToBake.length > 0 && !projectionBakeCacheHit && bakeResult) {
        reusableProjectionBakeCacheRef.current.set('merge-uv', {
          signature: projectionBakeSignature,
          imageData: cloneProjectionBakeImageData(mergedImageData),
          report: bakeResult.report,
        });
      }
      let mergedRgba = mergedImageData.data;
      readbackDurationMs = performance.now() - readbackStartedAt;

      // Flatten selected UV sources underneath projection coverage. This is
      // the step that used to be silently skipped, causing a selected content-
      // aware repair layer to disappear after merge.
      const uvCompositeStartedAt = performance.now();
      let mergedImageBlob: Blob | undefined;
      let mergedImageUrl: string | undefined;
      let mergedOutputBytes = 0;
      if (document.body.dataset.perfSimulatedViewportInteraction === '1') {
        document.body.dataset.perfUvBakePhase = 'uv-underlay-composite';
      }
      for (let index = 0; index < selectedUvLayers.length; index += 1) {
        const layer = selectedUvLayers[index];
        if (webGpuComposite.enabled) {
          try {
            const result = await compositeRgbaUrlUnderWithWebGpu(
              mergedRgba,
              layer.imageUrl,
              bakeResolution,
              bakeResolution,
              layer.opacity,
              options?.taskContext?.signal,
            );
            const metrics: WebGpuRgbaCompositeMetrics = result.metrics;
            mergedRgba = result.data;
            webGpuComposite.dispatches += 1;
            webGpuComposite.uploadMs += metrics.uploadMs;
            webGpuComposite.computeMs += metrics.computeMs;
            webGpuComposite.readbackMs += metrics.readbackMs;
            webGpuComposite.totalMs += metrics.totalMs;
            webGpuComposite.chunkMb = metrics.chunkBytes / 1024 / 1024;
            if (result.verification) {
              webGpuComposite.byteMismatches += result.verification.byteMismatches;
              webGpuComposite.maximumByteDelta = Math.max(
                webGpuComposite.maximumByteDelta,
                result.verification.maximumByteDelta,
              );
              webGpuComposite.firstMismatch ??= result.verification.firstMismatch;
              if (result.verification.usedCpuOutput) webGpuComposite.fallbackCount += 1;
            }
          } catch (error) {
            webGpuComposite.fallbackCount += 1;
            // The worker owns transferred production buffers. GPU capability
            // failures are handled by its CPU-worker parity path; only an
            // unexpected worker crash reaches here and must abort safely.
            throw new Error(
              `UV composite worker failed: ${error instanceof Error ? error.message : String(error)}`,
            );
          }
        } else {
          const source = await urlToImageData(layer.imageUrl, bakeResolution, bakeResolution);
          compositeRgbaUnderInPlace(mergedRgba, source.data, layer.opacity);
        }
        setManualBakeProgress({
          title: t('mergeSelectedLayersToUvLayer'),
          detail: t('autoBakePreparing'),
          progress: 0.9 + ((index + 1) / Math.max(1, selectedUvLayers.length)) * 0.06,
        });
        if (options?.taskContext?.signal.aborted) {
          if (mergedImageUrl) URL.revokeObjectURL(mergedImageUrl);
          throw new DOMException('UV merge was superseded.', 'AbortError');
        }
      }
      // Store authored albedo only. PBR remains a live viewport operation and
      // is never flattened into the merged UV texture.
      uvCompositeDurationMs = performance.now() - uvCompositeStartedAt;
      const mergedCoverageRatio =
        bakeResult?.report.coverageRatio ??
        reusableProjectionBake?.report.coverageRatio ??
        getRgbaAlphaCoverageRatio(mergedRgba);

      // Encode straight RGBA directly. Canvas PNG export is allowed to erase
      // RGB beneath alpha=0, which would destroy the transparent UV gutter and
      // reintroduce dark/white seams at bilinear-filter boundaries.
      const pngEncodeStartedAt = performance.now();
      if (document.body.dataset.perfSimulatedViewportInteraction === '1') {
        document.body.dataset.perfUvBakePhase = 'png-encode';
      }
      if (!mergedImageBlob && !mergedImageUrl) {
        const encoded = await encodeRgbaPngObjectUrl(bakeResolution, bakeResolution, mergedRgba, {
          transferOwnership: true,
        });
        mergedImageUrl = encoded.url;
        mergedOutputBytes = encoded.byteLength;
        pngEncodeDurationMs = performance.now() - pngEncodeStartedAt;
      }
      markPerformanceEvent('uv-merge', 'png-encode-complete', {
        byteLength: mergedOutputBytes || mergedImageBlob?.size || 0,
        durationMs: performance.now() - mergeStartedAt,
      });
      if (benchmarkOnly) {
        // The production handoff keeps projected layers visible until this
        // exact final PNG is decoded and uploaded. Exercise the same full-size
        // path in S4 so a white-membrane regression is measured, not hidden.
        document.body.dataset.perfUvBakePhase = 'preview-texture-prewarm';
        const previewUrl = mergedImageUrl ?? URL.createObjectURL(mergedImageBlob!);
        const previewPrewarmStartedAt = performance.now();
        try {
          const previewResults = await prewarmPreviewTextures([previewUrl]);
          previewPrewarmReady = previewResults.some((result) => result.status === 'fulfilled');
          if (!previewPrewarmReady) throw new Error('4K UV preview texture prewarm failed.');
        } finally {
          previewPrewarmDurationMs = performance.now() - previewPrewarmStartedAt;
          // S4 uses a one-shot Blob URL solely to validate the exact 4K GPU
          // handoff. Never retain that revoked 64MB texture in the resident LRU;
          // repeated stress runs must not manufacture a GC/VRAM regression.
          releasePreviewTexture(previewUrl);
          URL.revokeObjectURL(previewUrl);
        }
        const result = {
          resolution: bakeResolution,
          projectedLayerCount: projectedLayers.length,
          uvLayerCount: selectedUvLayers.length,
          gpuBakeDurationMs,
          readbackDurationMs,
          uvCompositeDurationMs,
          pngEncodeDurationMs,
          previewPrewarmDurationMs,
          previewPrewarmReady,
          totalDurationMs: performance.now() - mergeStartedAt,
          outputBytes: mergedOutputBytes || mergedImageBlob?.size || 0,
          coverageRatio: mergedCoverageRatio,
          bakePerformanceBreakdown:
            bakeResult?.report.performanceBreakdown ??
            (projectionBakeCacheHit ? { projectionBakeCacheHit: 1 } : {}),
          projectionBakeCacheHit,
          webGpuComposite,
        };
        markPerformanceEvent('uv-merge', 'real-4k-merge-benchmark-complete', result);
        finishMergeSpan('end', result);
        return result;
      }
      let imageUrl: string;
      const outputAssetStem = blankUvLayerId ?? createId('merged-uv-layer');
      if (project.workspaceMode === 'local-server') {
        const filename = `${outputAssetStem}.png`;
        const uploadBlob = mergedImageBlob ?? (await (await fetch(mergedImageUrl!)).blob());
        imageUrl = (
          await saveBlobAsset({
            projectId: project.id,
            category: 'layers',
            blob: uploadBlob,
            filename,
          })
        ).asset.url;
        if (mergedImageUrl) URL.revokeObjectURL(mergedImageUrl);
      } else {
        imageUrl = mergedImageUrl ?? URL.createObjectURL(mergedImageBlob!);
      }
      setManualBakeProgress({
        title: t('mergeSelectedLayersToUvLayer'),
        detail: '正在把最终 4K UV 纹理分帧上传到 GPU，原贴图会保持显示',
        progress: 0.985,
      });
      const previewPrewarmStartedAt = performance.now();
      const previewResults = await prewarmPreviewTextures([imageUrl]);
      previewPrewarmDurationMs = performance.now() - previewPrewarmStartedAt;
      previewPrewarmReady =
        previewResults.length > 0 &&
        previewResults.every((result) => result.status === 'fulfilled');
      if (!previewPrewarmReady) {
        throw new Error('最终 UV 纹理未能完成 GPU 预热；已保留原图层，未执行切换。');
      }
      if (options?.taskContext?.signal.aborted) {
        throw new DOMException('UV merge was superseded.', 'AbortError');
      }
      setManualBakeProgress({
        title: t('mergeSelectedLayersToUvLayer'),
        detail: '最终纹理已就绪，正在同步图层眼睛状态',
        progress: 0.995,
      });
      const mergedLayer = mergeLayersIntoUvLayer({
        // Every source that actually contributed to this PNG is consumed. A
        // selected repair layer no longer remains as an apparently enabled but
        // visually disconnected layer after the projected sources are hidden.
        sourceLayerIds: consumedLayerIds,
        targetUvLayerId: blankUvLayerId,
        imageUrl,
        objectId,
        name: t('mergedUvLayer'),
        role: 'merged-uv',
        uvMergeVersion: UV_MERGE_COMPOSITION_VERSION,
        renderedColor: false,
        renderedColorMaskUrl: undefined,
      });
      document.body.dataset.uvMergeAtomicHandoff = JSON.stringify({
        mergedLayerId: mergedLayer.id,
        mergedVisible: mergedLayer.visible,
        sourceLayerCount: consumedLayerIds.length,
        hiddenSourceCount: useLayerStore
          .getState()
          .layers.filter((layer) => consumedLayerIds.includes(layer.id) && !layer.visible).length,
        previewPrewarmReady,
        previewPrewarmDurationMs,
      });
      setProjectLayers(useLayerStore.getState().layers);
      options?.taskContext?.markFirstResult({
        layerId: mergedLayer.id,
        previewPrewarmDurationMs,
      });
      pushToast({
        tone: 'success',
        title: t('mergeComplete'),
        description: `${bakeResolution}px · ${(mergedCoverageRatio * 100).toFixed(1)}%`,
      });
      finishMergeSpan('end', {
        coverageRatio: mergedCoverageRatio,
        outputBytes: mergedOutputBytes || mergedImageBlob?.size || 0,
      });
      return mergedLayer;
    } catch (error) {
      finishMergeSpan('error', {
        message: error instanceof Error ? error.message : String(error),
      });
      if (!options?.suppressErrorToast) {
        pushToast({
          tone: 'error',
          title: t('autoBakeFailed'),
          description: error instanceof Error ? error.message : t('autoBakeFailedHelp'),
        });
      }
      if (benchmarkOnly || options?.throwOnError) throw error;
    } finally {
      delete document.body.dataset.perfUvBakePhase;
      releaseWebGpuRgbaCompositeResources();
      manualBakeRunningRef.current = false;
      manualBakeProgressTimerRef.current = window.setTimeout(
        () => setManualBakeProgress(undefined),
        1600,
      );
    }
  }

  function mergeLayersToUvLayer(
    layerIds: string[],
    blankUvLayerId?: string,
    options?: {
      benchmarkOnly?: boolean;
      objectId?: string;
      suppressErrorToast?: boolean;
      throwOnError?: boolean;
    },
  ) {
    const benchmarkOnly = options?.benchmarkOnly === true;
    return scheduleEngineHeavyTask(engineSession, {
      key: 'full-resolution-texture',
      label: '4k-uv-merge',
      priority: 'user-visible',
      replace: !benchmarkOnly,
      onQueued: () =>
        setManualBakeProgress({
          title: t('mergeSelectedLayersToUvLayer'),
          detail: '任务已排队，视口交互保持可用',
          progress: 0.01,
        }),
      run: (taskContext) =>
        executeMergeLayersToUvLayer(layerIds, blankUvLayerId, {
          benchmarkOnly,
          objectId: options?.objectId,
          suppressErrorToast: options?.suppressErrorToast,
          taskContext,
          throwOnError: options?.throwOnError,
        }),
    }).catch((error) => {
      if (!benchmarkOnly && error instanceof Error && error.name === 'AbortError') return undefined;
      throw error;
    });
  }

  function handleOpenBake(requestedHandoff?: TextureBakeHandoff) {
    if (generationConflictLocked) {
      showGenerationConflict('进入烘焙工作区');
      return;
    }
    if (publishingToBakeRef.current || manualBakeRunningRef.current) return;
    const objectId = requestedHandoff?.objectId ?? selectedObjectId ?? importedModel?.objectId;
    if (!project || !objectId) {
      pushToast({
        tone: 'warning',
        title: '请先导入模型',
        description: '贴图工作区中没有可传入烘焙的模型。',
        dedupeKey: 'bake-source-missing',
      });
      return;
    }

    publishingToBakeRef.current = true;
    setPublishingToBake(true);
    try {
      const mergedLayer = findMergedUvBakeLayer(useLayerStore.getState().layers, objectId);
      const baseColor =
        requestedHandoff?.baseColor ??
        (mergedLayer?.imageUrl
          ? { name: mergedLayer.name, imageUrl: mergedLayer.imageUrl }
          : undefined);

      onOpenBake({
        ...requestedHandoff,
        objectId,
        ...(baseColor ? { baseColor } : {}),
      });
    } finally {
      publishingToBakeRef.current = false;
      setPublishingToBake(false);
    }
  }

  function handleOpenUv() {
    if (generationConflictLocked) {
      showGenerationConflict('进入 UV 工作区');
      return;
    }
    onOpenUv();
  }

  useEffect(() => {
    if (!autoOpenBake || !project || !importedModel || serverReadyProjectId !== projectId) return;
    const objectId = pendingBakeHandoff?.objectId ?? importedModel.objectId;
    const sceneState = useSceneStore.getState();
    const targetModel = sceneState.importedModels.find((model) => model.objectId === objectId);
    if (!sceneState.viewport || !isBakeMergeModelReady(targetModel, objectId)) return;
    if (sceneState.importedModel?.objectId !== objectId) {
      sceneState.setActiveImportedModel(objectId);
      return;
    }
    const requestKey = `${projectId}:${objectId}`;
    if (automaticBakeEntryRef.current === requestKey) return;
    automaticBakeEntryRef.current = requestKey;
    void handleOpenBake(pendingBakeHandoff);
    // handleOpenBake reads the latest Zustand stores when this one-shot route
    // continuation fires; rerunning it on every render would duplicate a merge.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    autoOpenBake,
    importedModel,
    pendingBakeHandoff,
    project,
    projectId,
    serverReadyProjectId,
    viewport,
  ]);

  useEffect(() => {
    if (!new URLSearchParams(window.location.search).has('perfLab')) return;
    const target = window as typeof window & {
      LiclickPerfUvMerge?: {
        run: () => Promise<unknown>;
      };
    };
    target.LiclickPerfUvMerge = {
      run: async () => {
        const state = useLayerStore.getState();
        const currentObjectId =
          useSceneStore.getState().selectedObjectId ??
          useSceneStore.getState().importedModel?.objectId;
        const projectedIds = state.layers
          .filter(
            (layer) =>
              layer.type === 'projected' &&
              !isLocalRepaintProjectionLayer(layer) &&
              Boolean(layer.imageUrl && layer.camera) &&
              (!currentObjectId || !layer.objectId || layer.objectId === currentObjectId),
          )
          .slice(0, 14)
          .map((layer) => layer.id);
        const repairIds = state.layers
          .filter(
            (layer) =>
              layer.role === 'content-aware-underlay' &&
              Boolean(layer.imageUrl) &&
              (!currentObjectId || !layer.objectId || layer.objectId === currentObjectId),
          )
          .slice(0, 1)
          .map((layer) => layer.id);
        if (projectedIds.length < 14) {
          throw new Error(`当前对象只有 ${projectedIds.length} 个可用投影图层，需要 14 个。`);
        }
        // A repair underlay is optional in the real merge command. Requiring
        // one only in S4 made a perfectly valid 14-projection project unable to
        // quantify its 4K merge (and looked like a frozen benchmark button).
        document.body.dataset.perfUvMergeProjectedCount = String(projectedIds.length);
        document.body.dataset.perfUvMergeRepairCount = String(repairIds.length);
        return mergeLayersToUvLayer([...projectedIds, ...repairIds], undefined, {
          benchmarkOnly: true,
        });
      },
    };
    return () => {
      delete target.LiclickPerfUvMerge;
    };
  });

  async function handlePublishToRetopology() {
    if (generationConflictLocked) {
      showGenerationConflict('进入拓扑工作区');
      return;
    }
    if (!project || publishingToRetopology) return;
    const sourceObjectId = selectedObjectId ?? importedModel?.objectId;
    if (!sourceObjectId) {
      pushToast({
        tone: 'warning',
        title: '请先导入模型',
        description: '贴图工作区中没有可传入拓扑的模型。',
        dedupeKey: 'retopology-source-missing',
      });
      return;
    }
    const sourceObject =
      objects.find((object) => object.id === sourceObjectId) ??
      project.objects.find((object) => object.id === sourceObjectId);
    if (!sourceObject) {
      pushToast({
        tone: 'warning',
        title: '请先选择模型',
        description: '选择贴图工作区中的模型后，再传入拓扑。',
        dedupeKey: 'retopology-source-missing',
      });
      return;
    }

    setPublishingToRetopology(true);
    try {
      const importedSource = useSceneStore
        .getState()
        .importedModels.find((model) => model.objectId === sourceObject.id);
      const sourceUrls = Array.from(
        new Set(
          [importedSource?.objectUrl, sourceObject.sourcePath].filter((value): value is string =>
            Boolean(value),
          ),
        ),
      );
      let sourceBlob: Blob | undefined;
      let lastReadError: unknown;
      for (const sourceUrl of sourceUrls) {
        try {
          sourceBlob = getRegisteredObjectUrlBlob(sourceUrl);
          if (!sourceBlob) {
            sourceBlob = await readWorkspaceAssetBlob(sourceUrl);
          }
          if (sourceBlob) break;
        } catch (reason) {
          lastReadError = reason;
        }
      }
      if (!sourceBlob) {
        throw lastReadError instanceof Error
          ? lastReadError
          : new Error('当前模型源文件不可用，请重新导入模型后再试。');
      }

      const sourceName = importedSource?.sourceFileName ?? sourceObject.name;
      // A published checkpoint must own a unique immutable asset path. Reusing
      // the object/name-based path would make a later publish silently rewrite
      // the model referenced by historical pipeline revisions.
      const revisionId = createId();
      const saved = await saveBlobAsset({
        projectId: project.id,
        category: 'models',
        blob: sourceBlob,
        filename: `pipeline-${revisionId}-high-${sourceName}`,
      });
      let savedBaseColor: { asset: { url: string; relativePath: string } } | undefined;
      let savedBaseColorMimeType = 'image/png';
      if (currentObjectBaseColor) {
        const colorUrl = currentObjectBaseColor.imageUrl;
        const liveCanvasBlob = isLiveProjectedCanvasUrl(colorUrl)
          ? await getLiveProjectedTextureBlob(colorUrl)
          : undefined;
        const colorBlob =
          liveCanvasBlob ??
          getRegisteredObjectUrlBlob(colorUrl) ??
          (await urlToBlob(resolveImageAssetUrl(colorUrl)));
        savedBaseColorMimeType = colorBlob.type || 'image/png';
        savedBaseColor = await saveBlobAsset({
          projectId: project.id,
          category: 'baked',
          blob: colorBlob,
          filename: `pipeline-${revisionId}-base-color.png`,
        });
      }
      const currentProject = useProjectStore
        .getState()
        .projects.find((item) => item.id === project.id);
      if (!currentProject) throw new Error('项目状态已更新，请重试。');
      const projectWithHighSnapshot = replaceBakeHighSnapshot(currentProject, {
        objectId: sourceObject.id,
        asset: {
          name: sourceName,
          url: saved.asset.url,
          relativePath: saved.asset.relativePath,
          mimeType: sourceBlob.type || 'application/octet-stream',
        },
        highObject: sourceObject,
      });
      const previousTextureRevision = getLatestPipelineStageRevision(
        projectWithHighSnapshot.pipeline,
        'texture',
      );
      const currentPipeline = projectWithHighSnapshot.pipeline
        ? markDownstreamPipelineRevisionsStale(projectWithHighSnapshot.pipeline, 'texture')
        : undefined;
      const timestamp = new Date().toISOString();
      const highAsset = {
        id: `${revisionId}:high`,
        kind: 'high-model' as const,
        objectId: sourceObject.id,
        name: sourceName,
        url: saved.asset.url,
        relativePath: saved.asset.relativePath,
        mimeType: sourceBlob.type || 'application/octet-stream',
      };
      const baseColorAsset = currentObjectBaseColor
        ? {
            id: `${revisionId}:base-color`,
            kind: 'base-color' as const,
            objectId: sourceObject.id,
            name: currentObjectBaseColor.name,
            url: savedBaseColor!.asset.url,
            relativePath: savedBaseColor!.asset.relativePath,
            mimeType: savedBaseColorMimeType,
          }
        : undefined;
      const pipeline = publishPipelineRevision(currentPipeline, {
        id: revisionId,
        stage: 'texture',
        sourceMode: 'project',
        parentRevisionId: previousTextureRevision?.id,
        inputAssets: [],
        outputAssets: baseColorAsset ? [highAsset, baseColorAsset] : [highAsset],
        settings: { objectId: sourceObject.id },
        status: 'ready',
        createdAt: timestamp,
        updatedAt: timestamp,
        completedAt: timestamp,
      });
      const nextProject = {
        ...projectWithHighSnapshot,
        pipeline,
        bakeWorkspace: projectWithHighSnapshot.bakeWorkspace
          ? {
              ...projectWithHighSnapshot.bakeWorkspace,
              bakeSets: {
                ...projectWithHighSnapshot.bakeWorkspace.bakeSets,
                [sourceObject.id]: {
                  // The new texture checkpoint invalidates the operational
                  // low/cage/output state for this object. Historical outputs
                  // remain in the append-only pipeline, but Bake must not pair
                  // them with the newly published high model.
                  objectId: sourceObject.id,
                  high: projectWithHighSnapshot.bakeWorkspace.bakeSets[sourceObject.id]?.high,
                  highObject:
                    projectWithHighSnapshot.bakeWorkspace.bakeSets[sourceObject.id]?.highObject,
                  ...(baseColorAsset
                    ? {
                        color: {
                          name: baseColorAsset.name,
                          url: baseColorAsset.url,
                          mimeType: baseColorAsset.mimeType,
                        },
                      }
                    : {}),
                },
              },
            }
          : projectWithHighSnapshot.bakeWorkspace,
      };
      const result = await saveWorkspaceProject(nextProject);
      replaceCurrentProject(result.project);
      pushToast({
        tone: 'success',
        title: '贴图版本已发布',
        description: '已锁定独立高模与材质快照，正在传入拓扑。',
        dedupeKey: 'texture-published-to-retopology',
      });
      onOpenRetopology();
    } catch (reason) {
      pushToast({
        tone: 'error',
        title: '传入拓扑失败',
        description: reason instanceof Error ? reason.message : '请稍后重试。',
        dedupeKey: 'texture-publish-failed',
      });
    } finally {
      setPublishingToRetopology(false);
    }
  }

  async function runExportAction(title: string, action: () => Promise<void> | void) {
    pushToast({ tone: 'info', title: `${title}...` });
    try {
      await action();
      pushToast({ tone: 'success', title: t('exportComplete') });
    } catch (error) {
      console.error('[Liclick 3D Texture] Export failed:', error);
      pushToast({
        tone: 'error',
        title: t('exportFailed'),
        description: error instanceof Error ? error.message : t('exportFailedHelp'),
      });
    } finally {
      manualBakeProgressTimerRef.current = window.setTimeout(
        () => setManualBakeProgress(undefined),
        1200,
      );
    }
  }

  function handleExportAction(actionId: ExportActionId) {
    if (!project) return;
    const modelInput = importedModel
      ? {
          project,
          importedModel,
          selectedObjectId,
          target: actionId.startsWith('object') ? 'object' : 'scene',
          onProgress: updateExportBakeProgress,
        }
      : undefined;
    const textureModelExport =
      actionId.endsWith('-glb') || actionId.endsWith('-fbx') || actionId.endsWith('-obj');
    if (textureModelExport) {
      window.clearTimeout(manualBakeProgressTimerRef.current);
      setManualBakeProgress({
        title: t('exportPreparingUvTexture'),
        detail: t('exportUvBakeRequired'),
        progress: 0.02,
      });
    }

    const actions: Record<ExportActionId, () => Promise<void> | void> = {
      'scene-glb': () => {
        if (!modelInput) throw new Error(t('importModelFirst'));
        return import('@/engine/export/exportGltf').then(({ exportModelGlb }) =>
          exportModelGlb({ ...modelInput, target: 'scene' }),
        );
      },
      'scene-fbx': () => {
        if (!modelInput) throw new Error(t('importModelFirst'));
        return import('@/engine/export/exportFbx').then(({ exportModelFbx }) =>
          exportModelFbx({ ...modelInput, target: 'scene' }),
        );
      },
      'scene-obj': () => {
        if (!modelInput) throw new Error(t('importModelFirst'));
        return import('@/engine/export/exportObj').then(({ exportModelObj }) =>
          exportModelObj({ ...modelInput, target: 'scene' }),
        );
      },
      'scene-stl': () => {
        if (!modelInput) throw new Error(t('importModelFirst'));
        return import('@/engine/export/exportStl').then(({ exportModelStl }) =>
          exportModelStl({ ...modelInput, target: 'scene' }),
        );
      },
      'object-glb': () => {
        if (!modelInput) throw new Error(t('selectObjectFirst'));
        return import('@/engine/export/exportGltf').then(({ exportModelGlb }) =>
          exportModelGlb({ ...modelInput, target: 'object' }),
        );
      },
      'object-fbx': () => {
        if (!modelInput) throw new Error(t('selectObjectFirst'));
        return import('@/engine/export/exportFbx').then(({ exportModelFbx }) =>
          exportModelFbx({ ...modelInput, target: 'object' }),
        );
      },
      'object-obj': () => {
        if (!modelInput) throw new Error(t('selectObjectFirst'));
        return import('@/engine/export/exportObj').then(({ exportModelObj }) =>
          exportModelObj({ ...modelInput, target: 'object' }),
        );
      },
      'object-stl': () => {
        if (!modelInput) throw new Error(t('selectObjectFirst'));
        return import('@/engine/export/exportStl').then(({ exportModelStl }) =>
          exportModelStl({ ...modelInput, target: 'object' }),
        );
      },
      'texture-color': autoMergeUvAndExportBaseColor,
      'texture-normal': () => {
        if (normalLayer?.imageUrl) {
          return import('@/engine/export/exportTexture').then(({ exportTextureUrl }) =>
            exportTextureUrl(project, normalLayer.imageUrl, 'normal'),
          );
        }
        if (!normalMapTexture) throw new Error(t('normalTextureMissing'));
        return import('@/engine/export/exportTexture').then(({ exportNormalTexture }) =>
          exportNormalTexture(project, normalMapTexture),
        );
      },
      'viewport-png': () => {
        if (!viewport) throw new Error(t('viewportUnavailable'));
        return import('@/engine/export/exportSnapshot').then(({ exportViewportSnapshot }) =>
          exportViewportSnapshot({ project, viewport }),
        );
      },
      'turntable-webm': () => {
        if (!viewport || !importedModel) throw new Error(t('importModelFirst'));
        return import('@/engine/export/exportTurntable').then(({ exportTurntableWebm }) =>
          exportTurntableWebm({ project, viewport, root: importedModel.group, durationMs: 5000 }),
        );
      },
    };

    void runExportAction(t('exporting'), actions[actionId]);
  }

  const getLocalRepaintProjectionImage = useCallback(
    (generation: Generation, maskUrl: string) => {
      const seamMode = getLocalRepaintSeamMode();
      const metadata = generation.metadata;
      const rawResultUrl =
        typeof metadata.rawResultUrl === 'string' ? metadata.rawResultUrl : generation.resultUrl;
      if (!rawResultUrl) return Promise.reject(new Error('Local repaint result is missing.'));
      const referenceUrl =
        typeof metadata.viewportReferenceUrl === 'string'
          ? metadata.viewportReferenceUrl
          : undefined;
      const harmonizedResultUrl =
        typeof metadata.harmonizedResultUrl === 'string' ? metadata.harmonizedResultUrl : undefined;
      const seamHarmonizationVersion =
        typeof metadata.seamHarmonizationVersion === 'number'
          ? metadata.seamHarmonizationVersion
          : undefined;
      const reusableHarmonizedResultUrl =
        seamHarmonizationVersion === 2 ||
        seamHarmonizationVersion === 3 ||
        seamHarmonizationVersion === 4 ||
        seamHarmonizationVersion === 5 ||
        seamHarmonizationVersion === 6 ||
        seamHarmonizationVersion === 7 ||
        seamHarmonizationVersion === 8 ||
        seamHarmonizationVersion === 9 ||
        seamHarmonizationVersion === 10 ||
        seamHarmonizationVersion === 11 ||
        seamHarmonizationVersion === 12 ||
        seamHarmonizationVersion === 13 ||
        seamHarmonizationVersion === 14
          ? harmonizedResultUrl
          : undefined;
      const selectedResultUrl =
        (seamHarmonizationVersion === 3 ||
          seamHarmonizationVersion === 4 ||
          seamHarmonizationVersion === 5) &&
        reusableHarmonizedResultUrl
          ? reusableHarmonizedResultUrl
          : seamMode === 'enhanced' && reusableHarmonizedResultUrl
            ? reusableHarmonizedResultUrl
            : rawResultUrl;
      const cacheKey = [
        seamMode,
        generation.id,
        selectedResultUrl,
        referenceUrl ?? 'no-reference',
        maskUrl,
      ].join('|');
      const cached = localRepaintProjectionImageCacheRef.current.get(cacheKey);
      if (cached) return cached;

      const legacyResult = {
        imageUrl: rawResultUrl,
        persistentImageUrl: rawResultUrl,
        rawImageUrl: rawResultUrl,
        seamMode: 'legacy' as const,
        seamHarmonizationVersion: undefined,
      };
      const promise = (async () => {
        // Versions 3-5 are historical canonical full-frame composites. Version
        // 6+ keep both the raw and enhanced results so the explicit legacy
        // switch can still restore the old projection path.
        if (
          (seamHarmonizationVersion === 3 ||
            seamHarmonizationVersion === 4 ||
            seamHarmonizationVersion === 5) &&
          reusableHarmonizedResultUrl
        ) {
          return {
            imageUrl: reusableHarmonizedResultUrl,
            persistentImageUrl: reusableHarmonizedResultUrl,
            rawImageUrl: rawResultUrl,
            seamMode,
            seamHarmonizationVersion,
          };
        }
        // This is an explicit bypass, not an approximation of the old path.
        // Old projects without the archived flat-colour reference also retain
        // their exact legacy behaviour.
        if (seamMode === 'legacy' || !referenceUrl) return legacyResult;
        if (reusableHarmonizedResultUrl) {
          return {
            imageUrl: reusableHarmonizedResultUrl,
            persistentImageUrl: reusableHarmonizedResultUrl,
            rawImageUrl: rawResultUrl,
            seamMode,
            seamHarmonizationVersion,
          };
        }
        try {
          const result = await harmonizeLocalRepaintInWorker({
            generatedUrl: rawResultUrl,
            referenceUrl,
            maskUrl,
          });
          if (!result.report.applied) return legacyResult;
          const generationProjectId =
            typeof metadata.projectId === 'string' ? metadata.projectId : projectId;
          const generationProject = useProjectStore
            .getState()
            .projects.find((candidate) => candidate.id === generationProjectId);
          let persistentImageUrl: string;
          if (generationProject?.workspaceMode === 'local-server') {
            try {
              persistentImageUrl = (
                await saveBlobAsset({
                  projectId: generationProjectId,
                  category: 'generations',
                  blob: result.blob,
                  filename: `${generation.id}-seam-harmonized-v2.png`,
                })
              ).asset.url;
            } catch (error) {
              console.warn(
                '[Liclick 3D Texture] Could not persist harmonized repaint; keeping an embedded copy:',
                error,
              );
              persistentImageUrl = await blobToDataUrl(result.blob);
            }
          } else {
            persistentImageUrl = await blobToDataUrl(result.blob);
          }
          const latestGeneration =
            useGenerationStore
              .getState()
              .generations.find((candidate) => candidate.id === generation.id) ?? generation;
          const persistentRawResultUrl =
            typeof latestGeneration.metadata.rawResultUrl === 'string'
              ? latestGeneration.metadata.rawResultUrl
              : rawResultUrl;
          useGenerationStore.getState().addGeneration({
            ...latestGeneration,
            metadata: {
              ...latestGeneration.metadata,
              rawResultUrl: persistentRawResultUrl,
              harmonizedResultUrl: persistentImageUrl,
              seamHarmonizationVersion: 10,
              seamHarmonizationBlendWidth: result.report.blendWidth,
              seamHarmonizationSampleCount: result.report.sampledPixels,
              seamHarmonizationProcessMs: result.processMs,
            },
          });
          window.dispatchEvent(new Event(IMMEDIATE_PROJECT_SAVE_EVENT));
          return {
            imageUrl: persistentImageUrl,
            persistentImageUrl,
            rawImageUrl: persistentRawResultUrl,
            seamMode,
            seamHarmonizationVersion: 10,
          };
        } catch (error) {
          // Enhancements are never allowed to make projection unavailable.
          // Any decode, worker or persistence failure falls back to the exact
          // original generated image.
          console.warn(
            '[Liclick 3D Texture] Seam harmonization failed; using the original repaint result:',
            error,
          );
          return legacyResult;
        }
      })();
      localRepaintProjectionImageCacheRef.current.set(cacheKey, promise);
      return promise;
    },
    [projectId],
  );

  useEffect(() => {
    type SeamDebugApi = {
      getMode: () => LocalRepaintSeamMode;
      setMode: (mode: LocalRepaintSeamMode) => void;
    };
    const debugWindow = window as Window & { LiclickLocalRepaintSeam?: SeamDebugApi };
    debugWindow.LiclickLocalRepaintSeam = {
      getMode: getLocalRepaintSeamMode,
      setMode: (mode) => {
        setLocalRepaintSeamMode(mode);
        localRepaintProjectionImageCacheRef.current.clear();
        useSceneStore.getState().setLocalRepaintProjectionSource(undefined);
      },
    };
    return () => {
      delete debugWindow.LiclickLocalRepaintSeam;
    };
  }, []);

  useEffect(() => {
    const handleLocalRepaintPrewarmProgress = (event: Event) => {
      const detail = (
        event as CustomEvent<AutoBakeProgress & { done?: boolean; dismissAfterMs?: number }>
      ).detail;
      if (!detail) return;
      window.clearTimeout(manualBakeProgressTimerRef.current);
      setManualBakeProgress({
        title: detail.title,
        detail: detail.detail,
        progress: detail.progress,
        indeterminate: detail.indeterminate,
      });
      if (detail.done) {
        manualBakeProgressTimerRef.current = window.setTimeout(
          () => setManualBakeProgress(undefined),
          detail.dismissAfterMs ?? 450,
        );
      }
    };
    window.addEventListener(
      'liclick:local-repaint-prewarm-progress',
      handleLocalRepaintPrewarmProgress,
    );
    return () => {
      window.removeEventListener(
        'liclick:local-repaint-prewarm-progress',
        handleLocalRepaintPrewarmProgress,
      );
    };
  }, []);

  useEffect(() => {
    const handleLocalRepaintInteractiveState = (event: Event) => {
      const detail = (event as CustomEvent<LocalRepaintInteractiveStateDetail>).detail;
      if (!detail?.generationId) return;
      const pendingRequest = pendingLocalRepaintActivationRequestRef.current;
      const preferredGenerationId = preferredLocalRepaintGenerationIdRef.current;
      if (
        pendingRequest
          ? !localRepaintActivationRequestMatches(pendingRequest, detail)
          : preferredGenerationId && detail.generationId !== preferredGenerationId
      ) {
        return;
      }
      const source = useSceneStore.getState().localRepaintProjectionSource;
      if (
        detail.status !== 'preparing' &&
        (source?.generationId !== detail.generationId ||
          source.targetLayerId !== detail.targetLayerId)
      ) {
        return;
      }
      setLocalRepaintInteractiveState(detail);
      if (detail.status === 'ready' || detail.status === 'failed') {
        localRepaintGpuPrepareRequestedKeyRef.current = undefined;
        if (pendingLocalRepaintBackgroundGenerationIdRef.current === detail.generationId) {
          pendingLocalRepaintBackgroundGenerationIdRef.current = undefined;
        }
      }
      if (detail.status !== 'failed') return;
      pendingLocalRepaintActivationRequestRef.current = undefined;
      setLocalRepaintActivationQueued(false);
      pushToast({
        tone: 'error',
        title: '局部重绘 GPU 准备失败',
        description: detail.error ?? '高清结果或蒙版无法上传，请重试。',
        dedupeKey: 'local-repaint-gpu-prewarm-failed',
      });
    };
    window.addEventListener(
      LOCAL_REPAINT_INTERACTIVE_STATE_EVENT,
      handleLocalRepaintInteractiveState,
    );
    return () => {
      window.removeEventListener(
        LOCAL_REPAINT_INTERACTIVE_STATE_EVENT,
        handleLocalRepaintInteractiveState,
      );
    };
  }, [pushToast]);

  useEffect(() => {
    const preferredObjectId = selectedObjectId ?? importedModel?.objectId;
    const matchesUsableLocalRepaintGeneration = (generation: Generation) =>
      Boolean(generation.resultUrl) &&
      generation.status === 'succeeded' &&
      isLocalRepaintGeneration(generation) &&
      (!generation.metadata.projectId || generation.metadata.projectId === projectId) &&
      generationBelongsToObject(generation, preferredObjectId, project?.captures ?? []);
    const preferredGenerationId = preferredLocalRepaintGenerationIdRef.current;
    const latestLocalRepaintGeneration = selectPreferredLocalRepaintGeneration(
      generations,
      matchesUsableLocalRepaintGeneration,
      preferredGenerationId,
    );
    if (!latestLocalRepaintGeneration?.resultUrl) return;
    // Start fetching/converting the ComfyUI result as soon as it arrives. The
    // apply button should only bind an already warm source, regardless of which
    // repaint round the user is entering.
    const generationMaskUrl = getLocalRepaintAuthoringMaskUrl(
      latestLocalRepaintGeneration,
      paintMaskDataUrl,
    );
    if (!generationMaskUrl) return;
    void getLocalRepaintProjectionImage(latestLocalRepaintGeneration, generationMaskUrl).catch(
      (error) => {
        console.warn('[Liclick 3D Texture] Could not preload local repaint result:', error);
      },
    );
  }, [
    generations,
    getLocalRepaintProjectionImage,
    importedModel?.objectId,
    localImageGenerationSuccessKey,
    paintMaskDataUrl,
    project?.captures,
    projectId,
    selectedObjectId,
  ]);

  useEffect(() => {
    if (
      !project ||
      !importedModel ||
      paintTool === 'inpaint-apply' ||
      paintTool === 'eraser' ||
      document.body.dataset.localRepaintPrewarmProgressRequested === '1' ||
      document.body.dataset.perfUseCurrentLocalRepaintMask === '1'
    )
      return undefined;
    const preferredObjectId = selectedObjectId ?? importedModel.objectId;
    const matchesUsableLocalRepaintGeneration = (generation: Generation) =>
      Boolean(generation.resultUrl) &&
      generation.status === 'succeeded' &&
      isLocalRepaintGeneration(generation) &&
      (!generation.metadata.projectId || generation.metadata.projectId === projectId) &&
      generationBelongsToObject(generation, preferredObjectId, project.captures);
    const preferredGenerationId = preferredLocalRepaintGenerationIdRef.current;
    const latestLocalRepaintGeneration = selectPreferredLocalRepaintGeneration(
      generations,
      matchesUsableLocalRepaintGeneration,
      preferredGenerationId,
    );
    if (!latestLocalRepaintGeneration?.resultUrl) return undefined;
    // Only a generation that completed in this live editor session earns the
    // speculative GPU warmup. Replaying it for persisted generations on every
    // model/workspace switch caused the exact source decode, depth setup and
    // material compile to fight the visible transition. Explicit button-3
    // activation still runs the same authoritative preparation path.
    if (
      pendingLocalRepaintBackgroundGenerationIdRef.current !== latestLocalRepaintGeneration.id
    )
      return undefined;
    const objectId = preferredObjectId;
    const currentLayers = useLayerStore.getState().layers;
    const generationResultLayer = currentLayers.find(
      (layer) =>
        layer.type === 'projected' &&
        layer.generationId === latestLocalRepaintGeneration.id &&
        Boolean(layer.replacementTargetLayerId) &&
        layer.objectId === objectId,
    );
    const generationCapture =
      project.captures.find((capture) => capture.id === latestLocalRepaintGeneration.captureId) ??
      useProjectStore
        .getState()
        .getCurrentProject()
        ?.captures.find((capture) => capture.id === latestLocalRepaintGeneration.captureId);
    const archivedCamera =
      generationCapture?.camera ??
      generationResultLayer?.camera ??
      getGenerationCaptureCamera(latestLocalRepaintGeneration);
    // Broken legacy saves could retain the generation while dropping both its
    // capture and projected result row. Button 3 historically fell back to the
    // current view in that case; perform the same compatibility recovery while
    // idle so those projects no longer pay the entire depth/compile cost on the
    // click. New generations always archive captureCamera below.
    const generationCamera = archivedCamera ?? getCurrentCameraSnapshot();
    if (!generationCamera) return undefined;
    document.body.dataset.localRepaintBackgroundCameraBackend = archivedCamera
      ? 'archived-capture'
      : 'legacy-current-view';
    let targetLayer = currentLayers.find(
      (layer) =>
        layer.id === generationResultLayer?.replacementTargetLayerId &&
        isLocalRepaintDestinationLayer(layer, objectId),
    );
    const generationMaskUrl = getLocalRepaintAuthoringMaskUrl(
      latestLocalRepaintGeneration,
      paintMaskDataUrl,
    );
    if (!generationMaskUrl) return undefined;
    const preparedSource = useSceneStore.getState().localRepaintProjectionSource;
    const requestRendererPrepare = (targetLayerId: string) => {
      const generationId = latestLocalRepaintGeneration.id;
      const session = getLocalRepaintSessionSnapshot();
      const ready =
        session?.status === 'ready' &&
        session.generationId === generationId &&
        session.targetLayerId === targetLayerId;
      if (ready) return false;
      if (isLocalRepaintPreparationInFlight(generationId, targetLayerId)) return true;
      const requestKey = `${generationId}:${targetLayerId}`;
      if (localRepaintGpuPrepareRequestedKeyRef.current !== requestKey) {
        localRepaintGpuPrepareRequestedKeyRef.current = requestKey;
        document.body.dataset.localRepaintBackgroundGeneration = generationId;
        document.body.dataset.localRepaintBackgroundStage = 'renderer-retry';
        useSceneStore.getState().requestLocalRepaintGpuPrepare();
      }
      return true;
    };
    if (targetLayer) {
      const disposition = resolveLocalRepaintBackgroundPrewarmDisposition({
        currentSource: preparedSource,
        nextSource: {
          generationId: latestLocalRepaintGeneration.id,
          objectId,
          targetLayerId: targetLayer.id,
        },
        pendingGenerationId: pendingLocalRepaintBackgroundGenerationIdRef.current,
      });
      if (disposition === 'already-staged') {
        if (requestRendererPrepare(targetLayer.id)) return undefined;
        if (
          pendingLocalRepaintBackgroundGenerationIdRef.current === latestLocalRepaintGeneration.id
        ) {
          pendingLocalRepaintBackgroundGenerationIdRef.current = undefined;
        }
        return undefined;
      }
      if (disposition === 'preserve-current-source') return undefined;
    }

    let cancelled = false;
    const stage = async () => {
      const startedAt = performance.now();
      document.body.dataset.localRepaintBackgroundStage = 'running';
      document.body.dataset.localRepaintBackgroundGeneration = latestLocalRepaintGeneration.id;
      try {
        if (!isLocalRepaintDestinationLayer(targetLayer, objectId)) {
          // Create/bind the destination while the browser is idle, not in the
          // button-3 click handler. Preserve the user's active layer because
          // this is preparation rather than an explicit layer selection.
          const activeLayerId = useLayerStore.getState().activeProjectedLayerId;
          targetLayer = ensureLocalRepaintSessionLayer({
            objectId,
            generationId: latestLocalRepaintGeneration.id,
            preserveActiveProjection: true,
            preserveActiveLayer: true,
          }).layer;
          if (
            activeLayerId &&
            useLayerStore.getState().layers.some((layer) => layer.id === activeLayerId)
          ) {
            useLayerStore.getState().setActiveLayer(activeLayerId);
          }
          await waitForBrowserPaint();
        }
        if (!isLocalRepaintDestinationLayer(targetLayer, objectId)) return;
        const targetLayerId = targetLayer.id;
        const projectionImage = await getLocalRepaintProjectionImage(
          latestLocalRepaintGeneration,
          generationMaskUrl,
        );
        if (cancelled || document.body.dataset.perfUseCurrentLocalRepaintMask === '1') return;
        const currentTarget = useLayerStore
          .getState()
          .layers.find((layer) => layer.id === targetLayerId);
        if (!isLocalRepaintDestinationLayer(currentTarget, objectId)) return;
        const latestSceneState = useSceneStore.getState();
        const visibleProjectionSource = latestSceneState.localRepaintProjectionSource;
        const visiblePreviewLayer = latestSceneState.localRepaintPreviewLayer;
        // The persisted activeLayerId can legitimately remain on the previous
        // repaint after a newer generation lands or after project restore. It
        // is not proof that the user is editing history. A live projection
        // source/preview is the actual ownership signal and still prevents the
        // idle newest-result prewarm from stealing an active historical edit.
        if (
          visibleProjectionSource?.generationId === latestLocalRepaintGeneration.id &&
          visibleProjectionSource.targetLayerId === currentTarget.id
        ) {
          // Source identity alone is not readiness. A cancelled renderer effect
          // can leave the newest source in Zustand while the GPU markers still
          // belong to the previous generation. Explicitly restart the renderer
          // preparation once and wait for its ready/failed event.
          const preparing = requestRendererPrepare(currentTarget.id);
          if (
            !preparing &&
            pendingLocalRepaintBackgroundGenerationIdRef.current ===
              latestLocalRepaintGeneration.id
          ) {
            pendingLocalRepaintBackgroundGenerationIdRef.current = undefined;
          }
          return;
        }
        const disposition = resolveLocalRepaintBackgroundPrewarmDisposition({
          currentSource: visibleProjectionSource,
          nextSource: {
            generationId: latestLocalRepaintGeneration.id,
            objectId,
            targetLayerId: currentTarget.id,
          },
          pendingGenerationId: pendingLocalRepaintBackgroundGenerationIdRef.current,
        });
        if (disposition === 'preserve-current-source') return;
        if (!visibleProjectionSource && visiblePreviewLayer) {
          // A preview without a source has no renderer owner and cannot be
          // interactive. Project restore can leave this marker behind after a
          // previous repaint; treating it as an active edit blocked every later
          // background prewarm and forced button 3 down the cold path.
          latestSceneState.setLocalRepaintPreviewLayer(undefined);
        }
        importedModel.group.updateMatrixWorld(true);
        const nameSource = latestLocalRepaintGeneration.prompt.trim();
        setLocalRepaintProjectionSource({
          imageUrl: projectionImage.imageUrl,
          persistentImageUrl: projectionImage.persistentImageUrl,
          rawImageUrl: projectionImage.rawImageUrl,
          seamHarmonizationVersion: projectionImage.seamHarmonizationVersion,
          autoActivate: false,
          allowedMaskUrl: generationMaskUrl,
          depthUrl: generationCapture?.depthUrl ?? generationResultLayer?.depthUrl,
          depthEncoding: generationCapture?.depthEncoding ?? generationResultLayer?.depthEncoding,
          normalUrl: generationCapture?.normalUrl ?? generationResultLayer?.normalUrl,
          objectId,
          objectMatrixWorld:
            getGenerationObjectMatrixWorld(latestLocalRepaintGeneration) ??
            importedModel.group.matrixWorld.toArray(),
          camera: generationCamera,
          generationId: latestLocalRepaintGeneration.id,
          captureId:
            generationCapture?.id ??
            generationResultLayer?.captureId ??
            latestLocalRepaintGeneration.captureId,
          name: nameSource ? `${t('localRepaint')}: ${nameSource.slice(0, 20)}` : t('localRepaint'),
          targetLayerId: currentTarget.id,
          targetLayerType: currentTarget.type,
          targetLayerName: currentTarget.name,
        });
        if (
          pendingLocalRepaintBackgroundGenerationIdRef.current === latestLocalRepaintGeneration.id
        ) {
          pendingLocalRepaintBackgroundGenerationIdRef.current = undefined;
        }
        markPerformanceEvent('local-repaint', 'background-source-stage', {
          durationMs: performance.now() - startedAt,
        });
        document.body.dataset.localRepaintBackgroundStage = 'published';
        document.body.dataset.localRepaintBackgroundStageMs = (
          performance.now() - startedAt
        ).toFixed(1);
      } catch (error) {
        if (!cancelled) {
          document.body.dataset.localRepaintBackgroundStage = 'failed';
          console.warn('[Liclick 3D Texture] Could not stage local repaint source:', error);
        }
      } finally {
        if (
          document.body.dataset.localRepaintBackgroundGeneration ===
            latestLocalRepaintGeneration.id &&
          document.body.dataset.localRepaintBackgroundStage === 'running'
        ) {
          document.body.dataset.localRepaintBackgroundStage = cancelled ? 'cancelled' : 'skipped';
        }
      }
    };
    // Start the exact generation-scoped prewarm in the current effect turn.
    // A queued microtask avoids the extra timer task while still allowing all
    // sibling effects from the result publication to finish first.
    queueMicrotask(() => {
      if (!cancelled) void stage();
    });
    return () => {
      cancelled = true;
      if (
        document.body.dataset.localRepaintBackgroundGeneration ===
          latestLocalRepaintGeneration.id &&
        document.body.dataset.localRepaintBackgroundStage === 'running'
      ) {
        document.body.dataset.localRepaintBackgroundStage = 'cancelled';
      }
    };
  }, [
    generations,
    getCurrentCameraSnapshot,
    getLocalRepaintProjectionImage,
    importedModel,
    localImageGenerationSuccessKey,
    paintMaskDataUrl,
    paintTool,
    project,
    project?.captures,
    projectId,
    selectedObjectId,
    setLocalRepaintProjectionSource,
    t,
  ]);

  const handleLocalImageGenerationFromToolbar = useCallback(() => {
    if (generationOperationLocked) {
      notifyEditorTaskRunning();
      return;
    }
    if (!project || !importedModel) {
      pushToast({
        tone: 'warning',
        title: t('localRepaintUnavailable'),
        description: t('importModelFirst'),
      });
      return;
    }
    if (!useSceneStore.getState().paintMaskHasContent) {
      pushToast({
        tone: 'warning',
        title: '请先绘制蒙版',
        description: '请标记需要生成的区域，再点击局部生图。',
        dedupeKey: 'local-repaint-mask-required',
      });
      return;
    }
    const clickedAt = performance.now();
    document.body.dataset.localRepaintButton2ClickedAt = clickedAt.toFixed(1);
    document.body.dataset.perfLocalRepaintPhase = 'button2-click-response';
    window.requestAnimationFrame((frameAt) => {
      document.body.dataset.localRepaintButton2ResponseMs = (frameAt - clickedAt).toFixed(1);
      if (document.body.dataset.perfLocalRepaintPhase === 'button2-click-response') {
        delete document.body.dataset.perfLocalRepaintPhase;
      }
    });
    // Set the presentation guard in the same event turn as the toolbar click.
    // Waiting for GeneratePanel to mount would leave one frame where `none`
    // hides the live repaint before the persisted row has taken ownership.
    useSceneStore.getState().setLocalRepaintGenerationPresentationActive(true);
    pendingLocalRepaintActivationRequestRef.current = undefined;
    setLocalRepaintActivationQueued(false);
    setLocalRepaintGenerationSettledAwaitingUnlock(false);
    setPaintTool('none');
    setLocalImageGenerationRequested(true);
    showPanel('generate');
    setPanelCollapsed('generate', false);
    setLocalImageGenerationRequestKey((current) => current + 1);
  }, [
    generationOperationLocked,
    importedModel,
    notifyEditorTaskRunning,
    project,
    pushToast,
    setPaintTool,
    setPanelCollapsed,
    showPanel,
    t,
  ]);

  const handleLocalImageGenerationSettled = useCallback(
    (result: LocalImageGenerationSettledResult) => {
      useSceneStore.getState().setLocalRepaintGenerationPresentationActive(false);
      setLocalImageGenerationRequested(false);
      if (!result.succeeded) {
        pendingLocalRepaintActivationRequestRef.current = undefined;
        setLocalRepaintActivationQueued(false);
        setLocalRepaintGenerationSettledAwaitingUnlock(false);
        return;
      }
      setLocalRepaintGenerationSettledAwaitingUnlock(true);
      preferredLocalRepaintGenerationIdRef.current = result.generationId;
      pendingLocalRepaintBackgroundGenerationIdRef.current = result.generationId;
      if (pendingLocalRepaintActivationRequestRef.current) {
        pendingLocalRepaintActivationRequestRef.current = createLocalRepaintActivationRequest({
          generationId: result.generationId,
          now: pendingLocalRepaintActivationRequestRef.current.requestedAt,
        });
      }
      setLocalRepaintInteractiveState({
        generationId: result.generationId,
        status: 'preparing',
      });
      setLocalImageGenerationSuccessKey((current) => current + 1);
    },
    [],
  );

  const handleLocalRepaintFromToolbar = useCallback(() => {
    const clickedAt = performance.now();
    document.body.dataset.localRepaintButton3ClickedAt = clickedAt.toFixed(1);
    window.requestAnimationFrame((frameAt) => {
      document.body.dataset.localRepaintButton3ResponseMs = (frameAt - clickedAt).toFixed(1);
    });
    if (
      canQueueLocalRepaintActivation &&
      (generationOperationLocked || !localRepaintGenerationReady)
    ) {
      pendingLocalRepaintActivationRequestRef.current = createLocalRepaintActivationRequest({});
      setLocalRepaintActivationQueued(true);
      document.body.dataset.localRepaintButton3ActivationPath = 'queued-generation-unlock';
      return;
    }
    if (generationOperationLocked) {
      notifyEditorTaskRunning();
      return;
    }
    pendingLocalRepaintActivationRequestRef.current = undefined;
    setLocalRepaintActivationQueued(false);
    const requestRevision = localRepaintToolRequestRevisionRef.current + 1;
    localRepaintToolRequestRevisionRef.current = requestRevision;
    const showPrewarmProgress = (detail: string, progress: number) => {
      document.body.dataset.localRepaintPrewarmProgressRequested = '1';
      window.clearTimeout(manualBakeProgressTimerRef.current);
      setManualBakeProgress({
        title: '正在准备局部重绘',
        detail,
        progress,
        indeterminate: false,
      });
    };
    const clearPrewarmProgress = () => {
      delete document.body.dataset.localRepaintPrewarmProgressRequested;
      window.clearTimeout(manualBakeProgressTimerRef.current);
      setManualBakeProgress(undefined);
    };
    void (async () => {
      if (!project || !importedModel) {
        pushToast({
          tone: 'warning',
          title: t('localRepaintUnavailable'),
          description: t('importModelFirst'),
        });
        return;
      }
      const preferredObjectId = selectedObjectId ?? importedModel.objectId;
      const matchesUsableLocalRepaintGeneration = (generation: Generation) =>
        Boolean(generation.resultUrl) &&
        generation.status === 'succeeded' &&
        isLocalRepaintGeneration(generation) &&
        (!generation.metadata.projectId || generation.metadata.projectId === projectId) &&
        generationBelongsToObject(generation, preferredObjectId, project.captures);
      const preferredGenerationId = preferredLocalRepaintGenerationIdRef.current;
      const latestLocalRepaintGeneration = selectPreferredLocalRepaintGeneration(
        generations,
        matchesUsableLocalRepaintGeneration,
        preferredGenerationId,
      );
      const generationCapture = latestLocalRepaintGeneration
        ? (project.captures.find(
            (capture) => capture.id === latestLocalRepaintGeneration.captureId,
          ) ??
          useProjectStore
            .getState()
            .getCurrentProject()
            ?.captures.find((capture) => capture.id === latestLocalRepaintGeneration.captureId))
        : undefined;
      const objectId = preferredObjectId;
      if (!latestLocalRepaintGeneration?.resultUrl) {
        setLocalRepaintProjectionSource(undefined);
        setPaintTool('none');
        pushToast({
          tone: 'warning',
          title: t('localRepaintUnavailable'),
          description: '请先在生成面板的“局部重绘”中完成局部生图。',
          dedupeKey: 'local-repaint-generation-missing',
        });
        return;
      }
      const benchmarkMaskUrl =
        document.body.dataset.perfUseCurrentLocalRepaintMask === '1'
          ? useSceneStore.getState().paintMaskDataUrl
          : undefined;
      const generationMaskUrl =
        benchmarkMaskUrl ??
        getLocalRepaintAuthoringMaskUrl(latestLocalRepaintGeneration, paintMaskDataUrl);
      // Applying an already generated repaint must use the mask archived with
      // that generation. The transient viewport selection is intentionally not
      // guaranteed to survive reloads, tool changes, or a long generation job.
      if (!generationMaskUrl) {
        pushToast({
          tone: 'warning',
          title: t('localRepaintMaskMissing'),
          description: t('inpaintSelectToolHelp'),
          dedupeKey: 'local-repaint-mask-missing',
        });
        return;
      }

      // Hot path first: the result, mask and destination are staged while the
      // remote generation is finishing. Do not normalize every layer, trigger
      // an immediate project save and rebuild React subscribers before checking
      // the prepared GPU source. In the normal case button 3 now only flips the
      // tool mode and returns in the same frame.
      const preparedSource = useSceneStore.getState().localRepaintProjectionSource;
      const preparedTargetLayer = preparedSource?.targetLayerId
        ? useLayerStore.getState().layers.find((layer) => layer.id === preparedSource.targetLayerId)
        : undefined;
      const preparedTargetId = preparedTargetLayer?.id;
      const preparedSession = getLocalRepaintSessionSnapshot();
      const preparedSourceHasGpuError =
        preparedSession?.status === 'failed' &&
        preparedSession.generationId === latestLocalRepaintGeneration.id &&
        preparedSession.targetLayerId === preparedTargetId;
      if (
        preparedSource?.generationId === latestLocalRepaintGeneration.id &&
        preparedSource.objectId === objectId &&
        preparedTargetId &&
        isLocalRepaintDestinationLayer(preparedTargetLayer, objectId) &&
        !preparedSourceHasGpuError
      ) {
        // A restored persisted repaint converts its stable authored mask into
        // an equivalent live PNG URL. URL equality therefore says nothing
        // about readiness and forced a fully resident source back through the
        // cold 6% decode path. Generation + object + destination own the source
        // revision; the GPU-ready markers below guard the exact resident bind.
        const isGpuReady = () => {
          const session = getLocalRepaintSessionSnapshot();
          return (
            session?.status === 'ready' &&
            session.generationId === latestLocalRepaintGeneration.id &&
            session.targetLayerId === preparedTargetId
          );
        };
        if (isGpuReady()) {
          document.body.dataset.localRepaintButton3ActivationPath = 'resident-gpu';
          clearPrewarmProgress();
          setPaintTool('inpaint-apply');
          return;
        }
        document.body.dataset.localRepaintButton3ActivationPath = 'background-prewarm-queued';
        setPaintTool('none');
        clearPrewarmProgress();
        const gpuPrepareKey = `${latestLocalRepaintGeneration.id}:${preparedTargetId}`;
        localRepaintGpuPrepareRequestedKeyRef.current = gpuPrepareKey;
        pendingLocalRepaintActivationRequestRef.current = createLocalRepaintActivationRequest({
          generationId: latestLocalRepaintGeneration.id,
          targetLayerId: preparedTargetId,
        });
        requestLocalRepaintSessionActivation(
          latestLocalRepaintGeneration.id,
          preparedTargetId,
        );
        setLocalRepaintActivationQueued(true);
        // Join live background work; only restart if its renderer owner was
        // cancelled. Restarting an active decode/compile discards its progress.
        if (!isLocalRepaintPreparationInFlight(latestLocalRepaintGeneration.id, preparedTargetId)) {
          useSceneStore.getState().requestLocalRepaintGpuPrepare();
        }
        return;
      }

      const { layer: targetLayer } = ensureLocalRepaintSessionLayer({
        objectId,
        generationId: latestLocalRepaintGeneration.id,
      });
      document.body.dataset.localRepaintButton3ActivationPath = 'cold-prepare';
      if (!isLocalRepaintDestinationLayer(targetLayer, objectId)) {
        setLocalRepaintProjectionSource(undefined);
        setPaintTool('none');
        console.warn('[Liclick 3D Texture] Could not prepare the internal local repaint layer.');
        return;
      }
      const cameraState = generationCapture?.camera ?? getCurrentCameraSnapshot();
      if (!cameraState) {
        pushToast({
          tone: 'warning',
          title: t('viewportUnavailable'),
          description: t('textureMapSubmitting'),
        });
        return;
      }
      importedModel.group.updateMatrixWorld(true);
      const captureId = generationCapture?.id ?? latestLocalRepaintGeneration.captureId;
      // A new ComfyUI result is a fresh interactive session. Keep painting
      // disabled while its lightweight source and renderer material are being
      // prepared, so an early gesture cannot be silently queued behind setup.
      setPaintTool('none');
      showPrewarmProgress('读取高清生成结果', 0.06);
      let projectionImage: {
        imageUrl: string;
        persistentImageUrl: string;
        rawImageUrl: string;
        seamMode: LocalRepaintSeamMode;
        seamHarmonizationVersion?: number;
      };
      try {
        projectionImage = await getLocalRepaintProjectionImage(
          latestLocalRepaintGeneration,
          generationMaskUrl,
        );
      } catch (error) {
        if (localRepaintToolRequestRevisionRef.current !== requestRevision) return;
        clearPrewarmProgress();
        setLocalRepaintProjectionSource(undefined);
        setPaintTool('none');
        const reason = error instanceof Error ? error.message : t('localRepaintFailedHelp');
        pushToast({
          tone: 'error',
          title: '局部重绘结果无法读取',
          description: `${reason} 请重新生成局部重绘结果后再启用画笔。`,
          dedupeKey: 'local-repaint-result-unavailable',
        });
        return;
      }
      if (
        localRepaintToolRequestRevisionRef.current !== requestRevision ||
        useSceneStore.getState().paintTool !== 'none'
      )
        return;
      let currentTargetLayer = useLayerStore
        .getState()
        .layers.find((layer) => layer.id === targetLayer.id);
      if (!isLocalRepaintDestinationLayer(currentTargetLayer, objectId)) {
        const recoveredTarget = ensureLocalRepaintSessionLayer({
          objectId,
          generationId: latestLocalRepaintGeneration.id,
        }).layer;
        if (!isLocalRepaintDestinationLayer(recoveredTarget, objectId)) {
          clearPrewarmProgress();
          setLocalRepaintProjectionSource(undefined);
          setPaintTool('none');
          console.warn('[Liclick 3D Texture] Could not recover the internal local repaint layer.');
          return;
        }
        currentTargetLayer = recoveredTarget;
      }
      const nameSource = latestLocalRepaintGeneration.prompt.trim();
      const currentLayers = useLayerStore.getState().layers;
      const collapsedLayers = collapseLocalRepaintProjectionLayers(
        currentLayers,
        latestLocalRepaintGeneration.id,
        captureId,
        objectId,
        currentTargetLayer.id,
      );
      if (collapsedLayers.length !== currentLayers.length) {
        const selectedLayerId = useLayerStore.getState().activeProjectedLayerId;
        setLayers(collapsedLayers);
        restoreLocalRepaintLayerSelection(selectedLayerId);
        setProjectLayers(useLayerStore.getState().layers);
      }
      setLocalRepaintProjectionSource({
        imageUrl: projectionImage.imageUrl,
        persistentImageUrl: projectionImage.persistentImageUrl,
        rawImageUrl: projectionImage.rawImageUrl,
        seamHarmonizationVersion: projectionImage.seamHarmonizationVersion,
        autoActivate: true,
        allowedMaskUrl: generationMaskUrl,
        depthUrl: generationCapture?.depthUrl,
        depthEncoding: generationCapture?.depthEncoding,
        normalUrl: generationCapture?.normalUrl,
        objectId,
        objectMatrixWorld:
          getGenerationObjectMatrixWorld(latestLocalRepaintGeneration) ??
          importedModel.group.matrixWorld.toArray(),
        camera: cameraState,
        generationId: latestLocalRepaintGeneration.id,
        captureId,
        name: nameSource ? `${t('localRepaint')}: ${nameSource.slice(0, 20)}` : t('localRepaint'),
        targetLayerId: currentTargetLayer.id,
        targetLayerType: 'uv',
        targetLayerName: currentTargetLayer.name,
      });
    })();
  }, [
    canQueueLocalRepaintActivation,
    generationOperationLocked,
    generations,
    getCurrentCameraSnapshot,
    getLocalRepaintProjectionImage,
    importedModel,
    localRepaintGenerationReady,
    localRepaintInteractiveReady,
    notifyEditorTaskRunning,
    paintMaskDataUrl,
    project,
    projectId,
    pushToast,
    selectedObjectId,
    setLocalRepaintProjectionSource,
    setLayers,
    setPaintTool,
    setProjectLayers,
    t,
  ]);

  useEffect(() => {
    if (
      generationOperationLocked ||
      !localRepaintGenerationReady ||
      !pendingLocalRepaintActivationRequestRef.current
    ) {
      return;
    }
    pendingLocalRepaintActivationRequestRef.current = undefined;
    setLocalRepaintActivationQueued(false);
    document.body.dataset.localRepaintButton3ActivationPath = localRepaintInteractiveReady
      ? 'replayed-after-gpu-ready'
      : 'replayed-to-start-gpu-prepare';
    handleLocalRepaintFromToolbar();
  }, [
    generationOperationLocked,
    handleLocalRepaintFromToolbar,
    localRepaintGenerationReady,
    localRepaintInteractiveReady,
  ]);

  useEffect(() => {
    if (
      generationOperationLocked ||
      !localRepaintGenerationReady ||
      !localRepaintInteractiveReady
    )
      return;
    setLocalRepaintGenerationSettledAwaitingUnlock(false);
  }, [
    generationOperationLocked,
    localRepaintGenerationReady,
    localRepaintInteractiveReady,
  ]);

  useEffect(() => {
    const target = window as typeof window & {
      LiclickPerfLocalRepaintSource?: {
        prepareLatestGeneratedSource: () => Promise<boolean>;
      };
    };
    target.LiclickPerfLocalRepaintSource = {
      prepareLatestGeneratedSource: async () => {
        const wait = (durationMs: number) =>
          new Promise<void>((resolve) => window.setTimeout(resolve, durationMs));
        const maskDeadline = performance.now() + 15_000;
        while (performance.now() < maskDeadline) {
          const sceneState = useSceneStore.getState();
          if (sceneState.paintMaskHasContent) break;
          await wait(40);
        }
        const maskState = useSceneStore.getState();
        if (!maskState.paintMaskHasContent) {
          throw new Error('S6 蒙版编码超时，未进入现成生图绑定阶段。');
        }
        const preferredObjectId = selectedObjectId ?? importedModel?.objectId;
        const hasReusableGeneration = Boolean(
          project &&
            preferredObjectId &&
            generations.some(
              (generation) =>
                Boolean(generation.resultUrl) &&
                generation.status === 'succeeded' &&
                isLocalRepaintGeneration(generation) &&
                (!generation.metadata.projectId || generation.metadata.projectId === projectId) &&
                generationBelongsToObject(generation, preferredObjectId, project.captures),
            ),
        );
        // A performance run must not wait 25 seconds for a generation record
        // that does not exist. The viewport benchmark can bind an already
        // resident project texture as a deterministic, network-free source.
        if (!hasReusableGeneration) return false;
        document.body.dataset.perfUseCurrentLocalRepaintMask = '1';
        try {
          handleLocalRepaintFromToolbar();
          const sourceDeadline = performance.now() + 25_000;
          while (performance.now() < sourceDeadline) {
            const sceneState = useSceneStore.getState();
            if (
              sceneState.localRepaintProjectionSource &&
              sceneState.paintTool === 'inpaint-apply'
            ) {
              return true;
            }
            await wait(50);
          }
        } finally {
          delete document.body.dataset.perfUseCurrentLocalRepaintMask;
        }
        throw new Error('S6 绑定现成局部生图超时，请检查生成记录或目标图层。');
      },
    };
    return () => {
      delete target.LiclickPerfLocalRepaintSource;
    };
  }, [
    generations,
    handleLocalRepaintFromToolbar,
    importedModel,
    project,
    projectId,
    selectedObjectId,
  ]);

  const executeContentAwareRepair = useCallback(
    async (
      requestedObjectId?: string,
      options?: {
        benchmarkOnly?: boolean;
        silentForeground?: boolean;
        taskContext?: HeavyTaskContext;
      },
    ) => {
      const benchmarkOnly = options?.benchmarkOnly === true;
      const silentForeground = options?.silentForeground === true;
      if (contentAwareRepairRunningRef.current) return;
      contentAwareRepairRunningRef.current = true;
      setContentAwareRepairRunning(true);
      const repairRunStartedAt = performance.now();
      const reportRepairRunState = (
        status: 'running' | 'complete' | 'no-gaps' | 'error' | 'cancelled',
        phase: string,
        detail: Record<string, unknown> = {},
      ) => {
        const state = {
          status,
          phase,
          durationMs: Math.round((performance.now() - repairRunStartedAt) * 10) / 10,
          ...detail,
        };
        document.body.dataset.contentAwareRepairRun = JSON.stringify(state);
        document.body.dataset.perfContentAwareRepairPhase = `s9-${phase}`;
        let history: Array<typeof state> = [];
        if (phase !== 'prepare') {
          try {
            history = JSON.parse(
              document.body.dataset.contentAwareRepairPhaseHistory ?? '[]',
            ) as Array<typeof state>;
          } catch {
            history = [];
          }
        }
        history.push(state);
        document.body.dataset.contentAwareRepairPhaseHistory = JSON.stringify(history.slice(-24));
      };
      reportRepairRunState('running', 'prepare');
      const abortController = new AbortController();
      const abortFromScheduler = () => abortController.abort();
      options?.taskContext?.signal.addEventListener('abort', abortFromScheduler, { once: true });
      contentAwareRepairAbortControllerRef.current = abortController;
      try {
        const sceneState = useSceneStore.getState();
        const viewportRuntime = sceneState.viewport;
        const targetModel = requestedObjectId
          ? sceneState.importedModels.find((model) => model.objectId === requestedObjectId)
          : ((sceneState.selectedObjectId
              ? sceneState.importedModels.find(
                  (model) => model.objectId === sceneState.selectedObjectId,
                )
              : undefined) ?? sceneState.importedModel);
        if (!viewportRuntime || !targetModel) {
          if (!benchmarkOnly && !silentForeground) {
            pushToast({
              tone: 'warning',
              title: t('viewportUnavailable'),
              description: t('importModelFirst'),
            });
          }
          throw new Error(t('importModelFirst'));
        }
        if (!silentForeground) {
          window.clearTimeout(manualBakeProgressTimerRef.current);
          setManualBakeProgress({
            title: t('contentAwareRepair'),
            detail: t('contentAwareRepairScanning'),
            progress: 0.04,
          });
        }
        const objectId = targetModel.objectId;
        const currentLayers = useLayerStore.getState().layers;
        const sourceProjectedLayers = currentLayers
          .filter(
            (layer) =>
              layer.type === 'projected' &&
              layer.visible &&
              Boolean(layer.imageUrl && layer.camera) &&
              (!layer.objectId || layer.objectId === objectId) &&
              !isLocalRepaintLayer(layer) &&
              !isContentAwareRepairLayer(layer),
          )
          .sort(compareProjectedLayersForDeterministicBake);
        const sourceLayerIds = sourceProjectedLayers.map((layer) => layer.id);
        const previousRepairLayers = currentLayers.filter(
          (layer) =>
            isContentAwareRepairLayer(layer) &&
            layer.visible &&
            Boolean(layer.imageUrl) &&
            (!layer.objectId || layer.objectId === objectId),
        );
        if (sourceLayerIds.length === 0) {
          throw new Error(t('contentAwareRepairNoSource'));
        }
        const repairResolution = Math.min(
          resolutionToSize[useSettingsStore.getState().resolution],
          CONTENT_AWARE_UV_MAX_RESOLUTION,
        ) as UvBakeResolution;
        const completionPolicy = createVisibleSurfaceCompletionPolicy(
          repairResolution,
          repairResolution,
        );
        const projectionBakeSignature = createReusableProjectionBakeSignature({
          purpose: 'content-aware-repair',
          projectId: project?.id,
          objectId,
          resolution: repairResolution,
          group: targetModel.group,
          layers: sourceProjectedLayers,
          optionSignature: 'coverage-confidence:1|transparent|no-postprocess',
        });
        const reusableProjectionBake =
          reusableProjectionBakeCacheRef.current.get('content-aware-repair');
        const memoryProjectionBakeHit =
          reusableProjectionBake?.signature === projectionBakeSignature;
        const persistentProjectionBake = memoryProjectionBakeHit
          ? undefined
          : await readContentAwareProjectionBake(
              projectionBakeSignature,
              repairResolution,
              repairResolution,
            );
        const projectionBakeCacheHit = memoryProjectionBakeHit || Boolean(persistentProjectionBake);
        document.body.dataset.perfProjectionBakeCache = memoryProjectionBakeHit
          ? 'content-aware-repair-memory-hit'
          : persistentProjectionBake
            ? 'content-aware-repair-disk-hit'
            : 'content-aware-repair-miss';
        const bakeResult = projectionBakeCacheHit
          ? undefined
          : await bakeVisibleProjectedLayersToTexture({
              objectId,
              layerIds: sourceLayerIds,
              resolution: repairResolution,
              enableBackfaceCulling: true,
              enableDilation: false,
              dilationPixels: 0,
              outputAlpha: 'transparent',
              // Gap detection needs the same quality-ranked colour as UV merge,
              // but must retain aggregate coverage confidence in alpha. Otherwise
              // one weak grazing sample makes an actually empty surface look 100%
              // filled and the repair tool reports no blank area.
              preserveCoverageConfidenceAlpha: true,
              commitToProject: false,
              markSourceLayersBaked: false,
              skipImageEncoding: true,
              // The repair pipeline consumes straight RGBA directly. Avoid a
              // redundant 2K ImageData -> Canvas upload followed by an immediate
              // Canvas -> ImageData readback on the interaction thread.
              skipCanvasUpload: true,
              onProgress: silentForeground
                ? undefined
                : (progress) => {
                    if (abortController.signal.aborted) return;
                    setManualBakeProgress({
                      title: t('contentAwareRepair'),
                      detail: t('contentAwareRepairScanning'),
                      progress: 0.04 + progress.progress * 0.54,
                    });
                  },
            });
        if (abortController.signal.aborted) {
          throw new DOMException('Content-aware repair cancelled.', 'AbortError');
        }
        reportRepairRunState('running', 'projection-bake-ready', {
          resolution: repairResolution,
          sourceLayerCount: sourceLayerIds.length,
          projectionBakeCacheHit,
          bakePerformanceBreakdown:
            bakeResult?.report.performanceBreakdown ??
            (projectionBakeCacheHit ? { projectionBakeCacheHit: 1 } : undefined),
        });
        delete document.body.dataset.perfUvBakePhase;
        let workingImageData = memoryProjectionBakeHit
          ? cloneProjectionBakeImageData(reusableProjectionBake.imageData)
          : persistentProjectionBake
            ? cloneProjectionBakeImageData(persistentProjectionBake)
            : bakeResult?.imageData;
        if (!workingImageData) {
          const bakeContext = bakeResult?.canvas.getContext('2d', { willReadFrequently: true });
          if (!bakeContext) throw new Error(t('localRepaintFailedHelp'));
          workingImageData = bakeContext.getImageData(0, 0, repairResolution, repairResolution);
        }
        if (!projectionBakeCacheHit && bakeResult) {
          reusableProjectionBakeCacheRef.current.set('content-aware-repair', {
            signature: projectionBakeSignature,
            imageData: cloneProjectionBakeImageData(workingImageData),
            report: bakeResult.report,
          });
          // Persistence runs after the full-quality result is available and is
          // intentionally not awaited: CacheStorage owns its byte copy while
          // repair/topology continue, so no disk write extends the click path.
          void writeContentAwareProjectionBake(projectionBakeSignature, workingImageData);
        } else if (persistentProjectionBake && !memoryProjectionBakeHit) {
          reusableProjectionBakeCacheRef.current.set('content-aware-repair', {
            signature: projectionBakeSignature,
            imageData: cloneProjectionBakeImageData(persistentProjectionBake),
            report: {
              id: createId('persistent-projection-bake-report'),
              objectId,
              layerId: sourceLayerIds[0] ?? '',
              width: repairResolution,
              height: repairResolution,
              totalTriangles: 0,
              processedTriangles: 0,
              coveredPixels: 0,
              skippedPixels: 0,
              totalTexels: repairResolution * repairResolution,
              inFrustumTexels: 0,
              maskRejectedTexels: 0,
              depthRejectedTexels: 0,
              backfaceRejectedTexels: 0,
              writtenTexels: 0,
              coverageRatio: getRgbaAlphaCoverageRatio(persistentProjectionBake.data),
              warnings: ['Restored exact projection RGBA from the persistent content-aware cache.'],
              durationMs: 0,
            },
          });
        }
        // Projection remains the front layer. Repair deltas are applied in
        // authored top-to-bottom order and contribute only where coverage is
        // still empty, becoming evidence and donors for the next pass.
        for (const layer of previousRepairLayers) {
          const webGpuCompositeDisabled =
            typeof window !== 'undefined' &&
            new URLSearchParams(window.location.search).get('webGpuUv') === '0';
          if (!webGpuCompositeDisabled) {
            try {
              const result = await compositeRgbaUrlUnderWithWebGpu(
                workingImageData.data,
                layer.imageUrl!,
                repairResolution,
                repairResolution,
                layer.opacity,
                abortController.signal,
              );
              workingImageData = new ImageData(result.data, repairResolution, repairResolution);
            } catch (error) {
              throw new Error(
                `Repair composite worker failed: ${error instanceof Error ? error.message : String(error)}`,
              );
            }
          } else {
            const imageData = await urlToImageData(
              layer.imageUrl!,
              repairResolution,
              repairResolution,
            );
            compositeRgbaUnderInPlace(workingImageData.data, imageData.data, layer.opacity);
          }
        }
        const topologyPrewarmKey = `${projectId}:${objectId}:${repairResolution}`;
        const prewarmedTopology =
          contentAwareTopologyPrewarmRef.current?.key === topologyPrewarmKey &&
          contentAwareTopologyPrewarmRef.current.root === targetModel.group
            ? contentAwareTopologyPrewarmRef.current.promise
            : undefined;
        document.body.dataset.perfContentAwareTopologyCache = prewarmedTopology
          ? 'prewarm-hit'
          : 'miss';
        const topology = prewarmedTopology
          ? await prewarmedTopology
          : await buildContentAwareSurfaceTopology(
              targetModel.group,
              repairResolution,
              repairResolution,
              {
                includeInvisible: false,
                // A bounded physical-seam bridge can seed a fully blank UV island.
                // The repair core limits propagation to one seam crossing so colour
                // cannot cascade through an arbitrary chain of neighbouring islands.
                includeSeamLinks: true,
                seamBandPixels: 1,
                minimumSeamNormalDot: 0.72,
                yieldIntervalMs: 4,
                signal: abortController.signal,
                onProgress: silentForeground
                  ? undefined
                  : (progress) => {
                      if (document.body.dataset.perfContentAwareRepairMeasuring === '1') {
                        document.body.dataset.perfContentAwareRepairPhase = `s9-topology-${progress.phase}`;
                      }
                      const phaseRange =
                        progress.phase === 'analyze'
                          ? [0.58, 0.64]
                          : progress.phase === 'rasterize'
                            ? [0.64, 0.7]
                            : progress.phase === 'seams'
                              ? [0.7, 0.74]
                              : [0.74, 0.74];
                      const phaseProgress =
                        progress.total > 0 ? progress.completed / progress.total : 1;
                      setManualBakeProgress({
                        title: t('contentAwareRepair'),
                        detail: t('contentAwareRepairScanning'),
                        progress:
                          phaseRange[0] +
                          (phaseRange[1] - phaseRange[0]) * Math.max(0, Math.min(1, phaseProgress)),
                      });
                    },
              },
            );
        if (abortController.signal.aborted) {
          throw new DOMException('Content-aware repair was superseded.', 'AbortError');
        }
        reportRepairRunState('running', 'topology-ready', {
          componentCount: topology.componentCount,
          seamLinkCount: topology.seamLinkCount,
        });
        const detectedGaps = await buildContentAwareRepairMask({
          width: repairResolution,
          height: repairResolution,
          rgba: workingImageData.data,
          topologyMask: topology.topologyMask,
          coreMask: topology.coreMask,
          regionIds: topology.regionIds,
          conflictMask: topology.conflictMask,
          // This layer is a sparse underlay below every authored projection.
          // Imported atlases can overlap between components; those texels are
          // valid blank targets for this already-composited sparse underlay.
          allowConflictedWrites: true,
          // Use the exact live-hatch threshold and retain even a one-texel
          // crack: the product contract is complete visible coverage, not a
          // minimum repair-component size.
          ...completionPolicy.gapMask,
          signal: abortController.signal,
          yieldIntervalMs: 8,
        });
        console.info(
          '[Liclick Content Aware] Gap scan',
          JSON.stringify({
            resolution: repairResolution,
            topology: {
              surfaces: topology.surfaceCount,
              components: topology.componentCount,
              regions: topology.regionCount,
              seams: topology.seamLinkCount,
            },
            gaps: detectedGaps.stats,
          }),
        );
        if (detectedGaps.stats.totalPixels === 0) {
          reportRepairRunState('no-gaps', 'gap-scan-complete');
          if (!silentForeground) setManualBakeProgress(undefined);
          if (!benchmarkOnly && !silentForeground) {
            pushToast({
              tone: 'info',
              title: t('contentAwareRepair'),
              description: t('contentAwareRepairNoBlankArea'),
              dedupeKey: 'content-aware-no-blank-area',
            });
          }
          return;
        }

        if (!silentForeground) {
          setManualBakeProgress({
            title: t('contentAwareRepair'),
            detail: t('contentAwareRepairFilling'),
            progress: 0.74,
          });
        }
        const repair = await runSurfaceAwareRepair(
          {
            width: repairResolution,
            height: repairResolution,
            rgba: workingImageData.data,
            writeMask: detectedGaps.mask,
            // The input is already the final quality-ranked composite of all
            // six projections. This FBX shares its complete UV atlas between
            // two surface components, so excluding conflict texels would
            // exclude every possible donor. The repair engine still excludes
            // the detected holes plus padding before propagating colour.
            topologyMask: topology.topologyMask,
            topologyRegionIds: topology.regionIds,
            seamLinks: topology.seamLinks,
            // Complete every reachable hatch-visible texel in one Worker pass.
            // The queue remains O(N), while topology regions and physical seam
            // links prevent atlas-space bleeding into unrelated surfaces.
            ...completionPolicy.propagation,
          },
          {
            signal: abortController.signal,
            transferOwnership: { rgba: true, writeMask: true },
            onProgress: silentForeground
              ? undefined
              : (progress) =>
                  setManualBakeProgress({
                    title: t('contentAwareRepair'),
                    detail: t('contentAwareRepairFilling'),
                    progress: 0.74 + progress.progress * 0.2,
                  }),
          },
        );
        reportRepairRunState('running', 'repair-worker-ready', {
          repairedPixels: repair.stats.repairedPixels,
          outputChecksum: repair.stats.outputChecksum,
        });
        console.info('[Liclick Content Aware] Surface repair', JSON.stringify(repair.stats));
        if (repair.stats.repairedPixels === 0) {
          throw new Error(t('contentAwareRepairNoReachableSource'));
        }
        // `filledRgba` is intentionally sparse: only successfully repaired gap
        // texels are opaque. It never contains a flattened copy of source layers.
        const repairTexture = new ImageData(repair.filledRgba, repairResolution, repairResolution);
        if (!silentForeground) {
          setManualBakeProgress({
            title: t('contentAwareRepair'),
            detail: t('contentAwareRepairFilling'),
            progress: 0.96,
          });
        }
        if (!benchmarkOnly) captureHistory('创建独立内容识别 UV 修补图层');
        const repairLayer = await addUvContentAwareRepairLayer(
          repairTexture,
          objectId,
          benchmarkOnly,
          abortController.signal,
          silentForeground,
        );
        if (!benchmarkOnly) setProjectLayers(useLayerStore.getState().layers);
        reportRepairRunState('complete', 'atomic-publish', {
          layerId: repairLayer.id,
          repairedPixels: repair.stats.repairedPixels,
          outputChecksum: repair.stats.outputChecksum,
        });
        options?.taskContext?.markFirstResult({ layerId: repairLayer.id });
        if (!benchmarkOnly && !silentForeground) {
          pushToast({
            tone: 'success',
            title: t('contentAwareFillComplete'),
            description: `${t('uvRepairLayerCreated')}: ${repairLayer.name} · ${repair.stats.repairedPixels.toLocaleString()} px`,
            dedupeKey: `content-aware-repair:${repairLayer.id}`,
          });
        }
      } catch (error) {
        if (
          (error instanceof Error && error.name === 'AbortError') ||
          contentAwareRepairAbortControllerRef.current !== abortController
        ) {
          reportRepairRunState('cancelled', 'cancelled');
          return;
        }
        reportRepairRunState('error', 'failed', {
          message: error instanceof Error ? error.message : String(error),
        });
        if (!silentForeground) setManualBakeProgress(undefined);
        if (!benchmarkOnly && !silentForeground) {
          pushToast({
            tone: 'error',
            title: t('localRepaintFailed'),
            description: error instanceof Error ? error.message : t('localRepaintFailedHelp'),
          });
        }
        if (benchmarkOnly) throw error;
      } finally {
        options?.taskContext?.signal.removeEventListener('abort', abortFromScheduler);
        delete document.body.dataset.perfUvBakePhase;
        if (contentAwareRepairAbortControllerRef.current === abortController) {
          contentAwareRepairRunningRef.current = false;
          setContentAwareRepairRunning(false);
          contentAwareRepairAbortControllerRef.current = undefined;
          if (!silentForeground) {
            manualBakeProgressTimerRef.current = window.setTimeout(
              () => setManualBakeProgress(undefined),
              1200,
            );
          }
        }
      }
    },
    [
      addUvContentAwareRepairLayer,
      captureHistory,
      project?.id,
      projectId,
      pushToast,
      setProjectLayers,
      t,
    ],
  );

  const runContentAwareRepair = useCallback(
    (
      requestedObjectId?: string,
      options?: { benchmarkOnly?: boolean; silentForeground?: boolean },
    ) => {
      const benchmarkOnly = options?.benchmarkOnly === true;
      const silentForeground = options?.silentForeground === true;
      const taskToken = Symbol('content-aware-repair');
      if (!silentForeground) {
        contentAwareRepairTaskTokenRef.current = taskToken;
        setContentAwareRepairTaskActive(true);
        setContentAwareRepairCancelling(false);
      }
      return scheduleEngineHeavyTask(engineSession, {
        key: 'full-resolution-texture',
        label: 'content-aware-repair',
        priority: 'user-visible',
        replace: !benchmarkOnly,
        onQueued: silentForeground
          ? undefined
          : () =>
              setManualBakeProgress({
                title: t('contentAwareRepair'),
                detail: '任务已排队，视口交互保持可用',
                progress: 0.01,
              }),
        run: (taskContext) =>
          executeContentAwareRepair(requestedObjectId, {
            benchmarkOnly,
            silentForeground,
            taskContext,
          }),
      })
        .catch((error) => {
          if (!benchmarkOnly && error instanceof Error && error.name === 'AbortError') return;
          throw error;
        })
        .finally(() => {
          if (silentForeground || contentAwareRepairTaskTokenRef.current !== taskToken) return;
          contentAwareRepairTaskTokenRef.current = undefined;
          setContentAwareRepairTaskActive(false);
          setContentAwareRepairCancelling(false);
        });
    },
    [engineSession, executeContentAwareRepair, t],
  );

  const interruptContentAwareRepair = useCallback(() => {
    if (!contentAwareRepairTaskTokenRef.current) return;
    setContentAwareRepairCancelling(true);
    setManualBakeProgress((progress) =>
      progress
        ? {
            ...progress,
            detail: '正在中断内容识别填补任务…',
            indeterminate: true,
          }
        : progress,
    );
    contentAwareRepairAbortControllerRef.current?.abort();
    cancelEngineHeavyTasks(engineSession, 'full-resolution-texture');
    pushToast({
      tone: 'info',
      title: '正在中断内容识别填补',
      description: '当前扫描、填补和图层写入会停止。',
      dedupeKey: 'content-aware-repair-interrupting',
    });
  }, [engineSession, pushToast]);

  useEffect(() => {
    if (!new URLSearchParams(window.location.search).has('perfLab')) return;
    const target = window as typeof window & {
      LiclickPerfContentAwareRepair?: {
        run: (objectId?: string) => Promise<{
          terminal: Record<string, unknown>;
          history: Array<Record<string, unknown>>;
        }>;
      };
    };
    target.LiclickPerfContentAwareRepair = {
      run: async (objectId) => {
        delete document.body.dataset.contentAwareRepairRun;
        delete document.body.dataset.contentAwareRepairPhaseHistory;
        await runContentAwareRepair(objectId, { benchmarkOnly: true });
        const terminal = JSON.parse(document.body.dataset.contentAwareRepairRun ?? '{}') as Record<
          string,
          unknown
        >;
        const history = JSON.parse(
          document.body.dataset.contentAwareRepairPhaseHistory ?? '[]',
        ) as Array<Record<string, unknown>>;
        if (terminal.status !== 'complete' && terminal.status !== 'no-gaps') {
          throw new Error(
            typeof terminal.message === 'string'
              ? terminal.message
              : '内容识别修复测试未发布完整结果。',
          );
        }
        return { terminal, history };
      },
    };
    return () => {
      delete target.LiclickPerfContentAwareRepair;
    };
  }, [runContentAwareRepair]);

  const handleContentAwareRepairFromToolbar = useCallback(() => {
    if (generationOperationLocked) {
      notifyEditorTaskRunning();
      return;
    }
    void runContentAwareRepair();
  }, [generationOperationLocked, notifyEditorTaskRunning, runContentAwareRepair]);

  useEffect(() => {
    const handleAutomaticContentAwareRepair = (event: Event) => {
      const request = (event as CustomEvent<ContentAwareRepairRequestDetail>).detail;
      if (!request || request.source !== 'multiview-texture') return;
      if (request.projectId && request.projectId !== projectId) return;
      request.handled = true;
      void runContentAwareRepair(request.objectId, {
        silentForeground: request.silentForeground,
      }).then(request.resolve, request.reject);
    };
    window.addEventListener(CONTENT_AWARE_REPAIR_REQUEST_EVENT, handleAutomaticContentAwareRepair);
    return () =>
      window.removeEventListener(
        CONTENT_AWARE_REPAIR_REQUEST_EVENT,
        handleAutomaticContentAwareRepair,
      );
  }, [projectId, runContentAwareRepair]);

  useEffect(() => {
    function isEditingText(target: EventTarget | null) {
      if (!(target instanceof HTMLElement)) return false;
      return (
        target instanceof HTMLInputElement ||
        target instanceof HTMLTextAreaElement ||
        target instanceof HTMLSelectElement ||
        target.isContentEditable
      );
    }

    function handleEditorShortcuts(event: KeyboardEvent) {
      if (isEditingText(event.target)) return;
      if (document.querySelector('[data-shortcut-dialog]')) return;
      if (document.querySelector('[data-editor-shortcut-scope]')) return;
      const currentWorkspaceMode = useWorkspaceLayoutStore.getState().mode;
      const sceneState = useSceneStore.getState();
      const layerState = useLayerStore.getState();

      // Blender view conventions: numpad views, Ctrl for the opposite side.
      const viewPreset = (
        [
          ['view.front', 'front'],
          ['view.back', 'back'],
          ['view.right', 'right'],
          ['view.left', 'left'],
          ['view.top', 'top'],
          ['view.bottom', 'bottom'],
        ] as const
      ).find(([actionId]) => shortcutMatches(event, actionId));
      if (viewPreset) {
        event.preventDefault();
        setCameraToObjectView(sceneState.selectedObjectId, viewPreset[1]);
        return;
      }
      if (shortcutMatches(event, 'view.toggleProjection')) {
        event.preventDefault();
        sceneState.setProjectionMode(
          sceneState.projectionMode === 'perspective' ? 'orthographic' : 'perspective',
        );
        return;
      }

      // F / Numpad . keeps the current view but relocates the orbit pivot to the model.
      if (shortcutMatches(event, 'view.focus')) {
        event.preventDefault();
        const modelName = focusCameraOrbitOnObjectId(sceneState.selectedObjectId);
        pushToast({
          tone: modelName ? 'success' : 'warning',
          title: modelName ? '已聚焦当前模型' : t('importModelFirst'),
          description: modelName ? `旋转中心已定位到 ${modelName}` : undefined,
          dedupeKey: 'focus-current-model-shortcut',
        });
        return;
      }

      const taskBlockedShortcut = EDITOR_TASK_LOCKED_SHORTCUTS.some((actionId) =>
        shortcutMatches(event, actionId),
      );
      if (editorTaskRunning && taskBlockedShortcut) {
        event.preventDefault();
        event.stopImmediatePropagation();
        notifyEditorTaskRunning();
        return;
      }

      if (shortcutMatches(event, 'scene.arrange')) {
        event.preventDefault();
        if (sceneState.importedModels.length === 0) {
          pushToast({ tone: 'warning', title: t('importModelFirst') });
          return;
        }
        captureHistory(t('arrangeModels'));
        sceneState.arrangeImportedModels();
        updateCurrentProject({ objects: useSceneStore.getState().objects });
        pushToast({
          tone: 'success',
          title: t('modelsArranged'),
          description: 'Ctrl+Shift+A',
          dedupeKey: 'models-arranged',
        });
        return;
      }

      if (currentWorkspaceMode === 'texture' && shortcutMatches(event, 'texture.clearMask')) {
        event.preventDefault();
        if (!runPaintMaskHistoryAction('clear')) sceneState.clearPaintMask();
        return;
      }
      if (currentWorkspaceMode === 'texture' && shortcutMatches(event, 'texture.duplicateLayer')) {
        event.preventDefault();
        const activeLayer = layerState.layers.find(
          (layer) => layer.id === layerState.activeProjectedLayerId,
        );
        if (!activeLayer) {
          pushToast({ tone: 'warning', title: '请先选择要复制的图层' });
          return;
        }
        captureHistory(`复制图层：${activeLayer.name}`);
        layerState.duplicateLayer(activeLayer.id);
        return;
      }
      if (currentWorkspaceMode === 'texture' && shortcutMatches(event, 'texture.invertMask')) {
        event.preventDefault();
        if (!runPaintMaskHistoryAction('invert')) sceneState.invertPaintMask();
        return;
      }
      if (currentWorkspaceMode === 'texture' && shortcutMatches(event, 'texture.newLayer')) {
        event.preventDefault();
        captureHistory('创建空图层');
        layerState.addEmptyLayer();
        return;
      }
      const moveLayerDirection = shortcutMatches(event, 'texture.moveLayerUp')
        ? 'up'
        : shortcutMatches(event, 'texture.moveLayerDown')
          ? 'down'
          : undefined;
      if (currentWorkspaceMode === 'texture' && moveLayerDirection) {
        event.preventDefault();
        const activeLayer = layerState.layers.find(
          (layer) => layer.id === layerState.activeProjectedLayerId,
        );
        if (!activeLayer) return;
        captureHistory(`${moveLayerDirection === 'up' ? '上移' : '下移'}图层：${activeLayer.name}`);
        layerState.moveLayer(activeLayer.id, moveLayerDirection);
        return;
      }
      if (currentWorkspaceMode === 'texture' && shortcutMatches(event, 'texture.showAllLayers')) {
        event.preventDefault();
        captureHistory('显示全部图层');
        layerState.setLayerVisibility(
          layerState.layers.map((layer) => layer.id),
          true,
        );
        return;
      }
      if (currentWorkspaceMode !== 'texture') {
        const transformShortcut = (
          [
            ['scene.select', 'select'],
            ['scene.translate', 'translate'],
            ['scene.rotate', 'rotate'],
            ['scene.scale', 'scale'],
          ] as const
        ).find(([actionId]) => shortcutMatches(event, actionId));
        if (transformShortcut) {
          event.preventDefault();
          sceneState.setTransformMode(transformShortcut[1]);
        }
        return;
      }

      if (shortcutMatches(event, 'texture.toggleLayer')) {
        event.preventDefault();
        const activeLayer = layerState.layers.find(
          (layer) => layer.id === layerState.activeProjectedLayerId,
        );
        if (!activeLayer) return;
        captureHistory(`切换图层显隐：${activeLayer.name}`);
        layerState.toggleLayer(activeLayer.id);
        return;
      }
      if (shortcutMatches(event, 'texture.select')) {
        event.preventDefault();
        sceneState.setPaintTool('none');
        sceneState.setTransformMode('select');
        return;
      }
      if (shortcutMatches(event, 'texture.eraser')) {
        event.preventDefault();
        if (sceneState.paintTool === 'eraser') {
          sceneState.setPaintTool('none');
          return;
        }
        const activeLayer = layerState.layers.find(
          (layer) => layer.id === layerState.activeProjectedLayerId,
        );
        const eraserPolicy = getEraserTargetPolicy(activeLayer);
        if (!activeLayer?.visible || !eraserPolicy.canActivate) {
          pushToast({
            tone: eraserPolicy.requiresEditableUvCopy ? 'info' : 'warning',
            title: eraserPolicy.label,
            description:
              eraserPolicy.reason ??
              (activeLayer?.visible ? '当前图层不能使用橡皮擦。' : '请先显示当前图层。'),
            dedupeKey: `layer-eraser-shortcut:${activeLayer?.id ?? 'none'}`,
          });
          return;
        }
        sceneState.setPaintTool('eraser');
        return;
      }
      const brushSizeDirection = shortcutMatches(event, 'texture.brushSmaller')
        ? -1
        : shortcutMatches(event, 'texture.brushLarger')
          ? 1
          : 0;
      if (brushSizeDirection !== 0) {
        event.preventDefault();
        const direction = brushSizeDirection;
        const state = sceneState;
        const stepBrushSize = (value: number, min: number, max: number) => {
          const step = value < 1 ? 0.1 : value < 10 ? 1 : value < 60 ? 5 : 10;
          return Math.max(min, Math.min(max, Number((value + direction * step).toFixed(1))));
        };

        if (state.paintTool === 'eraser') {
          const nextSize = stepBrushSize(state.paintToolSettings.eraserSize, 0.5, 256);
          state.setPaintToolSettings({ eraserSize: nextSize });
          pushToast({
            tone: 'info',
            title: `橡皮大小 ${nextSize.toFixed(nextSize % 1 ? 1 : 0)}px`,
            description: '[ / ] 调整大小',
            dedupeKey: 'brush-size-shortcut',
          });
          return;
        }

        if (
          state.paintTool === 'inpaint-add' ||
          state.paintTool === 'inpaint-subtract' ||
          state.paintTool === 'inpaint-apply'
        ) {
          const nextSize = stepBrushSize(
            state.paintMaskSettings.brushSize,
            MIN_PAINT_MASK_BRUSH_SIZE,
            MAX_PAINT_MASK_BRUSH_SIZE,
          );
          state.setPaintMaskSettings({ brushSize: nextSize });
          pushToast({
            tone: 'info',
            title: `局部重绘画笔 ${nextSize.toFixed(nextSize % 1 ? 1 : 0)}px`,
            description: '[ / ] 调整大小',
            dedupeKey: 'brush-size-shortcut',
          });
          return;
        }

        return;
      }
      if (shortcutMatches(event, 'texture.maskAdd')) {
        sceneState.setPaintTool(sceneState.paintTool === 'inpaint-add' ? 'none' : 'inpaint-add');
        return;
      }
      if (shortcutMatches(event, 'texture.maskSubtract')) {
        sceneState.setPaintTool(
          sceneState.paintTool === 'inpaint-subtract' ? 'none' : 'inpaint-subtract',
        );
        return;
      }
      if (shortcutMatches(event, 'texture.localRepaint')) handleLocalRepaintFromToolbar();
    }

    window.addEventListener('keydown', handleEditorShortcuts);
    return () => window.removeEventListener('keydown', handleEditorShortcuts);
  }, [
    captureHistory,
    editorTaskRunning,
    handleLocalRepaintFromToolbar,
    notifyEditorTaskRunning,
    pushToast,
    t,
    updateCurrentProject,
  ]);

  const panelDefinitions = (
    [
      {
        id: 'objects',
        title: t('objectsPanel'),
        dock: 'left',
        order: 5,
        collapsed: workspacePanels.find((panel) => panel.id === 'objects')?.collapsed ?? false,
        visible: true,
        mode: 'all',
        actions: (
          <ObjectsPanelActions
            onImportModelClick={() => {
              if (modelMutationLocked) {
                notifyEditorTaskRunning();
                return;
              }
              modelInputRef.current?.click();
            }}
            importDisabled={modelImportBusy || modelMutationLocked}
            mutationLocked={modelMutationLocked}
            onMutationLocked={notifyEditorTaskRunning}
          />
        ),
        content: (
          <ObjectsPanel
            mutationLocked={modelMutationLocked}
            onMutationLocked={notifyEditorTaskRunning}
          />
        ),
      },
      {
        id: 'objectTransform',
        title: t('objectTransform'),
        dock: 'right',
        order: 5,
        collapsed:
          workspacePanels.find((panel) => panel.id === 'objectTransform')?.collapsed ?? false,
        visible: workspacePanels.find((panel) => panel.id === 'objectTransform')?.visible ?? false,
        mode: 'scene',
        content: (
          <ObjectTransformPanel
            transformLocked={editorToolsLocked}
            onTransformLocked={notifyEditorTaskRunning}
          />
        ),
      },
      {
        id: 'generate',
        title: t('generatePanel'),
        dock: 'left',
        order: 40,
        collapsed: workspacePanels.find((panel) => panel.id === 'generate')?.collapsed ?? true,
        visible: true,
        mode: 'texture',
        content: (
          <GeneratePanel
            workspaceActive={isActive}
            localImageGenerationRequestKey={localImageGenerationRequestKey}
            onRequestLocalImageGeneration={handleLocalImageGenerationFromToolbar}
            onLocalImageGenerationSettled={handleLocalImageGenerationSettled}
            cancelActiveGenerationRequestKey={cancelActiveGenerationRequestKey}
            // GeneratePanel owns its own local/multiview generation state. Do
            // not feed the toolbar-to-panel local request bridge back as an
            // external lock: the panel must be allowed to consume that exact
            // request before it can publish its running generation record.
            interactionLocked={contentAwareRepairRunning}
            onInteractionLocked={notifyEditorTaskRunning}
            onTaskRunningChange={setGeneratePanelTaskState}
          />
        ),
      },
      {
        id: 'viewport',
        title: t('viewport'),
        dock: 'right',
        order: 20,
        collapsed: workspacePanels.find((panel) => panel.id === 'viewport')?.collapsed ?? true,
        visible: true,
        mode: 'all',
        content: (
          <div data-task-preview-allowed="true">
            <ViewportPanel />
          </div>
        ),
      },
      {
        id: 'referenceImages',
        title: t('referenceImage'),
        dock: 'right',
        order: 25,
        collapsed:
          workspacePanels.find((panel) => panel.id === 'referenceImages')?.collapsed ?? false,
        visible: true,
        mode: 'scene',
        actions: (
          <label
            htmlFor="scene-reference-upload"
            className="grid h-7 w-7 cursor-pointer place-items-center rounded-md text-white/82 transition hover:bg-white/10 hover:text-white"
            title={t('uploadReference')}
            aria-label={t('uploadReference')}
          >
            <Plus className="h-4 w-4" />
          </label>
        ),
        content: (
          <ReferenceImagePicker
            compact
            inputId="scene-reference-upload"
            filterBySelectedObject={false}
            mutationLocked={modelMutationLocked}
            onMutationLocked={notifyEditorTaskRunning}
          />
        ),
      },
      {
        id: 'layers',
        title: t('layers'),
        dock: 'right',
        order: 30,
        collapsed: workspacePanels.find((panel) => panel.id === 'layers')?.collapsed ?? true,
        visible: true,
        mode: 'texture',
        actions: (
          <LayersPanelActions
            onContentAwareRepair={handleContentAwareRepairFromToolbar}
            onMergeVisibleProjectedToUvLayer={(layerIds) => void mergeLayersToUvLayer(layerIds)}
            adjustmentsOpen={layerAdjustmentsOpen}
            onToggleAdjustments={() => setLayerAdjustmentsOpen((open) => !open)}
            mutationLocked={modelMutationLocked}
            onMutationLocked={notifyEditorTaskRunning}
          />
        ),
        content: (
          <div className="space-y-2">
            {layerAdjustmentsOpen && (
              <div className="rounded-md border border-white/16 bg-white/[0.035] p-2">
                <LayerAdjustmentsPanel />
              </div>
            )}
            <LayersPanel
              onLayerImageReplace={(layer, file) => void replaceLayerImage(layer, file)}
              onLayerLocalRepaint={(layer) => void openLayerLocalRepaint(layer)}
              onMergeSelectedToUvLayer={(layerIds) => void mergeLayersToUvLayer(layerIds)}
              onMergeIntoSelectedBlankUvLayer={(layerIds, blankUvLayerId) =>
                void mergeLayersToUvLayer(layerIds, blankUvLayerId)
              }
              mutationLocked={modelMutationLocked}
              onMutationLocked={notifyEditorTaskRunning}
            />
          </div>
        ),
      },
      {
        id: 'normalVisualizer',
        title: t('normalVisualizer'),
        dock: 'left',
        order: 10,
        collapsed:
          workspacePanels.find((panel) => panel.id === 'normalVisualizer')?.collapsed ?? false,
        visible: true,
        mode: 'normal',
        content: (
          <WorkspaceModeShell
            title={t('normalPreview')}
            description={t('normalPreviewDescription')}
          />
        ),
      },
      {
        id: 'normalGeneration',
        title: t('normalGeneration'),
        dock: 'right',
        order: 10,
        collapsed:
          workspacePanels.find((panel) => panel.id === 'normalGeneration')?.collapsed ?? false,
        visible: true,
        mode: 'normal',
        content: (
          <WorkspaceModeShell
            title={t('comingSoon')}
            description={t('normalGenerationDescription')}
          />
        ),
      },
      {
        id: 'export',
        title: t('export'),
        dock: 'right',
        order: 10,
        collapsed: workspacePanels.find((panel) => panel.id === 'export')?.collapsed ?? false,
        visible: true,
        mode: 'export',
        content: (
          <WorkspaceModeShell
            title={t('exportWorkspace')}
            description={t('exportWorkspaceDescription')}
          >
            <div className="grid gap-2">
              <Button
                className="w-full"
                disabled={!importedModel || !viewport}
                onClick={() => handleExportAction('scene-glb')}
                title={!importedModel ? t('importModelFirst') : undefined}
              >
                {t('exportSceneGlb')}
              </Button>
              <Button
                className="w-full"
                disabled={!importedModel || !viewport}
                onClick={() => handleExportAction('viewport-png')}
                title={!importedModel ? t('importModelFirst') : undefined}
              >
                {t('viewportSnapshot')}
              </Button>
              <Button
                className="w-full"
                disabled={!importedModel}
                onClick={handleExportBaseColorDownload}
                icon={<Download className="h-4 w-4" />}
                title={!importedModel ? t('importModelFirst') : undefined}
              >
                {t('downloadBaseColor')}
              </Button>
            </div>
          </WorkspaceModeShell>
        ),
      },
    ] satisfies WorkspacePanelDefinition[]
  ).map((definition) => {
    const storedPanel = workspacePanels.find((panel) => panel.id === definition.id);
    return {
      ...definition,
      collapsed: storedPanel?.collapsed ?? definition.collapsed,
    };
  });

  if (!project || !isEditorProjectServerReady(projectId, serverReadyProjectId)) {
    return (
      <main className="liclick-surface grid min-h-screen place-items-center px-6 text-white">
        <section className="w-full max-w-md rounded-lg border border-white/12 bg-black/34 p-6 text-center shadow-[0_22px_70px_rgba(0,0,0,0.38)] backdrop-blur-md">
          {routeProjectStatus !== 'missing' && (
            <LoaderCircle className="mx-auto mb-4 h-9 w-9 animate-spin text-fuchsia-400" />
          )}
          <div className="text-lg font-semibold">
            {routeProjectStatus === 'missing' ? t('projectLoadFailed') : t('projectLoading')}
          </div>
          <p className="mt-2 text-sm leading-6 text-white/54">
            {routeProjectStatus === 'missing'
              ? t('projectLoadFailedHelp')
              : t('projectLoadingHelp')}
          </p>
          <Button className="mt-5" onClick={onBack}>
            {t('projects')}
          </Button>
        </section>
      </main>
    );
  }

  return (
    <>
      <input
        ref={modelInputRef}
        type="file"
        className="hidden"
        accept=".glb,.gltf,.fbx,.obj,.png,.jpg,.jpeg,.webp,.bmp,.tga"
        multiple
        disabled={modelImportBusy || modelMutationLocked}
        onChange={(event) => {
          if (modelMutationLocked) {
            notifyEditorTaskRunning();
            event.target.value = '';
            return;
          }
          const files = event.target.files ? Array.from(event.target.files) : [];
          if (files.length > 0) void handleImportModels(files);
        }}
      />
      <input
        ref={projectInputRef}
        type="file"
        className="hidden"
        accept="application/json,.json,.liclick.json"
        disabled={modelMutationLocked}
        onChange={(event) => {
          if (modelMutationLocked) {
            notifyEditorTaskRunning();
            event.target.value = '';
            return;
          }
          const file = event.target.files?.item(0);
          if (file) void handleLoadProject(file);
        }}
      />
      <div
        className="contents"
        onPointerDownCapture={handleLockedEditorInteraction}
        onClickCapture={handleLockedEditorInteraction}
      >
        <EditorShell
          projectName={project?.name ?? 'Untitled Project'}
          workspaceLabel={getWorkspaceLabel()}
          onRenameProject={handleRenameProject}
          onBack={handleBackToProjects}
          workflowSwitcher={
            <WorkflowModuleSwitcher
              compact
              activeModule="texture"
              pendingModule={
                publishingToRetopology ? 'retopology' : publishingToBake ? 'bake' : undefined
              }
              onOpenTexture={() => undefined}
              onOpenRetopology={() => void handlePublishToRetopology()}
              onOpenUv={handleOpenUv}
              onOpenBake={() => void handleOpenBake()}
            />
          }
          exportMenu={
            <ExportMenu
              canExportScene={Boolean(importedModel && viewport)}
              canExportObject={Boolean(importedModel && selectedObjectId)}
              canExportColor={Boolean(activeLayer && activeColorTextureUrl)}
              canExportNormal={Boolean(normalMapTexture || normalLayer?.imageUrl)}
              canRecordTurntable={canRecordTurntableInBrowser()}
              onExport={handleExportAction}
              labels={{
                export: t('export'),
                scene: t('scene'),
                object: t('object'),
                texture: t('texture'),
                video: t('video'),
                viewportSnapshot: t('viewportSnapshot'),
                turntable: t('turntable'),
                color: t('color'),
                normal: t('normal'),
                bakeFirst: t('bakeBaseColorFirst'),
                importModelFirst: t('importModelFirst'),
                selectObjectFirst: t('selectObjectFirst'),
                normalTextureMissing: t('normalTextureMissing'),
                browserUnsupported: t('browserUnsupported'),
              }}
            />
          }
          bottomToolbar={
            <BottomToolDock
              mode={workspaceMode}
              transformMode={transformMode}
              paintTool={paintTool}
              onTransformModeChange={setTransformMode}
              onPaintToolChange={setPaintTool}
              onLocalImageGeneration={handleLocalImageGenerationFromToolbar}
              onLocalRepaint={handleLocalRepaintFromToolbar}
              localImageGenerationRunning={localImageGenerationRunning}
              localImageGenerationSuccessKey={localImageGenerationSuccessKey}
              canLocalRepaint={localRepaintGenerationReady && localRepaintInteractiveReady}
              canQueueLocalRepaintActivation={canQueueLocalRepaintActivation}
              localRepaintActivationQueued={localRepaintActivationQueued}
              canUndo={canUndo}
              canRedo={canRedo}
              onUndo={undo}
              onRedo={redo}
              interactionLocked={editorToolsLocked}
              onInteractionLocked={notifyEditorTaskRunning}
              labels={{
                select: t('select'),
                move: t('move'),
                rotate: t('rotate'),
                scale: t('scale'),
                layers: t('layers'),
                localRepaint: t('localRepaint'),
                inpaintSelect: t('inpaintSelect'),
                inpaintUnselect: t('inpaintUnselect'),
                undo: t('undo'),
                redo: t('redo'),
                eraser: t('eraser'),
                brushSize: t('brushSize'),
                brushFeather: t('imageEditBrushFeather'),
                resetInpaintRegion: t('resetInpaintRegion'),
                invertInpaintRegion: t('invertInpaintRegion'),
                selectHelp: t('selectToolHelp'),
                moveHelp: t('moveToolHelp'),
                rotateHelp: t('rotateToolHelp'),
                scaleHelp: t('scaleToolHelp'),
                layersHelp: t('layersToolHelp'),
                eraserToolHelp: t('eraserToolHelp'),
                localRepaintHelp: t('localRepaintToolHelp'),
                inpaintSelectHelp: t('inpaintSelectToolHelp'),
                inpaintUnselectHelp: t('inpaintUnselectToolHelp'),
                viewportOrbit: t('viewportOrbit'),
                viewportOrbitHelp: t('viewportOrbitHelp'),
              }}
            />
          }
          center={
            <ViewportCanvas
              hasImportedModel={Boolean(importedModel)}
              onImportModels={(files) => {
                if (modelMutationLocked) {
                  notifyEditorTaskRunning();
                  return;
                }
                void handleImportModels(files);
              }}
              onImportReferenceImages={(files, sourceUrls) => {
                if (editorTaskRunning) {
                  notifyEditorTaskRunning();
                  return;
                }
                void handleImportReferenceImages(files, sourceUrls);
              }}
              onOpenImport={() => {
                if (modelMutationLocked) {
                  notifyEditorTaskRunning();
                  return;
                }
                modelInputRef.current?.click();
              }}
              importDisabled={modelImportBusy || modelMutationLocked}
              isActive={isActive}
            />
          }
          panels={panelDefinitions}
        />
      </div>
      {!editorTaskRunning && (
        <TextureOnboardingTour
          projectId={project.id}
          projectCreatedAt={project.createdAt}
          forceStart={showOnboarding}
        />
      )}
      {pendingReferenceImport ? (
        <ReferenceImportDialog
          references={pendingReferenceImport}
          onImport={confirmReferenceImageImport}
          onClose={() => setPendingReferenceImport(undefined)}
        />
      ) : null}
      {localRepaintRuntime && localRepaintVisible && (
        <LocalRepaintDialog
          mode={localRepaintRuntime.mode}
          workingImageUrl={localRepaintRuntime.workingImageUrl}
          objectMask={localRepaintRuntime.objectMask}
          holeMask={localRepaintRuntime.holeMask}
          initialUserMask={localRepaintRuntime.initialUserMask}
          targetName={localRepaintRuntime.targetName}
          references={references}
          onGenerate={generateLocalRepaint}
          onContentAwareFill={fillLocalRepaintContentAware}
          onAbort={abortLocalRepaint}
          onAccept={acceptLocalRepaint}
          onCancel={cancelLocalRepaintDialog}
          status={localRepaintRuntime.status}
          previewUrl={localRepaintRuntime.previewUrl}
          error={localRepaintRuntime.error}
        />
      )}
      {photoshopEditSession ? (
        <PhotoshopEditSessionPanel
          session={photoshopEditSession}
          busy={photoshopEditBusy}
          onSync={() => void handlePhotoshopSyncNow()}
          onApply={() => void handlePhotoshopApply()}
          onCancel={handlePhotoshopCancel}
          onLaunch={() => void handlePhotoshopLaunch()}
        />
      ) : null}
      {modelImportProgress
        ? createPortal(<AutoBakeProgressBar progress={modelImportProgress} />, document.body)
        : manualBakeProgress
          ? createPortal(
              <AutoBakeProgressBar
                progress={manualBakeProgress}
                onCancel={contentAwareRepairTaskActive ? interruptContentAwareRepair : undefined}
                cancelling={contentAwareRepairCancelling}
              />,
              document.body,
            )
          : null}
    </>
  );
}
