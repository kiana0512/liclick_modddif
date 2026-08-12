import type { Layer } from '@/types/layer';

type RenderedColorLayer = Pick<
  Layer,
  'id' | 'imageUrl' | 'generationId' | 'renderedColor' | 'role'
>;

/**
 * Returns whether a layer already contains the final viewport/display colour.
 *
 * Local repaint is used as an albedo replacement in the editor and must follow
 * the same Flat/PBR lighting as the surface underneath it. Only genuinely
 * flattened display-colour layers bypass viewport lighting.
 */
export function usesUnlitRenderedColor(layer: RenderedColorLayer) {
  const isLocalRepaint = Boolean(
    layer.id.startsWith('local-repaint-') ||
      layer.role === 'local-repaint-overlay' ||
      layer.role === 'local-repaint-draft' ||
      (layer.imageUrl ?? '').includes('surface-edit:local-repaint'),
  );
  if (isLocalRepaint) return false;
  return Boolean(
    layer.renderedColor ||
      layer.id.startsWith('content-aware-projected-repair') ||
      layer.generationId === 'texture-map-content-aware-repair',
  );
}
