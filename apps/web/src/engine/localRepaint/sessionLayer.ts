import { useLayerStore } from '@/stores/layerStore';
import { useGenerationStore } from '@/stores/generationStore';
import { IMMEDIATE_PROJECT_SAVE_EVENT, useProjectStore } from '@/stores/projectStore';
import { useSceneStore } from '@/stores/sceneStore';
import { isLiveProjectedCanvasUrl } from '@/engine/projection/liveProjectedCanvasTextureRegistry';
import { normalizeLocalRepaintObjectBindings } from './objectBinding';
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
  const belongsToObject = (layer: Layer) => layer.objectId === input.objectId;
  const isSessionTarget = (layer: Layer) =>
    belongsToObject(layer) &&
    layer.type === 'uv' &&
    (layer.role === 'local-repaint-draft' || layer.role === 'local-repaint-overlay');
  let initialLayers = useLayerStore.getState().layers;
  const currentProject = useProjectStore.getState().getCurrentProject();
  const normalizedBindings = normalizeLocalRepaintObjectBindings({
    layers: initialLayers,
    generations: useGenerationStore.getState().generations,
    captures: currentProject?.captures ?? [],
  });
  if (normalizedBindings.changed) {
    useLayerStore.getState().setLayers(normalizedBindings.layers);
    initialLayers = useLayerStore.getState().layers;
  }
  const migratedLayers = initialLayers.map((item) =>
    item.type === 'projected' &&
    item.localRepaintSourceUrl &&
    isLiveProjectedCanvasUrl(item.imageUrl)
      ? {
          ...item,
          // Older builds persisted one component-wide live preview URL. Its
          // backing texture was replaced by every later generation, so several
          // rows could display the same newest image. Restore each row to its
          // own durable generation result as soon as the project is touched.
          imageUrl: item.localRepaintSourceUrl,
          contentRevision: (item.contentRevision ?? 0) + 1,
        }
      : item,
  );
  const migratedRuntimeUrls = migratedLayers.some(
    (item, index) => item !== initialLayers[index],
  );
  if (migratedRuntimeUrls) {
    useLayerStore.getState().setLayers(migratedLayers);
    initialLayers = useLayerStore.getState().layers;
  }
  const sessionTargets = initialLayers.filter(isSessionTarget);
  const targetIds = new Set(sessionTargets.map((item) => item.id));
  const generationResult = initialLayers.find(
    (item) =>
      belongsToObject(item) &&
      item.type === 'projected' &&
      Boolean(item.replacementTargetLayerId) &&
      targetIds.has(item.replacementTargetLayerId!) &&
      Boolean(input.generationId) &&
      item.generationId === input.generationId,
  );
  const claimedTargetIds = new Set(
    initialLayers.flatMap((item) =>
      item.replacementTargetLayerId ? [item.replacementTargetLayerId] : [],
    ),
  );
  // One generated repaint source owns one independent destination layer. More
  // brush strokes from the same generation continue accumulating on that layer,
  // while a newer generation starts with an empty mask and cannot recolour the
  // pixels already authored by older repaint layers.
  let layer =
    sessionTargets.find((item) => item.id === generationResult?.replacementTargetLayerId) ??
    sessionTargets.find(
      (item) => Boolean(input.generationId) && item.generationId === input.generationId,
    ) ??
    // Reuse only an uncommitted placeholder. A destination that already owns a
    // visible result is historical content and must never be rebound.
    sessionTargets.find((item) => !item.imageUrl && !claimedTargetIds.has(item.id));
  let mutated = migratedRuntimeUrls || normalizedBindings.changed;
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
      .filter(
        (item) =>
          Boolean(input.generationId) &&
          item.generationId === input.generationId &&
          !item.imageUrl &&
          !claimedTargetIds.has(item.id),
      )
      .map((item) => item.id),
  );
  const runtimeResults = useLayerStore.getState().layers.filter(
    (item) =>
      belongsToObject(item) &&
      item.type === 'projected' &&
      Boolean(item.replacementTargetLayerId) &&
      (item.replacementTargetLayerId === canonicalTargetId ||
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
    // Collapse only duplicates belonging to this generation. Repaint results
    // from other generations are intentional independent user-facing layers.
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

  const sceneState = useSceneStore.getState();
  const currentSource = sceneState.localRepaintProjectionSource;
  const sourceOwnsTarget = currentSource?.targetLayerId === canonicalTargetId;
  if (!sourceOwnsTarget) {
    // A persisted result is not itself a renderer-owned live preview. Publishing
    // it here used to mute the stored row before any GPU overlay existed. This
    // effect runs again as soon as a remote generation succeeds, so the previous
    // repaint vanished until an eye toggle forced the projected uniforms to
    // refresh. Only ViewportCanvas may publish localRepaintPreviewLayer, after
    // it has prepared the matching source, mask and overlay.
    if (currentSource) {
      // Keep the old persistent row muted until ViewportCanvas has physically
      // removed its renderer-owned twin. Clearing preview ownership first lets
      // SceneRoot show the stored row for one frame while the duplicate overlay
      // geometry is still present; the two coplanar surfaces then z-fight into
      // the regular stripe/moire pattern seen after a remote result returns.
      // The source teardown owns the atomic order: dispose GPU overlay, then
      // release preview ownership and reveal the persistent row.
      sceneState.setLocalRepaintProjectionSource(undefined);
      sceneState.setPaintTool('none');
    } else if (sceneState.localRepaintPreviewLayer) {
      // No renderer source means there cannot be a live overlay waiting to
      // dispose, so a genuinely stale preview marker is safe to clear here.
      sceneState.setLocalRepaintPreviewLayer(undefined);
    }
  }

  if (mutated) {
    useProjectStore.getState().setProjectLayers(useLayerStore.getState().layers);
    if (typeof window !== 'undefined') {
      window.dispatchEvent(new Event(IMMEDIATE_PROJECT_SAVE_EVENT));
    }
  }
  return { layer, created, boundGeneration };
}
