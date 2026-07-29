import { create } from 'zustand';
import { mockProjects } from '@/mock/mockProjects';
import type { Capture } from '@/types/capture';
import type { BakedTexture } from '@/engine/bake/uvBakeTypes';
import type { Generation } from '@/types/generation';
import type { Layer } from '@/types/layer';
import type { ModelBoundingBox, SceneObject, Transform } from '@/types/model';
import type { AssetManifest, Project, ReferenceImage, WorkspaceMode } from '@/types/project';

export const IMMEDIATE_PROJECT_SAVE_EVENT = 'liclick:immediate-project-save';

type ProjectStore = {
  projects: Project[];
  currentProjectId: string;
  setProjects: (projects: Project[]) => void;
  setCurrentProject: (projectId: string) => void;
  getCurrentProject: () => Project | undefined;
  replaceCurrentProject: (project: Project) => void;
  updateCurrentProject: (patch: Partial<Project>) => void;
  setProjectObjects: (objects: SceneObject[]) => void;
  setProjectLayers: (layers: Layer[]) => void;
  setProjectGenerations: (generations: Generation[]) => void;
  setProjectCaptures: (captures: Capture[]) => void;
  setProjectReferences: (references: ReferenceImage[]) => void;
  deleteProjectObject: (objectId: string) => void;
  setWorkspaceState: (state: {
    workspaceName?: string;
    workspaceMode: WorkspaceMode;
    lastSavedAt?: string;
    dirty?: boolean;
    assetManifest?: AssetManifest;
  }) => void;
  markDirty: () => void;
  markSaved: (lastSavedAt: string, assetManifest?: AssetManifest) => void;
  updateObjectTransform: (objectId: string, transform: Transform, boundingBox?: ModelBoundingBox) => void;
  addCapture: (capture: Capture) => void;
  addGeneration: (generation: Generation) => void;
  addBakedTexture: (bakedTexture: BakedTexture) => void;
};

function getReferencedObjectIds(project: Project) {
  const referenced = new Set<string>();
  Object.entries(project.bakeWorkspace?.bakeSets ?? {}).forEach(([objectId, bakeSet]) => {
    referenced.add(objectId);
    referenced.add(bakeSet.objectId);
  });
  project.references?.forEach((reference) => {
    if (reference.objectId) referenced.add(reference.objectId);
  });
  project.layers?.forEach((layer) => {
    if (layer.objectId) referenced.add(layer.objectId);
  });
  project.captures?.forEach((capture) => {
    if (capture.objectId) referenced.add(capture.objectId);
  });
  project.generations?.forEach((generation) => {
    const objectId = generation.metadata.objectId;
    if (typeof objectId === 'string') referenced.add(objectId);
  });
  return referenced;
}

function preserveReferencedObjects(project: Project, patch: Partial<Project>) {
  if (!patch.objects || patch.objects.length >= project.objects.length) return patch;
  const nextObjectIds = new Set(patch.objects.map((object) => object.id));
  const referencedObjectIds = getReferencedObjectIds({ ...project, ...patch });
  const preservedObjects = project.objects.filter(
    (object) => !nextObjectIds.has(object.id) && referencedObjectIds.has(object.id),
  );
  if (preservedObjects.length === 0) return patch;
  return { ...patch, objects: [...patch.objects, ...preservedObjects] };
}

function withoutObjectData(project: Project, objectId: string): Project {
  const removedLayerIds = new Set(
    project.layers.filter((layer) => layer.objectId === objectId).map((layer) => layer.id),
  );
  const bakeWorkspace = project.bakeWorkspace
    ? {
        ...project.bakeWorkspace,
        selectedObjectId:
          project.bakeWorkspace.selectedObjectId === objectId
            ? undefined
            : project.bakeWorkspace.selectedObjectId,
        bakeSets: Object.fromEntries(
          Object.entries(project.bakeWorkspace.bakeSets).filter(
            ([key, bakeSet]) => key !== objectId && bakeSet.objectId !== objectId,
          ),
        ),
      }
    : undefined;
  const objects = project.objects.filter((object) => object.id !== objectId);
  const layers = project.layers.filter((layer) => layer.objectId !== objectId);
  return {
    ...project,
    objects,
    layers,
    references: project.references.filter((reference) => reference.objectId !== objectId),
    captures: project.captures.filter((capture) => capture.objectId !== objectId),
    generations: project.generations.filter(
      (generation) => generation.metadata.objectId !== objectId,
    ),
    bakedTextures: project.bakedTextures.filter(
      (texture) =>
        texture.objectId !== objectId &&
        !removedLayerIds.has(texture.sourceLayerId) &&
        !(texture.sourceLayerIds ?? []).some((layerId) => removedLayerIds.has(layerId)),
    ),
    bakeWorkspace,
    activeObjectId:
      project.activeObjectId === objectId ? objects[0]?.id : project.activeObjectId,
    activeLayerId:
      project.activeLayerId && removedLayerIds.has(project.activeLayerId)
        ? layers.find((layer) => layer.objectId === objects[0]?.id)?.id
        : project.activeLayerId,
    deletedObjectIds: Array.from(new Set([...(project.deletedObjectIds ?? []), objectId])),
    dirty: true,
    updatedAt: new Date().toISOString(),
  };
}

function updateProject(projects: Project[], projectId: string, patch: Partial<Project>) {
  return projects.map((project) =>
    project.id === projectId
      ? { ...project, ...preserveReferencedObjects(project, patch), dirty: patch.dirty ?? true, updatedAt: new Date().toISOString() }
      : project,
  );
}

function upsertGeneration(generations: Generation[], generation: Generation) {
  const exists = generations.some((item) => item.id === generation.id);
  return exists ? generations.map((item) => (item.id === generation.id ? generation : item)) : [generation, ...generations];
}

export const useProjectStore = create<ProjectStore>((set, get) => ({
  projects: mockProjects,
  currentProjectId: mockProjects[0]?.id ?? '',
  setProjects: (projects) =>
    set((state) => ({
      projects,
      currentProjectId: projects.some((project) => project.id === state.currentProjectId)
        ? state.currentProjectId
        : (projects[0]?.id ?? ''),
    })),
  setCurrentProject: (projectId) => set({ currentProjectId: projectId }),
  getCurrentProject: () =>
    get().projects.find((project) => project.id === get().currentProjectId) ?? get().projects[0],
  replaceCurrentProject: (project) =>
    set((state) => {
      const exists = state.projects.some((item) => item.id === project.id);
      return {
        currentProjectId: project.id,
        projects: exists
          ? state.projects.map((item) => (item.id === project.id ? project : item))
          : [project, ...state.projects],
      };
    }),
  updateCurrentProject: (patch) =>
    set((state) => ({
      projects: updateProject(state.projects, state.currentProjectId, patch),
    })),
  setProjectObjects: (objects) => get().updateCurrentProject({ objects }),
  setProjectLayers: (layers) => get().updateCurrentProject({ layers }),
  setProjectGenerations: (generations) => get().updateCurrentProject({ generations }),
  setProjectCaptures: (captures) => get().updateCurrentProject({ captures }),
  setProjectReferences: (references) => get().updateCurrentProject({ references }),
  deleteProjectObject: (objectId) =>
    set((state) => ({
      projects: state.projects.map((project) =>
        project.id === state.currentProjectId ? withoutObjectData(project, objectId) : project,
      ),
    })),
  setWorkspaceState: (workspaceState) => get().updateCurrentProject(workspaceState),
  markDirty: () => get().updateCurrentProject({ dirty: true }),
  markSaved: (lastSavedAt, assetManifest) =>
    get().updateCurrentProject({
      lastSavedAt,
      dirty: false,
      deletedObjectIds: [],
      assetManifest,
    }),
  updateObjectTransform: (objectId, transform, boundingBox) =>
    set((state) => {
      const project = state.projects.find((item) => item.id === state.currentProjectId);
      return {
        projects: updateProject(state.projects, state.currentProjectId, {
          objects: (project?.objects ?? []).map((object) =>
            object.id === objectId
              ? {
                  ...object,
                  transform,
                  userTransform: transform,
                  boundingBox: boundingBox ?? object.boundingBox,
                }
              : object,
          ),
        }),
      };
    }),
  addCapture: (capture) =>
    set((state) => {
      const project = state.projects.find((item) => item.id === state.currentProjectId);
      return {
        projects: updateProject(state.projects, state.currentProjectId, {
          captures: [capture, ...(project?.captures ?? [])],
        }),
      };
    }),
  addGeneration: (generation) =>
    set((state) => {
      const project = state.projects.find((item) => item.id === state.currentProjectId);
      return {
        projects: updateProject(state.projects, state.currentProjectId, {
          generations: upsertGeneration(project?.generations ?? [], generation),
        }),
      };
    }),
  addBakedTexture: (bakedTexture) =>
    set((state) => {
      const project = state.projects.find((item) => item.id === state.currentProjectId);
      return {
        projects: updateProject(state.projects, state.currentProjectId, {
          bakedTextures: [bakedTexture, ...(project?.bakedTextures ?? [])],
        }),
      };
    }),
}));
