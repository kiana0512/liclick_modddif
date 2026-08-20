import type { Layer } from '@/types/layer';

export type ProjectedOverlayMode = 'feathered' | 'literal';

/**
 * Local repaint projections are replacement patches in the live viewport.
 * Older saved projects persist them with blendMode="normal", so their
 * compositing role must be inferred from the stable layer identity as well.
 */
export function isLocalRepaintProjectedLayer(
  layer: Pick<Layer, 'type' | 'id' | 'imageUrl'>,
) {
  return (
    layer.type === 'projected' &&
    (layer.id.startsWith('local-repaint-') ||
      (layer.imageUrl ?? '').includes('surface-edit:local-repaint'))
  );
}

export function getProjectedLayerOverlayMode(
  layer: Pick<Layer, 'type' | 'id' | 'imageUrl' | 'blendMode'>,
): ProjectedOverlayMode | undefined {
  if (isLocalRepaintProjectedLayer(layer)) return 'literal';
  return layer.blendMode === 'overlay' ? 'feathered' : undefined;
}

/**
 * CPU-parity composition resolves ordinary projected layers first and then
 * applies projection overlays in order. Only the final contiguous literal run
 * can therefore be collapsed without crossing a feathered overlay boundary.
 */
export function getBatchedLiteralOverlaySuffix<
  T extends Pick<Layer, 'type' | 'id' | 'imageUrl' | 'blendMode'>,
>(layers: readonly T[]) {
  const overlays = layers.filter((layer) => getProjectedLayerOverlayMode(layer));
  let suffixStart = overlays.length;
  while (
    suffixStart > 0 &&
    getProjectedLayerOverlayMode(overlays[suffixStart - 1]) === 'literal'
  ) {
    suffixStart -= 1;
  }
  const suffix = overlays.slice(suffixStart);
  return suffix.length > 1 ? suffix : [];
}

/**
 * Persistent projection overlays keep the historical quality feather. Local
 * repaint already owns a user-authored mask, so its source-over alpha must be
 * the rasterized coverage itself to match the live layer stack exactly.
 */
export function getProjectionOverlayAlpha(
  layerCoverage: number,
  quality: number,
  mode: ProjectedOverlayMode,
) {
  const coverage = Math.max(0, Math.min(1, layerCoverage));
  if (mode === 'literal') return coverage;
  const qualitySignal = Math.max(quality, coverage * 0.25);
  const t = Math.max(0, Math.min(1, qualitySignal / 0.15));
  const qualityFade = t * t * (3 - 2 * t);
  return coverage * (0.75 + 0.25 * qualityFade);
}
