import { mockProjects } from '@/mock/mockProjects';
import type { Project } from '@/types/project';

export async function listProjects(): Promise<Project[]> {
  return mockProjects;
}

export async function getProject(projectId: string): Promise<Project | undefined> {
  return mockProjects.find((project) => project.id === projectId);
}
