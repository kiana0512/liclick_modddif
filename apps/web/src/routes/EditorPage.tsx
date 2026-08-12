import { startTransition, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Download, Plus } from 'lucide-react';
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
} from '@/features/projects/projectThumbnailPolicy';
import { neutralizeUntexturedThumbnailMaterials } from '@/features/projects/projectThumbnailMaterials';
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
import { GeneratePanel } from '@/components/panels/GeneratePanel';
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
import { PerfScenarioLoader } from '@/dev/PerfScenarioLoader';
import { applyBakedTextureToObject } from '@/engine/bake/applyBakedTexture';
import { bakeVisibleProjectedLayersToTexture } from '@/engine/bake/bakeProjectedLayerToTexture';
import { resolveImageAssetUrl } from '@/engine/bake/imageSampler';
import {
  buildContentAwareRepairMask,
  buildContentAwareSurfaceTopology,
  CONTENT_AWARE_REPAIR_REQUEST_EVENT,
  runSurfaceAwareRepair,
  type ContentAwareRepairRequestDetail,
} from '@/engine/contentAware';
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
  isLiveProjectedCanvasUrl,
} from '@/engine/projection/liveProjectedCanvasTextureRegistry';
import {
  createProjectionMaskedImage,
  prewarmMaskedProjectedImageWorker,
} from '@/engine/projection/createMaskedProjectedImage';
import { isLocalRepaintProjectedLayer } from '@/engine/bake/projectedOverlayComposition';
import { syncProjectedLayerMaterialProjection } from '@/engine/projection/ProjectedLayerMaterial';
import { loadModelFromFile, loadModelFromUrl } from '@/engine/loaders/loadModelFromFile';
import {
  getModelImportBatchProgress,
  isModelImportProgressIndeterminate,
  type ModelImportPhase,
  type ModelImportProgressEvent,
} from '@/engine/loaders/modelImportProgress';
import { getImportedBaseColorTextureUrl } from '@/engine/loaders/modelLoadUtils';
import { placeImportedModelBesideScene } from '@/engine/scene/placeImportedModelBesideScene';
import { getBoundingBoxForObject } from '@/engine/scene/boundingBoxUtils';
import {
  bakePbrPreviewLightingIntoUv,
  compositeRgbaUnderInPlace,
  compositeRenderedColorMaskUnderInPlace,
  compositeUniformRenderedColorUnderInPlace,
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
import { ensureLocalRepaintSessionLayer } from '@/engine/localRepaint/sessionLayer';
import {
  prewarmPreviewTextures,
  releasePreviewTexture,
} from '@/engine/viewport/previewTextureCache';
import type { ModelLoadResult } from '@/engine/loaders/modelImportTypes';
import { focusCameraOrbitOnObjectId, setCameraToObjectView } from '@/engine/scene/transformActions';
import { applySerializedCamera, serializeCamera } from '@/engine/projection/ProjectionCamera';
import { ViewportCanvas } from '@/engine/viewport/ViewportCanvas';
import { isViewportInteractionBusy } from '@/engine/viewport/viewportInteractionState';
import {
  markPerformanceEvent,
  startPerformanceSpan,
} from '@/engine/performance/performanceTimeline';
import {
  cancelHeavyTasks,
  scheduleHeavyTask,
  type HeavyTaskContext,
} from '@/engine/performance/heavyTaskScheduler';
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
import { ensurePersonalLiclickAccountForUser } from '@/services/liclickAccountBindingFlow';
import { resolveLiclickAuthStrategy } from '@/services/liclickAuthStrategy';
import { hasTrackedModuleAction, trackModuleActionOnce } from '@/services/telemetryClient';
import {
  fileToDataUrl,
  getWorkspaceHealth,
  isTrustedGenerationWorkspaceAssetUrl,
  isWorkspaceAssetUrl,
  loadProject as loadWorkspaceProject,
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
import { shortcutMatches } from '@/stores/shortcutStore';
import { useToastStore } from '@/stores/toastStore';
import type { BakeProgress, UvBakeResolution } from '@/engine/bake/uvBakeTypes';
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
import { mapWithConcurrency } from '@/utils/mapWithConcurrency';

type EditorPageProps = {
  projectId: string;
  onBack: () => void;
  onOpenRetopology: () => void;
  onOpenUv: () => void;
  onOpenBake: (handoff?: TextureBakeHandoff) => void;
  autoOpenBake?: boolean;
  pendingBakeHandoff?: TextureBakeHandoff;
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

async function waitForProjectRestoreIdle(timeoutMs = 800) {
  while (isViewportInteractionBusy()) {
    await new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()));
  }
  await new Promise<void>((resolve) => {
    const scheduleIdle = () => {
      if (typeof window.requestIdleCallback === 'function') {
        window.requestIdleCallback(() => resolve(), { timeout: timeoutMs });
        return;
      }
      window.setTimeout(resolve, 0);
    };
    window.requestAnimationFrame(() => scheduleIdle());
  });
  if (isViewportInteractionBusy()) {
    await waitForProjectRestoreIdle(timeoutMs);
  }
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

function getGenerationObjectMatrixWorld(generation: Generation) {
  const value = generation.metadata.objectMatrixWorld;
  if (!Array.isArray(value) || value.length !== 16) return undefined;
  return value.every((item) => typeof item === 'number') ? value : undefined;
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
  return !layer.objectId || layer.objectId === objectId;
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
  if (!layer || layer.type !== 'uv' || (layer.objectId && layer.objectId !== objectId))
    return false;
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

export function EditorPage({
  projectId,
  onBack,
  onOpenRetopology,
  onOpenUv,
  onOpenBake,
  autoOpenBake = false,
  pendingBakeHandoff,
}: EditorPageProps) {
  const modelInputRef = useRef<HTMLInputElement>(null);
  const projectInputRef = useRef<HTMLInputElement>(null);
  const loadedProjectIdRef = useRef<string>();
  const routeProjectLoadRevisionRef = useRef(0);
  const restoredModelKeyRef = useRef<string>();
  const modelRestoreRequestRef = useRef(0);
  const hydratedProjectVersionRef = useRef<string>();
  const skipProjectStoreSyncRef = useRef({
    layers: false,
    generations: false,
    references: false,
  });
  const autosaveTimerRef = useRef<number>();
  const manualSaveHandlerRef = useRef<() => void>(() => undefined);
  const immediateSaveHandlerRef = useRef<() => void>(() => undefined);
  const manualSaveRunningRef = useRef(false);
  const pendingImmediateSaveRef = useRef(false);
  const workspaceSaveQueueRef = useRef<Promise<void>>(Promise.resolve());
  const backNavigationPendingRef = useRef(false);
  const manualBakeRunningRef = useRef(false);
  const manualBakeProgressTimerRef = useRef<number>();
  const automaticBakeEntryRef = useRef<string>();
  const modelImportRunningRef = useRef(false);
  const modelImportRevisionRef = useRef(0);
  const modelImportProgressTimerRef = useRef<number>();
  const contentAwareRepairRunningRef = useRef(false);
  const contentAwareRepairAbortControllerRef = useRef<AbortController>();
  const localRepaintProjectionImageCacheRef = useRef(new Map<string, Promise<string>>());
  const localRepaintToolRequestRevisionRef = useRef(0);
  const standardProjectThumbnailCaptureRef = useRef<() => string | undefined>(() => undefined);
  const thumbnailRefreshTimerRef = useRef<number>();
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
  const [manualBakeProgress, setManualBakeProgress] = useState<AutoBakeProgress | undefined>();
  const [modelImportBusy, setModelImportBusy] = useState(false);
  const [layerAdjustmentsOpen, setLayerAdjustmentsOpen] = useState(false);
  const [localImageGenerationRequestKey, setLocalImageGenerationRequestKey] = useState(0);
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
  const replaceCurrentProject = useProjectStore((state) => state.replaceCurrentProject);
  const updateCurrentProject = useProjectStore((state) => state.updateCurrentProject);
  const updateProjectById = useProjectStore((state) => state.updateProjectById);
  const markSavedById = useProjectStore((state) => state.markSavedById);
  const setObjects = useSceneStore((state) => state.setObjects);
  const objects = useSceneStore((state) => state.objects);
  const setImportedModel = useSceneStore((state) => state.setImportedModel);
  const restoreImportedModels = useSceneStore((state) => state.restoreImportedModels);
  const clearImportedModel = useSceneStore((state) => state.clearImportedModel);
  const importedModel = useSceneStore((state) => state.importedModel);
  const viewport = useSceneStore((state) => state.viewport);
  const importSettings = useSceneStore((state) => state.importSettings);
  const transformMode = useSceneStore((state) => state.transformMode);
  const setTransformMode = useSceneStore((state) => state.setTransformMode);
  const paintTool = useSceneStore((state) => state.paintTool);
  const setPaintTool = useSceneStore((state) => state.setPaintTool);
  const paintMaskDataUrl = useSceneStore((state) => state.paintMaskDataUrl);
  const paintMaskHasContent = useSceneStore((state) => state.paintMaskHasContent);
  const paintMaskRevision = useSceneStore((state) => state.paintMaskRevision);
  const setLocalRepaintProjectionSource = useSceneStore(
    (state) => state.setLocalRepaintProjectionSource,
  );
  const selectedObjectId = useSceneStore((state) => state.selectedObjectId);
  const setLayers = useLayerStore((state) => state.setLayers);
  const setActiveLayer = useLayerStore((state) => state.setActiveLayer);
  const layers = useLayerStore((state) => state.layers);
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
  const activeLayer = layers.find((layer) => layer.id === activeProjectedLayerId);
  const localRepaintGenerationReady = useMemo(() => {
    const preferredObjectId = selectedObjectId ?? importedModel?.objectId;
    return generations.some(
      (generation) =>
        generation.status === 'succeeded' &&
        Boolean(generation.resultUrl) &&
        isLocalRepaintGeneration(generation) &&
        generation.metadata.paintMaskRevision === paintMaskRevision &&
        (!generation.metadata.projectId || generation.metadata.projectId === projectId) &&
        (!preferredObjectId ||
          !generation.metadata.objectId ||
          generation.metadata.objectId === preferredObjectId),
    );
  }, [generations, importedModel?.objectId, paintMaskRevision, projectId, selectedObjectId]);
  const localImageGenerationRunning = useMemo(() => {
    const preferredObjectId = selectedObjectId ?? importedModel?.objectId;
    return generations.some(
      (generation) =>
        (generation.status === 'queued' || generation.status === 'running') &&
        isLocalRepaintGeneration(generation) &&
        generation.metadata.paintMaskRevision === paintMaskRevision &&
        (!generation.metadata.projectId || generation.metadata.projectId === projectId) &&
        (!preferredObjectId ||
          !generation.metadata.objectId ||
          generation.metadata.objectId === preferredObjectId),
    );
  }, [generations, importedModel?.objectId, paintMaskRevision, projectId, selectedObjectId]);
  const activeBakedTexture = project?.bakedTextures.find(
    (texture) => texture.id === activeLayer?.bakedTextureId,
  );
  const activeColorTextureUrl =
    activeLayer?.type === 'uv' && activeLayer.imageUrl
      ? activeLayer.imageUrl
      : activeBakedTexture?.imageUrl;
  const currentTextureObjectId = selectedObjectId ?? importedModel?.objectId;
  const currentObjectBaseColor = selectBakeBaseColor(
    project ? { layers, bakedTextures: project.bakedTextures } : undefined,
    currentTextureObjectId,
  );
  const normalLayer = layers.find(
    (layer) =>
      layer.type === 'normal' &&
      Boolean(layer.imageUrl) &&
      (!selectedObjectId || !layer.objectId || layer.objectId === selectedObjectId),
  );
  const normalMapTexture = findNormalMapTexture(importedModel);

  useEffect(() => {
    contentAwareRepairAbortControllerRef.current?.abort();
    contentAwareRepairAbortControllerRef.current = undefined;
    contentAwareRepairRunningRef.current = false;
    setRouteProjectStatus('idle');
    setServerReadyProjectId(undefined);
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
      window.clearTimeout(thumbnailRefreshTimerRef.current);
      modelImportRevisionRef.current += 1;
      modelImportRunningRef.current = false;
      contentAwareRepairAbortControllerRef.current?.abort();
      contentAwareRepairAbortControllerRef.current = undefined;
      contentAwareRepairRunningRef.current = false;
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
      .catch(() => {
        if (token.revision !== routeProjectLoadRevisionRef.current || token.projectId !== projectId)
          return;
        setRouteProjectStatus('missing');
        pushToast({
          tone: 'error',
          title: t('projectLoadFailed'),
          description: t('projectLoadFailedHelp'),
          dedupeKey: `project-load:${projectId}`,
        });
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
    if (serverReadyProjectId !== projectId) return;
    if (skipProjectStoreSyncRef.current.layers) {
      skipProjectStoreSyncRef.current.layers = false;
      return;
    }
    if (document.body.dataset.perfSuppressProjectLayerSync === '1') return;
    if (suppressProjectLayerSyncRef.current > 0) return;
    const storedProject = useProjectStore.getState().projects.find((item) => item.id === projectId);
    if (import.meta.hot && layers.length === 0 && (storedProject?.layers.length ?? 0) > 0) {
      setLayers(storedProject!.layers);
      return;
    }
    // The layer store is the renderer's immediate source of truth. Mirroring a
    // large stack into the project snapshot may reconcile most of the editor,
    // so keep that secondary UI work interruptible while the viewport presents
    // the already-published GPU result.
    startTransition(() => setProjectLayers(layers));
  }, [layers, projectId, serverReadyProjectId, setLayers, setProjectLayers]);

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

  useEffect(() => {
    if (!activeProjectedLayerId) return;
    showPanel('layers');
    setPanelCollapsed('layers', false);
  }, [activeProjectedLayerId, setPanelCollapsed, showPanel]);

  useEffect(() => {
    function handleManualSaveShortcut(event: KeyboardEvent) {
      if (document.querySelector('[data-shortcut-dialog]')) return;
      if (!shortcutMatches(event, 'project.save')) return;
      event.preventDefault();
      manualSaveHandlerRef.current();
    }
    window.addEventListener('keydown', handleManualSaveShortcut);
    return () => window.removeEventListener('keydown', handleManualSaveShortcut);
  }, []);

  useEffect(() => {
    const handleImmediateSave = () => immediateSaveHandlerRef.current();
    window.addEventListener(IMMEDIATE_PROJECT_SAVE_EVENT, handleImmediateSave);
    return () => window.removeEventListener(IMMEDIATE_PROJECT_SAVE_EVENT, handleImmediateSave);
  }, []);

  useEffect(() => {
    function handleUndoRedo(event: KeyboardEvent) {
      if (document.querySelector('[data-shortcut-dialog]')) return;
      if (document.querySelector('[data-editor-shortcut-scope]')) return;
      if (shortcutMatches(event, 'history.undo')) {
        event.preventDefault();
        undo();
      } else if (shortcutMatches(event, 'history.redo')) {
        event.preventDefault();
        redo();
      }
    }
    window.addEventListener('keydown', handleUndoRedo);
    return () => window.removeEventListener('keydown', handleUndoRedo);
  }, [redo, undo]);

  useEffect(() => {
    if (
      !project ||
      project.workspaceMode !== 'local-server' ||
      !project.dirty ||
      serverReadyProjectId !== project.id
    )
      return;
    window.clearTimeout(autosaveTimerRef.current);
    setSaveStatus('idle');
    const runAutosave = () => {
      const viewportBusy =
        isViewportInteractionBusy(1_200) ||
        document.body.dataset.perfAutoOrbit === '1' ||
        document.body.dataset.perfSimulatedViewportInteraction === '1';
      if (suppressProjectLayerSyncRef.current > 0 || viewportBusy) {
        autosaveTimerRef.current = window.setTimeout(runAutosave, 1000);
        return;
      }
      const snapshot = getProjectSnapshot({ refreshThumbnail: false });
      if (!snapshot) return;
      setSaveStatus('saving');
      void saveToWorkspaceServer(snapshot)
        .then((result) => {
          if (result.savedLatestSnapshot) {
            setSaveStatus('saved');
            return;
          }
          // Edits made while assets were uploading must remain dirty and get a
          // follow-up save instead of being incorrectly marked as persisted.
          setSaveStatus('idle');
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
            setSaveStatus('idle');
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
          setSaveStatus(blockedEmptySave ? 'idle' : workspaceOnline ? 'failed' : 'offline');
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
                ? '当前页面尝试把已有模型/图层保存为空项目，已被本地服务拦截。请刷新项目重新加载。'
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
    autosaveTimerRef.current = window.setTimeout(runAutosave, 5000);
    return () => window.clearTimeout(autosaveTimerRef.current);
    // Autosave is intentionally keyed to project dirty/id/mode. The save helpers read the latest stores.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    autosaveRetryToken,
    project?.dirty,
    project?.id,
    project?.workspaceMode,
    pushToast,
    serverReadyProjectId,
  ]);

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
    const models = sceneState.importedModels;
    const viewportRuntime = sceneState.viewport;
    if (!viewportRuntime || models.length === 0) return getViewportThumbnailDataUrl();
    if (sceneState.displayMode !== 'pbr') return undefined;
    if (models.some((model) => model.restoreStage && model.restoreStage !== 'full')) {
      return undefined;
    }

    const framing = getProjectThumbnailFraming(
      models.map((model) => getBoundingBoxForObject(model.group)),
    );
    if (!framing) return getViewportThumbnailDataUrl();

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
    }
  }
  standardProjectThumbnailCaptureRef.current = getStandardProjectThumbnailDataUrl;

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

  const scheduleTexturedThumbnailRefresh = useCallback(
    (delayMs = 900) => {
      window.clearTimeout(thumbnailRefreshTimerRef.current);
      thumbnailRefreshTimerRef.current = window.setTimeout(() => {
        const thumbnail = standardProjectThumbnailCaptureRef.current();
        if (thumbnail) updateCurrentProject({ thumbnail });
      }, delayMs);
    },
    [updateCurrentProject],
  );

  useEffect(() => {
    if (!project || !importedModel || layers.length === 0) return;
    const projectedLayerSignature = layers
      .filter((layer) => layer.type === 'projected')
      .map((layer) =>
        [
          layer.id,
          layer.visible ? 1 : 0,
          layer.imageUrl,
          layer.opacity,
          layer.strength ?? 1,
          layer.blendMode,
          layer.bakedTextureId ?? '',
          layer.needsRebake ? 1 : 0,
        ].join(':'),
      )
      .join('|');
    if (!projectedLayerSignature) return;
    scheduleTexturedThumbnailRefresh(1200);
    // Thumbnail refresh intentionally follows projected layer visual state.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [importedModel, layers, project?.id]);

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
    setObjects(projectToHydrate.objects.filter((object) => object.format !== 'primitive'));
    setLayers(projectToHydrate.layers);
    const visibleTextureLayers = projectToHydrate.layers.filter(
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
    );
    setGenerations(projectToHydrate.generations, projectToHydrate.id);
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
      pushToast({
        tone: 'warning',
        title: t('modelRestoreSkipped'),
        description: t('modelRestoreRelativePath'),
        dedupeKey: `model-restore:${projectToRestore.id}`,
      });
    }
    if (restorableObjects.length === 0) return;
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
        await waitForProjectRestoreIdle();
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
        return {
          object,
          model: {
            ...applySavedObjectToLoadedModel(loaded, object),
            // Always admit parsed geometry through the lightweight outline
            // stage first. Publishing the active FBX with its original material
            // stack made Chromium upload/compile those temporary assets in the
            // same frame that the exact 4K UV became ready (measured 500ms+).
            // The final textured stage is still atomic and pixel-identical; the
            // queue below waits for its exact UV upload before flipping stages.
            restoreStage: 'outline' as const,
          },
        };
      } catch (error) {
        return { object, error };
      }
    }

    let textureRestoreQueue = Promise.resolve();
    const queueFullTextureRestore = (objectId: string) => {
      textureRestoreQueue = textureRestoreQueue.then(async () => {
        await waitForProjectRestoreIdle(1200);
        if (restoreRequest !== modelRestoreRequestRef.current) return;
        const outlineModel = restoredModelByObjectId.get(objectId);
        if (!outlineModel || outlineModel.restoreStage !== 'outline') return;
        if (objectId === activeObjectId) {
          const exactVisibleUvUrls = projectToRestore.layers
            .filter(
              (layer) =>
                layer.type === 'uv' &&
                layer.visible &&
                Boolean(layer.imageUrl) &&
                (!layer.objectId || layer.objectId === objectId),
            )
            .flatMap((layer) => (layer.imageUrl ? [layer.imageUrl] : []));
          if (exactVisibleUvUrls.length > 0) {
            await prewarmPreviewTextures(exactVisibleUvUrls);
          }
          // Guarantee that the outline material has replaced and disposed the
          // imported temporary material stack before the final stage is
          // admitted. Two presentation turns are bounded and avoid a single
          // monolithic restore frame without delaying background downloads.
          await new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()));
          await new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()));
        }
        if (restoreRequest !== modelRestoreRequestRef.current) return;
        restoredModelByObjectId.set(objectId, {
          ...outlineModel,
          restoreStage: 'full',
        });
        publishRestoreProgress();
        if (objectId === activeObjectId) {
          document.body.dataset.textureRestoreModelFull = '1';
          document.body.dataset.textureRestoreModelFullMs = performance.now().toFixed(1);
        }
        // Let image decoding and the first lightweight texture-array slices run
        // before admitting the next model's complete material stack.
        await waitForProjectRestoreIdle(1200);
      });
    };

    const allResults: Array<Awaited<ReturnType<typeof loadRestoredModel>>> = [];
    // Model downloads run concurrently, but parsing is admitted one model at a
    // time. Each parsed model first replaces its bounds with a cheap clay
    // silhouette. A separate queue then enables UV/projected textures one model
    // at a time, so geometry and texture restoration can progress independently.
    for (const object of prioritizedObjects) {
      if (restoreRequest !== modelRestoreRequestRef.current) return;
      const result = await loadRestoredModel(object);
      if (restoreRequest !== modelRestoreRequestRef.current) return;
      if ('cancelled' in result) return;
      allResults.push(result);
      const placeholder = restoredModelByObjectId.get(result.object.id);
      if (!result.model) {
        restoredModelByObjectId.delete(result.object.id);
        publishRestoreProgress();
        disposeProjectModelBoundsPlaceholder(placeholder);
        continue;
      }
      restoredModelByObjectId.set(result.object.id, result.model);
      publishRestoreProgress();
      window.requestAnimationFrame(() => disposeProjectModelBoundsPlaceholder(placeholder));
      queueFullTextureRestore(result.object.id);
    }
    await textureRestoreQueue;
    if (restoreRequest !== modelRestoreRequestRef.current) return;

    const restoredModels = restorableObjects.flatMap((object) => {
      const model = restoredModelByObjectId.get(object.id);
      return model && model.restoreStage !== 'bounds' ? [model] : [];
    });
    if (restoredModels.length > 0) {
      restoreImportedModels(restoredModels, activeObjectId);
    } else {
      restoredModelKeyRef.current = undefined;
    }

    const failedResults = allResults.filter((result) => result.error);
    if (failedResults.length > 0) {
      failedResults.forEach((result) => {
        console.error(
          `[Liclick 3D Texture] Restore model failed: ${result.object.name}`,
          result.error,
        );
      });
      pushToast({
        tone: 'error',
        title: t('modelRestoreFailed'),
        description:
          failedResults.length === restorableObjects.length
            ? failedResults[0]?.error instanceof Error
              ? failedResults[0].error.message
              : t('modelRestoreFailedHelp')
            : `${failedResults.length} / ${restorableObjects.length} 个模型加载失败，其余模型已恢复。`,
        dedupeKey: `model-restore:${projectToRestore.id}`,
      });
    }
  }

  async function persistAssetUrl(
    projectId: string,
    url: string | undefined,
    category: 'models' | 'references' | 'captures' | 'generations' | 'layers' | 'baked',
    filename: string,
  ) {
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
      if (!url || isWorkspaceAssetUrl(url)) return url;
      if (url.startsWith('http')) {
        if (!isPersistableRemoteAssetUrl(url)) return url;
        try {
          const result = await saveRemoteUrlAsset({ projectId, category, url, filename });
          return result.asset.relativePath;
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
            return result.asset.relativePath;
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
          return result.asset.relativePath;
        }
      }
      if (!url.startsWith('data:') && !url.startsWith('blob:')) return url;
      const dataUrl = url.startsWith('data:') ? url : await urlToDataUrl(url);
      const result = await saveDataUrlWithFallback(dataUrl);
      return result.asset.relativePath;
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
          const blobPromise = getLiveProjectedTextureBlob(url);
          if (!blobPromise) return fallback;
          const result = await saveBlobAsset({
            projectId: projectForSave.id,
            category,
            blob: await blobPromise,
            filename,
          });
          return result.asset.relativePath;
        }
        return await persistAssetUrl(projectForSave.id, url, category, filename);
      } catch (error) {
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
      const persistedImageSource = layer.localRepaintSourceUrl ?? layer.imageUrl;
      const persistedMaskSource = layer.localRepaintMaskUrl ?? layer.maskUrl;
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
      layer.localRepaintMaskUrl = layer.maskUrl;
    });

    return projectForSave;
  }

  async function performWorkspaceServerSave(snapshot: Project) {
    const projectForSave = await prepareProjectForWorkspaceSave(snapshot);
    const result = await saveWorkspaceProject(projectForSave).catch((error) => {
      throw new Error(
        `保存项目 JSON 失败: ${error instanceof Error ? error.message : 'Unknown error'}`,
      );
    });
    const latestProject = useProjectStore
      .getState()
      .projects.find((project) => project.id === snapshot.id);
    const snapshotUpdatedAt = Date.parse(snapshot.updatedAt);
    const latestUpdatedAt = Date.parse(latestProject?.updatedAt ?? '');
    const sameObjectIds =
      latestProject?.objects
        .map((object) => object.id)
        .sort()
        .join('|') ===
      snapshot.objects
        .map((object) => object.id)
        .sort()
        .join('|');
    const sameLayerIds =
      latestProject?.layers
        .map((layer) => layer.id)
        .sort()
        .join('|') ===
      snapshot.layers
        .map((layer) => layer.id)
        .sort()
        .join('|');
    const sameDeletionIntent =
      [...(latestProject?.deletedObjectIds ?? [])].sort().join('|') ===
      [...(snapshot.deletedObjectIds ?? [])].sort().join('|');
    const savedLatestSnapshot = Boolean(
      latestProject?.id === snapshot.id &&
      Number.isFinite(snapshotUpdatedAt) &&
      Number.isFinite(latestUpdatedAt) &&
      latestUpdatedAt <= snapshotUpdatedAt &&
      sameObjectIds &&
      sameLayerIds &&
      sameDeletionIntent,
    );
    if (savedLatestSnapshot) {
      markSavedById(
        snapshot.id,
        result.project.lastSavedAt ?? new Date().toISOString(),
        result.project.assetManifest,
      );
    }
    updateProjectById(snapshot.id, {
      workspaceMode: 'local-server',
      workspaceName: result.slug,
      lastSavedAt: result.project.lastSavedAt,
      dirty: !savedLatestSnapshot,
      assetManifest: result.project.assetManifest,
    });
    return { ...result, savedLatestSnapshot };
  }

  function saveToWorkspaceServer(snapshot: Project) {
    const operation = workspaceSaveQueueRef.current
      .catch(() => undefined)
      .then(() => performWorkspaceServerSave(snapshot));
    workspaceSaveQueueRef.current = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation;
  }

  async function handleManualSave(showSuccessToast = true) {
    if (manualSaveRunningRef.current) {
      if (!showSuccessToast) pendingImmediateSaveRef.current = true;
      return;
    }
    if (backNavigationPendingRef.current) return;
    const currentProject = useProjectStore.getState().getCurrentProject();
    if (!currentProject || currentProject.workspaceMode !== 'local-server') {
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
    const snapshot = getProjectSnapshot();
    if (!snapshot) return;

    manualSaveRunningRef.current = true;
    window.clearTimeout(autosaveTimerRef.current);
    setSaveStatus('saving');
    try {
      let result = await saveToWorkspaceServer(snapshot);
      if (!result.savedLatestSnapshot) {
        const latestSnapshot = getProjectSnapshot({ refreshThumbnail: false });
        if (latestSnapshot) result = await saveToWorkspaceServer(latestSnapshot);
      }
      if (result.savedLatestSnapshot) {
        setSaveStatus('saved');
        if (showSuccessToast)
          pushToast({
            tone: 'success',
            title: '项目已保存',
            description: 'Ctrl+S',
            dedupeKey: 'manual-project-save-success',
          });
      } else {
        setSaveStatus('idle');
        setAutosaveRetryToken((token) => token + 1);
      }
    } catch (error) {
      setSaveStatus('failed');
      console.error('[Liclick 3D Texture] Manual workspace save failed.', error);
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
      const result = await renameWorkspaceProject(project.id, trimmedName);
      updateProjectById(project.id, {
        name: result.project.name,
        workspaceName: result.project.workspaceName,
        updatedAt: result.project.updatedAt,
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
    window.clearTimeout(autosaveTimerRef.current);
    window.clearTimeout(thumbnailRefreshTimerRef.current);
    const thumbnail = getStandardProjectThumbnailDataUrl();
    if (thumbnail) updateCurrentProject({ thumbnail });
    const snapshot = getProjectSnapshot();
    if (!snapshot) {
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
          ...snapshot,
          thumbnail: thumbnail ?? snapshot.thumbnail,
        });
        if (!result.savedLatestSnapshot) {
          const latestSnapshot = getProjectSnapshot();
          if (latestSnapshot) result = await saveToWorkspaceServer(latestSnapshot);
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
      const loaded = placeImportedModelBesideScene(
        await loadModelFromFile(
          file,
          {
            normalize: importSettings.normalizeOnImport,
            ground: importSettings.groundOnImport,
            targetMaxDimension: 3,
          },
          resourceFiles,
          (event) => onProgress?.(event),
        ),
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
          object = { ...object, sourcePath: saved.asset.relativePath };
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
        const importedProjectSnapshot = getProjectSnapshot({ refreshThumbnail: false });
        if (importedProjectSnapshot) {
          setSaveStatus('saving');
          try {
            const result = await saveToWorkspaceServer(importedProjectSnapshot);
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
      window.setTimeout(() => {
        const thumbnail = getStandardProjectThumbnailDataUrl();
        if (thumbnail) updateCurrentProject({ thumbnail });
      }, 300);
      pushToast({
        tone: loaded.result.warnings.length > 0 ? 'warning' : 'success',
        title: 'Model imported',
        description:
          loaded.result.warnings[0] ??
          `${loaded.result.sourceFileName} loaded with ${loaded.result.childMeshCount} mesh node(s).`,
      });
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
        title: t('importingModel'),
        detail: `${fileIndex + 1}/${modelFiles.length} · ${file.name} · ${detail}`,
        progress: Math.max(current?.progress ?? 0, nextProgress),
        indeterminate: isModelImportProgressIndeterminate(event),
      }));
    };

    try {
      for (const [fileIndex, file] of modelFiles.entries()) {
        if (!isCurrentImport()) break;
        reportProgress(fileIndex, file, { phase: 'preparing', phaseProgress: 0 });
        await handleImportModel(
          file,
          resourceFiles,
          (event, detail) => reportProgress(fileIndex, file, event, detail),
          isCurrentImport,
        );
      }
      if (isCurrentImport()) {
        const lastFile = modelFiles[modelFiles.length - 1];
        reportProgress(
          modelFiles.length - 1,
          lastFile,
          { phase: 'complete', phaseProgress: 1 },
          t('modelImportComplete'),
        );
        modelImportProgressTimerRef.current = window.setTimeout(() => {
          if (modelImportRevisionRef.current === revision) setModelImportProgress(undefined);
        }, 1200);
      }
    } finally {
      modelImportRunningRef.current = false;
      setModelImportBusy(false);
      if (modelInputRef.current) modelInputRef.current.value = '';
    }
  }

  async function handleImportReferenceImages(files: File[]) {
    const imageFiles = files.filter(
      (file) => file.type.startsWith('image/') || /\.(png|jpe?g|webp)$/i.test(file.name),
    );
    if (imageFiles.length === 0) return;
    try {
      const importedReferences: ReferenceImage[] = [];
      for (const [index, file] of imageFiles.entries()) {
        const url = await fileToDataUrl(file);
        const size = await getImageSize(url);
        importedReferences.push({
          id: createId('reference'),
          name: file.name || `Reference ${index + 1}`,
          url,
          width: size.width,
          height: size.height,
          isPrimary: true,
        });
      }
      setPendingReferenceImport(importedReferences);
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
      setObjects(importedProject.objects);
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

  function handleExportBaseColorDownload() {
    if (!project || !importedModel) return;
    const exportInput = {
      project,
      importedModel,
      selectedObjectId,
      target: 'scene' as const,
      onProgress: updateExportBakeProgress,
    };
    void runExportAction(t('exporting'), () =>
      import('@/engine/export/exportTexture').then(({ exportCompositedBaseColor }) =>
        exportCompositedBaseColor(exportInput),
      ),
    );
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
      scheduleTexturedThumbnailRefresh(layer.type === 'uv' ? 250 : 450);
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
    scheduleTexturedThumbnailRefresh(snapshot.type === 'uv' ? 250 : 450);
  }

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
      scheduleTexturedThumbnailRefresh(snapshot.type === 'uv' ? 250 : 450);
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
    if (snapshot) scheduleTexturedThumbnailRefresh(snapshot.type === 'uv' ? 250 : 450);
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
    if (authStrategy === 'personal-local-component') {
      await ensurePersonalLiclickAccountForUser(authState.user, {
        onStatus: (message) =>
          pushToast({
            tone: 'info',
            title: '个人莉刻账号',
            description: message,
            dedupeKey: 'local-repaint-liclick-account',
          }),
      });
    }
    const source = localRepaintRuntime.workingImageData;
    const editMask =
      localRepaintRuntime.mode === 'edit_layer_image'
        ? input.userMask
        : buildEditMask(input.userMask, localRepaintRuntime.holeMask, {
            includeBlankArea: input.includeBlankArea,
            dilationRadius: input.limitToBlankAndSelection ? 0 : 8,
          });
    if (!ensureMaskContent(editMask)) throw new Error(t('localRepaintMaskMissing'));
    const protectMask = input.preserveUnmaskedArea
      ? buildProtectMask(localRepaintRuntime.objectMask, editMask)
      : createEmptyMask(source.width, source.height);
    const bbox = computeMaskBoundingBox(editMask);
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
      localRepaintRuntime.mode === 'edit_layer_image'
        ? input.userMask
        : buildEditMask(input.userMask, localRepaintRuntime.holeMask, {
            includeBlankArea: input.includeBlankArea,
            dilationRadius: input.limitToBlankAndSelection ? 0 : 8,
          });
    if (!ensureMaskContent(editMask)) throw new Error(t('localRepaintMaskMissing'));
    const protectMask = input.preserveUnmaskedArea
      ? buildProtectMask(localRepaintRuntime.objectMask, editMask)
      : createEmptyMask(source.width, source.height);
    const bbox = computeMaskBoundingBox(editMask);
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
      scheduleTexturedThumbnailRefresh(300);
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
      setManualBakeProgress({
        title: t('contentAwareRepair'),
        detail: '修补结果已生成，正在分帧上传完整纹理到 GPU',
        progress: 0.985,
      });
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
      if (!temporary) scheduleTexturedThumbnailRefresh(300);
      return layer;
    },
    [persistLayerImage, scheduleTexturedThumbnailRefresh, setActiveLayer, setLayers, t],
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
      scheduleTexturedThumbnailRefresh(450);
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
      if (runtime.status === 'submitting') {
        pushToast({
          tone: 'info',
          title: '已恢复局部重绘任务',
          description: '正在继续等待莉刻返回结果。',
          dedupeKey: `local-repaint-restored:${runtime.id}`,
        });
      } else if (runtime.status === 'preview_ready') {
        pushToast({
          tone: 'success',
          title: '已恢复局部重绘结果',
          description: '上一次莉刻返回的结果已恢复，可以预览并应用。',
          dedupeKey: `local-repaint-result-restored:${runtime.id}`,
        });
      }
    });
    return () => {
      cancelled = true;
    };
  }, [localRepaintRuntime?.projectId, openLocalRepaintRuntime, projectId, pushToast]);

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
    const selectedUvLayers = [...(baseUvLayer ? [baseUvLayer] : []), ...selectedUvSourceLayers]
      .sort((left, right) => {
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
              }
            : layer,
        ),
      );
      const postprocess = getMergeUvPostprocessOptions(bakeResolution);
      markPerformanceEvent('uv-merge', 'gpu-bake-start', {
        layerCount: layersToBake.length,
        resolution: bakeResolution,
      });
      const gpuBakeStartedAt = performance.now();
      const bakeResult =
        layersToBake.length > 0
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
        coverageRatio: bakeResult?.report.coverageRatio,
      });

      const outputCanvas = bakeResult?.canvas ?? document.createElement('canvas');
      if (!bakeResult) {
        outputCanvas.width = bakeResolution;
        outputCanvas.height = bakeResolution;
      }
      const readbackStartedAt = performance.now();
      let mergedImageData = bakeResult?.imageData;
      if (!mergedImageData) {
        const outputContext = outputCanvas.getContext('2d', { willReadFrequently: true });
        if (!outputContext) throw new Error('Could not create merged UV canvas.');
        mergedImageData = outputContext.getImageData(0, 0, bakeResolution, bakeResolution);
      }
      let mergedRgba = mergedImageData.data;
      const renderedColorMask =
        bakeResult?.renderedColorMask ?? new Uint8Array(bakeResolution * bakeResolution);
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
        if (layer.renderedColorMaskUrl) {
          const underlayRenderedColorMask = await urlToImageData(
            layer.renderedColorMaskUrl,
            bakeResolution,
            bakeResolution,
          );
          compositeRenderedColorMaskUnderInPlace(
            renderedColorMask,
            mergedRgba,
            underlayRenderedColorMask.data,
            layer.opacity,
          );
        } else if (layer.renderedColor) {
          compositeUniformRenderedColorUnderInPlace(
            renderedColorMask,
            mergedRgba,
            layer.opacity,
          );
        }
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
      setManualBakeProgress({
        title: t('mergeSelectedLayersToUvLayer'),
        detail: '正在将当前 PBR 全局光照写入合并图层',
        progress: 0.965,
      });
      const currentLighting = useSettingsStore.getState();
      await bakePbrPreviewLightingIntoUv({
        rgba: mergedRgba,
        width: bakeResolution,
        height: bakeResolution,
        root: currentImportedModel.group,
        settings: {
          exposure: currentLighting.exposure,
          pbrEnvironmentIntensity: currentLighting.pbrEnvironmentIntensity,
          pbrKeyLightIntensity: currentLighting.pbrKeyLightIntensity,
          pbrLightAzimuth: currentLighting.pbrLightAzimuth,
          environmentPreset: currentLighting.environmentPreset,
        },
        renderedColorMask,
      });
      // The final UV is entirely display color. The layer-level flag is enough
      // to bypass lighting in both Flat and PBR; do not encode/upload a 4K mask.
      uvCompositeDurationMs =
        performance.now() - uvCompositeStartedAt - pngEncodeDurationMs;
      const mergedCoverageRatio =
        bakeResult?.report.coverageRatio ?? getRgbaAlphaCoverageRatio(mergedRgba);

      // Encode straight RGBA directly. Canvas PNG export is allowed to erase
      // RGB beneath alpha=0, which would destroy the transparent UV gutter and
      // reintroduce dark/white seams at bilinear-filter boundaries.
      const pngEncodeStartedAt = performance.now();
      if (document.body.dataset.perfSimulatedViewportInteraction === '1') {
        document.body.dataset.perfUvBakePhase = 'png-encode';
      }
      if (!mergedImageBlob && !mergedImageUrl) {
        const encoded = await encodeRgbaPngObjectUrl(
          bakeResolution,
          bakeResolution,
          mergedRgba,
          { transferOwnership: true },
        );
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
          bakePerformanceBreakdown: bakeResult?.report.performanceBreakdown ?? {},
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
        renderedColor: true,
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
      scheduleTexturedThumbnailRefresh(350);
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
    return scheduleHeavyTask({
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

  async function handleOpenBake(requestedHandoff?: TextureBakeHandoff) {
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
      const mergePlan = resolveBakeUvMergePlan(useLayerStore.getState().layers, objectId);
      let mergedLayer = mergePlan.action === 'reuse' ? mergePlan.mergedLayer : undefined;
      if (mergePlan.action === 'missing') {
        pushToast({
            tone: 'warning',
            title: '没有可合并的投影图层',
            description: '请先生成并显示至少一个投影图层，再传入烘焙。',
            dedupeKey: 'bake-merged-uv-missing',
        });
        return;
      }
      if (mergePlan.action === 'merge') {
        pushToast({
          tone: 'info',
          title: '进入烘焙前需要合并 UV',
          description: '正在自动合并当前对象的可见投影图层，完成后将进入烘焙界面。',
          dedupeKey: 'bake-auto-merge-uv',
        });
        const mergeResult = await mergeLayersToUvLayer(
          mergePlan.sourceLayerIds,
          mergePlan.baseUvLayerId,
          {
            objectId,
            suppressErrorToast: true,
            throwOnError: true,
          },
        );
        if (mergeResult && 'type' in mergeResult && mergeResult.type === 'uv') {
          mergedLayer = mergeResult;
        }
        mergedLayer = findMergedUvBakeLayer(useLayerStore.getState().layers, objectId);
      }
      if (!mergedLayer?.imageUrl) {
        throw new Error('自动合并 UV 图层未生成有效贴图，请稍后重试。');
      }

      // Entering the bake route unmounts the texture editor immediately. The
      // normal five-second autosave therefore cannot be relied on to retain a
      // UV merge that was just created above. Persist the complete layer stack
      // first so returning to Texture (or entering Bake again) reuses the same
      // merged UV layer instead of baking all projected layers a second time.
      if (project.workspaceMode === 'local-server') {
        window.clearTimeout(autosaveTimerRef.current);
        window.clearTimeout(manualBakeProgressTimerRef.current);
        setManualBakeProgress({
          title: '正在保存合并 UV 图层',
          detail: '保存后再次进入烘焙将直接复用这一层。',
          progress: 0.998,
        });
        setSaveStatus('saving');

        const saveMergedLayer = async () => {
          const snapshot = getProjectSnapshot({ refreshThumbnail: false });
          if (!snapshot) throw new Error('无法读取当前贴图项目。');
          const result = await saveToWorkspaceServer(snapshot);
          const persisted = result.project.layers.some(
            (layer) =>
              layer.id === mergedLayer.id &&
              layer.type === 'uv' &&
              layer.role === 'merged-uv' &&
              Boolean(layer.imageUrl),
          );
          return { result, persisted };
        };

        let saved = await saveMergedLayer();
        if (!saved.persisted) saved = await saveMergedLayer();
        if (!saved.persisted) throw new Error('合并 UV 图层未能保存到贴图项目。');
        setSaveStatus(saved.result.savedLatestSnapshot ? 'saved' : 'idle');
      }

      onOpenBake({
        ...requestedHandoff,
        objectId,
        baseColor: { name: mergedLayer.name, imageUrl: mergedLayer.imageUrl },
      });
    } catch (error) {
      setSaveStatus('failed');
      pushToast({
        tone: 'error',
        title: '传入烘焙失败',
        description:
          error instanceof Error ? error.message : '保存合并 UV 图层失败，请稍后重试。',
        dedupeKey: 'bake-merged-uv-persist-failed',
      });
    } finally {
      publishingToBakeRef.current = false;
      setPublishingToBake(false);
    }
  }

  useEffect(() => {
    if (
      !autoOpenBake ||
      !project ||
      !importedModel ||
      serverReadyProjectId !== projectId
    )
      return;
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
            const response = await fetch(sourceUrl, { credentials: 'include' });
            if (!response.ok) throw new Error(`读取模型失败（${response.status}）`);
            sourceBlob = await response.blob();
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
      let savedBaseColor:
        | { asset: { url: string; relativePath: string } }
        | undefined;
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
      'texture-color': () => {
        if (modelInput) {
          return import('@/engine/export/exportTexture').then(({ exportCompositedBaseColor }) =>
            exportCompositedBaseColor({ ...modelInput, target: 'scene' }),
          );
        }
        if (!activeColorTextureUrl) throw new Error(t('bakeBaseColorFirst'));
        return import('@/engine/export/exportTexture').then(({ exportTextureUrl }) =>
          exportTextureUrl(project, activeColorTextureUrl, 'basecolor'),
        );
      },
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

  const getLocalRepaintProjectionImage = useCallback((resultUrl: string) => {
    const cached = localRepaintProjectionImageCacheRef.current.get(resultUrl);
    if (cached) return cached;
    // The generation result is already a browser-loadable asset URL. Converting
    // a 2K/4K response to base64 duplicated the download, copied every byte on
    // the main thread and accounted for most of the observed 3-5 second cold
    // activation. Keep the original URL; the viewport image loader uses CORS
    // and the persisted layer already stores this same asset.
    const promise = Promise.resolve(resultUrl);
    localRepaintProjectionImageCacheRef.current.set(resultUrl, promise);
    promise.catch(() => {
      if (localRepaintProjectionImageCacheRef.current.get(resultUrl) === promise) {
        localRepaintProjectionImageCacheRef.current.delete(resultUrl);
      }
    });
    return promise;
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
    window.addEventListener(
      'liclick:projected-preview-progress',
      handleLocalRepaintPrewarmProgress,
    );
    return () => {
      window.removeEventListener(
        'liclick:local-repaint-prewarm-progress',
        handleLocalRepaintPrewarmProgress,
      );
      window.removeEventListener(
        'liclick:projected-preview-progress',
        handleLocalRepaintPrewarmProgress,
      );
    };
  }, []);

  useEffect(() => {
    const latestLocalRepaintGeneration = generations.find(
      (generation) =>
        generation.resultUrl &&
        generation.status === 'succeeded' &&
        isLocalRepaintGeneration(generation) &&
        (!generation.metadata.projectId || generation.metadata.projectId === projectId),
    );
    if (!latestLocalRepaintGeneration?.resultUrl) return;
    // Start fetching/converting the ComfyUI result as soon as it arrives. The
    // apply button should only bind an already warm source, regardless of which
    // repaint round the user is entering.
    void getLocalRepaintProjectionImage(latestLocalRepaintGeneration.resultUrl).catch((error) => {
      console.warn('[Liclick 3D Texture] Could not preload local repaint result:', error);
    });
  }, [generations, getLocalRepaintProjectionImage, projectId]);

  useEffect(() => {
    if (
      !project ||
      !importedModel ||
      paintTool === 'inpaint-apply' ||
      document.body.dataset.localRepaintPrewarmProgressRequested === '1' ||
      document.body.dataset.perfUseCurrentLocalRepaintMask === '1'
    )
      return undefined;
    const latestLocalRepaintGeneration = generations.find(
      (generation) =>
        generation.resultUrl &&
        generation.status === 'succeeded' &&
        isLocalRepaintGeneration(generation) &&
        (!generation.metadata.projectId || generation.metadata.projectId === projectId),
    );
    if (!latestLocalRepaintGeneration?.resultUrl) return undefined;
    const generationCapture =
      project.captures.find((capture) => capture.id === latestLocalRepaintGeneration.captureId) ??
      useProjectStore
        .getState()
        .getCurrentProject()
        ?.captures.find((capture) => capture.id === latestLocalRepaintGeneration.captureId);
    // Background staging must use the exact generation camera. Falling back to
    // a moving viewport here would prewarm the wrong projection while the user
    // is still selecting the mask.
    if (!generationCapture?.camera) return undefined;
    const objectId = selectedObjectId ?? generationCapture.objectId ?? importedModel.objectId;
    const generationResultLayer = layers.find(
      (layer) =>
        layer.type === 'projected' &&
        layer.generationId === latestLocalRepaintGeneration.id &&
        Boolean(layer.replacementTargetLayerId) &&
        (!layer.objectId || layer.objectId === objectId),
    );
    const targetLayer = layers.find(
      (layer) =>
        layer.id === generationResultLayer?.replacementTargetLayerId &&
        isLocalRepaintDestinationLayer(layer, objectId),
    );
    if (!isLocalRepaintDestinationLayer(targetLayer, objectId)) return undefined;
    const generationMaskUrl =
      typeof latestLocalRepaintGeneration.metadata.maskUrl === 'string'
        ? latestLocalRepaintGeneration.metadata.maskUrl
        : paintMaskDataUrl;
    if (!generationMaskUrl) return undefined;
    const preparedSource = useSceneStore.getState().localRepaintProjectionSource;
    if (
      preparedSource?.generationId === latestLocalRepaintGeneration.id &&
      preparedSource.objectId === objectId &&
      preparedSource.targetLayerId === targetLayer.id
    )
      return undefined;

    let cancelled = false;
    let idleId: number | undefined;
    let timeoutId: number | undefined;
    const stage = async () => {
      const startedAt = performance.now();
      try {
        const projectionImageUrl = await getLocalRepaintProjectionImage(
          latestLocalRepaintGeneration.resultUrl!,
        );
        if (
          cancelled ||
          document.body.dataset.localRepaintPrewarmProgressRequested === '1' ||
          document.body.dataset.perfUseCurrentLocalRepaintMask === '1'
        )
          return;
        const currentTarget = useLayerStore
          .getState()
          .layers.find((layer) => layer.id === targetLayer.id);
        if (!isLocalRepaintDestinationLayer(currentTarget, objectId)) return;
        importedModel.group.updateMatrixWorld(true);
        const nameSource = latestLocalRepaintGeneration.prompt.trim();
        setLocalRepaintProjectionSource({
          imageUrl: projectionImageUrl,
          persistentImageUrl: latestLocalRepaintGeneration.resultUrl,
          autoActivate: false,
          allowedMaskUrl: generationMaskUrl,
          depthUrl: generationCapture.depthUrl,
          depthEncoding: generationCapture.depthEncoding,
          normalUrl: generationCapture.normalUrl,
          objectId,
          objectMatrixWorld:
            getGenerationObjectMatrixWorld(latestLocalRepaintGeneration) ??
            importedModel.group.matrixWorld.toArray(),
          camera: generationCapture.camera,
          generationId: latestLocalRepaintGeneration.id,
          captureId: generationCapture.id,
          name: nameSource ? `${t('localRepaint')}: ${nameSource.slice(0, 20)}` : t('localRepaint'),
          targetLayerId: currentTarget.id,
          targetLayerType: currentTarget.type,
          targetLayerName: currentTarget.name,
        });
        markPerformanceEvent('local-repaint', 'background-source-stage', {
          durationMs: performance.now() - startedAt,
        });
      } catch (error) {
        if (!cancelled) {
          console.warn('[Liclick 3D Texture] Could not stage local repaint source:', error);
        }
      }
    };
    if (typeof window.requestIdleCallback === 'function') {
      idleId = window.requestIdleCallback(() => void stage(), { timeout: 500 });
    } else {
      timeoutId = window.setTimeout(() => void stage(), 0);
    }
    return () => {
      cancelled = true;
      if (idleId !== undefined) window.cancelIdleCallback(idleId);
      if (timeoutId !== undefined) window.clearTimeout(timeoutId);
    };
  }, [
    generations,
    getLocalRepaintProjectionImage,
    importedModel,
    layers,
    paintMaskDataUrl,
    paintTool,
    project,
    projectId,
    selectedObjectId,
    setLocalRepaintProjectionSource,
    t,
  ]);

  const handleLocalImageGenerationFromToolbar = useCallback(() => {
    if (!project || !importedModel) {
      pushToast({
        tone: 'warning',
        title: t('localRepaintUnavailable'),
        description: t('importModelFirst'),
      });
      return;
    }
    const clickedAt = performance.now();
    // Reserve the viewport/GPU synchronously, before React panel updates can
    // schedule background 4K composition or projected-material promotion.
    document.body.dataset.localRepaintGenerationBusy = '1';
    document.body.dataset.localRepaintButton2ClickedAt = clickedAt.toFixed(1);
    document.body.dataset.perfLocalRepaintPhase = 'button2-click-response';
    window.requestAnimationFrame((frameAt) => {
      document.body.dataset.localRepaintButton2ResponseMs = (frameAt - clickedAt).toFixed(1);
      if (document.body.dataset.perfLocalRepaintPhase === 'button2-click-response') {
        delete document.body.dataset.perfLocalRepaintPhase;
      }
    });
    setPaintTool('none');
    showPanel('generate');
    setPanelCollapsed('generate', false);
    setLocalImageGenerationRequestKey((current) => current + 1);
  }, [importedModel, project, pushToast, setPaintTool, setPanelCollapsed, showPanel, t]);

  const handleLocalRepaintFromToolbar = useCallback(() => {
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
      const latestLocalRepaintGeneration = generations.find(
        (generation) =>
          generation.resultUrl &&
          generation.status === 'succeeded' &&
          isLocalRepaintGeneration(generation) &&
          (!generation.metadata.projectId || generation.metadata.projectId === projectId) &&
          (!generation.metadata.objectId || generation.metadata.objectId === preferredObjectId),
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
      const { layer: targetLayer } = ensureLocalRepaintSessionLayer({
        objectId,
        generationId: latestLocalRepaintGeneration?.id,
      });
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
      const benchmarkMaskUrl =
        document.body.dataset.perfUseCurrentLocalRepaintMask === '1'
          ? useSceneStore.getState().paintMaskDataUrl
          : undefined;
      const generationMaskUrl =
        benchmarkMaskUrl ??
        (typeof latestLocalRepaintGeneration.metadata.maskUrl === 'string'
          ? latestLocalRepaintGeneration.metadata.maskUrl
          : paintMaskDataUrl);
      // Applying an already generated repaint must use the mask archived with
      // that generation. The transient viewport selection is intentionally not
      // guaranteed to survive reloads, tool changes, or a long generation job.
      // Requiring it here left the toolbar visually focused but still in Select,
      // so every apparent brush stroke was silently ignored.
      if (!generationMaskUrl) {
        pushToast({
          tone: 'warning',
          title: t('localRepaintMaskMissing'),
          description: t('inpaintSelectToolHelp'),
          dedupeKey: 'local-repaint-mask-missing',
        });
        return;
      }
      const preparedSource = useSceneStore.getState().localRepaintProjectionSource;
      if (
        preparedSource?.generationId === latestLocalRepaintGeneration.id &&
        preparedSource.allowedMaskUrl === generationMaskUrl &&
        preparedSource.objectId === objectId &&
        preparedSource.targetLayerId === targetLayer.id
      ) {
        const isGpuReady = () =>
          document.body.dataset.localRepaintGpuReadyGeneration ===
            latestLocalRepaintGeneration.id &&
          document.body.dataset.localRepaintGpuReadyTarget === targetLayer.id;
        const hasGpuError = () =>
          document.body.dataset.localRepaintGpuErrorGeneration ===
            latestLocalRepaintGeneration.id &&
          document.body.dataset.localRepaintGpuErrorTarget === targetLayer.id;
        if (isGpuReady()) {
          clearPrewarmProgress();
          setPaintTool('inpaint-apply');
          return;
        }
        // The user clicked while background staging was still finishing. Block
        // strokes, but keep the decoded source/material job alive instead of
        // restarting it. In the common warm case this branch is never entered.
        setPaintTool('none');
        showPrewarmProgress('复用后台 GPU 预热任务', 0.2);
        while (
          localRepaintToolRequestRevisionRef.current === requestRevision &&
          !isGpuReady() &&
          !hasGpuError()
        ) {
          await new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()));
        }
        if (localRepaintToolRequestRevisionRef.current !== requestRevision) return;
        if (isGpuReady()) {
          clearPrewarmProgress();
          setPaintTool('inpaint-apply');
        } else {
          clearPrewarmProgress();
          pushToast({
            tone: 'error',
            title: '局部重绘 GPU 准备失败',
            description: '高清结果或蒙版无法上传，请再次点击局部重绘重试。',
            dedupeKey: 'local-repaint-gpu-prewarm-failed',
          });
        }
        return;
      }
      // A new ComfyUI result is a fresh interactive session. Keep painting
      // disabled while its lightweight source and renderer material are being
      // prepared, so an early gesture cannot be silently queued behind setup.
      setPaintTool('none');
      showPrewarmProgress('读取高清生成结果', 0.06);
      let projectionImageUrl: string;
      try {
        projectionImageUrl = await getLocalRepaintProjectionImage(
          latestLocalRepaintGeneration.resultUrl,
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
        setLayers(collapsedLayers);
        setProjectLayers(useLayerStore.getState().layers);
      }
      setLocalRepaintProjectionSource({
        imageUrl: projectionImageUrl,
        persistentImageUrl: latestLocalRepaintGeneration.resultUrl,
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
    generations,
    getCurrentCameraSnapshot,
    getLocalRepaintProjectionImage,
    importedModel,
    paintMaskDataUrl,
    paintMaskHasContent,
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
    const target = window as typeof window & {
      LiclickPerfLocalRepaintSource?: {
        prepareLatestGeneratedSource: () => Promise<void>;
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
        document.body.dataset.perfUseCurrentLocalRepaintMask = '1';
        try {
          handleLocalRepaintFromToolbar();
          const sourceDeadline = performance.now() + 25_000;
          while (performance.now() < sourceDeadline) {
            const sceneState = useSceneStore.getState();
            if (sceneState.localRepaintProjectionSource && sceneState.paintTool === 'inpaint-apply') {
              return;
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
  }, [handleLocalRepaintFromToolbar]);

  const executeContentAwareRepair = useCallback(
    async (
      requestedObjectId?: string,
      options?: { benchmarkOnly?: boolean; taskContext?: HeavyTaskContext },
    ) => {
      const benchmarkOnly = options?.benchmarkOnly === true;
      if (contentAwareRepairRunningRef.current) return;
      contentAwareRepairRunningRef.current = true;
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
        document.body.dataset.contentAwareRepairPhaseHistory = JSON.stringify(
          history.slice(-24),
        );
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
          if (!benchmarkOnly) {
            pushToast({
              tone: 'warning',
              title: t('viewportUnavailable'),
              description: t('importModelFirst'),
            });
          }
          throw new Error(t('importModelFirst'));
        }
        window.clearTimeout(manualBakeProgressTimerRef.current);
        setManualBakeProgress({
          title: t('contentAwareRepair'),
          detail: t('contentAwareRepairScanning'),
          progress: 0.04,
        });
        const objectId = targetModel.objectId;
        const currentLayers = useLayerStore.getState().layers;
        const sourceLayerIds = currentLayers
          .filter(
            (layer) =>
              layer.type === 'projected' &&
              layer.visible &&
              Boolean(layer.imageUrl && layer.camera) &&
              (!layer.objectId || layer.objectId === objectId) &&
              !isLocalRepaintLayer(layer) &&
              !isContentAwareRepairLayer(layer),
          )
          .map((layer) => layer.id);
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
        const bakeResult = await bakeVisibleProjectedLayersToTexture({
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
          onProgress: (progress) =>
            setManualBakeProgress({
              title: t('contentAwareRepair'),
              detail: t('contentAwareRepairScanning'),
              progress: 0.04 + progress.progress * 0.54,
            }),
        });
        reportRepairRunState('running', 'projection-bake-ready', {
          resolution: repairResolution,
          sourceLayerCount: sourceLayerIds.length,
          bakePerformanceBreakdown: bakeResult.report.performanceBreakdown,
        });
        delete document.body.dataset.perfUvBakePhase;
        const bakeContext = bakeResult.canvas.getContext('2d', { willReadFrequently: true });
        if (!bakeContext) throw new Error(t('localRepaintFailedHelp'));
        let workingImageData = bakeContext.getImageData(0, 0, repairResolution, repairResolution);
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
        const topology = await buildContentAwareSurfaceTopology(
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
            yieldIntervalMs: 8,
            signal: abortController.signal,
            onProgress: (progress) => {
              const phaseRange =
                progress.phase === 'analyze'
                  ? [0.58, 0.64]
                  : progress.phase === 'rasterize'
                    ? [0.64, 0.7]
                    : progress.phase === 'seams'
                      ? [0.7, 0.74]
                      : [0.74, 0.74];
              const phaseProgress = progress.total > 0 ? progress.completed / progress.total : 1;
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
          // The empty-area hatch is visible while aggregate projection
          // confidence is below roughly 12.5%. Treat that as a hard gap; the
          // connected-component filter still rejects isolated raster specks.
          hardAlphaThreshold: 32,
          weakAlphaThreshold: 64,
          weakGrowPixels: 1,
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
          setManualBakeProgress(undefined);
          if (!benchmarkOnly) {
            pushToast({
              tone: 'info',
              title: t('contentAwareRepair'),
              description: t('contentAwareRepairNoBlankArea'),
              dedupeKey: 'content-aware-no-blank-area',
            });
          }
          return;
        }

        setManualBakeProgress({
          title: t('contentAwareRepair'),
          detail: t('contentAwareRepairFilling'),
          progress: 0.74,
        });
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
            maxSeamCrossings: 1,
            // Keep a small donor guard band, but leave enough of the previous
            // pass available for the next pass to advance progressively.
            sourcePaddingPixels: Math.max(2, Math.min(4, Math.round(repairResolution / 768))),
            // One click advances one bounded surface-distance layer. A later
            // click starts from the cumulative result and continues farther.
            maxDistance: Math.max(64, Math.min(128, Math.round(repairResolution / 16))),
            minSourceAlpha: 64,
            sourceColorOutlierThreshold: 64,
            connectivity: 4,
            // Publish one opaque texel only where the composited input is still
            // empty and inside the same UV region. This closes bilinear-filter
            // seams without overwriting projections or earlier repair passes.
            coverageSkirtPixels: 1,
            coverageSkirtMaxInputAlpha: 32,
            outputBleedPixels: 4,
            // Unify a genuinely flat boundary, but preserve nearest-source
            // expansion when competing donors contain real colour variation.
            lockToDominantSourceRegion: true,
            dominantSourceColorThreshold: 18,
            // Publish the reachable band only. Unresolved centres remain gaps
            // for the next user-triggered repair pass instead of invalidating
            // the complete pass.
            requireCompleteComponents: false,
          },
          {
            signal: abortController.signal,
            transferOwnership: { rgba: true, writeMask: true },
            onProgress: (progress) =>
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
        setManualBakeProgress({
          title: t('contentAwareRepair'),
          detail: t('contentAwareRepairFilling'),
          progress: 0.96,
        });
        if (!benchmarkOnly) captureHistory('创建独立内容识别 UV 修补图层');
        const repairLayer = await addUvContentAwareRepairLayer(
          repairTexture,
          objectId,
          benchmarkOnly,
          abortController.signal,
        );
        if (!benchmarkOnly) setProjectLayers(useLayerStore.getState().layers);
        reportRepairRunState('complete', 'atomic-publish', {
          layerId: repairLayer.id,
          repairedPixels: repair.stats.repairedPixels,
          outputChecksum: repair.stats.outputChecksum,
        });
        options?.taskContext?.markFirstResult({ layerId: repairLayer.id });
        if (!benchmarkOnly) {
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
        setManualBakeProgress(undefined);
        if (!benchmarkOnly) {
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
          contentAwareRepairAbortControllerRef.current = undefined;
          manualBakeProgressTimerRef.current = window.setTimeout(
            () => setManualBakeProgress(undefined),
            1200,
          );
        }
      }
    },
    [addUvContentAwareRepairLayer, captureHistory, pushToast, setProjectLayers, t],
  );

  const runContentAwareRepair = useCallback(
    (requestedObjectId?: string, options?: { benchmarkOnly?: boolean }) => {
      const benchmarkOnly = options?.benchmarkOnly === true;
      return scheduleHeavyTask({
        key: 'full-resolution-texture',
        label: 'content-aware-repair',
        priority: 'user-visible',
        replace: !benchmarkOnly,
        onQueued: () =>
          setManualBakeProgress({
            title: t('contentAwareRepair'),
            detail: '任务已排队，视口交互保持可用',
            progress: 0.01,
          }),
        run: (taskContext) =>
          executeContentAwareRepair(requestedObjectId, { benchmarkOnly, taskContext }),
      }).catch((error) => {
        if (!benchmarkOnly && error instanceof Error && error.name === 'AbortError') return;
        throw error;
      });
    },
    [executeContentAwareRepair, t],
  );

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
        const terminal = JSON.parse(
          document.body.dataset.contentAwareRepairRun ?? '{}',
        ) as Record<string, unknown>;
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
    void runContentAwareRepair();
  }, [runContentAwareRepair]);

  useEffect(() => {
    const handleAutomaticContentAwareRepair = (event: Event) => {
      const request = (event as CustomEvent<ContentAwareRepairRequestDetail>).detail;
      if (!request || request.source !== 'multiview-texture') return;
      if (request.projectId && request.projectId !== projectId) return;
      request.handled = true;
      void runContentAwareRepair(request.objectId).then(request.resolve, request.reject);
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
        sceneState.clearPaintMask();
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
        sceneState.invertPaintMask();
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
      const nextPaintTool = shortcutMatches(event, 'texture.eraser') ? 'eraser' : undefined;
      if (nextPaintTool) {
        event.preventDefault();
        sceneState.setPaintTool(sceneState.paintTool === nextPaintTool ? 'none' : nextPaintTool);
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
  }, [captureHistory, handleLocalRepaintFromToolbar, pushToast, t, updateCurrentProject]);

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
            onImportModelClick={() => modelInputRef.current?.click()}
            importDisabled={modelImportBusy}
          />
        ),
        content: <ObjectsPanel />,
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
        content: <ObjectTransformPanel />,
      },
      {
        id: 'generate',
        title: t('generatePanel'),
        dock: 'left',
        order: 40,
        collapsed: workspacePanels.find((panel) => panel.id === 'generate')?.collapsed ?? true,
        visible: true,
        mode: 'texture',
        content: <GeneratePanel localImageGenerationRequestKey={localImageGenerationRequestKey} />,
      },
      {
        id: 'viewport',
        title: t('viewport'),
        dock: 'right',
        order: 20,
        collapsed: workspacePanels.find((panel) => panel.id === 'viewport')?.collapsed ?? true,
        visible: true,
        mode: 'all',
        content: <ViewportPanel />,
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
              onLayerImageEdit={openLayerImageEdit}
              onLayerImageReplace={(layer, file) => void replaceLayerImage(layer, file)}
              onLayerLocalRepaint={(layer) => void openLayerLocalRepaint(layer)}
              onMergeSelectedToUvLayer={(layerIds) => void mergeLayersToUvLayer(layerIds)}
              onMergeIntoSelectedBlankUvLayer={(layerIds, blankUvLayerId) =>
                void mergeLayersToUvLayer(layerIds, blankUvLayerId)
              }
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
      <PerfScenarioLoader />
      <input
        ref={modelInputRef}
        type="file"
        className="hidden"
        accept=".glb,.gltf,.fbx,.obj,.png,.jpg,.jpeg,.webp,.bmp,.tga"
        multiple
        disabled={modelImportBusy}
        onChange={(event) => {
          const files = event.target.files ? Array.from(event.target.files) : [];
          if (files.length > 0) void handleImportModels(files);
        }}
      />
      <input
        ref={projectInputRef}
        type="file"
        className="hidden"
        accept="application/json,.json,.liclick.json"
        onChange={(event) => {
          const file = event.target.files?.item(0);
          if (file) void handleLoadProject(file);
        }}
      />
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
            onOpenUv={onOpenUv}
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
            canLocalRepaint={localRepaintGenerationReady}
            canUndo={canUndo}
            canRedo={canRedo}
            onUndo={undo}
            onRedo={redo}
            labels={{
              select: t('select'),
              move: t('move'),
              rotate: t('rotate'),
              scale: t('scale'),
              layers: t('layers'),
              eraser: t('eraser'),
              eraserSize: t('eraserSize'),
              eraserHardness: t('eraserHardness'),
              localRepaint: t('localRepaint'),
              inpaintSelect: t('inpaintSelect'),
              inpaintUnselect: t('inpaintUnselect'),
              undo: t('undo'),
              redo: t('redo'),
              brushSize: t('brushSize'),
              brushOpacity: t('imageEditBrushOpacity'),
              resetInpaintRegion: t('resetInpaintRegion'),
              invertInpaintRegion: t('invertInpaintRegion'),
              selectHelp: t('selectToolHelp'),
              moveHelp: t('moveToolHelp'),
              rotateHelp: t('rotateToolHelp'),
              scaleHelp: t('scaleToolHelp'),
              layersHelp: t('layersToolHelp'),
              eraserHelp: t('eraserToolHelp'),
              localRepaintHelp: t('localRepaintToolHelp'),
              inpaintSelectHelp: t('inpaintSelectToolHelp'),
              inpaintUnselectHelp: t('inpaintUnselectToolHelp'),
            }}
          />
        }
        center={
          <ViewportCanvas
            hasImportedModel={Boolean(importedModel)}
            onImportModels={(files) => void handleImportModels(files)}
            onImportReferenceImages={(files) => void handleImportReferenceImages(files)}
            onOpenImport={() => modelInputRef.current?.click()}
            importDisabled={modelImportBusy}
          />
        }
        panels={panelDefinitions}
      />
      <TextureOnboardingTour projectId={project.id} projectCreatedAt={project.createdAt} />
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
          ? createPortal(<AutoBakeProgressBar progress={manualBakeProgress} />, document.body)
          : null}
    </>
  );
}
