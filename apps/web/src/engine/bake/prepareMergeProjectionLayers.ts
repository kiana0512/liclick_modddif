import type { Layer } from '@/types/layer';
import { createProjectionMaskedImage } from '@/engine/projection/createMaskedProjectedImage';
import { isLocalRepaintProjectedLayer } from './projectedOverlayComposition';

/** The display and explicit Merge must rasterize identical source alpha. */
export function prepareMergeProjectionLayers(layers: Layer[], maskImage = createProjectionMaskedImage) {
  return Promise.all(layers.map(async layer =>
    isLocalRepaintProjectedLayer(layer) && layer.maskUrl ? { ...layer,
      imageUrl: await maskImage(layer.imageUrl, layer.maskUrl, { ignoreSourceAlpha: layer.ignoreSourceAlpha ?? true }),
      maskUrl: undefined, ignoreSourceAlpha: false,
    } : layer));
}
