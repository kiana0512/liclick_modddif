import { z } from 'zod';

export const transformSchema = z.object({
  position: z.tuple([z.number(), z.number(), z.number()]),
  rotation: z.tuple([z.number(), z.number(), z.number()]),
  scale: z.tuple([z.number(), z.number(), z.number()]),
});

export const sceneObjectSchema = z.object({
  id: z.string(),
  name: z.string(),
  type: z.enum(['mesh', 'group', 'camera', 'light']),
  sourcePath: z.string().optional(),
  format: z.enum(['glb', 'gltf', 'fbx', 'obj', 'primitive']),
  materialSlots: z.array(z.object({ id: z.string(), name: z.string(), baseColor: z.string().optional() })),
  uvSets: z.array(z.string()),
  transform: transformSchema,
  visible: z.boolean(),
  selected: z.boolean(),
});

export const projectSchema = z.object({
  id: z.string(),
  name: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
  thumbnail: z.string(),
  objects: z.array(sceneObjectSchema),
  references: z.array(z.unknown()),
  captures: z.array(z.unknown()),
  generations: z.array(z.unknown()),
  layers: z.array(z.unknown()),
  settings: z.record(z.unknown()),
});

export type LiclickProjectDocument = z.infer<typeof projectSchema>;
