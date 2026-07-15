import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Download, Plus } from 'lucide-react';
import * as THREE from 'three';
import { BottomToolDock } from '@/components/editor/BottomToolDock';
import { ExportMenu, type ExportActionId } from '@/components/editor/ExportMenu';
import { ImageLayerEditorDialog } from '@/components/layerEdit/ImageLayerEditorDialog';
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
import { QuickMaskPanel, QuickMaskPanelActions } from '@/components/panels/QuickMaskPanel';
import { ReferenceImagePicker } from '@/components/panels/ReferenceImagePicker';
import { SegmentsPanel, SegmentsPanelActions } from '@/components/panels/SegmentsPanel';
import { ViewportPanel } from '@/components/panels/ViewportPanel';
import { Button } from '@/components/ui/Button';
import { WorkspaceModeShell } from '@/components/workspace/WorkspaceModeShell';
import { useWorkspaceLayoutStore } from '@/components/workspace/workspaceLayoutStore';
import type { WorkspacePanelDefinition } from '@/components/workspace/workspacePanelTypes';
import { PerfScenarioLoader } from '@/dev/PerfScenarioLoader';
import { applyBakedTextureToObject } from '@/engine/bake/applyBakedTexture';
import { downloadBaseColorTexture } from '@/engine/bake/downloadTexture';
import { bakeVisibleProjectedLayersToTexture } from '@/engine/bake/bakeProjectedLayerToTexture';
import {
  clearDebugUvBakeMethod,
  getDebugUvBakeStatus,
  setDebugGpuCoverageValidation,
  setDebugGpuProjectedImageUvFlipY,
  setDebugUvBakeMethod,
  setDebugUvBakeVerbose,
} from '@/engine/bake/uvBakeDebugControls';
import { createMaskedProjectedImage } from '@/engine/projection/createMaskedProjectedImage';
import {
  getLiveProjectedCanvasDataUrl,
  isLiveProjectedCanvasUrl,
} from '@/engine/projection/liveProjectedCanvasTextureRegistry';
import { loadModelFromFile, loadModelFromUrl } from '@/engine/loaders/loadModelFromFile';
import { getImportedBaseColorTextureUrl } from '@/engine/loaders/modelLoadUtils';
import {
  applyAlphaFromMask,
  blobToDataUrl,
  compositeUsingMask,
  contentAwareFillMaskedPixels,
  dataUrlToBlob,
  imageDataToBlob,
  inferAlphaObjectMask,
  inferWhiteHoleMask,
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
  dilateMask,
  expandRect,
  featherMask,
  maskToBlob,
  removeSmallMaskComponents,
} from '@/engine/localRepaint/maskUtils';
import { buildLocalRepaintPrompt } from '@/engine/localRepaint/promptBuilder';
import type { LoadedModel, ModelLoadResult } from '@/engine/loaders/modelImportTypes';
import { getBoundingBoxForObject } from '@/engine/scene/boundingBoxUtils';
import { focusCameraOrbitOnObjectId, setCameraToObjectView } from '@/engine/scene/transformActions';
import { applySerializedCamera, serializeCamera } from '@/engine/projection/ProjectionCamera';
import { ViewportCanvas } from '@/engine/viewport/ViewportCanvas';
import { EditorShell } from '@/layouts/EditorShell';
import { importProjectJson } from '@/services/projectService';
import { liclickImageEditProvider } from '@/services/imageEditProvider';
import {
  fileToDataUrl,
  getWorkspaceHealth,
  isWorkspaceAssetUrl,
  loadProject as loadWorkspaceProject,
  saveBlobAsset,
  saveDataUrlAsset,
  saveRemoteUrlAsset,
  saveProject as saveWorkspaceProject,
  urlToDataUrl,
  WorkspaceApiError,
} from '@/services/workspaceApiClient';
import { useGenerationStore } from '@/stores/generationStore';
import { useLocalRepaintStore } from '@/stores/localRepaintStore';
import { useEditorHistoryStore } from '@/stores/editorHistoryStore';
import { useT } from '@/stores/i18nStore';
import { useLayerStore } from '@/stores/layerStore';
import { useProjectStore } from '@/stores/projectStore';
import { useReferenceStore } from '@/stores/referenceStore';
import {
  MAX_PAINT_MASK_BRUSH_SIZE,
  MIN_PAINT_MASK_BRUSH_SIZE,
  useSceneStore,
} from '@/stores/sceneStore';
import { useSettingsStore } from '@/stores/settingsStore';
import { shortcutMatches } from '@/stores/shortcutStore';
import { useToastStore } from '@/stores/toastStore';
import type { BakeProgress } from '@/engine/bake/uvBakeTypes';
import type { LocalRepaintRuntime, MaskBitmap, Rect } from '@/types/localRepaint';
import type { SerializedCamera } from '@/types/capture';
import type { Generation } from '@/types/generation';
import type { Layer } from '@/types/layer';
import type { SceneObject } from '@/types/model';
import type { Project, ReferenceImage } from '@/types/project';
import { getRegisteredObjectUrlBlob } from '@/utils/blobUrlRegistry';
import { createId } from '@/utils/id';

type EditorPageProps = {
  projectId: string;
  onBack: () => void;
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

const LOCAL_REPAINT_CAPTURE_SCALE = 0.75;
const LOCAL_REPAINT_CAPTURE_MAX_DIMENSION = 1536;
const IMAGE_EDIT_MAPPED_PREVIEW_SIZE = 3072;
const LARGE_DATA_URL_ASSET_UPLOAD_THRESHOLD = 256 * 1024;
const PROJECT_THUMBNAIL_BACKGROUND = '#333333';
const PROJECT_THUMBNAIL_SIZE = 2048;

function isLocalRepaintGeneration(generation: Generation) {
  return generation.metadata.workflow === 'local-repaint';
}

function getGenerationObjectMatrixWorld(generation: Generation) {
  const value = generation.metadata.objectMatrixWorld;
  if (!Array.isArray(value) || value.length !== 16) return undefined;
  return value.every((item) => typeof item === 'number') ? value : undefined;
}

function isLocalRepaintProjectionLayer(layer: Layer) {
  return (
    layer.type === 'projected' &&
    (layer.id.startsWith('local-repaint-projection') ||
      layer.id.startsWith('local-repaint-brush-projection'))
  );
}

function isMatchingLocalRepaintProjectionLayer(
  layer: Layer,
  generationId: string | undefined,
  captureId: string | undefined,
  objectId: string,
) {
  if (!isLocalRepaintProjectionLayer(layer)) return false;
  if (generationId) return layer.generationId === generationId;
  if (captureId) return layer.captureId === captureId;
  return !layer.objectId || layer.objectId === objectId;
}

function collapseLocalRepaintProjectionLayers(
  layers: Layer[],
  generationId: string | undefined,
  captureId: string | undefined,
  objectId: string,
) {
  let keptLocalRepaintLayer = false;
  return layers.filter((layer) => {
    if (!isMatchingLocalRepaintProjectionLayer(layer, generationId, captureId, objectId))
      return true;
    if (keptLocalRepaintLayer) return false;
    keptLocalRepaintLayer = true;
    return true;
  });
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

function constrainMaskToObject(mask: MaskBitmap, objectMask: MaskBitmap) {
  const output = createEmptyMask(mask.width, mask.height);
  for (let index = 0; index < output.data.length; index += 1) {
    output.data[index] = (mask.data[index] ?? 0) > 0 && (objectMask.data[index] ?? 0) > 0 ? 255 : 0;
  }
  return output;
}

function buildContentAwareRepairMask(baseMask: MaskBitmap, objectMask: MaskBitmap) {
  const bounds = computeMaskBoundingBox(baseMask);
  if (!bounds) return baseMask;
  const minSide = Math.min(bounds.w, bounds.h);
  const growRadius = minSide > 180 ? 2 : 1;
  return constrainMaskToObject(dilateMask(baseMask, growRadius), objectMask);
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
    const softMask = featherMask(editMask, 1);
    for (let index = 0; index < patchMask.data.length; index += 1) {
      patchMask.data[index] =
        (runtime.objectMask.data[index] ?? 0) > 0 ? (softMask.data[index] ?? 0) : 0;
      if ((editMask.data[index] ?? 0) > 0) patchMask.data[index] = 255;
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

async function waitForViewportMaterialRefresh() {
  await new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()));
  await new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()));
  await new Promise<void>((resolve) => window.setTimeout(resolve, 120));
  await new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()));
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

function transformFromLoadedGroup(group: THREE.Group) {
  return {
    position: [group.position.x, group.position.y, group.position.z] as [number, number, number],
    rotation: [group.rotation.x, group.rotation.y, group.rotation.z] as [number, number, number],
    scale: [group.scale.x, group.scale.y, group.scale.z] as [number, number, number],
  };
}

function arrangeImportedModelForComparison(
  loaded: LoadedModel,
  existingModels: ModelLoadResult[],
): LoadedModel {
  if (existingModels.length === 0) return loaded;

  const existingBox = new THREE.Box3();
  let hasExistingModel = false;
  existingModels.forEach((model) => {
    model.group.updateMatrixWorld(true);
    const modelBox = new THREE.Box3().setFromObject(model.group);
    if (modelBox.isEmpty()) return;
    existingBox.union(modelBox);
    hasExistingModel = true;
  });
  if (!hasExistingModel) return loaded;

  loaded.result.group.updateMatrixWorld(true);
  const newBox = new THREE.Box3().setFromObject(loaded.result.group);
  if (newBox.isEmpty()) return loaded;

  const existingSize = new THREE.Vector3();
  const newSize = new THREE.Vector3();
  const newCenter = new THREE.Vector3();
  existingBox.getSize(existingSize);
  newBox.getSize(newSize);
  newBox.getCenter(newCenter);

  const gap = Math.max(0.45, Math.min(1.2, Math.max(existingSize.x, newSize.x) * 0.18));
  const targetCenterX = existingBox.max.x + newSize.x / 2 + gap;
  loaded.result.group.position.x += targetCenterX - newCenter.x;
  loaded.result.group.updateMatrixWorld(true);

  const boundingBox = getBoundingBoxForObject(loaded.result.group);
  const transform = transformFromLoadedGroup(loaded.result.group);
  const importNormalizationTransform = {
    ...loaded.result.importNormalizationTransform,
    position: transform.position,
  };

  return {
    ...loaded,
    result: {
      ...loaded.result,
      boundingBox,
      importNormalizationTransform,
    },
    object: {
      ...loaded.object,
      boundingBox,
      transform,
      userTransform: transform,
      importNormalizationTransform,
    },
  };
}

export function EditorPage({ projectId, onBack }: EditorPageProps) {
  const modelInputRef = useRef<HTMLInputElement>(null);
  const projectInputRef = useRef<HTMLInputElement>(null);
  const loadedProjectIdRef = useRef<string>();
  const serverLoadedProjectIdRef = useRef<string>();
  const restoredModelKeyRef = useRef<string>();
  const autosaveTimerRef = useRef<number>();
  const backNavigationPendingRef = useRef(false);
  const manualBakeRunningRef = useRef(false);
  const manualBakeProgressTimerRef = useRef<number>();
  const localRepaintCutoutCacheRef = useRef(new Map<string, Promise<string>>());
  const standardProjectThumbnailCaptureRef = useRef<() => string | undefined>(() => undefined);
  const thumbnailRefreshTimerRef = useRef<number>();
  const [saveStatus, setSaveStatus] = useState<'idle' | 'saving' | 'saved' | 'failed' | 'offline'>(
    'idle',
  );
  const [routeProjectStatus, setRouteProjectStatus] = useState<'idle' | 'loading' | 'missing'>(
    'idle',
  );
  const [manualBakeProgress, setManualBakeProgress] = useState<AutoBakeProgress | undefined>();
  const [imageEditLayerId, setImageEditLayerId] = useState<string>();
  const [imageEditLayerSnapshot, setImageEditLayerSnapshot] = useState<Layer>();
  const [imageEditMappedPreviewUrl, setImageEditMappedPreviewUrl] = useState<string>();
  const imageEditPreviewChainRef = useRef<Promise<unknown>>(Promise.resolve());
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
  const projects = useProjectStore((state) => state.projects);
  const setCurrentProject = useProjectStore((state) => state.setCurrentProject);
  const replaceCurrentProject = useProjectStore((state) => state.replaceCurrentProject);
  const updateCurrentProject = useProjectStore((state) => state.updateCurrentProject);
  const setWorkspaceState = useProjectStore((state) => state.setWorkspaceState);
  const markSaved = useProjectStore((state) => state.markSaved);
  const setObjects = useSceneStore((state) => state.setObjects);
  const objects = useSceneStore((state) => state.objects);
  const setImportedModel = useSceneStore((state) => state.setImportedModel);
  const setActiveImportedModel = useSceneStore((state) => state.setActiveImportedModel);
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
  const localRepaintProjectionSource = useSceneStore((state) => state.localRepaintProjectionSource);
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
  const setProjectGenerations = useProjectStore((state) => state.setProjectGenerations);
  const setProjectLayers = useProjectStore((state) => state.setProjectLayers);
  const setProjectReferences = useProjectStore((state) => state.setProjectReferences);
  const references = useReferenceStore((state) => state.references);
  const setReferences = useReferenceStore((state) => state.setReferences);
  const addReferences = useReferenceStore((state) => state.addReferences);
  const resolution = useSettingsStore((state) => state.resolution);
  const pushToast = useToastStore((state) => state.pushToast);
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
  const project = projects.find((item) => item.id === projectId);
  const activeLayer = layers.find((layer) => layer.id === activeProjectedLayerId);
  const imageEditLayer =
    imageEditLayerSnapshot ?? layers.find((item) => item.id === imageEditLayerId);
  const activeBakedTexture = project?.bakedTextures.find(
    (texture) => texture.id === activeLayer?.bakedTextureId,
  );
  const activeColorTextureUrl =
    activeLayer?.type === 'uv' && activeLayer.imageUrl
      ? activeLayer.imageUrl
      : activeBakedTexture?.imageUrl;
  const normalLayer = layers.find(
    (layer) =>
      layer.type === 'normal' &&
      Boolean(layer.imageUrl) &&
      (!selectedObjectId || !layer.objectId || layer.objectId === selectedObjectId),
  );
  const normalMapTexture = findNormalMapTexture(importedModel);

  useEffect(() => {
    setRouteProjectStatus('idle');
    restoredHistoryProjectIdRef.current = undefined;
  }, [projectId]);

  useEffect(
    () => () => {
      window.clearTimeout(manualBakeProgressTimerRef.current);
      window.clearTimeout(thumbnailRefreshTimerRef.current);
    },
    [],
  );

  useEffect(() => {
    if (project) {
      setRouteProjectStatus('idle');
      return;
    }
    if (routeProjectStatus !== 'idle') return;
    setRouteProjectStatus('loading');
    void loadWorkspaceProject(projectId)
      .then((result) => {
        serverLoadedProjectIdRef.current = result.project.id;
        replaceCurrentProject(result.project);
        setObjects(result.project.objects.filter((object) => object.format !== 'primitive'));
        setLayers(result.project.layers);
        setGenerations(result.project.generations, result.project.id);
        setReferences(result.project.references);
        void restoreProjectModel(result.project).then(() => {
          restorePersistedHistory(result.project.id);
          restoredHistoryProjectIdRef.current = result.project.id;
        });
        setRouteProjectStatus('idle');
      })
      .catch(() => {
        setRouteProjectStatus('missing');
        pushToast({
          tone: 'error',
          title: t('projectLoadFailed'),
          description: t('projectLoadFailedHelp'),
          dedupeKey: `project-load:${projectId}`,
        });
      });
    // restoreProjectModel is intentionally not a dependency; this effect should run once per route project id.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    project,
    projectId,
    pushToast,
    replaceCurrentProject,
    restorePersistedHistory,
    routeProjectStatus,
    setGenerations,
    setLayers,
    setObjects,
    setReferences,
    t,
  ]);

  useEffect(() => {
    if (!project) return;
    if (loadedProjectIdRef.current === project.id) return;
    loadedProjectIdRef.current = project.id;
    setCurrentProject(project.id);
    setObjects(project.objects.filter((object) => object.format !== 'primitive'));
    setLayers(project.layers);
    setGenerations(project.generations, project.id);
    setReferences(project.references);
    void restoreProjectModel(project).then(() => {
      restorePersistedHistory(project.id);
      restoredHistoryProjectIdRef.current = project.id;
    });
    // restoreProjectModel is intentionally not a dependency; this effect should run once per project id.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    project,
    restorePersistedHistory,
    setCurrentProject,
    setGenerations,
    setLayers,
    setObjects,
    setReferences,
  ]);

  useEffect(() => {
    if (!project || project.workspaceMode !== 'local-server') return;
    if (serverLoadedProjectIdRef.current === project.id) return;
    serverLoadedProjectIdRef.current = project.id;
    void loadWorkspaceProject(project.id)
      .then((result) => {
        replaceCurrentProject(result.project);
        setSaveStatus('saved');
        setObjects(result.project.objects.filter((object) => object.format !== 'primitive'));
        setLayers(result.project.layers);
        setGenerations(result.project.generations, result.project.id);
        setReferences(result.project.references);
        void restoreProjectModel(result.project).then(() => {
          restorePersistedHistory(result.project.id);
          restoredHistoryProjectIdRef.current = result.project.id;
        });
      })
      .catch(() => {
        setSaveStatus('offline');
        pushToast({
          tone: 'warning',
          title: t('workspaceOfflineToast'),
          dedupeKey: 'workspace-server-offline',
        });
      });
    // restoreProjectModel is intentionally not a dependency; this effect should run once per server project id.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    project,
    pushToast,
    replaceCurrentProject,
    restorePersistedHistory,
    setGenerations,
    setLayers,
    setObjects,
    setReferences,
    t,
  ]);

  useEffect(() => {
    if (suppressProjectLayerSyncRef.current > 0) return;
    const storedProject = useProjectStore.getState().projects.find((item) => item.id === projectId);
    if (import.meta.hot && layers.length === 0 && (storedProject?.layers.length ?? 0) > 0) {
      setLayers(storedProject!.layers);
      return;
    }
    setProjectLayers(layers);
  }, [layers, projectId, setLayers, setProjectLayers]);

  useEffect(() => {
    void objects;
  }, [objects]);

  useEffect(() => {
    setProjectGenerations(generations);
  }, [generations, setProjectGenerations]);

  useEffect(() => {
    setProjectReferences(references);
  }, [references, setProjectReferences]);

  useEffect(() => {
    if (!activeProjectedLayerId) return;
    showPanel('layers');
    setPanelCollapsed('layers', false);
    showPanel('layerAdjustments');
    setPanelCollapsed('layerAdjustments', false);
  }, [activeProjectedLayerId, setPanelCollapsed, showPanel]);

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
    if (!project || project.workspaceMode !== 'local-server' || !project.dirty) return;
    window.clearTimeout(autosaveTimerRef.current);
    setSaveStatus('idle');
    const runAutosave = () => {
      if (suppressProjectLayerSyncRef.current > 0) {
        autosaveTimerRef.current = window.setTimeout(runAutosave, 1000);
        return;
      }
      const snapshot = getProjectSnapshot({ refreshThumbnail: false });
      if (!snapshot) return;
      setSaveStatus('saving');
      void saveToWorkspaceServer(snapshot)
        .then(() => setSaveStatus('saved'))
        .catch(async (error) => {
          const authRequired = error instanceof WorkspaceApiError && error.status === 401;
          const blockedEmptySave = error instanceof WorkspaceApiError && error.status === 409;
          const workspaceOnline =
            !authRequired && !blockedEmptySave
              ? await getWorkspaceHealth().then(
                  () => true,
                  () => false,
                )
              : false;
          setSaveStatus(blockedEmptySave ? 'idle' : workspaceOnline ? 'failed' : 'offline');
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
  }, [project?.dirty, project?.id, project?.workspaceMode, pushToast]);

  useEffect(() => {
    if (!project || project.workspaceMode !== 'local-server' || saveStatus !== 'offline') return;
    let cancelled = false;
    void getWorkspaceHealth().then(
      () => {
        if (!cancelled) setSaveStatus(project.dirty ? 'idle' : 'saved');
      },
      () => undefined,
    );
    return () => {
      cancelled = true;
    };
  }, [project, saveStatus]);

  function getProjectSnapshot(options: { refreshThumbnail?: boolean } = {}): Project | undefined {
    if (!project) return undefined;
    return {
      ...project,
      thumbnail:
        options.refreshThumbnail === false
          ? project.thumbnail
          : (getStandardProjectThumbnailDataUrl() ?? project.thumbnail),
      objects: useSceneStore.getState().objects,
      layers: useLayerStore.getState().layers,
      generations: useGenerationStore.getState().generations,
      captures: useProjectStore.getState().getCurrentProject()?.captures ?? project.captures,
      bakedTextures:
        useProjectStore.getState().getCurrentProject()?.bakedTextures ?? project.bakedTextures,
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
      if (options.width && options.height)
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
    if (models.length === 0) return getViewportThumbnailDataUrl();
    const viewportRuntime = sceneState.viewport;

    const originalModelStates = models.map((model) => ({
      group: model.group,
      parent: model.group.parent,
      siblingIndex: model.group.parent?.children.indexOf(model.group) ?? -1,
      position: model.group.position.clone(),
      quaternion: model.group.quaternion.clone(),
      scale: model.group.scale.clone(),
      visible: model.group.visible,
    }));

    try {
      if (viewportRuntime) {
        for (const model of models) {
          if (!viewportRuntime.scene.getObjectById(model.group.id)) {
            viewportRuntime.scene.attach(model.group);
            model.group.updateMatrixWorld(true);
          }
        }
      }

      if (models.length > 1) {
        const modelExtent = 1.82;
        const modelGap = 0.24;
        const packedWidths: number[] = [];

        models.forEach((model) => {
          const { group } = model;
          group.visible = true;
          group.updateMatrixWorld(true);
          const initialBounds = new THREE.Box3().setFromObject(group);
          const initialSize = initialBounds.getSize(new THREE.Vector3());
          const maxDimension = Math.max(initialSize.x, initialSize.y, initialSize.z);
          if (maxDimension > Number.EPSILON) {
            group.scale.multiplyScalar(modelExtent / maxDimension);
            group.updateMatrixWorld(true);
          }

          const packedBounds = new THREE.Box3().setFromObject(group);
          const packedSize = packedBounds.getSize(new THREE.Vector3());
          packedWidths.push(Math.max(packedSize.x, modelExtent * 0.18));
        });

        const packedRowWidth =
          packedWidths.reduce((sum, width) => sum + width, 0) +
          modelGap * Math.max(models.length - 1, 0);
        let cursorX = -packedRowWidth / 2;

        models.forEach((model, index) => {
          const { group } = model;
          const width = packedWidths[index];
          const targetCenter = new THREE.Vector3(cursorX + width / 2, 0, 0);
          const packedBounds = new THREE.Box3().setFromObject(group);
          const packedCenter = packedBounds.getCenter(new THREE.Vector3());
          group.position.add(targetCenter.sub(packedCenter));
          group.updateMatrixWorld(true);
          cursorX += width + modelGap;
        });
      } else {
        models[0].group.visible = true;
        models[0].group.updateMatrixWorld(true);
      }

      const bounds = new THREE.Box3();
      for (const model of models) {
        model.group.updateMatrixWorld(true);
        bounds.union(new THREE.Box3().setFromObject(model.group));
      }
      if (bounds.isEmpty()) return getViewportThumbnailDataUrl();

      const center = bounds.getCenter(new THREE.Vector3());
      const size = bounds.getSize(new THREE.Vector3());
      const aspect = 1;
      const fov = 35;
      const halfFov = THREE.MathUtils.degToRad(fov / 2);
      const distanceForHeight = size.y / 2 / Math.tan(halfFov);
      const distanceForWidth = size.x / 2 / (Math.tan(halfFov) * aspect);
      const distance = Math.max(distanceForHeight, distanceForWidth, 0.5) + size.z * 0.4;
      const camera = new THREE.PerspectiveCamera(
        fov,
        aspect,
        0.01,
        Math.max(distance + Math.max(size.x, size.y, size.z) * 8, 100),
      );
      camera.position.set(center.x, center.y, center.z + distance);
      camera.up.set(0, 1, 0);
      camera.lookAt(center);
      camera.updateProjectionMatrix();
      camera.updateMatrixWorld(true);

      return getViewportThumbnailDataUrl({
        camera: serializeCamera(camera, aspect, center),
        width: PROJECT_THUMBNAIL_SIZE,
        height: PROJECT_THUMBNAIL_SIZE,
        cropVisibleContent: true,
        visibleContentFill: models.length > 1 ? 0.9 : 0.8,
        matchCameraToRenderAspect: true,
      });
    } finally {
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
      }
      if (viewportRuntime) {
        viewportRuntime.gl.render(viewportRuntime.scene, viewportRuntime.camera);
      }
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

  const getLocalRepaintCaptureSize = useCallback((canvas: HTMLCanvasElement) => {
    const maxSide = Math.max(canvas.width, canvas.height);
    if (maxSide <= 0) return undefined;
    const scale = Math.max(
      0.5,
      Math.min(LOCAL_REPAINT_CAPTURE_SCALE, LOCAL_REPAINT_CAPTURE_MAX_DIMENSION / maxSide),
    );
    return {
      width: Math.max(1, Math.round(canvas.width * scale)),
      height: Math.max(1, Math.round(canvas.height * scale)),
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

  const getCleanViewportCapture = useCallback(
    (size?: { width: number; height: number }) => {
      const viewportRuntime = useSceneStore.getState().viewport;
      if (!viewportRuntime) return undefined;
      const canvas = viewportRuntime.gl.domElement;
      if (!canvas || canvas.width === 0 || canvas.height === 0) return undefined;
      const hiddenHelpers: Array<{ object: THREE.Object3D; visible: boolean }> = [];
      const previousBackground = viewportRuntime.scene.background;
      const previousClearColor = viewportRuntime.gl.getClearColor(new THREE.Color()).clone();
      const previousClearAlpha = viewportRuntime.gl.getClearAlpha();
      let restoreRenderSize: (() => void) | undefined;
      try {
        viewportRuntime.scene.traverse((object) => {
          if (!object.userData.liclickViewportHelper && !object.userData.liclickPaintOverlay)
            return;
          hiddenHelpers.push({ object, visible: object.visible });
          object.visible = false;
        });
        viewportRuntime.scene.background = null;
        viewportRuntime.gl.setClearColor(0x000000, 0);
        if (size) restoreRenderSize = prepareViewportRenderSize(size.width, size.height);
        viewportRuntime.gl.render(viewportRuntime.scene, viewportRuntime.camera);
        const dataUrl = canvas.toDataURL('image/png');
        const readCanvas = document.createElement('canvas');
        readCanvas.width = canvas.width;
        readCanvas.height = canvas.height;
        const context = readCanvas.getContext('2d', { willReadFrequently: true });
        if (!context) return { dataUrl, objectMask: createFullMask(canvas.width, canvas.height) };
        context.drawImage(canvas, 0, 0);
        return {
          dataUrl,
          objectMask: inferAlphaObjectMask(context.getImageData(0, 0, canvas.width, canvas.height)),
        };
      } finally {
        for (const { object, visible } of hiddenHelpers) object.visible = visible;
        viewportRuntime.scene.background = previousBackground;
        viewportRuntime.gl.setClearColor(previousClearColor, previousClearAlpha);
        restoreRenderSize?.();
        viewportRuntime.gl.render(viewportRuntime.scene, viewportRuntime.camera);
      }
    },
    [prepareViewportRenderSize],
  );

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
    async (imageData: ImageData, filename: string) => {
      const blob = await imageDataToBlob(imageData);
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
    try {
      const parsed = new URL(url);
      return parsed.protocol === 'https:' && parsed.hostname === 'ai-assets.lilithgames.com';
    } catch {
      return false;
    }
  }

  async function restoreProjectModel(projectToRestore: Project) {
    const objects = projectToRestore.objects.filter(
      (item) => item.format !== 'primitive' && item.sourcePath,
    );
    if (objects.length === 0) {
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
    try {
      for (const object of restorableObjects) {
        const loaded = await loadModelFromUrl({
          sourceUrl: object.sourcePath!,
          fileName: getObjectFileName(object),
          normalizeOptions: {
            normalize: object.importNormalizationTransform?.normalized ?? true,
            ground: object.importNormalizationTransform?.grounded ?? true,
            targetMaxDimension: object.importNormalizationTransform?.targetMaxDimension ?? 3,
          },
        });
        const restoredResult = applySavedObjectToLoadedModel(loaded, object);
        setImportedModel(restoredResult, {
          ...object,
          selected: object.id === projectToRestore.activeObjectId,
        });
      }
      const activeObjectId = projectToRestore.activeObjectId ?? restorableObjects[0]?.id;
      if (activeObjectId) setActiveImportedModel(activeObjectId);
    } catch (error) {
      console.error('[Liclick 3D Texture] Restore model failed:', error);
      pushToast({
        tone: 'error',
        title: t('modelRestoreFailed'),
        description: error instanceof Error ? error.message : t('modelRestoreFailedHelp'),
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
        const result = await saveRemoteUrlAsset({ projectId, category, url, filename });
        return result.asset.relativePath;
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

    for (const object of projectForSave.objects) {
      object.sourcePath = await persistAssetUrl(
        projectForSave.id,
        object.sourcePath,
        'models',
        object.name,
      );
    }
    for (const reference of projectForSave.references) {
      reference.url =
        (await persistAssetUrl(projectForSave.id, reference.url, 'references', reference.name)) ??
        reference.url;
    }
    for (const capture of projectForSave.captures) {
      capture.colorUrl =
        (await persistAssetUrl(
          projectForSave.id,
          capture.colorUrl,
          'captures',
          `${capture.id}-color.png`,
        )) ?? capture.colorUrl;
      capture.maskUrl =
        (await persistAssetUrl(
          projectForSave.id,
          capture.maskUrl,
          'captures',
          `${capture.id}-mask.png`,
        )) ?? capture.maskUrl;
      capture.depthUrl =
        (await persistAssetUrl(
          projectForSave.id,
          capture.depthUrl,
          'captures',
          `${capture.id}-depth.png`,
        )) ?? capture.depthUrl;
      capture.normalUrl =
        (await persistAssetUrl(
          projectForSave.id,
          capture.normalUrl,
          'captures',
          `${capture.id}-normal.png`,
        )) ?? capture.normalUrl;
    }
    for (const generation of projectForSave.generations) {
      generation.resultUrl =
        (await persistAssetUrl(
          projectForSave.id,
          generation.resultUrl,
          'generations',
          `${generation.id}.png`,
        )) ?? generation.resultUrl;
    }
    const persistOptionalLayerAsset = async (url: string | undefined, filename: string) => {
      try {
        const resolvedUrl =
          url && isLiveProjectedCanvasUrl(url) ? (getLiveProjectedCanvasDataUrl(url) ?? url) : url;
        return await persistAssetUrl(projectForSave.id, resolvedUrl, 'layers', filename);
      } catch (error) {
        console.warn(
          `[Liclick 3D Texture] Dropping unsaved optional layer asset ${filename}.`,
          error,
        );
        return undefined;
      }
    };
    for (const layer of projectForSave.layers) {
      const resolvedImageUrl = isLiveProjectedCanvasUrl(layer.imageUrl)
        ? (getLiveProjectedCanvasDataUrl(layer.imageUrl) ?? layer.imageUrl)
        : layer.imageUrl;
      layer.imageUrl =
        (await persistAssetUrl(projectForSave.id, resolvedImageUrl, 'layers', `${layer.id}.png`)) ??
        layer.imageUrl;
      layer.maskUrl = await persistOptionalLayerAsset(layer.maskUrl, `${layer.id}-mask.png`);
      layer.depthUrl = await persistOptionalLayerAsset(layer.depthUrl, `${layer.id}-depth.png`);
    }
    for (const bakedTexture of projectForSave.bakedTextures) {
      bakedTexture.imageUrl =
        (await persistAssetUrl(
          projectForSave.id,
          bakedTexture.imageUrl,
          'baked',
          `${bakedTexture.id}.png`,
        )) ?? bakedTexture.imageUrl;
    }
    projectForSave.thumbnail =
      (await persistAssetUrl(
        projectForSave.id,
        projectForSave.thumbnail,
        'captures',
        'project-thumbnail.png',
      )) ?? projectForSave.thumbnail;

    return projectForSave;
  }

  async function saveToWorkspaceServer(snapshot: Project) {
    const projectForSave = await prepareProjectForWorkspaceSave(snapshot);
    const result = await saveWorkspaceProject(projectForSave).catch((error) => {
      throw new Error(
        `保存项目 JSON 失败: ${error instanceof Error ? error.message : 'Unknown error'}`,
      );
    });
    markSaved(result.project.lastSavedAt ?? new Date().toISOString(), result.project.assetManifest);
    setWorkspaceState({
      workspaceMode: 'local-server',
      workspaceName: result.slug,
      lastSavedAt: result.project.lastSavedAt,
      dirty: false,
      assetManifest: result.project.assetManifest,
    });
    return result;
  }

  async function handleBackToProjects() {
    if (backNavigationPendingRef.current) return;
    const currentProject = useProjectStore.getState().getCurrentProject();
    if (!currentProject || currentProject.workspaceMode !== 'local-server') {
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
    try {
      await saveToWorkspaceServer({
        ...snapshot,
        thumbnail: thumbnail ?? snapshot.thumbnail,
      });
      setSaveStatus('saved');
      onBack();
    } catch (error) {
      backNavigationPendingRef.current = false;
      setSaveStatus('failed');
      pushToast({
        tone: 'error',
        title: '返回项目前保存失败',
        description: error instanceof Error ? error.message : '项目缩略图未能写入本地工作区。',
        dedupeKey: 'workspace-save-before-back-failed',
      });
    }
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

  async function handleImportModel(file: File, resourceFiles: File[] = []) {
    try {
      const loaded = arrangeImportedModelForComparison(
        await loadModelFromFile(file, {
          normalize: importSettings.normalizeOnImport,
          ground: importSettings.groundOnImport,
          targetMaxDimension: 3,
        }, resourceFiles),
        useSceneStore.getState().importedModels,
      );
      let object = loaded.object;
      const importedBaseColorUrl = await getImportedBaseColorTextureUrl(loaded.result.group);
      if (project?.workspaceMode === 'local-server') {
        try {
          const saved = await saveDataUrlAsset({
            projectId: project.id,
            category: 'models',
            dataUrl: await fileToDataUrl(file),
            filename: `${object.id}-${file.name}`,
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
        activeObjectId: object.id,
      });
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
    } catch (error) {
      console.error('[Liclick 3D Texture] Import model failed:', error);
      pushToast({
        tone: 'error',
        title: 'Import failed',
        description: error instanceof Error ? error.message : 'The model could not be loaded.',
      });
    } finally {
      if (modelInputRef.current) modelInputRef.current.value = '';
    }
  }

  async function handleImportModels(files: File[]) {
    const modelFiles = files.filter((file) => /\.(glb|gltf|fbx|obj)$/i.test(file.name));
    const resourceFiles = files.filter((file) => !modelFiles.includes(file));
    if (modelFiles.length === 0) return;
    for (const file of modelFiles) {
      await handleImportModel(file, resourceFiles);
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
      addReferences(importedReferences);
      const nextReferences = [
        ...importedReferences,
        ...useReferenceStore
          .getState()
          .references.filter(
            (reference) => !importedReferences.some((item) => item.id === reference.id),
          ),
      ];
      setProjectReferences(nextReferences);
      pushToast({
        tone: 'success',
        title: '参考图已添加',
        description: '已添加到当前项目。',
      });
    } catch (error) {
      console.error('[Liclick 3D Texture] Import references failed:', error);
      pushToast({
        tone: 'error',
        title: '参考图导入失败',
        description: error instanceof Error ? error.message : '图片文件无法读取。',
      });
    }
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
    if (!project || !activeLayer || !activeColorTextureUrl) return;
    downloadBaseColorTexture(activeColorTextureUrl, project, activeLayer);
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

  function openLayerImageEdit(layer: Layer) {
    setImageEditLayerId(layer.id);
    setImageEditLayerSnapshot({ ...layer });
    setImageEditMappedPreviewUrl(undefined);
    window.requestAnimationFrame(() => {
      void captureLayerMappedPreview(layer).then((preview) => {
        if (preview) setImageEditMappedPreviewUrl(preview);
      });
    });
  }

  function closeLayerImageEdit() {
    setImageEditLayerId(undefined);
    setImageEditLayerSnapshot(undefined);
    setImageEditMappedPreviewUrl(undefined);
  }

  function getLayerMappedPreviewCamera(layer: Layer) {
    if (!layer.camera) return undefined;
    const targetModel =
      useSceneStore.getState().importedModels.find((model) => model.objectId === layer.objectId) ??
      importedModel;
    if (!layer.objectMatrixWorld || !targetModel) return layer.camera;

    targetModel.group.updateMatrixWorld(true);
    const captureObjectMatrix = new THREE.Matrix4().fromArray(layer.objectMatrixWorld);
    const currentObjectMatrix = targetModel.group.matrixWorld.clone();
    const captureToCurrent = currentObjectMatrix.multiply(captureObjectMatrix.clone().invert());
    const rotationDelta = new THREE.Quaternion().setFromRotationMatrix(
      new THREE.Matrix4().extractRotation(captureToCurrent),
    );
    const position = new THREE.Vector3()
      .fromArray(layer.camera.position)
      .applyMatrix4(captureToCurrent);
    const target = new THREE.Vector3()
      .fromArray(layer.camera.target)
      .applyMatrix4(captureToCurrent);
    const quaternion = rotationDelta.multiply(
      new THREE.Quaternion().fromArray(layer.camera.quaternion),
    );
    const matrixWorld = new THREE.Matrix4().compose(
      position,
      quaternion,
      new THREE.Vector3(1, 1, 1),
    );

    return {
      ...layer.camera,
      position: position.toArray() as [number, number, number],
      target: target.toArray() as [number, number, number],
      quaternion: quaternion.toArray() as [number, number, number, number],
      matrixWorld: matrixWorld.toArray(),
      viewMatrix: matrixWorld.clone().invert().toArray(),
    };
  }

  async function captureLayerMappedPreview(layer: Layer, imageUrl?: string) {
    const run = async () => {
      const previousLayers = useLayerStore.getState().layers.map((item) => ({ ...item }));
      const previousActiveLayerId = useLayerStore.getState().activeProjectedLayerId;
      let preview: string | undefined;
      suppressProjectLayerSyncRef.current += 1;
      try {
        setLayers(
          previousLayers.map((item) =>
            item.id === layer.id
              ? { ...item, imageUrl: imageUrl ?? item.imageUrl, visible: true }
              : item,
          ),
        );
        await waitForViewportMaterialRefresh();
        const previewCamera = getLayerMappedPreviewCamera(layer);
        preview =
          getViewportThumbnailDataUrl({
            camera: previewCamera,
            width: IMAGE_EDIT_MAPPED_PREVIEW_SIZE,
            height: IMAGE_EDIT_MAPPED_PREVIEW_SIZE,
            cropVisibleContent: true,
            matchCameraToRenderAspect: true,
          }) ??
          getViewportThumbnailDataUrl({
            width: IMAGE_EDIT_MAPPED_PREVIEW_SIZE,
            height: IMAGE_EDIT_MAPPED_PREVIEW_SIZE,
            cropVisibleContent: true,
            matchCameraToRenderAspect: true,
          });
      } finally {
        setLayers(previousLayers);
        if (previousActiveLayerId) setActiveLayer(previousActiveLayerId);
        await waitForViewportMaterialRefresh();
        suppressProjectLayerSyncRef.current = Math.max(0, suppressProjectLayerSyncRef.current - 1);
      }
      if (preview) setImageEditMappedPreviewUrl(preview);
      return preview;
    };

    const chained = imageEditPreviewChainRef.current.catch(() => undefined).then(run);
    imageEditPreviewChainRef.current = chained.catch(() => undefined);
    return chained;
  }

  async function refreshLayerImageMappedPreview(dataUrl: string) {
    const targetLayerId = imageEditLayerId;
    if (!targetLayerId) return undefined;
    const targetLayer =
      useLayerStore.getState().layers.find((item) => item.id === targetLayerId) ??
      imageEditLayerSnapshot;
    if (!targetLayer) return undefined;
    return captureLayerMappedPreview(targetLayer, dataUrl);
  }

  async function applyLayerImageEdit(dataUrl: string) {
    const targetLayer = imageEditLayer;
    if (!targetLayer) return;
    captureHistory(`应用图像编辑：${targetLayer.name}`);
    const imageUrl = await persistEditedLayerDataUrl(targetLayer, dataUrl);
    updateLayerImage(targetLayer.id, imageUrl);
    setProjectLayers(useLayerStore.getState().layers);
    closeLayerImageEdit();
    scheduleTexturedThumbnailRefresh(targetLayer.type === 'uv' ? 250 : 450);
    pushToast({
      tone: 'success',
      title: t('imageEditApplied'),
      description:
        targetLayer.type === 'uv' ? t('imageEditUvAppliedHelp') : t('projectionPreservedHelp'),
    });
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
    const patchImage = applyAlphaFromMask(sourcePatch, patchMask);
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
      setLayers(previousLayers);
      releaseProjectLayerSyncSuppression();
      const uvLayer = addUvLayer({
        name: 'UV Repair Layer',
        imageUrl,
        objectId,
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

  const addProjectedRepairLayer = useCallback(
    async (runtime: LocalRepaintRuntime) => {
      if (!project || !importedModel) throw new Error(t('importModelFirst'));
      const cameraState = runtime.cameraState ?? getCurrentCameraSnapshot();
      if (!cameraState) throw new Error(t('viewportUnavailable'));
      const sourcePatch = runtime.mergedImageData ?? runtime.workingImageData;
      const patchMask = buildLocalRepaintPatchMask(runtime, sourcePatch);
      const patchImage = applyAlphaFromMask(sourcePatch, patchMask);
      const layerId = createId('content-aware-projected-repair');
      const imageUrl = await persistLayerImage(patchImage, `${layerId}.png`);
      const objectId = selectedObjectId ?? importedModel.objectId;
      importedModel.group.updateMatrixWorld(true);
      const layer: Layer = {
        id: layerId,
        name: t('contentAwareRepair'),
        type: 'projected',
        imageUrl,
        objectId,
        objectMatrixWorld: importedModel.group.matrixWorld.toArray(),
        camera: cameraState,
        generationId: 'texture-map-content-aware-repair',
        visible: true,
        opacity: 1,
        strength: 1,
        blendMode: 'normal',
        adjustments: { hue: 0, saturation: 0, lightness: 0 },
        order: 0,
        createdAt: new Date().toISOString(),
      };
      setLayers([layer, ...useLayerStore.getState().layers]);
      setActiveLayer(layer.id);
      scheduleTexturedThumbnailRefresh(300);
      return layer;
    },
    [
      getCurrentCameraSnapshot,
      importedModel,
      persistLayerImage,
      project,
      scheduleTexturedThumbnailRefresh,
      selectedObjectId,
      setActiveLayer,
      setLayers,
      t,
    ],
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

  async function mergeLayersToUvLayer(layerIds: string[], blankUvLayerId?: string) {
    const currentImportedModel = useSceneStore.getState().importedModel;
    if (!project || !currentImportedModel) {
      pushToast({ tone: 'error', title: t('autoBakeFailed'), description: t('importModelFirst') });
      return;
    }
    const objectId = selectedObjectId ?? currentImportedModel.objectId;
    const projectedLayerIds = layerIds.filter((layerId) => {
      const layer = useLayerStore.getState().layers.find((item) => item.id === layerId);
      return layer?.type === 'projected' && layer.imageUrl && layer.camera;
    });
    if (projectedLayerIds.length === 0) {
      pushToast({ tone: 'warning', title: t('mergeNoProjectedLayers') });
      return;
    }
    captureHistory(blankUvLayerId ? '合并选中投影图层到空 UV 图层' : '合并选中投影图层为 UV 图层');
    manualBakeRunningRef.current = true;
    setManualBakeProgress({
      title: t('mergeSelectedLayersToUvLayer'),
      detail: t('autoBakePreparing'),
      progress: 0.02,
    });
    try {
      const bakeResult = await bakeVisibleProjectedLayersToTexture({
        objectId,
        layerIds: projectedLayerIds,
        resolution: resolutionToSize[resolution],
        enableBackfaceCulling: true,
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
        const filename = `${blankUvLayerId ?? createId('merged-uv-layer')}.png`;
        imageUrl = (
          await saveBlobAsset({
            projectId: project.id,
            category: 'layers',
            blob: bakeResult.imageBlob ?? dataUrlToBlob(bakeResult.imageUrl),
            filename,
          })
        ).asset.url;
      }
      mergeLayersIntoUvLayer({
        sourceLayerIds: projectedLayerIds,
        targetUvLayerId: blankUvLayerId,
        imageUrl,
        objectId,
        name: t('mergedUvLayer'),
      });
      setProjectLayers(useLayerStore.getState().layers);
      scheduleTexturedThumbnailRefresh(350);
      pushToast({
        tone: 'success',
        title: t('mergeComplete'),
        description: `${bakeResult.bakedTexture.width}px · ${(bakeResult.report.coverageRatio * 100).toFixed(1)}%`,
      });
    } catch (error) {
      pushToast({
        tone: 'error',
        title: t('autoBakeFailed'),
        description: error instanceof Error ? error.message : t('autoBakeFailedHelp'),
      });
    } finally {
      manualBakeRunningRef.current = false;
      manualBakeProgressTimerRef.current = window.setTimeout(
        () => setManualBakeProgress(undefined),
        1600,
      );
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

  const getLocalRepaintCutoutImage = useCallback((resultUrl: string, maskUrl: string) => {
    const cacheKey = `${resultUrl}\n${maskUrl}`;
    const cached = localRepaintCutoutCacheRef.current.get(cacheKey);
    if (cached) return cached;
    const promise = (async () => {
      const sourceImageUrl = resultUrl.startsWith('http')
        ? await urlToDataUrl(resultUrl)
        : resultUrl;
      return createMaskedProjectedImage(sourceImageUrl, maskUrl);
    })();
    localRepaintCutoutCacheRef.current.set(cacheKey, promise);
    promise.catch(() => {
      if (localRepaintCutoutCacheRef.current.get(cacheKey) === promise) {
        localRepaintCutoutCacheRef.current.delete(cacheKey);
      }
    });
    return promise;
  }, []);

  const handleLocalRepaintFromToolbar = useCallback(() => {
    void (async () => {
      if (!project || !importedModel) {
        pushToast({
          tone: 'warning',
          title: t('localRepaintUnavailable'),
          description: t('importModelFirst'),
        });
        return;
      }
      const targetLayerId = useLayerStore.getState().activeProjectedLayerId;
      const targetLayer = useLayerStore
        .getState()
        .layers.find((layer) => layer.id === targetLayerId);
      if (!targetLayer || (targetLayer.type !== 'uv' && targetLayer.type !== 'projected')) {
        pushToast({
          tone: 'warning',
          title: '请先选择替换目标图层',
          description:
            '按钮 3 会把重绘结果刷入当前选中的 UV 图层，或作为所选投射图层的局部替换层。',
          dedupeKey: 'local-repaint-target-layer-required',
        });
        return;
      }
      if (!paintMaskHasContent || !paintMaskDataUrl) {
        pushToast({
          tone: 'warning',
          title: t('localRepaintMaskMissing'),
          description: t('inpaintSelectToolHelp'),
          dedupeKey: 'local-repaint-mask-missing',
        });
        return;
      }
      const latestLocalRepaintGeneration = generations.find(
        (generation) =>
          generation.resultUrl &&
          generation.status === 'succeeded' &&
          isLocalRepaintGeneration(generation) &&
          (!generation.metadata.projectId || generation.metadata.projectId === projectId),
      );
      if (!latestLocalRepaintGeneration?.resultUrl) {
        pushToast({
          tone: 'warning',
          title: t('localRepaintUnavailable'),
          description: '请先在生成面板的“局部重绘”中完成局部生图。',
          dedupeKey: 'local-repaint-generation-missing',
        });
        return;
      }
      const generationCapture =
        project.captures.find((capture) => capture.id === latestLocalRepaintGeneration.captureId) ??
        useProjectStore
          .getState()
          .getCurrentProject()
          ?.captures.find((capture) => capture.id === latestLocalRepaintGeneration.captureId);
      const cameraState = generationCapture?.camera ?? getCurrentCameraSnapshot();
      if (!cameraState) {
        pushToast({
          tone: 'warning',
          title: t('viewportUnavailable'),
          description: t('textureMapSubmitting'),
        });
        return;
      }
      const objectId = selectedObjectId ?? generationCapture?.objectId ?? importedModel.objectId;
      importedModel.group.updateMatrixWorld(true);
      const captureId = generationCapture?.id ?? latestLocalRepaintGeneration.captureId;
      const generationMaskUrl =
        typeof latestLocalRepaintGeneration.metadata.maskUrl === 'string'
          ? latestLocalRepaintGeneration.metadata.maskUrl
          : paintMaskDataUrl;
      if (
        localRepaintProjectionSource?.generationId === latestLocalRepaintGeneration.id &&
        localRepaintProjectionSource.allowedMaskUrl === generationMaskUrl &&
        localRepaintProjectionSource.objectId === objectId &&
        localRepaintProjectionSource.targetLayerId === targetLayer.id
      ) {
        setPaintTool('inpaint-apply');
        return;
      }
      const cutoutImageUrl = await getLocalRepaintCutoutImage(
        latestLocalRepaintGeneration.resultUrl,
        generationMaskUrl,
      );
      const nameSource = latestLocalRepaintGeneration.prompt.trim();
      const currentLayers = useLayerStore.getState().layers;
      const collapsedLayers = collapseLocalRepaintProjectionLayers(
        currentLayers,
        latestLocalRepaintGeneration.id,
        captureId,
        objectId,
      );
      if (collapsedLayers.length !== currentLayers.length) {
        setLayers(collapsedLayers);
        setProjectLayers(useLayerStore.getState().layers);
      }
      setLocalRepaintProjectionSource({
        imageUrl: cutoutImageUrl,
        allowedMaskUrl: generationMaskUrl,
        depthUrl: generationCapture?.depthUrl,
        objectId,
        objectMatrixWorld:
          getGenerationObjectMatrixWorld(latestLocalRepaintGeneration) ??
          importedModel.group.matrixWorld.toArray(),
        camera: cameraState,
        generationId: latestLocalRepaintGeneration.id,
        captureId,
        name: nameSource ? `${t('localRepaint')}: ${nameSource.slice(0, 20)}` : t('localRepaint'),
        targetLayerId: targetLayer.id,
        targetLayerType: targetLayer.type,
        targetLayerName: targetLayer.name,
      });
      setPaintTool('inpaint-apply');
      pushToast({
        tone: 'info',
        title: t('localRepaint'),
        description:
          targetLayer.type === 'uv'
            ? `当前目标：${targetLayer.name}。刷完一笔后会在后台合成回这个 UV 图层。`
            : `当前目标：${targetLayer.name}。刷过的区域会作为该图层的局部替换。`,
        dedupeKey: `local-repaint-apply-source:${latestLocalRepaintGeneration.id}`,
      });
    })();
  }, [
    generations,
    getCurrentCameraSnapshot,
    getLocalRepaintCutoutImage,
    importedModel,
    localRepaintProjectionSource,
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

  const handleContentAwareRepairFromToolbar = useCallback(() => {
    void (async () => {
      const viewportRuntime = useSceneStore.getState().viewport;
      const captureSize = viewportRuntime
        ? getLocalRepaintCaptureSize(viewportRuntime.gl.domElement)
        : undefined;
      const capture = getCleanViewportCapture(captureSize);
      const cameraState = getCurrentCameraSnapshot();
      if (!capture || !cameraState || !importedModel) {
        pushToast({
          tone: 'warning',
          title: t('viewportUnavailable'),
          description: t('importModelFirst'),
        });
        return;
      }

      try {
        window.clearTimeout(manualBakeProgressTimerRef.current);
        setManualBakeProgress({
          title: t('contentAwareRepair'),
          detail: t('contentAwareRepairScanning'),
          progress: 0.08,
        });
        const workingImageData = await urlToImageData(capture.dataUrl);
        const objectMask = capture.objectMask;
        const editMask = buildContentAwareRepairMask(
          removeSmallMaskComponents(inferWhiteHoleMask(workingImageData, objectMask), 48),
          objectMask,
        );
        if (!ensureMaskContent(editMask)) {
          setManualBakeProgress(undefined);
          pushToast({
            tone: 'info',
            title: t('contentAwareRepair'),
            description: t('contentAwareRepairNoBlankArea'),
            dedupeKey: 'content-aware-no-blank-area',
          });
          return;
        }

        const bbox = computeMaskBoundingBox(editMask);
        if (!bbox) throw new Error(t('contentAwareRepairNoBlankArea'));
        const roiRect = expandRect(bbox, 32, {
          width: workingImageData.width,
          height: workingImageData.height,
        });
        captureHistory('内容识别修补白膜未填充区域');
        setManualBakeProgress({
          title: t('contentAwareRepair'),
          detail: t('contentAwareRepairFilling'),
          progress: 0.24,
        });
        const filled = contentAwareFillMaskedPixels(workingImageData, editMask, objectMask, {
          searchRadius: Math.max(
            24,
            Math.min(72, Math.ceil(Math.max(roiRect.w, roiRect.h) * 0.26)),
          ),
          iterations: 5,
          patchRadius: 4,
        });
        const composited = compositeUsingMask(workingImageData, filled, editMask);
        const protectMask = buildProtectMask(objectMask, editMask);
        const restored = restoreProtectedPixels(workingImageData, composited, protectMask);
        const runtime: LocalRepaintRuntime = {
          id: createId('content-aware-repair'),
          projectId,
          mode: 'repair_current_view',
          targetName: importedModel.name,
          cameraState,
          workingImageUrl: capture.dataUrl,
          workingImageData,
          objectMask,
          holeMask: editMask,
          editMask,
          protectMask,
          roiRect,
          mergedImageData: restored,
          previewUrl: await imageDataToDataUrl(restored),
          providerRaw: { provider: 'local-content-aware-fill' },
          status: 'preview_ready',
        };
        const repairLayer = await addProjectedRepairLayer(runtime);
        setProjectLayers(useLayerStore.getState().layers);
        pushToast({
          tone: 'success',
          title: t('contentAwareFillComplete'),
          description: `${t('projectedLayerAdded')}: ${repairLayer.name}`,
          dedupeKey: `content-aware-repair:${repairLayer.id}`,
        });
      } catch (error) {
        setManualBakeProgress(undefined);
        pushToast({
          tone: 'error',
          title: t('localRepaintFailed'),
          description: error instanceof Error ? error.message : t('localRepaintFailedHelp'),
        });
      } finally {
        manualBakeProgressTimerRef.current = window.setTimeout(
          () => setManualBakeProgress(undefined),
          1200,
        );
      }
    })();
  }, [
    addProjectedRepairLayer,
    captureHistory,
    getCurrentCameraSnapshot,
    getCleanViewportCapture,
    getLocalRepaintCaptureSize,
    importedModel,
    projectId,
    pushToast,
    setProjectLayers,
    t,
  ]);

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
      if (
        currentWorkspaceMode === 'texture' &&
        shortcutMatches(event, 'texture.newLayer')
      ) {
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
      const nextPaintTool = shortcutMatches(event, 'texture.brush')
        ? 'brush'
        : shortcutMatches(event, 'texture.eraser')
          ? 'eraser'
          : undefined;
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

        const nextSize = stepBrushSize(state.paintToolSettings.brushSize, 0.5, 256);
        state.setPaintToolSettings({ brushSize: nextSize });
        pushToast({
          tone: 'info',
          title: `画笔大小 ${nextSize.toFixed(nextSize % 1 ? 1 : 0)}px`,
          description: '[ / ] 调整大小',
          dedupeKey: 'brush-size-shortcut',
        });
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
        id: 'segments',
        title: t('segments'),
        dock: 'left',
        order: 10,
        collapsed: workspacePanels.find((panel) => panel.id === 'segments')?.collapsed ?? true,
        visible: true,
        mode: 'segments',
        actions: <SegmentsPanelActions />,
        content: <SegmentsPanel />,
      },
      {
        id: 'quickMask',
        title: t('quickMask'),
        dock: 'left',
        order: 20,
        collapsed: workspacePanels.find((panel) => panel.id === 'quickMask')?.collapsed ?? true,
        visible: true,
        mode: 'segments',
        actions: <QuickMaskPanelActions />,
        content: <QuickMaskPanel />,
      },
      {
        id: 'objects',
        title: t('objectsPanel'),
        dock: 'left',
        order: 5,
        collapsed: workspacePanels.find((panel) => panel.id === 'objects')?.collapsed ?? false,
        visible: true,
        mode: 'all',
        actions: <ObjectsPanelActions onImportModelClick={() => modelInputRef.current?.click()} />,
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
        content: <GeneratePanel />,
      },
      {
        id: 'layerAdjustments',
        title: t('layerAdjustments'),
        dock: 'right',
        order: 10,
        collapsed:
          workspacePanels.find((panel) => panel.id === 'layerAdjustments')?.collapsed ?? true,
        visible: true,
        mode: 'texture',
        content: <LayerAdjustmentsPanel />,
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
          />
        ),
        content: (
          <LayersPanel
            onLayerImageEdit={openLayerImageEdit}
            onLayerImageReplace={(layer, file) => void replaceLayerImage(layer, file)}
            onLayerLocalRepaint={(layer) => void openLayerLocalRepaint(layer)}
            onMergeSelectedToUvLayer={(layerIds) => void mergeLayersToUvLayer(layerIds)}
            onMergeIntoSelectedBlankUvLayer={(layerIds, blankUvLayerId) =>
              void mergeLayersToUvLayer(layerIds, blankUvLayerId)
            }
          />
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
                disabled={!activeColorTextureUrl || !activeLayer}
                onClick={handleExportBaseColorDownload}
                icon={<Download className="h-4 w-4" />}
                title={!activeColorTextureUrl ? t('bakeBaseColorFirst') : undefined}
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

  if (!project) {
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
        onBack={handleBackToProjects}
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
            onLocalRepaint={handleLocalRepaintFromToolbar}
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
              brush: t('brush'),
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
              brushColor: t('brushColor'),
              resetInpaintRegion: t('resetInpaintRegion'),
              invertInpaintRegion: t('invertInpaintRegion'),
              selectHelp: t('selectToolHelp'),
              moveHelp: t('moveToolHelp'),
              rotateHelp: t('rotateToolHelp'),
              scaleHelp: t('scaleToolHelp'),
              layersHelp: t('layersToolHelp'),
              brushHelp: t('brushToolHelp'),
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
          />
        }
        panels={panelDefinitions}
      />
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
      {imageEditLayer && (
        <ImageLayerEditorDialog
          layer={imageEditLayer}
          mappedPreviewUrl={imageEditMappedPreviewUrl}
          onRefreshMappedPreview={refreshLayerImageMappedPreview}
          onApply={applyLayerImageEdit}
          onCancel={closeLayerImageEdit}
        />
      )}
      {manualBakeProgress &&
        createPortal(<AutoBakeProgressBar progress={manualBakeProgress} />, document.body)}
    </>
  );
}
