import type { Layer } from '@/types/layer';

type RenderedColorLayer = Pick<
  Layer,
  | 'id'
  | 'imageUrl'
  | 'generationId'
  | 'renderedColor'
  | 'role'
  | 'replacementTargetLayerId'
  | 'localRepaintSourceUrl'
  | 'localRepaintMaskUrl'
>;

/**
 * Returns whether a layer already contains the final viewport/display colour.
 *
 * PBR preview lighting is intentionally restricted to BaseColor-bearing
 * results: the final merged UV and local-repaint replacements. Other editing
 * layers keep their authored display colour and bypass the PBR sweep.
 */
export function usesUnlitRenderedColor(layer: RenderedColorLayer) {
  const isLocalRepaintBaseColor = Boolean(
    layer.role === 'local-repaint-overlay' ||
    layer.role === 'local-repaint-draft' ||
    layer.id.startsWith('local-repaint-') ||
    (layer.imageUrl ?? '').includes('surface-edit:local-repaint') ||
    layer.replacementTargetLayerId ||
    layer.localRepaintSourceUrl ||
    layer.localRepaintMaskUrl,
  );
  if (isLocalRepaintBaseColor) return false;
  return layer.role !== 'merged-uv';
}
