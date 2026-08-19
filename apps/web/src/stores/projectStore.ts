import { create } from 'zustand';
import type { Capture } from '@/types/capture';
import type { BakedTexture } from '@/engine/bake/uvBakeTypes';
import type { Generation } from '@/types/generation';
import type { Layer } from '@/types/layer';
import type { ModelBoundingBox, SceneObject, Transform } from '@/types/model';
import type { AssetManifest, Project, ReferenceImage, WorkspaceMode } from '@/types/project';
import {
  collapseGenerationRecords,
  upsertGenerationByIdentity,
} from '@/utils/generationIdentity';

export const IMMEDIATE_PROJECT_SAVE_EVENT = 'liclick:immediate-project-save';
const LOCAL_OBJECT_DELETION_KEY = 'liclick:pending-object-deletions:v1';

type ProjectStore = {
  projects: Project[];
  currentProjectId: string;
  setProjects: (projects: Project[]) => void;
  setCurrentProject: (projectId: string) => void;
  getCurrentProject: () => Project | undefined;
  replaceCurrentProject: (project: Project) => void;
  updateProjectById: (projectId: string, patch: Partial<Project>) => void;
  updateCurrentProject: (patch: Partial<Project>) => void;
  setProjectObjects: (objects: SceneObject[]) => void;
  setProjectLayers: (layers: Layer[]) => void;
  setProjectGenerations: (generations: Generation[]) => void;
  setProjectGenerationsById: (projectId: string, generations: Generation[]) => void;
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
  markSavedById: (
    projectId: string,
    lastSavedAt: string,
    assetManifest?: AssetManifest,
  ) => void;
  updateObjectTransform: (objectId: string, transform: Transform, boundingBox?: ModelBoundingBox) => void;
  addCapture: (capture: Capture) => void;
  addGeneration: (generation: Generation) => void;
  addGenerationByProjectId: (projectId: string, generation: Generation) => void;
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

function readLocalObjectDeletions() {
  if (typeof window === 'undefined') return {} as Record<string, string[]>;
  try {
    const parsed = JSON.parse(window.localStorage.getItem(LOCAL_OBJECT_DELETION_KEY) ?? '{}');
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
      return {} as Record<string, string[]>;
    return Object.fromEntries(
      Object.entries(parsed).flatMap(([projectId, value]) => {
        if (!Array.isArray(value)) return [];
        const ids = value.filter((item): item is string => typeof item === 'string');
        return ids.length > 0 ? [[projectId, Array.from(new Set(ids))]] : [];
      }),
    );
  } catch {
    return {} as Record<string, string[]>;
  }
}

function writeLocalObjectDeletions(deletions: Record<string, string[]>) {
  if (typeof window === 'undefined') return;
  try {
    if (Object.keys(deletions).length === 0)
      window.localStorage.removeItem(LOCAL_OBJECT_DELETION_KEY);
    else window.localStorage.setItem(LOCAL_OBJECT_DELETION_KEY, JSON.stringify(deletions));
  } catch {
    // The in-memory deletion still applies when browser storage is unavailable.
  }
}

function recordLocalObjectDeletion(projectId: string, objectId: string) {
  const deletions = readLocalObjectDeletions();
  deletions[projectId] = Array.from(new Set([...(deletions[projectId] ?? []), objectId]));
  writeLocalObjectDeletions(deletions);
}

function clearLocalObjectDeletions(projectId: string, objectIds: string[]) {
  if (objectIds.length === 0) return;
  const deletions = readLocalObjectDeletions();
  const clearedIds = new Set(objectIds);
  const remaining = (deletions[projectId] ?? []).filter((objectId) => !clearedIds.has(objectId));
  if (remaining.length > 0) deletions[projectId] = remaining;
  else delete deletions[projectId];
  writeLocalObjectDeletions(deletions);
}

function applyLocalObjectDeletions(project: Project) {
  return (readLocalObjectDeletions()[project.id] ?? []).reduce(
    (current, objectId) => withoutObjectData(current, objectId),
    project,
  );
}

function updateProject(projects: Project[], projectId: string, patch: Partial<Project>) {
  return projects.map((project) =>
    project.id === projectId
      ? { ...project, ...preserveReferencedObjects(project, patch), dirty: patch.dirty ?? true, updatedAt: new Date().toISOString() }
      : project,
  );
}

export const useProjectStore = create<ProjectStore>((set, get) => ({
  projects: [],
  currentProjectId: '',
  setProjects: (projects) =>
    set((state) => ({
      projects: projects.map(applyLocalObjectDeletions),
      currentProjectId: projects.some((project) => project.id === state.currentProjectId)
        ? state.currentProjectId
        : (projects[0]?.id ?? ''),
    })),
  setCurrentProject: (projectId) => set({ currentProjectId: projectId }),
  getCurrentProject: () =>
    get().projects.find((project) => project.id === get().currentProjectId) ?? get().projects[0],
  replaceCurrentProject: (project) =>
    set((state) => {
      const projectWithLocalDeletions = applyLocalObjectDeletions(project);
      const exists = state.projects.some((item) => item.id === project.id);
      return {
        currentProjectId: project.id,
        projects: exists
          ? state.projects.map((item) =>
              item.id === project.id ? projectWithLocalDeletions : item,
            )
          : [projectWithLocalDeletions, ...state.projects],
      };
    }),
  updateProjectById: (projectId, patch) =>
    set((state) => ({
      projects: updateProject(state.projects, projectId, patch),
    })),
  updateCurrentProject: (patch) =>
    set((state) => ({
      projects: updateProject(state.projects, state.currentProjectId, patch),
    })),
  setProjectObjects: (objects) => get().updateCurrentProject({ objects }),
  setProjectLayers: (layers) => get().updateCurrentProject({ layers }),
  setProjectGenerations: (generations) =>
    get().updateCurrentProject({ generations: collapseGenerationRecords(generations) }),
  setProjectGenerationsById: (projectId, generations) =>
    get().updateProjectById(projectId, {
      generations: collapseGenerationRecords(generations),
    }),
  setProjectCaptures: (captures) => get().updateCurrentProject({ captures }),
  setProjectReferences: (references) => get().updateCurrentProject({ references }),
  deleteProjectObject: (objectId) =>
    set((state) => {
      recordLocalObjectDeletion(state.currentProjectId, objectId);
      return {
        projects: state.projects.map((project) =>
          project.id === state.currentProjectId ? withoutObjectData(project, objectId) : project,
        ),
      };
    }),
  setWorkspaceState: (workspaceState) => get().updateCurrentProject(workspaceState),
  markDirty: () => get().updateCurrentProject({ dirty: true }),
  markSaved: (lastSavedAt, assetManifest) =>
    get().markSavedById(get().currentProjectId, lastSavedAt, assetManifest),
  markSavedById: (projectId, lastSavedAt, assetManifest) => {
    const project = get().projects.find((item) => item.id === projectId);
    if (project) clearLocalObjectDeletions(project.id, project.deletedObjectIds ?? []);
    get().updateProjectById(projectId, {
      lastSavedAt,
      dirty: false,
      deletedObjectIds: [],
      assetManifest,
    });
  },
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
    get().addGenerationByProjectId(get().currentProjectId, generation),
  addGenerationByProjectId: (projectId, generation) =>
    set((state) => {
      const project = state.projects.find((item) => item.id === projectId);
      return {
        projects: updateProject(state.projects, projectId, {
          generations: upsertGenerationByIdentity(project?.generations ?? [], generation),
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
