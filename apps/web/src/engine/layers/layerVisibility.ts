import type { Layer } from '@/types/layer';

export function isLocalRepaintVisibilityLayer(layer: Layer) {
  return Boolean(
    layer.role === 'local-repaint-draft' ||
      layer.role === 'local-repaint-overlay' ||
      layer.id.startsWith('local-repaint-projection') ||
      layer.id.startsWith('local-repaint-brush-projection') ||
      layer.id.startsWith('local-repaint-uv-merge'),
  );
}

/**
 * A local repaint is one authored result represented by a projected row and
 * an implementation-only UV destination. User visibility actions must update
 * the complete representation atomically.
 */
export function expandAuthoredLayerVisibilityIds(layers: Layer[], layerIds: string[]) {
  const expanded = new Set(layerIds);
  for (const layerId of layerIds) {
    const layer = layers.find((item) => item.id === layerId);
    if (!layer || !isLocalRepaintVisibilityLayer(layer)) continue;
    if (layer.replacementTargetLayerId) expanded.add(layer.replacementTargetLayerId);
    for (const candidate of layers) {
      if (
        isLocalRepaintVisibilityLayer(candidate) &&
        candidate.replacementTargetLayerId === layer.id
      ) {
        expanded.add(candidate.id);
      }
    }
  }
  return [...expanded];
}
