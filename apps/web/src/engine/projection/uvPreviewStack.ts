import type { Layer } from '@/types/layer';
import { isLiveProjectedCanvasUrl } from './liveProjectedCanvasTextureRegistry';

export function isRenderedLocalRepaintLayer(layer: Layer) {
  return Boolean(
    layer.id.startsWith('local-repaint-') ||
    layer.role === 'local-repaint-overlay' ||
    layer.role === 'local-repaint-draft' ||
    (layer.imageUrl ?? '').includes('surface-edit:local-repaint') ||
    layer.localRepaintSourceUrl ||
    layer.localRepaintMaskUrl,
  );
}

/** UV-REPAINT-PREVIEW-BINDING/1.0.1. Inputs are visible, ordered UV rows.
 * Manual drawing rows deliberately keep their UUID and ordinary UV role.
 * All display consumers must split the same top sampler from the lower stack.
 * A missing live owner stays on this path (fail closed), never image decoding.
 */
export function getTopUvPreviewLayer(
  uvLayers: Layer[],
  projectedLayers: ReadonlyArray<{ order: number; visible?: boolean }>,
  previewLayerId?: string,
) {
  const top = uvLayers[0];
  if (!top) return undefined;
  if (isRenderedLocalRepaintLayer(top)) return top;
  if (!isLiveProjectedCanvasUrl(top.imageUrl)) return undefined;
  return previewLayerId || projectedLayers.every(
    (layer) => layer.visible === false || top.order < layer.order,
  ) ? top : undefined;
}
