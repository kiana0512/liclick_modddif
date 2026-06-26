import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Download } from 'lucide-react';
import * as THREE from 'three';
import { BottomToolDock } from '@/components/editor/BottomToolDock';
import { ExportMenu, type ExportActionId } from '@/components/editor/ExportMenu';
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
  getVisibleProjectedLayerStack,
} from '@/engine/bake/layerStackCache';
import { exportModelGlb } from '@/engine/export/exportGltf';
import { exportModelFbx } from '@/engine/export/exportFbx';
import { exportModelObj } from '@/engine/export/exportObj';
import { renderProjectThumbnail } from '@/engine/export/projectThumbnail';
import { exportViewportSnapshot } from '@/engine/export/exportSnapshot';
import { exportModelStl } from '@/engine/export/exportStl';
import { exportNormalTexture, exportTextureUrl, findNormalMapTexture } from '@/engine/export/exportTexture';
import { canRecordTurntable, exportTurntableWebm } from '@/engine/export/exportTurntable';
import { loadModelFromFile, loadModelFromUrl } from '@/engine/loaders/loadModelFromFile';
import type { LoadedModel, ModelLoadResult } from '@/engine/loaders/modelImportTypes';
import { getBoundingBoxForObject } from '@/engine/scene/boundingBoxUtils';
import { ViewportCanvas } from '@/engine/viewport/ViewportCanvas';
import { EditorShell } from '@/layouts/EditorShell';
import { importProjectJson } from '@/services/projectService';
import {
  fileToDataUrl,
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
import { useEditorHistoryStore } from '@/stores/editorHistoryStore';
import { useT } from '@/stores/i18nStore';
import { useLayerStore } from '@/stores/layerStore';
import { useProjectStore } from '@/stores/projectStore';
import { useReferenceStore } from '@/stores/referenceStore';
import { useSceneStore } from '@/stores/sceneStore';
import { useSettingsStore } from '@/stores/settingsStore';
import { useToastStore } from '@/stores/toastStore';
import type { BakeProgress } from '@/engine/bake/uvBakeTypes';
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
  const manualBakeRunningRef = useRef(false);
  const manualBakeProgressTimerRef = useRef<number>();
  const [saveStatus, setSaveStatus] = useState<'idle' | 'saving' | 'saved' | 'failed' | 'offline'>('idle');
  const [routeProjectStatus, setRouteProjectStatus] = useState<'idle' | 'loading' | 'missing'>('idle');
  const [manualBakeProgress, setManualBakeProgress] = useState<AutoBakeProgress | undefined>();
  const projects = useProjectStore((state) => state.projects);
  const setCurrentProject = useProjectStore((state) => state.setCurrentProject);
  const replaceCurrentProject = useProjectStore((state) => state.replaceCurrentProject);
  const updateCurrentProject = useProjectStore((state) => state.updateCurrentProject);
  const setWorkspaceState = useProjectStore((state) => state.setWorkspaceState);
  const markSaved = useProjectStore((state) => state.markSaved);
  const setObjects = useSceneStore((state) => state.setObjects);
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
  const paintMaskHasContent = useSceneStore((state) => state.paintMaskHasContent);
  const clearPaintMask = useSceneStore((state) => state.clearPaintMask);
  const invertPaintMask = useSceneStore((state) => state.invertPaintMask);
  const selectedObjectId = useSceneStore((state) => state.selectedObjectId);
  const setLayers = useLayerStore((state) => state.setLayers);
  const layers = useLayerStore((state) => state.layers);
  const activeProjectedLayerId = useLayerStore((state) => state.activeProjectedLayerId);
  const markLayersBaked = useLayerStore((state) => state.markLayersBaked);
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
  const canUndo = useEditorHistoryStore((state) => state.past.length > 0);
  const canRedo = useEditorHistoryStore((state) => state.future.length > 0);
  const project = projects.find((item) => item.id === projectId);
  const activeLayer = layers.find((layer) => layer.id === activeProjectedLayerId);
  const activeBakedTexture = project?.bakedTextures.find((texture) => texture.id === activeLayer?.bakedTextureId);
  const normalMapTexture = findNormalMapTexture(importedModel);

  useEffect(() => {
    setRouteProjectStatus('idle');
  }, [projectId]);

  useEffect(() => () => window.clearTimeout(manualBakeProgressTimerRef.current), []);

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
        void restoreProjectModel(result.project);
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
  }, [project, projectId, pushToast, replaceCurrentProject, routeProjectStatus, setGenerations, setLayers, setObjects, setReferences, t]);

  useEffect(() => {
    if (!project) return;
    if (loadedProjectIdRef.current === project.id) return;
    loadedProjectIdRef.current = project.id;
    setCurrentProject(project.id);
    setObjects(project.objects.filter((object) => object.format !== 'primitive'));
    setLayers(project.layers);
    setGenerations(project.generations, project.id);
    setReferences(project.references);
    void restoreProjectModel(project);
    // restoreProjectModel is intentionally not a dependency; this effect should run once per project id.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project, setCurrentProject, setGenerations, setLayers, setObjects, setReferences]);

  useEffect(() => {
    if (!project || project.workspaceMode !== 'local-server') return;
    if (serverLoadedProjectIdRef.current === project.id) return;
    serverLoadedProjectIdRef.current = project.id;
    void loadWorkspaceProject(project.id)
      .then((result) => {
        replaceCurrentProject(result.project);
        setObjects(result.project.objects.filter((object) => object.format !== 'primitive'));
        setLayers(result.project.layers);
        setGenerations(result.project.generations, result.project.id);
        setReferences(result.project.references);
        void restoreProjectModel(result.project);
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
  }, [project, pushToast, replaceCurrentProject, setGenerations, setLayers, setObjects, setReferences, t]);

  useEffect(() => {
    setProjectLayers(layers);
  }, [layers, setProjectLayers]);

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
    autosaveTimerRef.current = window.setTimeout(() => {
      const snapshot = getProjectSnapshot({ refreshThumbnail: false });
      if (!snapshot) return;
      setSaveStatus('saving');
      void saveToWorkspaceServer(snapshot)
        .then(() => setSaveStatus('saved'))
        .catch((error) => {
          setSaveStatus('offline');
          const authRequired = error instanceof WorkspaceApiError && error.status === 401;
          pushToast({
            tone: authRequired ? 'warning' : 'warning',
            title: authRequired ? '需要飞书登录' : 'Local workspace server is not running.',
            description: authRequired ? '当前工程的模型、参考图、图层和生成记录需要登录后才能保存到你的用户工作区。' : undefined,
            dedupeKey: authRequired ? 'workspace-auth-required-editor-save' : 'workspace-server-offline',
          });
      });
    }, 5000);
    return () => window.clearTimeout(autosaveTimerRef.current);
    // Autosave is intentionally keyed to project dirty/id/mode. The save helpers read the latest stores.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project?.dirty, project?.id, project?.workspaceMode, pushToast]);

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

  function getViewportThumbnailDataUrl() {
    const imported = useSceneStore.getState().importedModel;
    if (imported) {
      try {
        return renderProjectThumbnail(imported.group);
      } catch (error) {
        console.warn('[Liclick 3D Texture] Project thumbnail render failed:', error);
      }
    }
    const canvas = useSceneStore.getState().viewport?.gl.domElement;
    if (!canvas || canvas.width === 0 || canvas.height === 0) return undefined;
    try {
      return canvas.toDataURL('image/png');
    } catch {
      return undefined;
    }
  }

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
    const result = await saveDataUrlAsset({ projectId, category, dataUrl, filename });
    return result.asset.relativePath;
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
    for (const layer of projectForSave.layers) {
      layer.imageUrl = await persistAssetUrl(projectForSave.id, layer.imageUrl, 'layers', `${layer.id}.png`) ?? layer.imageUrl;
      layer.maskUrl = await persistAssetUrl(projectForSave.id, layer.maskUrl, 'layers', `${layer.id}-mask.png`);
      layer.depthUrl = await persistAssetUrl(projectForSave.id, layer.depthUrl, 'layers', `${layer.id}-depth.png`);
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
    const result = await saveWorkspaceProject(projectForSave);
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

  function updateManualBakeProgress(progress: BakeProgress) {
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
    setManualBakeProgress({
      title: t('autoBake'),
      detail: `${phaseLabel} ${percent}%${layerDetail}${triangleDetail}`,
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

  async function persistBakeState() {
    const bakedLayers = useLayerStore.getState().layers;
    setProjectLayers(bakedLayers);
    if (!project || project.workspaceMode !== 'local-server') return;
    const snapshot = getProjectSnapshot({ refreshThumbnail: false });
    if (snapshot) await saveToWorkspaceServer(snapshot);
  }

  async function handleLayerBakeRequest(layer: Layer) {
    if (manualBakeRunningRef.current) {
      pushToast({
        tone: 'info',
        title: t('autoBakeQueued'),
        description: '当前已有 UV 烘焙在执行，请稍等完成后再双击。',
        dedupeKey: 'manual-bake-busy',
      });
      return;
    }

    const currentImportedModel = useSceneStore.getState().importedModel;
    if (!project || !currentImportedModel) {
      pushToast({ tone: 'error', title: t('autoBakeFailed'), description: t('importModelFirst') });
      return;
    }

    const objectId = layer.objectId ?? selectedObjectId ?? currentImportedModel.objectId;
    const visibleLayers = getVisibleProjectedLayerStack(useLayerStore.getState().layers, objectId);
    if (visibleLayers.length === 0) {
      pushToast({ tone: 'error', title: t('autoBakeFailed'), description: t('addProjectedLayerFirst') });
      return;
    }

    manualBakeRunningRef.current = true;
    window.clearTimeout(manualBakeProgressTimerRef.current);
    setManualBakeProgress({
      title: t('autoBake'),
      detail: `${layer.name} ${t('autoBakePreparing')}`,
      progress: 0.02,
    });

    try {
      const cachedTexture = findExactLayerStackTexture(project, visibleLayers);
      if (cachedTexture && canUseLayerStackCache(visibleLayers, cachedTexture)) {
        setManualBakeProgress({ title: t('autoBake'), detail: t('autoBakeApplying'), progress: 0.96 });
        markLayersBaked(
          visibleLayers.map((item) => item.id),
          cachedTexture.id,
          cachedTexture.createdAt,
        );
        await applyBakedTextureToObject(currentImportedModel.group, cachedTexture.imageUrl);
        await persistBakeState();
        setManualBakeProgress({
          title: t('autoBakeComplete'),
          detail: '已恢复当前可见图层栈的 UV 缓存',
          progress: 1,
        });
        pushToast({
          tone: 'success',
          title: t('autoBakeComplete'),
          description: '已从缓存恢复当前可见图层栈，无需重新烘焙。',
          dedupeKey: `manual-bake-cache:${cachedTexture.id}`,
        });
        return;
      }

      const bakeResult = await bakeVisibleProjectedLayersToTexture({
        objectId,
        resolution: resolutionToSize[resolution],
        enableBackfaceCulling: true,
        enableDilation: true,
        dilationPixels: 4,
        preferBlobOutput: project.workspaceMode === 'local-server',
        onProgress: updateManualBakeProgress,
      });
      setManualBakeProgress({ title: t('autoBake'), detail: t('autoBakeApplyPbr'), progress: 0.98 });
      await applyBakedTextureToObject(currentImportedModel.group, bakeResult.imageUrl);

      if (project.workspaceMode === 'local-server') {
        setManualBakeProgress({ title: t('autoBake'), detail: t('autoBakePersistWorkspace'), progress: 0.99 });
        const imageUrl = await persistManualBakedTexture(
          bakeResult.bakedTexture.id,
          bakeResult.imageUrl,
          bakeResult.imageBlob,
        );
        if (imageUrl !== bakeResult.imageUrl) {
          const bakedTextures = (useProjectStore.getState().getCurrentProject()?.bakedTextures ?? project.bakedTextures).map(
            (item) => (item.id === bakeResult.bakedTexture.id ? { ...item, imageUrl } : item),
          );
          updateCurrentProject({ bakedTextures });
        }
      }

      await persistBakeState();
      setManualBakeProgress({
        title: t('autoBakeComplete'),
        detail: `${bakeResult.bakedTexture.width}px ${t('autoBakeCompleteDetail')}`,
        progress: 1,
      });
      pushToast({
        tone: 'success',
        title: t('autoBakeComplete'),
        description: `${t('autoBakeSuccessHelp')} ${bakeResult.bakedTexture.width}px，${t('coverage')} ${(bakeResult.report.coverageRatio * 100).toFixed(1)}%。`,
        dedupeKey: `manual-bake-success:${layer.id}`,
      });
    } catch (error) {
      console.error('[Liclick 3D Texture] Manual layer bake failed:', error);
      pushToast({
        tone: 'error',
        title: t('autoBakeFailed'),
        description: error instanceof Error ? error.message : t('autoBakeFailedHelp'),
        dedupeKey: `manual-bake-failed:${layer.id}`,
      });
      setManualBakeProgress(undefined);
    } finally {
      manualBakeRunningRef.current = false;
      manualBakeProgressTimerRef.current = window.setTimeout(() => {
        setManualBakeProgress(undefined);
      }, 1600);
    }
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
    }
  }

  function handleExportAction(actionId: ExportActionId) {
    if (!project) return;
    const modelInput = importedModel
      ? { project, importedModel, selectedObjectId, target: actionId.startsWith('object') ? 'object' : 'scene' }
      : undefined;

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
    showPanel('generate');
    setPanelCollapsed('generate', false);
    pushToast({
      tone: paintMaskHasContent ? 'info' : 'warning',
      title: paintMaskHasContent ? t('paintMaskReady') : t('inpaintMaskMissing'),
      description: paintMaskHasContent ? t('inpaintApiPendingHelp') : t('inpaintMaskMissingHelp'),
      dedupeKey: paintMaskHasContent ? 'inpaint-api-pending' : 'inpaint-mask-missing',
    });
  }, [paintMaskHasContent, pushToast, setPanelCollapsed, showPanel, t]);

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
  }, [clearPaintMask, handleLocalRepaintFromToolbar, invertPaintMask, setPaintTool]);

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
      actions: <LayersPanelActions />,
      content: <LayersPanel onLayerDoubleClick={(layer) => void handleLayerBakeRequest(layer)} />,
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
      {manualBakeProgress && createPortal(<AutoBakeProgressBar progress={manualBakeProgress} />, document.body)}
    </>
  );
}
