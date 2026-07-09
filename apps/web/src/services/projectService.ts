import { z } from 'zod';
import { mockProjects } from '@/mock/mockProjects';
import type { Project } from '@/types/project';

const projectJsonSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    createdAt: z.string(),
    updatedAt: z.string(),
    thumbnail: z.string(),
    objects: z.array(z.unknown()),
    references: z.array(z.unknown()),
    captures: z.array(z.unknown()),
    generations: z.array(z.unknown()),
    layers: z.array(z.unknown()),
    bakedTextures: z.array(z.unknown()).optional(),
    settings: z.record(z.unknown()),
  })
  .passthrough();

export async function listProjects(): Promise<Project[]> {
  return mockProjects;
}

export async function getProject(projectId: string): Promise<Project | undefined> {
  return mockProjects.find((project) => project.id === projectId);
}

export function validateProjectJson(data: unknown): Project {
  const result = projectJsonSchema.parse(data);
  return { ...result, bakedTextures: result.bakedTextures ?? [] } as Project;
}

export function exportProjectJson(project: Project): Blob {
  const payload = {
    schemaVersion: '0.4.0',
    savedAt: new Date().toISOString(),
    ...project,
  };

  return new Blob([JSON.stringify(payload, null, 2)], {
    type: 'application/json',
  });
}

export function downloadProjectJson(project: Project) {
  const blob = exportProjectJson(project);
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = `${project.name.replace(/[^a-z0-9-_]+/gi, '-').toLowerCase()}.liclick.json`;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

export async function importProjectJson(file: File): Promise<Project> {
  const text = await file.text();
  const parsed = JSON.parse(text) as unknown;
  return validateProjectJson(parsed);
}
