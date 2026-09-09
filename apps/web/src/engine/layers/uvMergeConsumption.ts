import type { Layer } from '@/types/layer';

/** UV-MERGE-SOURCE-CONSUMPTION v1.0.0: consume only baked inputs and orphaned implementation targets. */
export function prepareUvMergeConsumption(
  layers: Layer[],
  input: { sourceLayerIds: string[]; targetUvLayerId?: string; objectId?: string },
) {
  const requested = new Set(input.sourceLayerIds);
  const sameObject = (layer: Layer) =>
    !input.objectId || !layer.objectId || layer.objectId === input.objectId;
  const consumed = new Set(
    layers.filter((layer) => requested.has(layer.id) &&
      layer.id !== input.targetUvLayerId && sameObject(layer)).map((layer) => layer.id),
  );
  for (const layer of layers) {
    if (!consumed.has(layer.id) || !layer.replacementTargetLayerId) continue;
    const target = layers.find((candidate) => candidate.id === layer.replacementTargetLayerId);
    if (!target || target.id === input.targetUvLayerId || !sameObject(target) || target.type !== 'uv' ||
      (target.role !== 'local-repaint-draft' && target.role !== 'local-repaint-overlay')) continue;
    // Never remove a shared destination still owned by an unmerged result.
    if (!layers.some((candidate) => candidate.replacementTargetLayerId === target.id && !consumed.has(candidate.id))) {
      consumed.add(target.id);
    }
  }
  const firstSource = layers.findIndex((layer) => consumed.has(layer.id));
  const insertIndex = Math.max(0, firstSource);
  return { layers: layers.filter((layer) => !consumed.has(layer.id)), insertIndex };
}
