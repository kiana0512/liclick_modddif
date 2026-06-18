import { create } from 'zustand';
import { mockProjects } from '@/mock/mockProjects';
import type { Project } from '@/types/project';

type ProjectStore = {
  projects: Project[];
  currentProjectId: string;
  setCurrentProject: (projectId: string) => void;
  getCurrentProject: () => Project | undefined;
};

export const useProjectStore = create<ProjectStore>((set, get) => ({
  projects: mockProjects,
  currentProjectId: mockProjects[0]?.id ?? '',
  setCurrentProject: (projectId) => set({ currentProjectId: projectId }),
  getCurrentProject: () =>
    get().projects.find((project) => project.id === get().currentProjectId) ?? get().projects[0],
}));
