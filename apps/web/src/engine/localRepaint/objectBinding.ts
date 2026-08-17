import type { Capture } from '@/types/capture';
import type { Generation } from '@/types/generation';
import type { Layer } from '@/types/layer';

function metadataObjectId(generation: Generation) {
  const value = generation.metadata.objectId;
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

export function getGenerationObjectId(
  generation: Generation,
  captures: readonly Capture[],
) {
  return (
    metadataObjectId(generation) ??
    captures.find((capture) => capture.id === generation.captureId)?.objectId
  );
}

export function generationBelongsToObject(
  generation: Generation,
  objectId: string | undefined,
  captures: readonly Capture[],
) {
  if (!objectId) return false;
  return getGenerationObjectId(generation, captures) === objectId;
}

function isLocalRepaintArtifact(layer: Layer) {
  return (
    layer.role === 'local-repaint-draft' ||
    layer.role === 'local-repaint-overlay' ||
    (layer.type === 'projected' &&
      Boolean(
        layer.replacementTargetLayerId ||
          layer.localRepaintSourceUrl ||
          layer.localRepaintMaskUrl,
      ))
  );
}

/**
 * Older projects may contain local-repaint rows without an object id. Regular
 * texture rows are allowed to be project-wide, but a repaint is camera/model
 * specific. Recover its owner from the archived generation/capture; if that is
 * impossible, quarantine the row instead of rendering it on every later model.
 */
export function normalizeLocalRepaintObjectBindings(input: {
  layers: readonly Layer[];
  generations: readonly Generation[];
  captures: readonly Capture[];
}) {
  const generationObjectIds = new Map(
    input.generations.flatMap((generation) => {
      const objectId = getGenerationObjectId(generation, input.captures);
      return objectId ? [[generation.id, objectId] as const] : [];
    }),
  );
  const captureObjectIds = new Map(
    input.captures.map((capture) => [capture.id, capture.objectId] as const),
  );
  const targetObjectIds = new Map<string, string>();

  for (const layer of input.layers) {
    if (layer.type !== 'projected' || !layer.replacementTargetLayerId) continue;
    const objectId =
      layer.objectId ||
      (layer.generationId ? generationObjectIds.get(layer.generationId) : undefined) ||
      (layer.captureId ? captureObjectIds.get(layer.captureId) : undefined);
    if (objectId) targetObjectIds.set(layer.replacementTargetLayerId, objectId);
  }

  let changed = false;
  const layers = input.layers.map((layer) => {
    if (layer.objectId || !isLocalRepaintArtifact(layer)) return layer;
    const inferredObjectId =
      (layer.generationId ? generationObjectIds.get(layer.generationId) : undefined) ||
      (layer.captureId ? captureObjectIds.get(layer.captureId) : undefined) ||
      targetObjectIds.get(layer.id);
    if (inferredObjectId) {
      changed = true;
      return { ...layer, objectId: inferredObjectId };
    }
    if (layer.visible) {
      changed = true;
      return { ...layer, visible: false };
    }
    return layer;
  });

  return { layers, changed };
}
