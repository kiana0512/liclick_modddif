import type { ModelLoadResult } from '@/engine/loaders/modelImportTypes';

type PublishedModelSelectionInput = {
  publishedObjectIds: string[];
  selectedObjectId?: string;
  requestedActiveObjectId?: string;
  sceneObjectIds?: string[];
};

/**
 * Publishing progressive model geometry must not behave like a user selection.
 * Keep the live selection whenever that model still exists, and only use the
 * persisted active id while initializing a scene with no usable selection.
 */
export function resolvePublishedModelSelection({
  publishedObjectIds,
  selectedObjectId,
  requestedActiveObjectId,
  sceneObjectIds = [],
}: PublishedModelSelectionInput) {
  const publishedIds = new Set(publishedObjectIds);
  if (selectedObjectId && publishedIds.has(selectedObjectId)) return selectedObjectId;
  if (requestedActiveObjectId && publishedIds.has(requestedActiveObjectId)) {
    return requestedActiveObjectId;
  }
  return publishedObjectIds[0] ?? sceneObjectIds[0];
}

/**
 * Bounds are loading placeholders rather than authored scene content. Prefer
 * every parsed outline/full model for a project thumbnail, but still fall back
 * to placeholders when no geometry has arrived so a new project can get a
 * current preview instead of silently retaining an unrelated historical one.
 */
export function getProjectThumbnailCaptureModels<T extends Pick<ModelLoadResult, 'restoreStage'>>(
  models: T[],
) {
  const parsedModels = models.filter((model) => model.restoreStage !== 'bounds');
  return parsedModels.length > 0 ? parsedModels : models;
}
