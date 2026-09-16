import { useLayerStore } from '@/stores/layerStore';
import type { Layer } from '@/types/layer';

export function isContentAwareRepairLayer(layer: Layer) {
  return layer.role === 'content-aware-underlay' ||
    layer.generationId === 'texture-map-content-aware-repair' ||
    layer.id.startsWith('content-aware-projected-repair') ||
    layer.id.startsWith('content-aware-uv-repair');
}

/** Manual destination policy v1.1. Sources never create, convert or select rows. */
export function isLocalRepaintDestinationLayer(
  layer: Layer | undefined,
  objectId: string,
): layer is Layer & { type: 'uv' } {
  return Boolean(layer && layer.type === 'uv' && layer.objectId === objectId && layer.visible &&
    !isContentAwareRepairLayer(layer));
}

export function getSelectedLocalRepaintLayer(objectId: string) {
  const state = useLayerStore.getState();
  const layer = state.layers.find((item) => item.id === state.activeProjectedLayerId);
  return isLocalRepaintDestinationLayer(layer, objectId) ? layer : undefined;
}

/** Repaint resources do not own the user's layer-panel selection (including none). */
export function restoreLocalRepaintLayerSelection(layerId: string | undefined) {
  const state = useLayerStore.getState();
  const selectedId = state.layers.some((layer) => layer.id === layerId) ? layerId : undefined;
  if (state.activeProjectedLayerId === selectedId) return;
  if (selectedId) state.setActiveLayer(selectedId);
  else useLayerStore.setState({ activeProjectedLayerId: undefined });
}
