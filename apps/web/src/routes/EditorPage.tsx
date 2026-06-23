import { useEffect, useRef, useState } from 'react';
import { Download } from 'lucide-react';
import { BottomToolDock } from '@/components/editor/BottomToolDock';
import { ExportMenu, type ExportActionId } from '@/components/editor/ExportMenu';
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
import { downloadBaseColorTexture } from '@/engine/bake/downloadTexture';
import { exportModelGlb } from '@/engine/export/exportGltf';
import { exportModelObj } from '@/engine/export/exportObj';
import { renderProjectThumbnail } from '@/engine/export/projectThumbnail';
import { exportViewportSnapshot } from '@/engine/export/exportSnapshot';
import { exportModelStl } from '@/engine/export/exportStl';
import { exportNormalTexture, exportTextureUrl, findNormalMapTexture } from '@/engine/export/exportTexture';
import { canRecordTurntable, exportTurntableWebm } from '@/engine/export/exportTurntable';
import { loadModelFromFile, loadModelFromUrl } from '@/engine/loaders/loadModelFromFile';
import { ViewportCanvas } from '@/engine/viewport/ViewportCanvas';
import { EditorShell } from '@/layouts/EditorShell';
import { importProjectJson } from '@/services/projectService';
import {
  fileToDataUrl,
  isWorkspaceAssetUrl,
  loadProject as loadWorkspaceProject,
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
import { useToastStore } from '@/stores/toastStore';
import type { SceneObject } from '@/types/model';
import type { Project } from '@/types/project';

type EditorPageProps = {
  projectId: string;
  onBack: () => void;
};

export function EditorPage({ projectId, onBack }: EditorPageProps) {
  const modelInputRef = useRef<HTMLInputElement>(null);
  const projectInputRef = useRef<HTMLInputElement>(null);
  const loadedProjectIdRef = useRef<string>();
  const serverLoadedProjectIdRef = useRef<string>();
  const restoredModelKeyRef = useRef<string>();
  const autosaveTimerRef = useRef<number>();
  const [saveStatus, setSaveStatus] = useState<'idle' | 'saving' | 'saved' | 'failed' | 'offline'>('idle');
  const [routeProjectStatus, setRouteProjectStatus] = useState<'idle' | 'loading' | 'missing'>('idle');
  const projects = useProjectStore((state) => state.projects);
  const setCurrentProject = useProjectStore((state) => state.setCurrentProject);
  const replaceCurrentProject = useProjectStore((state) => state.replaceCurrentProject);
  const updateCurrentProject = useProjectStore((state) => state.updateCurrentProject);
  const setWorkspaceState = useProjectStore((state) => state.setWorkspaceState);
  const markSaved = useProjectStore((state) => state.markSaved);
  const setObjects = useSceneStore((state) => state.setObjects);
  const setImportedModel = useSceneStore((state) => state.setImportedModel);
  const clearImportedModel = useSceneStore((state) => state.clearImportedModel);
  const importedModel = useSceneStore((state) => state.importedModel);
  const viewport = useSceneStore((state) => state.viewport);
  const importSettings = useSceneStore((state) => state.importSettings);
  const transformMode = useSceneStore((state) => state.transformMode);
  const setTransformMode = useSceneStore((state) => state.setTransformMode);
  const paintTool = useSceneStore((state) => state.paintTool);
  const setPaintTool = useSceneStore((state) => state.setPaintTool);
  const selectedObjectId = useSceneStore((state) => state.selectedObjectId);
  const setLayers = useLayerStore((state) => state.setLayers);
  const layers = useLayerStore((state) => state.layers);
  const activeProjectedLayerId = useLayerStore((state) => state.activeProjectedLayerId);
  const generations = useGenerationStore((state) => state.generations);
  const setGenerations = useGenerationStore((state) => state.setGenerations);
  const setProjectGenerations = useProjectStore((state) => state.setProjectGenerations);
  const setProjectLayers = useProjectStore((state) => state.setProjectLayers);
  const setProjectReferences = useProjectStore((state) => state.setProjectReferences);
  const references = useReferenceStore((state) => state.references);
  const setReferences = useReferenceStore((state) => state.setReferences);
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
      const snapshot = getProjectSnapshot();
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
    }, 1500);
    return () => window.clearTimeout(autosaveTimerRef.current);
    // Autosave is intentionally keyed to project dirty/id/mode. The save helpers read the latest stores.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project?.dirty, project?.id, project?.workspaceMode, pushToast]);

  function getProjectSnapshot(): Project | undefined {
    if (!project) return undefined;
    return {
      ...project,
      thumbnail: getViewportThumbnailDataUrl() ?? project.thumbnail,
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
    const object = projectToRestore.objects.find((item) => item.format !== 'primitive' && item.sourcePath);
    if (!object?.sourcePath) {
      clearImportedModel();
      return;
    }
    const modelKey = `${projectToRestore.id}:${object.id}:${object.sourcePath}`;
    if (restoredModelKeyRef.current === modelKey) return;
    restoredModelKeyRef.current = modelKey;
    if (!/^(https?:|blob:|data:)/.test(object.sourcePath)) {
      pushToast({
        tone: 'warning',
        title: t('modelRestoreSkipped'),
        description: t('modelRestoreRelativePath'),
        dedupeKey: `model-restore:${projectToRestore.id}`,
      });
      return;
    }
    try {
      const loaded = await loadModelFromUrl({
        sourceUrl: object.sourcePath,
        fileName: getObjectFileName(object),
        normalizeOptions: {
          normalize: object.importNormalizationTransform?.normalized ?? true,
          ground: object.importNormalizationTransform?.grounded ?? true,
          targetMaxDimension: object.importNormalizationTransform?.targetMaxDimension ?? 3,
        },
      });
      const restoredResult = applySavedObjectToLoadedModel(loaded, object);
      setImportedModel(restoredResult, { ...object, selected: true });
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

  async function handleImportModel(file: File) {
    try {
      const loaded = await loadModelFromFile(file, {
        normalize: importSettings.normalizeOnImport,
        ground: importSettings.groundOnImport,
        targetMaxDimension: 3,
      });
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
      updateCurrentProject({ objects: [object] });
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
      'scene-obj': () => {
        if (!modelInput) throw new Error(t('importModelFirst'));
        exportModelObj({ ...modelInput, target: 'scene' });
      },
      'scene-stl': () => {
        if (!modelInput) throw new Error(t('importModelFirst'));
        exportModelStl({ ...modelInput, target: 'scene' });
      },
      'object-glb': () => {
        if (!modelInput) throw new Error(t('selectObjectFirst'));
        return exportModelGlb({ ...modelInput, target: 'object' });
      },
      'object-obj': () => {
        if (!modelInput) throw new Error(t('selectObjectFirst'));
        exportModelObj({ ...modelInput, target: 'object' });
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

  function handleOpenLayersFromToolbar() {
    showPanel('layers');
    setPanelCollapsed('layers', false);
  }

  function handleLocalRepaintFromToolbar() {
    setPaintTool('brush');
    showPanel('generate');
    setPanelCollapsed('generate', false);
    pushToast({
      tone: 'info',
      title: t('paintMaskReady'),
      description: t('paintMaskReadyHelp'),
      dedupeKey: 'paint-mask-ready',
    });
  }

  function handleReferenceLinkFromToolbar() {
    showPanel('generate');
    setPanelCollapsed('generate', false);
    pushToast({
      tone: 'info',
      title: t('referenceImage'),
      description: t('referenceLinkToolHelp'),
      dedupeKey: 'reference-link-ready',
    });
  }

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
      actions: <ObjectsPanelActions />,
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
      content: <LayersPanel />,
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
            onOpenLayers={handleOpenLayersFromToolbar}
            onLocalRepaint={handleLocalRepaintFromToolbar}
            onReferenceLink={handleReferenceLinkFromToolbar}
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
              referenceLink: t('referenceLink'),
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
              referenceLinkHelp: t('referenceLinkToolHelp'),
            }}
          />
        }
        center={
          <ViewportCanvas
            hasImportedModel={Boolean(importedModel)}
            onImportModel={(file) => void handleImportModel(file)}
            onOpenImport={() => modelInputRef.current?.click()}
          />
        }
        panels={panelDefinitions}
      />
    </>
  );
}
