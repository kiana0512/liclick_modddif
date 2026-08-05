import type * as THREE from 'three';
import type {
  ImportNormalizationTransform,
  MaterialSlot,
  ModelBoundingBox,
  ModelFormat,
  SceneObject,
} from '@/types/model';
import type { NormalizeImportedModelOptions } from '@/engine/scene/normalizeImportedModel';
import type { ModelImportProgressCallback } from './modelImportProgress';

export type ModelLoadResult = {
  objectId: string;
  name: string;
  format: Exclude<ModelFormat, 'primitive'>;
  group: THREE.Group;
  sourceFileName: string;
  objectUrl?: string;
  materialSlots: string[];
  uvSets: string[];
  boundingBox: ModelBoundingBox;
  originalBoundingBox: ModelBoundingBox;
  importNormalizationTransform: ImportNormalizationTransform;
  childMeshCount: number;
  warnings: string[];
  restoreStage?: 'bounds' | 'outline' | 'full';
};

export type LoadedModel = {
  object: SceneObject;
  root: THREE.Group;
  result: ModelLoadResult;
  sourceUrl: string;
};

export type ModelImportOptions = {
  sourceUrl: string;
  fileName: string;
  normalizeOptions?: NormalizeImportedModelOptions;
  sourceBuffer?: ArrayBuffer;
  sourceByteLength?: number;
  resourceFiles?: File[];
  onProgress?: ModelImportProgressCallback;
};

export type SupportedImportFormat = ModelLoadResult['format'];

export function materialSlotsToSceneSlots(names: string[]): MaterialSlot[] {
  return names.map((name, index) => ({
    id: `mat-${index + 1}`,
    name,
  }));
}
