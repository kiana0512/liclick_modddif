import { z } from 'zod';
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

function validateProjectJson(data: unknown): Project {
  const result = projectJsonSchema.parse(data);
  return { ...result, bakedTextures: result.bakedTextures ?? [] } as Project;
}

export async function importProjectJson(file: File): Promise<Project> {
  const text = await file.text();
  const parsed = JSON.parse(text) as unknown;
  return validateProjectJson(parsed);
}
