import type { Layer } from '@/types/layer';

/**
 * Capture-space linear visibility remains valid across a later rigid object
 * transform because both UV rasterizers map the current surface back through
 * the authored object matrix before sampling it. Legacy rows without that
 * matrix stay on the conservative regeneration path.
 */
export function canReuseAuthoredProjectionVisibility(
  layer: Layer,
  includeNormal: boolean,
) {
  return Boolean(
    layer.depthUrl &&
      layer.depthEncoding === 'linear-view' &&
      layer.objectMatrixWorld?.length === 16 &&
      (!includeNormal || layer.normalUrl),
  );
}
