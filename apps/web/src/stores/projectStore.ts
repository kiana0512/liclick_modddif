import { create } from 'zustand';
import { mockProjects } from '@/mock/mockProjects';
import type { Capture } from '@/types/capture';
import type { BakedTexture } from '@/engine/bake/uvBakeTypes';
import type { Generation } from '@/types/generation';
import type { Layer } from '@/types/layer';
import type { ModelBoundingBox, SceneObject, Transform } from '@/types/model';
import type { AssetManifest, Project, ReferenceImage, WorkspaceMode } from '@/types/project';

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

function updateProject(projects: Project[], projectId: string, patch: Partial<Project>) {
  return projects.map((project) =>
    project.id === projectId
      ? { ...project, ...patch, dirty: patch.dirty ?? true, updatedAt: new Date().toISOString() }
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
  setWorkspaceState: (workspaceState) => get().updateCurrentProject(workspaceState),
  markDirty: () => get().updateCurrentProject({ dirty: true }),
  markSaved: (lastSavedAt, assetManifest) =>
    get().updateCurrentProject({ lastSavedAt, dirty: false, assetManifest }),
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
