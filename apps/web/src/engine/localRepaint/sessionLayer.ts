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
  const belongsToObject = (layer: Layer) =>
    !layer.objectId || layer.objectId === input.objectId;
  const isSessionTarget = (layer: Layer) =>
    belongsToObject(layer) &&
    layer.type === 'uv' &&
    (layer.role === 'local-repaint-draft' || layer.role === 'local-repaint-overlay');
  const initialLayers = useLayerStore.getState().layers;
  const sessionTargets = initialLayers.filter(isSessionTarget);
  const targetIds = new Set(sessionTargets.map((item) => item.id));
  const currentVisibleResult = initialLayers.find(
    (item) =>
      belongsToObject(item) &&
      item.type === 'projected' &&
      Boolean(item.replacementTargetLayerId) &&
      targetIds.has(item.replacementTargetLayerId!),
  );
  // A local repaint is one user-facing layer. Generation IDs describe newer
  // source images for that same layer; they must not create another empty row.
  // Prefer the target already owned by the visible first-row result so legacy
  // projects converge without losing the current replacement.
  let layer =
    sessionTargets.find((item) => item.id === currentVisibleResult?.replacementTargetLayerId) ??
    sessionTargets[0];
  let mutated = false;
  let boundGeneration = false;

  let created = false;
  if (!layer) {
    layer = useLayerStore.getState().addEmptyLayer({
      name: '局部重绘',
      objectId: input.objectId,
      role: 'local-repaint-draft',
      generationId: input.generationId,
    });
    mutated = true;
    created = true;
    boundGeneration = Boolean(input.generationId);
  } else {
    if (input.generationId && layer.generationId !== input.generationId) {
      useLayerStore.getState().updateLayer(layer.id, { generationId: input.generationId });
      layer = useLayerStore.getState().layers.find((item) => item.id === layer!.id) ?? layer;
      mutated = true;
      boundGeneration = true;
    }
    useLayerStore.getState().setActiveLayer(layer.id);
  }

  const canonicalTargetId = layer.id;
  const duplicateTargetIds = new Set(
    useLayerStore
      .getState()
      .layers.filter((item) => isSessionTarget(item) && item.id !== canonicalTargetId)
      .map((item) => item.id),
  );
  const runtimeResults = useLayerStore.getState().layers.filter(
    (item) =>
      belongsToObject(item) &&
      item.type === 'projected' &&
      Boolean(item.replacementTargetLayerId) &&
      (item.id.startsWith('local-repaint-projection') ||
        item.id.startsWith('local-repaint-brush-projection') ||
        targetIds.has(item.replacementTargetLayerId!) ||
        duplicateTargetIds.has(item.replacementTargetLayerId!)),
  );
  const visibleResultId = runtimeResults[0]?.id;
  if (visibleResultId && runtimeResults[0]?.visible === false) {
    // Entering local repaint means the single user-facing result is the active
    // top layer. Restore its visibility automatically instead of creating a
    // live GPU overlay whose matching layer row is still hidden.
    useLayerStore.getState().updateLayer(visibleResultId, { visible: true });
    mutated = true;
  }
  if (duplicateTargetIds.size > 0 || runtimeResults.length > 1) {
    // Older builds produced one draft and one visible result for every
    // generation. Keep the newest top-row result and the single canonical
    // target; both the editor and exporter then see one coherent session.
    const nextLayers = useLayerStore
      .getState()
      .layers.filter(
        (item) =>
          !duplicateTargetIds.has(item.id) &&
          (!runtimeResults.some((result) => result.id === item.id) || item.id === visibleResultId),
      )
      .map((item) =>
        item.id === visibleResultId
          ? { ...item, replacementTargetLayerId: canonicalTargetId }
          : item,
      );
    useLayerStore.getState().setLayers(nextLayers);
    mutated = true;
  }

  if (mutated) {
    useProjectStore.getState().setProjectLayers(useLayerStore.getState().layers);
    if (typeof window !== 'undefined') {
      window.dispatchEvent(new Event(IMMEDIATE_PROJECT_SAVE_EVENT));
    }
  }
  return { layer, created, boundGeneration };
}
