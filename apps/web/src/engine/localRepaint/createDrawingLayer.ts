import { useLayerStore } from '@/stores/layerStore';

/** Explicit user action: create a normal, panel-visible UV layer, not an internal draft. */
export function createLocalRepaintDrawingLayer(objectId: string) {
  return useLayerStore.getState().addEmptyLayer({ name: '局部重绘', objectId });
}
