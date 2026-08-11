import type { Layer } from '@/types/layer';

type RenderedColorLayer = Pick<
  Layer,
  'id' | 'imageUrl' | 'generationId' | 'renderedColor' | 'role'
>;

/**
 * Returns whether a layer already contains the final viewport/display colour.
 *
 * Local repaint generation edits a rendered capture, not a neutral albedo map.
 * Treat legacy repaint layers as rendered colour even when an older project
 * persisted `renderedColor: false`, otherwise the viewport applies lighting a
 * second time and makes the painted region visibly darker than its source.
 */
export function usesUnlitRenderedColor(layer: RenderedColorLayer) {
  return Boolean(
    layer.renderedColor ||
      layer.id.startsWith('local-repaint-') ||
      layer.role === 'local-repaint-overlay' ||
      layer.role === 'local-repaint-draft' ||
      (layer.imageUrl ?? '').includes('surface-edit:local-repaint') ||
      layer.id.startsWith('content-aware-projected-repair') ||
      layer.generationId === 'texture-map-content-aware-repair',
  );
}
