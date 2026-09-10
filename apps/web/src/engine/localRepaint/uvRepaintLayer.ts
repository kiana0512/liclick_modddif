import type { Layer } from '@/types/layer';
import type { LocalRepaintProjectionSource } from '@/stores/sceneStore';
import { useLayerStore } from '@/stores/layerStore';
import { useProjectStore } from '@/stores/projectStore';
import { restoreLocalRepaintLayerSelection } from './sessionLayer';
import { getVisibleUvLayerStack } from '@/engine/layers/uvLayerComposition';

/** Layer publication only. Pixel math and rendering live in uvRepaint.ts. */
export function publishUvRepaintLayer(input: {
  id: string;
  assetUrl: string;
  source: LocalRepaintProjectionSource;
  objectId: string;
  initialize?: boolean;
}) {
  const state = useLayerStore.getState();
  const existing = state.layers.find((layer) => layer.id === input.id);
  // A late GPU readback must never resurrect a row deleted by the user.
  if (!existing && !input.initialize) return false;
  const source = input.source;
  const layer: Layer = {
    id: input.id,
    name: source.targetLayerName ? `${source.targetLayerName} · 局部替换` : '局部重绘 · 局部替换',
    type: 'uv',
    role: 'local-repaint-overlay',
    imageUrl: input.assetUrl,
    objectId: source.objectId ?? input.objectId,
    generationId: source.generationId,
    captureId: source.captureId,
    replacementTargetLayerId: source.targetLayerId,
    localRepaintSourceUrl: source.persistentImageUrl ?? source.imageUrl,
    localRepaintRawSourceUrl: source.rawImageUrl,
    camera: source.camera,
    objectMatrixWorld: source.objectMatrixWorld,
    // RGBA is already clipped/composited once in UV; no projected/raw mask here.
    renderedColor: false,
    ignoreSourceAlpha: false,
    visible: existing?.visible ?? true,
    opacity: existing?.opacity ?? 1,
    strength: existing?.strength ?? 1,
    blendMode: existing?.blendMode ?? 'normal',
    adjustments: existing?.adjustments ?? { hue: 0, saturation: 0, lightness: 0 },
    order: existing?.order ?? 0,
    contentRevision: existing?.contentRevision ?? 0,
    isBaked: false,
    needsRebake: false,
    createdAt: existing?.createdAt ?? new Date().toISOString(),
  };
  const activeId = state.activeProjectedLayerId;
  if (!existing) state.setLayers([layer, ...state.layers]);
  else if (
    existing.imageUrl !== layer.imageUrl ||
    input.initialize ||
    getVisibleUvLayerStack(state.layers, input.objectId, 'top-to-bottom')[0]?.id !== layer.id
  ) {
    // A reopened GPU owner or a historical (CPU-composited) row must invalidate
    // its old resident binding. The actively drawn top RT needs no rebuild.
    state.updateLayer(layer.id, {
      imageUrl: layer.imageUrl,
      contentRevision: (existing.contentRevision ?? 0) + 1,
    });
  }
  if (input.initialize) restoreLocalRepaintLayerSelection(activeId);
  useProjectStore.getState().setProjectLayers(useLayerStore.getState().layers);
  return true;
}
