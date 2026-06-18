import type { LoadedModel, SupportedImportFormat } from './modelImportTypes';
import { loadFbxModel } from './loadFbxModel';
import { loadGltfModel } from './loadGltfModel';
import { loadObjModel } from './loadObjModel';
import type { NormalizeImportedModelOptions } from '@/engine/scene/normalizeImportedModel';

export const supportedModelExtensions = ['glb', 'gltf', 'fbx', 'obj'] as const;

export function getModelFormatFromFileName(fileName: string): SupportedImportFormat | undefined {
  const extension = fileName.split('.').pop()?.toLowerCase();
  if (!extension) return undefined;
  if (supportedModelExtensions.includes(extension as SupportedImportFormat)) {
    return extension as SupportedImportFormat;
  }
  return undefined;
}

export async function loadModelFromFile(
  file: File,
  normalizeOptions?: NormalizeImportedModelOptions,
): Promise<LoadedModel> {
  const format = getModelFormatFromFileName(file.name);
  if (!format) {
    throw new Error('Unsupported model format. Please import GLB, GLTF, FBX, or OBJ.');
  }

  const sourceUrl = URL.createObjectURL(file);
  const options = { sourceUrl, fileName: file.name, normalizeOptions };

  if (format === 'glb' || format === 'gltf') return loadGltfModel(options);
  if (format === 'fbx') return loadFbxModel(options);
  return loadObjModel(options);
}
