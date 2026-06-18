import type { SceneObject } from '@/types/model';

export type LoadedModel = {
  object: SceneObject;
  root: unknown;
  sourceUrl: string;
};

export type ModelImportOptions = {
  sourceUrl: string;
  fileName: string;
};
