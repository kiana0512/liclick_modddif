import type { Layer } from '@/types/layer';

function isPersistedLocalRepaintProjection(layer: Layer, objectId: string) {
  return Boolean(
    layer.type === 'projected' &&
      (!layer.objectId || layer.objectId === objectId) &&
      (layer.id.startsWith('local-repaint-') ||
        layer.role === 'local-repaint-overlay' ||
        layer.role === 'local-repaint-draft' ||
        layer.replacementTargetLayerId ||
        layer.localRepaintSourceUrl ||
        layer.localRepaintMaskUrl ||
        (layer.imageUrl ?? '').includes('surface-edit:local-repaint')),
  );
}

/**
 * Projected preview batches deliberately freeze ordinary projection rows while
 * several generated views arrive. A persisted repaint is an authored foreground
 * result, so it must always come from the authoritative project layer list.
 */
export function mergeAuthoritativeLocalRepaintLayers(
  authoritativeLayers: readonly Layer[],
  projectedPreviewLayers: readonly Layer[] | undefined,
  objectId: string,
) {
  if (!projectedPreviewLayers) return [...authoritativeLayers];

  const authoritativeRepaints = authoritativeLayers.filter((layer) =>
    isPersistedLocalRepaintProjection(layer, objectId),
  );
  if (authoritativeRepaints.length === 0) return [...projectedPreviewLayers];

  const repaintById = new Map(authoritativeRepaints.map((layer) => [layer.id, layer]));
  const mergedIds = new Set<string>();
  const merged = projectedPreviewLayers.map((layer) => {
    const authoritative = repaintById.get(layer.id);
    if (!authoritative) return layer;
    mergedIds.add(layer.id);
    return authoritative;
  });
  for (const layer of authoritativeRepaints) {
    if (!mergedIds.has(layer.id)) merged.push(layer);
  }
  return merged.sort((left, right) => left.order - right.order);
}
