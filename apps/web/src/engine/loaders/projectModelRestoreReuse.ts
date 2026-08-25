import type { ModelLoadResult } from './modelImportTypes';
import type { SceneObject } from '@/types/model';

function isRestorableProjectObject(object: SceneObject) {
  return Boolean(object.sourcePath && /^(https?:|blob:|data:)/.test(object.sourcePath));
}

/**
 * Returns the already-loaded models in persisted object order when the texture
 * route is reopening the same project. R3F does not dispose externally-owned
 * primitives, so these groups retain their decoded geometry, textures and
 * shader inputs while the UV route is active.
 */
export function getReusableFullProjectModels(
  objects: SceneObject[],
  loadedModels: ModelLoadResult[],
) {
  const restorableObjects = objects.filter(isRestorableProjectObject);
  if (restorableObjects.length === 0 || loadedModels.length !== restorableObjects.length) {
    return undefined;
  }

  const modelByObjectId = new Map(loadedModels.map((model) => [model.objectId, model] as const));
  const reusableModels: ModelLoadResult[] = [];
  for (const object of restorableObjects) {
    const model = modelByObjectId.get(object.id);
    if (
      !model ||
      model.objectUrl !== object.sourcePath ||
      (model.restoreStage && model.restoreStage !== 'full') ||
      model.group.userData.liclickRestorePlaceholder === true
    ) {
      return undefined;
    }
    reusableModels.push(model);
  }
  return reusableModels;
}
