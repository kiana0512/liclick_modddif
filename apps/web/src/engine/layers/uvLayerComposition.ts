import type { Layer } from '@/types/layer';

export type UvLayerCompositionDirection = 'bottom-to-top' | 'top-to-bottom';

export function isLocalRepaintUvOverlayLayer(
  layer: Pick<Layer, 'id' | 'name' | 'type' | 'role' | 'imageUrl'>,
) {
  return Boolean(
    layer.type === 'uv' &&
      (layer.role === 'local-repaint-overlay' ||
        layer.id.startsWith('local-repaint-uv-merge') ||
        layer.name === 'UV Repair Layer' ||
        layer.imageUrl.includes('surface-edit:local-repaint')),
  );
}

export function compareUvLayersForComposition(
  left: Pick<Layer, 'id' | 'name' | 'type' | 'role' | 'imageUrl' | 'order'>,
  right: Pick<Layer, 'id' | 'name' | 'type' | 'role' | 'imageUrl' | 'order'>,
  direction: UvLayerCompositionDirection = 'bottom-to-top',
) {
  const leftIsLocalRepaint = Number(isLocalRepaintUvOverlayLayer(left));
  const rightIsLocalRepaint = Number(isLocalRepaintUvOverlayLayer(right));
  const overlayDifference = leftIsLocalRepaint - rightIsLocalRepaint;
  if (overlayDifference !== 0) {
    return direction === 'bottom-to-top' ? overlayDifference : -overlayDifference;
  }
  return direction === 'bottom-to-top' ? right.order - left.order : left.order - right.order;
}

export function getVisibleUvLayerStack(
  layers: Layer[],
  objectId: string,
  direction: UvLayerCompositionDirection = 'bottom-to-top',
) {
  return layers
    .filter(
      (layer) =>
        layer.type === 'uv' &&
        layer.visible &&
        Boolean(layer.imageUrl) &&
        (!layer.objectId || layer.objectId === objectId),
    )
    .sort((left, right) => compareUvLayersForComposition(left, right, direction));
}
