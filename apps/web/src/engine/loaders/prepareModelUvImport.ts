import { Mesh, Texture } from 'three';
import type { LoadedModel } from './modelImportTypes';
import type { NormalizeImportedModelOptions } from '@/engine/scene/normalizeImportedModel';
import { disposeRejectedModel } from './modelTriangleLimit';
import type { ModelUvReport } from './modelUvValidation';

export function disposeImportCandidate(model: LoadedModel) {
  disposeRejectedModel(model.root);
  if (model.sourceUrl.startsWith('blob:')) URL.revokeObjectURL(model.sourceUrl);
}

export async function waitForImportTextures(model: LoadedModel, signal: AbortSignal) {
  const textures = new Set<Texture>();
  model.root.traverse(child => {
    if (!(child instanceof Mesh)) return;
    for (const material of [child.material].flat()) {
      for (const value of Object.values(material)) if (value instanceof Texture) textures.add(value);
    }
  });
  await Promise.all([...textures].map(async texture => {
    const deadline = performance.now() + 5000;
    while (!texture.image && performance.now() < deadline) {
      signal.throwIfAborted();
      await new Promise(resolve => setTimeout(resolve, 40));
    }
    signal.throwIfAborted();
    if (!texture.image) throw new Error('模型贴图未能加载，请同时提供配套贴图后重新导入');
    if (texture.image instanceof HTMLImageElement) await texture.image.decode();
  }));
}

export type ModelImportProcessingInput = {
  file: File; parsed: LoadedModel; resources: File[]; normalize: NormalizeImportedModelOptions;
  confirm: (name: string, report: ModelUvReport, signal: AbortSignal, operation?: 'uv' | 'decimate') => Promise<boolean>;
  isCurrent: () => boolean; progress: (message: string) => void;
};

export async function prepareModelUvImport(input: ModelImportProcessingInput) {
  // Keep the Blender preparation workflow outside the editor's initial bundle.
  const { processModelImport } = await import('./processModelImport').catch(error => {
    disposeImportCandidate(input.parsed);
    throw error;
  });
  return processModelImport(input);
}
