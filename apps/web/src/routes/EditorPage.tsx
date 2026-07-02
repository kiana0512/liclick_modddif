import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Download } from 'lucide-react';
import * as THREE from 'three';
import { BottomToolDock } from '@/components/editor/BottomToolDock';
import { ExportMenu, type ExportActionId } from '@/components/editor/ExportMenu';
import { ImageLayerEditorDialog } from '@/components/layerEdit/ImageLayerEditorDialog';
import { LocalRepaintDialog, type LocalRepaintGenerateInput } from '@/components/localRepaint/LocalRepaintDialog';
import { AutoBakeProgressBar, type AutoBakeProgress } from '@/components/panels/AutoBakeProgressBar';
import { GeneratePanel } from '@/components/panels/GeneratePanel';
import { LayerAdjustmentsPanel } from '@/components/panels/LayerAdjustmentsPanel';
import { LayersPanel, LayersPanelActions } from '@/components/panels/LayersPanel';
import { ObjectsPanel, ObjectsPanelActions } from '@/components/panels/ObjectsPanel';
import { QuickMaskPanel, QuickMaskPanelActions } from '@/components/panels/QuickMaskPanel';
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
  canUseLayerStackCache,
  findExactLayerStackTexture,
  getLayerStackBakeInFlight,
  getProjectedLayerStackSignature,
  getVisibleProjectedLayerStack,
  registerLayerStackBakeInFlight,
} from '@/engine/bake/layerStackCache';
import { exportModelGlb } from '@/engine/export/exportGltf';
import { exportModelFbx } from '@/engine/export/exportFbx';
import { exportModelObj } from '@/engine/export/exportObj';
import { exportComfyControlInputs } from '@/engine/export/comfyControlInputExporter';
import { exportViewportSnapshot } from '@/engine/export/exportSnapshot';
import { exportModelStl } from '@/engine/export/exportStl';
import { exportNormalTexture, exportTextureUrl, findNormalMapTexture } from '@/engine/export/exportTexture';
import { canRecordTurntable, exportTurntableWebm } from '@/engine/export/exportTurntable';
import { loadModelFromFile, loadModelFromUrl } from '@/engine/loaders/loadModelFromFile';
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
import { applySerializedCamera } from '@/engine/projection/ProjectionCamera';
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
import { useSceneStore } from '@/stores/sceneStore';
import { useSettingsStore } from '@/stores/settingsStore';
import { useToastStore } from '@/stores/toastStore';
import type { BakeProgress } from '@/engine/bake/uvBakeTypes';
import type { LocalRepaintRuntime, MaskBitmap, Rect } from '@/types/localRepaint';
import type { SerializedCamera } from '@/types/capture';
import type { Layer } from '@/types/layer';
import type { SceneObject } from '@/types/model';
import type { Project, ReferenceImage } from '@/types/project';
import { getRegisteredObjectUrlBlob } from '@/utils/blobUrlRegistry';
import { createId } from '@/utils/id';

type EditorPageProps = {
  projectId: string;
  onBack: () => void;
};

const resolutionToSize = {
  '1K': 1024,
  '2K': 2048,
  '4K': 4096,
  '8K': 8192,
} as const;

const AUTO_PREVIEW_STACK_BAKE_ENABLED = false;
const MIN_AUTO_PREVIEW_STACK_BAKE_COVERAGE_RATIO = 0.001;
const PREVIEW_STACK_BAKE_FAILURE_COOLDOWN_MS = 10 * 60 * 1000;
const LOCAL_REPAINT_CAPTURE_SCALE = 2;
const LOCAL_REPAINT_CAPTURE_MAX_DIMENSION = 4096;
const IMAGE_EDIT_MAPPED_PREVIEW_SIZE = 3072;
const LARGE_DATA_URL_ASSET_UPLOAD_THRESHOLD = 256 * 1024;

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
    initialUserMaskUrl: runtime.initialUserMask ? await maskToDataUrl(runtime.initialUserMask) : undefined,
    holeMaskUrl: await maskToDataUrl(runtime.holeMask),
    editMaskUrl: runtime.editMask ? await maskToDataUrl(runtime.editMask) : undefined,
    protectMaskUrl: runtime.protectMask ? await maskToDataUrl(runtime.protectMask) : undefined,
    roiRect: runtime.roiRect,
    mergedImageUrl: runtime.mergedImageData ? await imageDataToPersistedDataUrl(runtime.mergedImageData) : undefined,
    previewUrl: runtime.previewUrl,
    editJobId: runtime.editJobId,
    taskId: runtime.taskId,
    status: runtime.status,
    error: runtime.error,
    startedAt: runtime.startedAt,
  };
  try {
    window.localStorage.setItem(localRepaintPersistenceKey(runtime.projectId), JSON.stringify(payload));
  } catch (error) {
    console.warn('[Liclick 3D Texture] Could not persist local repaint runtime.', error);
  }
}

function clearPersistedLocalRepaintRuntime(projectId: string) {
  if (typeof window === 'undefined') return;
  window.localStorage.removeItem(localRepaintPersistenceKey(projectId));
}

function cropThumbnailToVisibleContent(sourceCanvas: HTMLCanvasElement) {
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
      const brightness = data[offset] + data[offset + 1] + data[offset + 2];
      if (alpha <= 8 || brightness <= 54) continue;
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
  if (cropWidth >= width * 0.88 && cropHeight >= height * 0.88) return sourceCanvas;

  const targetCanvas = document.createElement('canvas');
  targetCanvas.width = width;
  targetCanvas.height = height;
  const targetContext = targetCanvas.getContext('2d');
  if (!targetContext) return sourceCanvas;
  targetContext.fillStyle = '#070813';
  targetContext.fillRect(0, 0, width, height);
  targetContext.imageSmoothingEnabled = true;
  targetContext.imageSmoothingQuality = 'high';

  const scale = Math.min(width / cropWidth, height / cropHeight) * 0.92;
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

async function restorePersistedLocalRepaintRuntime(projectId: string): Promise<LocalRepaintRuntime | undefined> {
  if (typeof window === 'undefined') return undefined;
  const raw = window.localStorage.getItem(localRepaintPersistenceKey(projectId));
  if (!raw) return undefined;
  try {
    const payload = JSON.parse(raw) as PersistedLocalRepaintRuntime;
    if (payload.version !== 1 || payload.projectId !== projectId) return undefined;
    const workingImageData = await urlToImageData(payload.workingImageUrl);
    const mergedImageUrl = payload.mergedImageUrl ?? (payload.status === 'preview_ready' ? payload.previewUrl : undefined);
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
      initialUserMask: payload.initialUserMaskUrl ? await dataUrlToMask(payload.initialUserMaskUrl) : undefined,
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

function arrangeImportedModelForComparison(loaded: LoadedModel, existingModels: ModelLoadResult[]): LoadedModel {
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
  const historyPersistTimerRef = useRef<number>();
  const manualBakeRunningRef = useRef(false);
  const manualBakeProgressTimerRef = useRef<number>();
  const previewStackBakeRunningRef = useRef(false);
  const previewStackBakeKeyRef = useRef('');
  const previewStackBakeFailureRef = useRef(new Map<string, number>());
  const previewStackBakeTimerRef = useRef<number>();
  const lastViewportInteractionRef = useRef(0);
  const thumbnailRefreshTimerRef = useRef<number>();
  const [saveStatus, setSaveStatus] = useState<'idle' | 'saving' | 'saved' | 'failed' | 'offline'>('idle');
  const [routeProjectStatus, setRouteProjectStatus] = useState<'idle' | 'loading' | 'missing'>('idle');
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
  const setLocalRepaintAbortController = useLocalRepaintStore((state) => state.setActiveAbortController);
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
  const clearPaintMask = useSceneStore((state) => state.clearPaintMask);
  const invertPaintMask = useSceneStore((state) => state.invertPaintMask);
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
  const setPanelCollapsed = useWorkspaceLayoutStore((state) => state.setPanelCollapsed);
  const showPanel = useWorkspaceLayoutStore((state) => state.showPanel);
  const undo = useEditorHistoryStore((state) => state.undo);
  const redo = useEditorHistoryStore((state) => state.redo);
  const captureHistory = useEditorHistoryStore((state) => state.capture);
  const persistCurrentHistorySnapshot = useEditorHistoryStore((state) => state.persistCurrentSnapshot);
  const restorePersistedHistory = useEditorHistoryStore((state) => state.restorePersisted);
  const canUndo = useEditorHistoryStore((state) => state.past.length > 0);
  const canRedo = useEditorHistoryStore((state) => state.future.length > 0);
  const project = projects.find((item) => item.id === projectId);
  const activeLayer = layers.find((layer) => layer.id === activeProjectedLayerId);
  const imageEditLayer = imageEditLayerSnapshot ?? layers.find((item) => item.id === imageEditLayerId);
  const activeBakedTexture = project?.bakedTextures.find((texture) => texture.id === activeLayer?.bakedTextureId);
  const normalMapTexture = findNormalMapTexture(importedModel);

  useEffect(() => {
    setRouteProjectStatus('idle');
    restoredHistoryProjectIdRef.current = undefined;
  }, [projectId]);

  useEffect(
    () => () => {
      window.clearTimeout(manualBakeProgressTimerRef.current);
      window.clearTimeout(previewStackBakeTimerRef.current);
      window.clearTimeout(thumbnailRefreshTimerRef.current);
      window.clearTimeout(historyPersistTimerRef.current);
    },
    [],
  );

  useEffect(() => {
    const markInteraction = () => {
      lastViewportInteractionRef.current = performance.now();
    };
    window.addEventListener('pointerdown', markInteraction, true);
    window.addEventListener('pointermove', markInteraction, true);
    window.addEventListener('wheel', markInteraction, true);
    return () => {
      window.removeEventListener('pointerdown', markInteraction, true);
      window.removeEventListener('pointermove', markInteraction, true);
      window.removeEventListener('wheel', markInteraction, true);
    };
  }, []);

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
  }, [project, restorePersistedHistory, setCurrentProject, setGenerations, setLayers, setObjects, setReferences]);

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
  }, [project, pushToast, replaceCurrentProject, restorePersistedHistory, setGenerations, setLayers, setObjects, setReferences, t]);

  useEffect(() => {
    if (suppressProjectLayerSyncRef.current > 0) return;
    setProjectLayers(layers);
    if (project?.id && restoredHistoryProjectIdRef.current === project.id) {
      window.clearTimeout(historyPersistTimerRef.current);
      historyPersistTimerRef.current = window.setTimeout(() => persistCurrentHistorySnapshot(project.id), 220);
    }
  }, [layers, persistCurrentHistorySnapshot, project?.id, setProjectLayers]);

  useEffect(() => {
    if (!project?.id || restoredHistoryProjectIdRef.current !== project.id) return;
    window.clearTimeout(historyPersistTimerRef.current);
    historyPersistTimerRef.current = window.setTimeout(() => persistCurrentHistorySnapshot(project.id), 220);
  }, [objects, persistCurrentHistorySnapshot, project?.id]);

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

  function getLiveProjectedPreviewLimit(stack: Layer[] = []) {
    return Math.max(1, stack.length);
  }

  useEffect(() => {
    if (!project || !importedModel || !viewport) return undefined;
    if (!AUTO_PREVIEW_STACK_BAKE_ENABLED) return undefined;
    const objectId = selectedObjectId ?? importedModel.objectId;
    const visibleStack = getVisibleProjectedLayerStack(layers, objectId);
    if (visibleStack.length === 0) return undefined;
    const liveLimit = getLiveProjectedPreviewLimit(visibleStack);
    if (visibleStack.length <= liveLimit) return undefined;
    const currentProject = useProjectStore.getState().getCurrentProject() ?? project;
    const expectedResolution = resolutionToSize[resolution];
    const stackSignature = getProjectedLayerStackSignature(currentProject.id, objectId, expectedResolution, visibleStack);
    const exactTexture = findExactLayerStackTexture(currentProject, visibleStack, expectedResolution, objectId, stackSignature);
    if (canUseLayerStackCache(visibleStack, exactTexture, expectedResolution, objectId, stackSignature)) return undefined;

    if (previewStackBakeRunningRef.current && previewStackBakeKeyRef.current === stackSignature) return undefined;
    if (getLayerStackBakeInFlight(stackSignature)) return undefined;
    const previousFailureAt = previewStackBakeFailureRef.current.get(stackSignature) ?? 0;
    if (Date.now() - previousFailureAt < PREVIEW_STACK_BAKE_FAILURE_COOLDOWN_MS) return undefined;
    window.clearTimeout(previewStackBakeTimerRef.current);
    const tryBakeWhenIdle = () => {
      if (previewStackBakeRunningRef.current) return;
      const idleForMs = performance.now() - lastViewportInteractionRef.current;
      if (idleForMs < 1400) {
        previewStackBakeTimerRef.current = window.setTimeout(tryBakeWhenIdle, 1400 - idleForMs + 250);
        return;
      }
      const latestProject = useProjectStore.getState().getCurrentProject() ?? project;
      const latestObjectId = useSceneStore.getState().selectedObjectId ?? importedModel.objectId;
      const latestStack = getVisibleProjectedLayerStack(useLayerStore.getState().layers, latestObjectId);
      if (latestStack.length === 0) return;
      const latestLiveLimit = getLiveProjectedPreviewLimit(latestStack);
      if (latestStack.length <= latestLiveLimit) return;
      const latestExpectedResolution = resolutionToSize[resolution];
      const latestSignature = getProjectedLayerStackSignature(latestProject.id, latestObjectId, latestExpectedResolution, latestStack);
      const latestExactTexture = findExactLayerStackTexture(
        latestProject,
        latestStack,
        latestExpectedResolution,
        latestObjectId,
        latestSignature,
      );
      if (canUseLayerStackCache(latestStack, latestExactTexture, latestExpectedResolution, latestObjectId, latestSignature)) return;
      if (getLayerStackBakeInFlight(latestSignature)) return;
      const latestFailureAt = previewStackBakeFailureRef.current.get(latestSignature) ?? 0;
      if (Date.now() - latestFailureAt < PREVIEW_STACK_BAKE_FAILURE_COOLDOWN_MS) return;
      previewStackBakeRunningRef.current = true;
      previewStackBakeKeyRef.current = latestSignature;
      setManualBakeProgress({
        title: t('autoBake'),
        detail: `${t('autoBakeCompositing')} · ${latestStack.length}/${latestLiveLimit} projected layers`,
        progress: 0.03,
      });
      const bakePromise = bakeVisibleProjectedLayersToTexture({
        objectId: latestObjectId,
        layerIds: latestStack.map((layer) => layer.id),
        resolution: resolutionToSize[resolution],
        cacheKey: latestSignature,
        enableBackfaceCulling: true,
        enableDilation: true,
        dilationPixels: 4,
        method: 'gpu',
        preferBlobOutput: latestProject.workspaceMode === 'local-server',
        commitToProject: false,
        markSourceLayersBaked: false,
        onProgress: updateManualBakeProgress,
      })
        .then(async (bakeResult) => {
          if (bakeResult.report.coverageRatio < MIN_AUTO_PREVIEW_STACK_BAKE_COVERAGE_RATIO) {
            throw new Error(
              `UV bake coverage ${(bakeResult.report.coverageRatio * 100).toFixed(1)}% is too low for projected stack cache.`,
            );
          }
          let imageUrl = bakeResult.imageUrl;
          let bakedTexture = bakeResult.bakedTexture;
          if (latestProject.workspaceMode === 'local-server') {
            imageUrl = await persistManualBakedTexture(bakeResult.bakedTexture.id, bakeResult.imageUrl, bakeResult.imageBlob);
            if (imageUrl !== bakeResult.imageUrl) bakedTexture = { ...bakedTexture, imageUrl };
          }
          const currentObjectId = useSceneStore.getState().selectedObjectId ?? importedModel.objectId;
          const currentStack = getVisibleProjectedLayerStack(useLayerStore.getState().layers, currentObjectId);
          const currentProject = useProjectStore.getState().getCurrentProject() ?? latestProject;
          const currentSignature = getProjectedLayerStackSignature(
            currentProject.id,
            currentObjectId,
            latestExpectedResolution,
            currentStack,
          );
          if (currentSignature !== latestSignature) return bakedTexture;
          useProjectStore.getState().addBakedTexture(bakedTexture);
          useLayerStore.getState().markLayersBaked(
            bakedTexture.sourceLayerIds ?? [bakedTexture.sourceLayerId],
            bakedTexture.id,
            bakedTexture.createdAt,
          );
          previewStackBakeFailureRef.current.delete(latestSignature);
          scheduleTexturedThumbnailRefresh(350);
          return bakedTexture;
        })
        .catch((error) => {
          previewStackBakeFailureRef.current.set(latestSignature, Date.now());
          console.warn('[Liclick 3D Texture] Could not bake projected preview stack:', error);
          return undefined;
        })
        .finally(() => {
          previewStackBakeRunningRef.current = false;
          manualBakeProgressTimerRef.current = window.setTimeout(() => setManualBakeProgress(undefined), 1200);
        });
      void registerLayerStackBakeInFlight(latestSignature, bakePromise);
    };
    previewStackBakeTimerRef.current = window.setTimeout(tryBakeWhenIdle, 1800);

    return () => window.clearTimeout(previewStackBakeTimerRef.current);
  }, [importedModel, layers, project, pushToast, resolution, selectedObjectId, t, updateCurrentProject, viewport]);

  useEffect(() => {
    function handleUndoRedo(event: KeyboardEvent) {
      if (!(event.ctrlKey || event.metaKey)) return;
      const key = event.key.toLowerCase();
      if (key === 'z' && !event.shiftKey) {
        event.preventDefault();
        undo();
      }
      if (key === 'y' || (key === 'z' && event.shiftKey)) {
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
      thumbnail: options.refreshThumbnail === false ? project.thumbnail : getViewportThumbnailDataUrl() ?? project.thumbnail,
      objects: useSceneStore.getState().objects,
      layers: useLayerStore.getState().layers,
      generations: useGenerationStore.getState().generations,
      captures: useProjectStore.getState().getCurrentProject()?.captures ?? project.captures,
      bakedTextures: useProjectStore.getState().getCurrentProject()?.bakedTextures ?? project.bakedTextures,
      references: useReferenceStore.getState().references,
      updatedAt: new Date().toISOString(),
    };
  }

  function getViewportThumbnailDataUrl(
    options: { camera?: SerializedCamera; width?: number; height?: number; cropVisibleContent?: boolean } = {},
  ) {
    const viewportRuntime = useSceneStore.getState().viewport;
    if (!viewportRuntime) return undefined;
    const canvas = viewportRuntime.gl.domElement;
    if (!canvas || canvas.width === 0 || canvas.height === 0) return undefined;
    const hiddenHelpers: Array<{ object: THREE.Object3D; visible: boolean }> = [];
    const previousCamera = getCurrentCameraSnapshot();
    const previousTarget = viewportRuntime.controls?.target.clone();
    let restoreRenderSize: (() => void) | undefined;
    try {
      if (options.width && options.height) restoreRenderSize = prepareViewportRenderSize(options.width, options.height);
      if (options.camera) {
        applySerializedCamera(viewportRuntime.camera, options.camera);
        if (options.camera.matrixWorld?.length === 16) {
          viewportRuntime.camera.matrixWorld.fromArray(options.camera.matrixWorld);
          viewportRuntime.camera.matrixWorld.decompose(
            viewportRuntime.camera.position,
            viewportRuntime.camera.quaternion,
            viewportRuntime.camera.scale,
          );
          viewportRuntime.camera.matrixWorldInverse.copy(viewportRuntime.camera.matrixWorld).invert();
        }
        if (options.camera.projectionMatrix?.length === 16) {
          viewportRuntime.camera.projectionMatrix.fromArray(options.camera.projectionMatrix);
          viewportRuntime.camera.projectionMatrixInverse.copy(viewportRuntime.camera.projectionMatrix).invert();
        }
        viewportRuntime.camera.updateMatrixWorld(true);
      }
      viewportRuntime.scene.traverse((object) => {
        if (!object.userData.liclickViewportHelper && !object.userData.liclickPaintOverlay) return;
        hiddenHelpers.push({ object, visible: object.visible });
        object.visible = false;
      });
      viewportRuntime.gl.render(viewportRuntime.scene, viewportRuntime.camera);
      const thumbnailCanvas = document.createElement('canvas');
      thumbnailCanvas.width = options.width ?? 640;
      thumbnailCanvas.height = options.height ?? 420;
      const context = thumbnailCanvas.getContext('2d');
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
        const sample = context.getImageData(0, 0, thumbnailCanvas.width, thumbnailCanvas.height).data;
        let visibleSamples = 0;
        const stride = Math.max(4, Math.floor(sample.length / 4000 / 4) * 4);
        for (let offset = 0; offset < sample.length; offset += stride) {
          if (sample[offset + 3] > 8 && sample[offset] + sample[offset + 1] + sample[offset + 2] > 45) visibleSamples += 1;
          if (visibleSamples > 16) break;
        }
        if (visibleSamples <= 16) return undefined;
      }
      const outputCanvas = options.cropVisibleContent ? cropThumbnailToVisibleContent(thumbnailCanvas) : thumbnailCanvas;
      return outputCanvas.toDataURL('image/png');
    } catch (error) {
      console.warn('[Liclick 3D Texture] Project thumbnail capture failed:', error);
      return undefined;
    } finally {
      for (const { object, visible } of hiddenHelpers) {
        object.visible = visible;
      }
      restoreRenderSize?.();
      if (previousCamera) {
        applySerializedCamera(viewportRuntime.camera, previousCamera);
        if (previousCamera.projectionMatrix?.length === 16) {
          viewportRuntime.camera.projectionMatrix.fromArray(previousCamera.projectionMatrix);
          viewportRuntime.camera.projectionMatrixInverse.copy(viewportRuntime.camera.projectionMatrix).invert();
        }
        viewportRuntime.controls?.target.copy(previousTarget ?? new THREE.Vector3(...previousCamera.target));
        viewportRuntime.controls?.update();
      }
      viewportRuntime.gl.render(viewportRuntime.scene, viewportRuntime.camera);
    }
  }

  function getCurrentCameraSnapshot() {
    const viewportRuntime = useSceneStore.getState().viewport;
    if (!viewportRuntime) return undefined;
    const camera = viewportRuntime.camera;
    camera.updateMatrixWorld(true);
    const target = viewportRuntime.controls?.target ?? new THREE.Vector3();
    const cameraType: SerializedCamera['type'] = camera instanceof THREE.OrthographicCamera ? 'orthographic' : 'perspective';
    const near = camera instanceof THREE.PerspectiveCamera || camera instanceof THREE.OrthographicCamera ? camera.near : 0.1;
    const far = camera instanceof THREE.PerspectiveCamera || camera instanceof THREE.OrthographicCamera ? camera.far : 1000;
    const zoom = camera instanceof THREE.PerspectiveCamera || camera instanceof THREE.OrthographicCamera ? camera.zoom : 1;
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
  }

  const getLocalRepaintCaptureSize = useCallback((canvas: HTMLCanvasElement) => {
    const maxSide = Math.max(canvas.width, canvas.height);
    if (maxSide <= 0) return undefined;
    const scale = Math.max(1, Math.min(LOCAL_REPAINT_CAPTURE_SCALE, LOCAL_REPAINT_CAPTURE_MAX_DIMENSION / maxSide));
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

  const getCleanViewportCapture = useCallback((size?: { width: number; height: number }) => {
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
        if (!object.userData.liclickViewportHelper && !object.userData.liclickPaintOverlay) return;
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
  }, [prepareViewportRenderSize]);

  const getViewportInpaintSelectionMask = useCallback((size?: { width: number; height: number }) => {
    const viewportRuntime = useSceneStore.getState().viewport;
    if (!viewportRuntime) return undefined;
    const canvas = viewportRuntime.gl.domElement;
    if (!canvas || canvas.width === 0 || canvas.height === 0) return undefined;
    const hiddenObjects: Array<{ object: THREE.Object3D; visible: boolean }> = [];
    const materialSnapshots: Array<{ mesh: THREE.Mesh; material: THREE.Material | THREE.Material[] }> = [];
    const temporaryMaterials: THREE.Material[] = [];
    const previousBackground = viewportRuntime.scene.background;
    const previousClearColor = viewportRuntime.gl.getClearColor(new THREE.Color()).clone();
    const previousClearAlpha = viewportRuntime.gl.getClearAlpha();
    let restoreRenderSize: (() => void) | undefined;
    const invisibleMaterial = new THREE.MeshBasicMaterial({
      color: '#ffffff',
      colorWrite: false,
      depthWrite: true,
      depthTest: true,
      toneMapped: false,
    });
    let hasMaskOverlay = false;
    try {
      viewportRuntime.scene.traverse((object) => {
        if (object instanceof THREE.Mesh && object.name === 'Liclick UV Inpaint Mask Overlay') {
          hiddenObjects.push({ object, visible: object.visible });
          object.visible = true;
          const logicalMaskTexture = object.userData.liclickInpaintMaskTexture;
          if (logicalMaskTexture instanceof THREE.Texture) {
            const maskMaterial = new THREE.MeshBasicMaterial({
              map: logicalMaskTexture,
              transparent: true,
              opacity: 1,
              depthWrite: false,
              depthTest: true,
              polygonOffset: true,
              polygonOffsetFactor: -8,
              side: THREE.DoubleSide,
              toneMapped: false,
            });
            temporaryMaterials.push(maskMaterial);
            materialSnapshots.push({ mesh: object, material: object.material });
            object.material = maskMaterial;
          }
          hasMaskOverlay = true;
          return;
        }
        if (object.userData.liclickPaintOverlay || object.userData.liclickViewportHelper) {
          hiddenObjects.push({ object, visible: object.visible });
          object.visible = false;
          return;
        }
        if (object instanceof THREE.Mesh) {
          materialSnapshots.push({ mesh: object, material: object.material });
          object.material = invisibleMaterial;
        }
      });
      if (!hasMaskOverlay) return undefined;
      viewportRuntime.scene.background = null;
      viewportRuntime.gl.setClearColor(0x000000, 0);
      if (size) restoreRenderSize = prepareViewportRenderSize(size.width, size.height);
      viewportRuntime.gl.render(viewportRuntime.scene, viewportRuntime.camera);
      const readCanvas = document.createElement('canvas');
      readCanvas.width = canvas.width;
      readCanvas.height = canvas.height;
      const context = readCanvas.getContext('2d', { willReadFrequently: true });
      if (!context) return undefined;
      context.drawImage(canvas, 0, 0);
      const mask = inferAlphaObjectMask(context.getImageData(0, 0, canvas.width, canvas.height));
      return ensureMaskContent(mask) ? mask : undefined;
    } finally {
      for (const { object, visible } of hiddenObjects) object.visible = visible;
      for (const { mesh, material } of materialSnapshots) mesh.material = material;
      temporaryMaterials.forEach((material) => material.dispose());
      viewportRuntime.scene.background = previousBackground;
      viewportRuntime.gl.setClearColor(previousClearColor, previousClearAlpha);
      restoreRenderSize?.();
      invisibleMaterial.dispose();
      viewportRuntime.gl.render(viewportRuntime.scene, viewportRuntime.camera);
    }
  }, [prepareViewportRenderSize]);

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

  function getLocalRepaintFeatherRadius(mask: MaskBitmap) {
    const bounds = computeMaskBoundingBox(mask);
    if (!bounds) return 0;
    const minSide = Math.min(bounds.w, bounds.h);
    if (minSide <= 48) return 1;
    if (minSide <= 120) return 2;
    return 3;
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
        patchMask.data[index] = (runtime.objectMask.data[index] ?? 0) > 0 ? (softMask.data[index] ?? 0) : 0;
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
      featheredMask.data[index] = Math.min(featheredMask.data[index] ?? 0, runtime.objectMask.data[index] ?? 0);
    }
    return featheredMask;
  }

  async function persistLayerImage(imageData: ImageData, filename: string) {
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
  }

  function scheduleTexturedThumbnailRefresh(delayMs = 900) {
    window.clearTimeout(thumbnailRefreshTimerRef.current);
    thumbnailRefreshTimerRef.current = window.setTimeout(() => {
      const thumbnail = getViewportThumbnailDataUrl();
      if (thumbnail) updateCurrentProject({ thumbnail });
    }, delayMs);
  }

  useEffect(() => {
    if (!project || !importedModel || layers.length === 0) return;
    const projectedLayerSignature = layers
      .filter((layer) => layer.type === 'projected')
      .map((layer) => [
        layer.id,
        layer.visible ? 1 : 0,
        layer.imageUrl,
        layer.opacity,
        layer.strength ?? 1,
        layer.blendMode,
        layer.bakedTextureId ?? '',
        layer.needsRebake ? 1 : 0,
      ].join(':'))
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

  function applySavedObjectToLoadedModel(loaded: Awaited<ReturnType<typeof loadModelFromUrl>>, object: SceneObject) {
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
    const objects = projectToRestore.objects.filter((item) => item.format !== 'primitive' && item.sourcePath);
    if (objects.length === 0) {
      clearImportedModel();
      return;
    }
    const modelKey = `${projectToRestore.id}:${objects.map((object) => `${object.id}:${object.sourcePath}`).join('|')}`;
    if (restoredModelKeyRef.current === modelKey) return;
    restoredModelKeyRef.current = modelKey;
    const restorableObjects = objects.filter((object) => object.sourcePath && /^(https?:|blob:|data:)/.test(object.sourcePath));
    const skippedObjects = objects.filter((object) => !object.sourcePath || !/^(https?:|blob:|data:)/.test(object.sourcePath));
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
        setImportedModel(restoredResult, { ...object, selected: object.id === projectToRestore.activeObjectId });
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
      const asBlob = () => saveBlobAsset({ projectId, category, blob: dataUrlToBlob(dataUrl), filename });
      try {
        return preferBlob ? await asBlob() : await asDataUrl();
      } catch (firstError) {
        try {
          return preferBlob ? await asDataUrl() : await asBlob();
        } catch (secondError) {
          const firstMessage = firstError instanceof Error ? firstError.message : 'Unknown error';
          const secondMessage = secondError instanceof Error ? secondError.message : 'Unknown error';
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
      object.sourcePath = await persistAssetUrl(projectForSave.id, object.sourcePath, 'models', object.name);
    }
    for (const reference of projectForSave.references) {
      reference.url = await persistAssetUrl(projectForSave.id, reference.url, 'references', reference.name) ?? reference.url;
    }
    for (const capture of projectForSave.captures) {
      capture.colorUrl = await persistAssetUrl(projectForSave.id, capture.colorUrl, 'captures', `${capture.id}-color.png`) ?? capture.colorUrl;
      capture.maskUrl = await persistAssetUrl(projectForSave.id, capture.maskUrl, 'captures', `${capture.id}-mask.png`) ?? capture.maskUrl;
      capture.depthUrl = await persistAssetUrl(projectForSave.id, capture.depthUrl, 'captures', `${capture.id}-depth.png`) ?? capture.depthUrl;
      capture.normalUrl = await persistAssetUrl(projectForSave.id, capture.normalUrl, 'captures', `${capture.id}-normal.png`) ?? capture.normalUrl;
    }
    for (const generation of projectForSave.generations) {
      generation.resultUrl =
        await persistAssetUrl(projectForSave.id, generation.resultUrl, 'generations', `${generation.id}.png`) ??
        generation.resultUrl;
    }
    const persistOptionalLayerAsset = async (url: string | undefined, filename: string) => {
      try {
        return await persistAssetUrl(projectForSave.id, url, 'layers', filename);
      } catch (error) {
        console.warn(`[Liclick 3D Texture] Dropping unsaved optional layer asset ${filename}.`, error);
        return undefined;
      }
    };
    for (const layer of projectForSave.layers) {
      layer.imageUrl = await persistAssetUrl(projectForSave.id, layer.imageUrl, 'layers', `${layer.id}.png`) ?? layer.imageUrl;
      layer.maskUrl = await persistOptionalLayerAsset(layer.maskUrl, `${layer.id}-mask.png`);
      layer.depthUrl = await persistOptionalLayerAsset(layer.depthUrl, `${layer.id}-depth.png`);
    }
    for (const bakedTexture of projectForSave.bakedTextures) {
      bakedTexture.imageUrl =
        await persistAssetUrl(projectForSave.id, bakedTexture.imageUrl, 'baked', `${bakedTexture.id}.png`) ??
        bakedTexture.imageUrl;
    }
    projectForSave.thumbnail =
      await persistAssetUrl(projectForSave.id, projectForSave.thumbnail, 'captures', 'project-thumbnail.png') ??
      projectForSave.thumbnail;

    return projectForSave;
  }

  async function saveToWorkspaceServer(snapshot: Project) {
    const projectForSave = await prepareProjectForWorkspaceSave(snapshot);
    const result = await saveWorkspaceProject(projectForSave).catch((error) => {
      throw new Error(`保存项目 JSON 失败: ${error instanceof Error ? error.message : 'Unknown error'}`);
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

  async function persistManualBakedTexture(textureId: string, imageUrl: string, imageBlob?: Blob) {
    if (!project || project.workspaceMode !== 'local-server') return imageUrl;
    const filename = `${textureId}.png`;
    const result = imageBlob
      ? await saveBlobAsset({ projectId: project.id, category: 'baked', blob: imageBlob, filename })
      : imageUrl.startsWith('http')
        ? await saveRemoteUrlAsset({ projectId: project.id, category: 'baked', url: imageUrl, filename })
        : await saveDataUrlAsset({
            projectId: project.id,
            category: 'baked',
            dataUrl: imageUrl.startsWith('data:') ? imageUrl : await urlToDataUrl(imageUrl),
            filename,
          });
    return result.asset.url;
  }

  async function handleImportModel(file: File) {
    try {
      const loaded = arrangeImportedModelForComparison(await loadModelFromFile(file, {
        normalize: importSettings.normalizeOnImport,
        ground: importSettings.groundOnImport,
        targetMaxDimension: 3,
      }), useSceneStore.getState().importedModels);
      let object = loaded.object;
      if (project?.workspaceMode === 'local-server') {
        try {
          const saved = await saveDataUrlAsset({
            projectId: project.id,
            category: 'models',
            dataUrl: await fileToDataUrl(file),
            filename: file.name,
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
      updateCurrentProject({ objects: useSceneStore.getState().objects, activeObjectId: object.id });
      window.setTimeout(() => {
        const thumbnail = getViewportThumbnailDataUrl();
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

  async function handleImportReferenceImages(files: File[]) {
    const imageFiles = files.filter((file) => file.type.startsWith('image/') || /\.(png|jpe?g|webp)$/i.test(file.name));
    if (imageFiles.length === 0) return;
    try {
      const objectId = useSceneStore.getState().selectedObjectId;
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
          objectId,
          isPrimary: true,
        });
      }
      addReferences(importedReferences);
      const nextReferences = [...importedReferences, ...useReferenceStore.getState().references.filter((reference) => !importedReferences.some((item) => item.id === reference.id))];
      setProjectReferences(nextReferences);
      pushToast({
        tone: 'success',
        title: '参考图已添加',
        description: objectId ? '已添加到当前选中的模型。' : undefined,
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
    if (!project || !activeLayer || !activeBakedTexture) return;
    downloadBaseColorTexture(activeBakedTexture.imageUrl, project, activeLayer);
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
          : runtime.error ?? '已恢复上一次局部重绘状态。',
      dedupeKey: `local-repaint-restore:${runtime.id}:${runtime.status}`,
    });
    return true;
  }, [projectId, pushToast, showLocalRepaint]);

  async function openLayerLocalRepaint(layer: Layer) {
    if (restoreExistingLocalRepaintSession()) return;
    if (layer.type !== 'projected' || !layer.imageUrl) {
      pushToast({ tone: 'warning', title: t('localRepaintUnavailable'), description: t('selectProjectedLayerHelp') });
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

  async function persistEditedLayerDataUrl(targetLayer: Layer, dataUrl: string) {
    if (!project || project.workspaceMode !== 'local-server') return dataUrl;
    try {
      const saved = await saveDataUrlAsset({
        projectId: project.id,
        category: 'layers',
        dataUrl,
        filename: `${targetLayer.id}.png`,
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
    const rotationDelta = new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().extractRotation(captureToCurrent));
    const position = new THREE.Vector3().fromArray(layer.camera.position).applyMatrix4(captureToCurrent);
    const target = new THREE.Vector3().fromArray(layer.camera.target).applyMatrix4(captureToCurrent);
    const quaternion = rotationDelta.multiply(new THREE.Quaternion().fromArray(layer.camera.quaternion));
    const matrixWorld = new THREE.Matrix4().compose(position, quaternion, new THREE.Vector3(1, 1, 1));

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
            item.id === layer.id ? { ...item, imageUrl: imageUrl ?? item.imageUrl, visible: true } : item,
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
          }) ??
          getViewportThumbnailDataUrl({
            width: IMAGE_EDIT_MAPPED_PREVIEW_SIZE,
            height: IMAGE_EDIT_MAPPED_PREVIEW_SIZE,
            cropVisibleContent: true,
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
    const targetLayer = useLayerStore.getState().layers.find((item) => item.id === targetLayerId) ?? imageEditLayerSnapshot;
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
      description: targetLayer.type === 'uv' ? t('imageEditUvAppliedHelp') : t('projectionPreservedHelp'),
    });
  }

  const completeLocalRepaintRuntime = useCallback(async (runtime: LocalRepaintRuntime, outputImage: Blob, raw?: unknown): Promise<LocalRepaintRuntime> => {
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
    const featheredMask = featherMask(runtime.editMask, getLocalRepaintFeatherRadius(runtime.editMask));
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
  }, []);

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
        const completed = await completeLocalRepaintRuntime(runtimeWithJob, job.outputImage, job.raw);
        updateLocalRepaintRuntime(completed);
        await persistLocalRepaintRuntime(completed);
        return { previewUrl: completed.previewUrl ?? '' };
      }
      updateLocalRepaintRuntime(runtimeWithJob);
      await persistLocalRepaintRuntime(runtimeWithJob);
      return { previewUrl: '' };
    } catch (error) {
      const wasAborted = abortController.signal.aborted;
      const message = wasAborted ? '已终止当前局部重绘任务。' : error instanceof Error ? error.message : t('localRepaintFailed');
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
        enableDilation: false,
        dilationPixels: 0,
        method: 'cpu',
        outputAlpha: 'transparent',
        commitToProject: false,
        markSourceLayersBaked: false,
        preferBlobOutput: project.workspaceMode === 'local-server',
        onProgress: updateManualBakeProgress,
      });
      let imageUrl = bakeResult.imageUrl;
      if (project.workspaceMode === 'local-server') {
        imageUrl = await persistManualBakedTexture(bakeResult.bakedTexture.id, bakeResult.imageUrl, bakeResult.imageBlob);
        if (imageUrl !== bakeResult.imageUrl) {
          updateCurrentProject({
            bakedTextures: (useProjectStore.getState().getCurrentProject()?.bakedTextures ?? project.bakedTextures).map((item) =>
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

  async function addProjectedRepairLayer(runtime: LocalRepaintRuntime) {
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
  }

  async function acceptLocalRepaint({ continueEditing }: { continueEditing: boolean }) {
    const runtime = localRepaintRuntime;
    if (!runtime?.mergedImageData) return;
    captureHistory(runtime.mode === 'edit_layer_image' ? '应用图层局部重绘' : '应用局部重绘 UV 修复');
    try {
      if (runtime.mode === 'edit_layer_image' && runtime.targetLayerId) {
        const imageUrl = runtime.previewUrl ?? (await imageDataToDataUrl(runtime.mergedImageData));
        updateLayerImage(runtime.targetLayerId, imageUrl);
        setProjectLayers(useLayerStore.getState().layers);
        pushToast({ tone: 'success', title: t('localRepaintApplied'), description: t('projectionPreservedHelp') });
      } else {
        const uvLayer = await bakePatchToUvRepairLayer(runtime);
        setProjectLayers(useLayerStore.getState().layers);
        pushToast({ tone: 'success', title: t('localRepaintApplied'), description: `${t('uvRepairLayerCreated')}: ${uvLayer.name}` });
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
      void liclickImageEditProvider.cancelEditImageJob(runtime.editJobId ?? runtime.taskId!).catch((error) => {
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
    setManualBakeProgress({ title: t('mergeSelectedLayersToUvLayer'), detail: t('autoBakePreparing'), progress: 0.02 });
    try {
      const bakeResult = await bakeVisibleProjectedLayersToTexture({
        objectId,
        layerIds: projectedLayerIds,
        resolution: resolutionToSize[resolution],
        enableBackfaceCulling: true,
        enableDilation: false,
        dilationPixels: 0,
        method: 'cpu',
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
      manualBakeProgressTimerRef.current = window.setTimeout(() => setManualBakeProgress(undefined), 1600);
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
      manualBakeProgressTimerRef.current = window.setTimeout(() => setManualBakeProgress(undefined), 1200);
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
    const textureModelExport = actionId.endsWith('-glb') || actionId.endsWith('-fbx') || actionId.endsWith('-obj');
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
        return exportModelGlb({ ...modelInput, target: 'scene' });
      },
      'scene-fbx': () => {
        if (!modelInput) throw new Error(t('importModelFirst'));
        return exportModelFbx({ ...modelInput, target: 'scene' });
      },
      'scene-obj': () => {
        if (!modelInput) throw new Error(t('importModelFirst'));
        return exportModelObj({ ...modelInput, target: 'scene' });
      },
      'scene-stl': () => {
        if (!modelInput) throw new Error(t('importModelFirst'));
        exportModelStl({ ...modelInput, target: 'scene' });
      },
      'object-glb': () => {
        if (!modelInput) throw new Error(t('selectObjectFirst'));
        return exportModelGlb({ ...modelInput, target: 'object' });
      },
      'object-fbx': () => {
        if (!modelInput) throw new Error(t('selectObjectFirst'));
        return exportModelFbx({ ...modelInput, target: 'object' });
      },
      'object-obj': () => {
        if (!modelInput) throw new Error(t('selectObjectFirst'));
        return exportModelObj({ ...modelInput, target: 'object' });
      },
      'object-stl': () => {
        if (!modelInput) throw new Error(t('selectObjectFirst'));
        exportModelStl({ ...modelInput, target: 'object' });
      },
      'texture-color': () => {
        if (!activeBakedTexture) throw new Error(t('bakeBaseColorFirst'));
        return exportTextureUrl(project, activeBakedTexture.imageUrl, 'basecolor');
      },
      'texture-normal': () => {
        if (!normalMapTexture) throw new Error(t('normalTextureMissing'));
        return exportNormalTexture(project, normalMapTexture);
      },
      'comfy-control-inputs': () => {
        if (!viewport || !importedModel) throw new Error(t('importModelFirst'));
        return exportComfyControlInputs({
          project,
          viewport,
          importedModel,
          selectedObjectId,
          references,
          options: {
            modelId: selectedObjectId ?? importedModel.objectId,
            viewId: 'current_mvp_view',
            outputRoot: './exports/comfy_control',
            width: resolutionToSize[resolution],
            height: resolutionToSize[resolution],
            exportCurrentViewOnly: true,
            includeMaterialReference: true,
            includeCurrentTextureRender: true,
            includeMissingMask: true,
            includeDepth: true,
            includeNormal: true,
            includePosition: true,
            includeEdge: true,
            includeIdBuffers: true,
            includeUVBuffers: true,
            includePoseBuffers: true,
            includeAngleBuffers: true,
            includeVisibilityBuffers: true,
            linearDepth: true,
            savePng16: true,
            saveDebugPng8: true,
          },
        }).then(() => undefined);
      },
      'viewport-png': () => {
        if (!viewport) throw new Error(t('viewportUnavailable'));
        return exportViewportSnapshot({ project, viewport });
      },
      'turntable-webm': () => {
        if (!viewport || !importedModel) throw new Error(t('importModelFirst'));
        return exportTurntableWebm({ project, viewport, root: importedModel.group, durationMs: 5000 });
      },
    };

    void runExportAction(t('exporting'), actions[actionId]);
  }

  const handleLocalRepaintFromToolbar = useCallback(() => {
    void (async () => {
      if (restoreExistingLocalRepaintSession()) return;
      const viewportRuntime = useSceneStore.getState().viewport;
      const captureSize = viewportRuntime ? getLocalRepaintCaptureSize(viewportRuntime.gl.domElement) : undefined;
      const capture = getCleanViewportCapture(captureSize);
      const initialUserMask = getViewportInpaintSelectionMask(captureSize);
      const cameraState = getCurrentCameraSnapshot();
      if (!capture || !cameraState || !importedModel) {
        pushToast({ tone: 'warning', title: t('viewportUnavailable'), description: t('importModelFirst') });
        return;
      }
      const workingImageData = await urlToImageData(capture.dataUrl);
      const objectMask = capture.objectMask;
      const holeMask = buildContentAwareRepairMask(
        removeSmallMaskComponents(inferWhiteHoleMask(workingImageData, objectMask), 48),
        objectMask,
      );
      openLocalRepaintRuntime({
        id: createId('local-repaint'),
        projectId,
        mode: 'repair_current_view',
        targetName: importedModel.name,
        cameraState,
        workingImageUrl: capture.dataUrl,
        workingImageData,
        objectMask,
        initialUserMask,
        holeMask,
        status: 'idle',
      });
    })();
  }, [getCleanViewportCapture, getLocalRepaintCaptureSize, getViewportInpaintSelectionMask, importedModel, openLocalRepaintRuntime, projectId, pushToast, restoreExistingLocalRepaintSession, t]);

  const handleContentAwareRepairFromToolbar = useCallback(() => {
    void (async () => {
      const viewportRuntime = useSceneStore.getState().viewport;
      const captureSize = viewportRuntime ? getLocalRepaintCaptureSize(viewportRuntime.gl.domElement) : undefined;
      const capture = getCleanViewportCapture(captureSize);
      const cameraState = getCurrentCameraSnapshot();
      if (!capture || !cameraState || !importedModel) {
        pushToast({ tone: 'warning', title: t('viewportUnavailable'), description: t('importModelFirst') });
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
        const roiRect = expandRect(bbox, 32, { width: workingImageData.width, height: workingImageData.height });
        captureHistory('内容识别修补白膜未填充区域');
        setManualBakeProgress({
          title: t('contentAwareRepair'),
          detail: t('contentAwareRepairFilling'),
          progress: 0.24,
        });
        const filled = contentAwareFillMaskedPixels(workingImageData, editMask, objectMask, {
          searchRadius: Math.max(24, Math.min(72, Math.ceil(Math.max(roiRect.w, roiRect.h) * 0.26))),
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
        manualBakeProgressTimerRef.current = window.setTimeout(() => setManualBakeProgress(undefined), 1200);
      }
    })();
  }, [
    captureHistory,
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

    function handleInpaintShortcuts(event: KeyboardEvent) {
      if (isEditingText(event.target)) return;
      const key = event.key.toLowerCase();
      const isBrushSizeShortcut =
        event.key === '[' ||
        event.key === ']' ||
        event.code === 'BracketLeft' ||
        event.code === 'BracketRight';
      if (event.ctrlKey && key === 'd') {
        event.preventDefault();
        clearPaintMask();
        return;
      }
      if (event.ctrlKey && key === 'i') {
        event.preventDefault();
        invertPaintMask();
        return;
      }
      if (event.ctrlKey || event.metaKey || event.altKey) return;
      if (isBrushSizeShortcut) {
        event.preventDefault();
        const direction = event.key === '[' || event.code === 'BracketLeft' ? -1 : 1;
        const state = useSceneStore.getState();
        const stepBrushSize = (value: number, min: number, max: number) => {
          const step = value < 10 ? 1 : value < 60 ? 5 : 10;
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

        if (state.paintTool === 'inpaint-add' || state.paintTool === 'inpaint-subtract') {
          const nextSize = stepBrushSize(state.paintMaskSettings.brushSize, 1, 180);
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
      if (key === 'k') {
        setPaintTool(useSceneStore.getState().paintTool === 'inpaint-add' ? 'none' : 'inpaint-add');
        return;
      }
      if (key === 'o') {
        setPaintTool(useSceneStore.getState().paintTool === 'inpaint-subtract' ? 'none' : 'inpaint-subtract');
        return;
      }
      if (key === 'i') handleLocalRepaintFromToolbar();
    }

    window.addEventListener('keydown', handleInpaintShortcuts);
    return () => window.removeEventListener('keydown', handleInpaintShortcuts);
  }, [clearPaintMask, handleLocalRepaintFromToolbar, invertPaintMask, pushToast, setPaintTool]);

  const panelDefinitions = ([
    {
      id: 'segments',
      title: t('segments'),
      dock: 'left',
      order: 10,
      collapsed: workspacePanels.find((panel) => panel.id === 'segments')?.collapsed ?? true,
      visible: true,
      mode: 'texture',
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
      mode: 'texture',
      actions: <QuickMaskPanelActions />,
      content: <QuickMaskPanel />,
    },
    {
      id: 'objects',
      title: t('objectsPanel'),
      dock: 'left',
      order: 30,
      collapsed: workspacePanels.find((panel) => panel.id === 'objects')?.collapsed ?? true,
      visible: true,
      mode: 'texture',
      actions: <ObjectsPanelActions onImportModelClick={() => modelInputRef.current?.click()} />,
      content: <ObjectsPanel />,
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
        workspacePanels.find((panel) => panel.id === 'layerAdjustments')?.collapsed ??
        true,
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
      mode: 'texture',
      content: <ViewportPanel />,
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
          onLayerLocalRepaint={(layer) => void openLayerLocalRepaint(layer)}
          onMergeSelectedToUvLayer={(layerIds) => void mergeLayersToUvLayer(layerIds)}
          onMergeIntoSelectedBlankUvLayer={(layerIds, blankUvLayerId) => void mergeLayersToUvLayer(layerIds, blankUvLayerId)}
        />
      ),
    },
    {
      id: 'normalVisualizer',
      title: t('normalVisualizer'),
      dock: 'left',
      order: 10,
      collapsed:
        workspacePanels.find((panel) => panel.id === 'normalVisualizer')?.collapsed ??
        false,
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
        workspacePanels.find((panel) => panel.id === 'normalGeneration')?.collapsed ??
        false,
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
              onClick={() => handleExportAction('comfy-control-inputs')}
              title={!importedModel ? t('importModelFirst') : undefined}
            >
              Comfy Control Inputs
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
              disabled={!activeBakedTexture || !activeLayer}
              onClick={handleExportBaseColorDownload}
              icon={<Download className="h-4 w-4" />}
              title={!activeBakedTexture ? t('bakeBaseColorFirst') : undefined}
            >
              {t('downloadBaseColor')}
            </Button>
          </div>
        </WorkspaceModeShell>
      ),
    },
  ] satisfies WorkspacePanelDefinition[]).map((definition) => {
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
            {routeProjectStatus === 'missing' ? t('projectLoadFailedHelp') : t('projectLoadingHelp')}
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
        accept=".glb,.gltf,.fbx,.obj"
        onChange={(event) => {
          const file = event.target.files?.item(0);
          if (file) void handleImportModel(file);
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
        onBack={onBack}
        exportMenu={
          <ExportMenu
            canExportScene={Boolean(importedModel && viewport)}
            canExportObject={Boolean(importedModel && selectedObjectId)}
            canExportColor={Boolean(activeLayer && activeBakedTexture)}
            canExportNormal={Boolean(normalMapTexture)}
            canRecordTurntable={canRecordTurntable()}
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
              browserUnsupported: t('browserUnsupported'),
            }}
          />
        }
        bottomToolbar={
          <BottomToolDock
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
              localRepaint: t('localRepaint'),
              inpaintSelect: t('inpaintSelect'),
              inpaintUnselect: t('inpaintUnselect'),
              undo: t('undo'),
              redo: t('redo'),
              brushSize: t('brushSize'),
              brushHardness: t('brushHardness'),
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
            onImportModel={(file) => void handleImportModel(file)}
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
          references={references.filter((reference) => !selectedObjectId || !reference.objectId || reference.objectId === selectedObjectId)}
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
      {manualBakeProgress && createPortal(<AutoBakeProgressBar progress={manualBakeProgress} />, document.body)}
    </>
  );
}
