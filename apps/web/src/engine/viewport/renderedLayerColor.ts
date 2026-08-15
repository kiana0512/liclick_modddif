import type { Layer } from '@/types/layer';

type RenderedColorLayer = Pick<
  Layer,
  'id' | 'imageUrl' | 'generationId' | 'renderedColor' | 'role'
>;

/**
 * Returns whether a layer already contains the final viewport/display colour.
 *
 * PBR preview lighting is intentionally restricted to the final merged UV
 * layer. Generated projections, local repaint and every other editing layer
 * keep their authored display colour and bypass the PBR sweep.
 */
export function usesUnlitRenderedColor(layer: RenderedColorLayer) {
  return layer.role !== 'merged-uv';
}
