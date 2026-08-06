import { useLayerStore } from '@/stores/layerStore';
import { IMMEDIATE_PROJECT_SAVE_EVENT, useProjectStore } from '@/stores/projectStore';
import type { Layer } from '@/types/layer';

export type LocalRepaintSessionLayerResult = {
  layer: Layer;
  created: boolean;
  boundGeneration: boolean;
};

export function ensureLocalRepaintSessionLayer(input: {
  objectId: string;
  generationId?: string;
}): LocalRepaintSessionLayerResult {
  const layerState = useLayerStore.getState();
  const belongsToObject = (layer: Layer) =>
    !layer.objectId || layer.objectId === input.objectId;
  let layer = layerState.layers.find(
    (item) =>
      belongsToObject(item) &&
      (item.role === 'local-repaint-draft' || item.role === 'local-repaint-overlay') &&
      item.generationId === input.generationId,
  );
  let mutated = false;
  let boundGeneration = false;

  if (!layer && input.generationId) {
    const unboundDraft = layerState.layers.find(
      (item) =>
        belongsToObject(item) &&
        item.role === 'local-repaint-draft' &&
        !item.generationId &&
        !item.imageUrl,
    );
    if (unboundDraft) {
      layerState.updateLayer(unboundDraft.id, { generationId: input.generationId });
      layer = useLayerStore.getState().layers.find((item) => item.id === unboundDraft.id);
      mutated = true;
      boundGeneration = true;
    }
  }

  let created = false;
  if (!layer) {
    const repaintLayerCount = layerState.layers.filter(
      (item) =>
        belongsToObject(item) &&
        (item.role === 'local-repaint-draft' || item.role === 'local-repaint-overlay'),
    ).length;
    layer = layerState.addEmptyLayer({
      name: repaintLayerCount === 0 ? '局部重绘' : `局部重绘 ${repaintLayerCount + 1}`,
      objectId: input.objectId,
      role: 'local-repaint-draft',
      generationId: input.generationId,
    });
    mutated = true;
    created = true;
    boundGeneration = Boolean(input.generationId);
  } else {
    useLayerStore.getState().setActiveLayer(layer.id);
  }

  if (mutated) {
    useProjectStore.getState().setProjectLayers(useLayerStore.getState().layers);
    if (typeof window !== 'undefined') {
      window.dispatchEvent(new Event(IMMEDIATE_PROJECT_SAVE_EVENT));
    }
  }
  return { layer, created, boundGeneration };
}
