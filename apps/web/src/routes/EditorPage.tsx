import { useEffect, useRef } from 'react';
import { GeneratePanel } from '@/components/panels/GeneratePanel';
import { LayerAdjustmentsPanel } from '@/components/panels/LayerAdjustmentsPanel';
import { LayersPanel } from '@/components/panels/LayersPanel';
import { ObjectTransformPanel } from '@/components/panels/ObjectTransformPanel';
import { ObjectsPanel } from '@/components/panels/ObjectsPanel';
import { ReferenceImagesPanel } from '@/components/panels/ReferenceImagesPanel';
import { ViewportPanel } from '@/components/panels/ViewportPanel';
import { loadModelFromFile } from '@/engine/loaders/loadModelFromFile';
import { ViewportCanvas } from '@/engine/viewport/ViewportCanvas';
import { EditorShell } from '@/layouts/EditorShell';
import {
  getRecentWorkspaceHandle,
  loadProjectWithPicker,
  saveProjectAsWorkspace,
  saveProjectToWorkspace,
} from '@/services/localWorkspaceService';
import { downloadProjectJson, importProjectJson } from '@/services/projectService';
import { useGenerationStore } from '@/stores/generationStore';
import { useLayerStore } from '@/stores/layerStore';
import { useProjectStore } from '@/stores/projectStore';
import { useReferenceStore } from '@/stores/referenceStore';
import { useSceneStore } from '@/stores/sceneStore';
import { useToastStore } from '@/stores/toastStore';
import type { Project } from '@/types/project';

type EditorPageProps = {
  projectId: string;
  onBack: () => void;
};

export function EditorPage({ projectId, onBack }: EditorPageProps) {
  const modelInputRef = useRef<HTMLInputElement>(null);
  const projectInputRef = useRef<HTMLInputElement>(null);
  const loadedProjectIdRef = useRef<string>();
  const projects = useProjectStore((state) => state.projects);
  const setCurrentProject = useProjectStore((state) => state.setCurrentProject);
  const replaceCurrentProject = useProjectStore((state) => state.replaceCurrentProject);
  const updateCurrentProject = useProjectStore((state) => state.updateCurrentProject);
  const setWorkspaceState = useProjectStore((state) => state.setWorkspaceState);
  const markSaved = useProjectStore((state) => state.markSaved);
  const setObjects = useSceneStore((state) => state.setObjects);
  const setImportedModel = useSceneStore((state) => state.setImportedModel);
  const importedModel = useSceneStore((state) => state.importedModel);
  const importSettings = useSceneStore((state) => state.importSettings);
  const setLayers = useLayerStore((state) => state.setLayers);
  const layers = useLayerStore((state) => state.layers);
  const generations = useGenerationStore((state) => state.generations);
  const setGenerations = useGenerationStore((state) => state.setGenerations);
  const setProjectGenerations = useProjectStore((state) => state.setProjectGenerations);
  const setProjectLayers = useProjectStore((state) => state.setProjectLayers);
  const setProjectReferences = useProjectStore((state) => state.setProjectReferences);
  const references = useReferenceStore((state) => state.references);
  const setReferences = useReferenceStore((state) => state.setReferences);
  const pushToast = useToastStore((state) => state.pushToast);
  const project = projects.find((item) => item.id === projectId) ?? projects[0];

  useEffect(() => {
    if (!project) return;
    if (loadedProjectIdRef.current === project.id) return;
    loadedProjectIdRef.current = project.id;
    setCurrentProject(project.id);
    setObjects(project.objects.filter((object) => object.format !== 'primitive'));
    setLayers(project.layers);
    setGenerations(project.generations);
  }, [project, setCurrentProject, setGenerations, setLayers, setObjects]);

  useEffect(() => {
    setProjectLayers(layers);
  }, [layers, setProjectLayers]);

  useEffect(() => {
    setProjectGenerations(generations);
  }, [generations, setProjectGenerations]);

  useEffect(() => {
    setProjectReferences(references);
  }, [references, setProjectReferences]);

  function getProjectSnapshot(): Project | undefined {
    if (!project) return undefined;
    return {
      ...project,
      objects: useSceneStore.getState().objects,
      layers: useLayerStore.getState().layers,
      generations: useGenerationStore.getState().generations,
      captures: useProjectStore.getState().getCurrentProject()?.captures ?? project.captures,
      bakedTextures: useProjectStore.getState().getCurrentProject()?.bakedTextures ?? project.bakedTextures,
      references: useReferenceStore.getState().references,
      updatedAt: new Date().toISOString(),
    };
  }

  async function handleImportModel(file: File) {
    try {
      const loaded = await loadModelFromFile(file, {
        normalize: importSettings.normalizeOnImport,
        ground: importSettings.groundOnImport,
        targetMaxDimension: 3,
      });
      setImportedModel(loaded.result, loaded.object);
      updateCurrentProject({ objects: [loaded.object] });
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

  async function applyWorkspaceSaveResult(result: Awaited<ReturnType<typeof saveProjectToWorkspace>>) {
    if (result.mode === 'download-fallback') {
      const snapshot = getProjectSnapshot();
      if (snapshot) downloadProjectJson(snapshot);
      setWorkspaceState({ workspaceMode: 'download-fallback', dirty: false, lastSavedAt: result.lastSavedAt });
      pushToast({
        tone: 'warning',
        title: 'Browser fallback: Download JSON only.',
        description: 'Use Chrome or Edge File System Access API for folder-based project save.',
      });
      return;
    }

    markSaved(result.lastSavedAt, result.project.assetManifest);
    setWorkspaceState({
      workspaceName: result.workspaceName,
      workspaceMode: 'file-system-access',
      lastSavedAt: result.lastSavedAt,
      dirty: false,
      assetManifest: result.project.assetManifest,
    });
    pushToast({
      tone: 'success',
      title: 'Project saved locally.',
      description: `Saved to ${result.workspaceName ?? 'selected workspace'}.`,
    });
  }

  async function handleSaveProject() {
    const snapshot = getProjectSnapshot();
    if (!snapshot) return;
    try {
      const recentWorkspace = await getRecentWorkspaceHandle();
      const result = recentWorkspace
        ? await saveProjectToWorkspace(snapshot, recentWorkspace)
        : await saveProjectAsWorkspace(snapshot);
      await applyWorkspaceSaveResult(result);
    } catch (error) {
      console.error('[Liclick 3D Texture] Save project failed:', error);
      pushToast({
        tone: 'error',
        title: 'Save failed',
        description: error instanceof Error ? error.message : 'Could not save this project.',
      });
    }
  }

  async function handleSaveAsProject() {
    const snapshot = getProjectSnapshot();
    if (!snapshot) return;
    try {
      await applyWorkspaceSaveResult(await saveProjectAsWorkspace(snapshot));
    } catch (error) {
      console.error('[Liclick 3D Texture] Save As failed:', error);
      pushToast({
        tone: 'error',
        title: 'Save As failed',
        description: error instanceof Error ? error.message : 'Could not choose a project workspace.',
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
      setGenerations(importedProject.generations);
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

  async function handleLoadProjectCommand() {
    try {
      const result = await loadProjectWithPicker();
      loadedProjectIdRef.current = result.project.id;
      replaceCurrentProject(result.project);
      setObjects(result.project.objects);
      setLayers(result.project.layers);
      setGenerations(result.project.generations);
      setReferences(result.project.references);
      pushToast({
        tone: result.warnings.length > 0 ? 'warning' : 'success',
        title: 'Project loaded',
        description: result.warnings[0] ?? 'Loaded project.liclick.json metadata.',
      });
    } catch (error) {
      console.warn('[Liclick 3D Texture] File picker load unavailable, falling back to file input:', error);
      projectInputRef.current?.click();
    }
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
        workspaceLabel={
          project
            ? `${project.workspaceName ?? 'No local workspace'}${project.dirty ? ' / Unsaved changes' : ' / Saved'}`
            : undefined
        }
        onBack={onBack}
        onImportModel={() => modelInputRef.current?.click()}
        onSaveProject={handleSaveProject}
        onSaveAsProject={handleSaveAsProject}
        onLoadProject={() => void handleLoadProjectCommand()}
        left={
          <>
            <ObjectsPanel />
            <GeneratePanel />
            <ReferenceImagesPanel />
          </>
        }
        center={
          <ViewportCanvas
            hasImportedModel={Boolean(importedModel)}
            onImportModel={(file) => void handleImportModel(file)}
            onOpenImport={() => modelInputRef.current?.click()}
          />
        }
        right={
          <>
            <ViewportPanel />
            <ObjectTransformPanel />
            <LayersPanel />
            <LayerAdjustmentsPanel />
          </>
        }
      />
    </>
  );
}
