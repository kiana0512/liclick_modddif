import type { Object3D } from 'three';
import type { ModelLoadResult } from '@/engine/loaders/modelImportTypes';
import type { ViewportRuntime } from '@/stores/sceneStore';
import type { Project } from '@/types/project';

export type ExportTarget = 'scene' | 'object';
export type ExportFormat = 'glb' | 'fbx' | 'obj' | 'stl';

export type ModelExportInput = {
  project: Project;
  importedModel: ModelLoadResult;
  target: ExportTarget;
  selectedObjectId?: string;
};

export type TextureExportInput = {
  project: Project;
  imageUrl: string;
  suffix: string;
};

export type ViewportExportInput = {
  project: Project;
  viewport: ViewportRuntime;
};

export type TurntableExportInput = ViewportExportInput & {
  root: Object3D;
  durationMs?: number;
};
