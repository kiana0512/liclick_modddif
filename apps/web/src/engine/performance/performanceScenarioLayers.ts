import type { Layer } from '@/types/layer';

type OpacityBinding = { layerId?: string; opacityUniform: string; arrayIndex?: number };

export function performanceScenarioVisibleBindings(
  bindings: readonly OpacityBinding[] | undefined,
  uniforms: Record<string, { value: unknown }>,
) {
  const compact = uniforms.compactLayerOpacities?.value;
  return bindings?.filter(binding => Number(
    binding.arrayIndex !== undefined && Array.isArray(compact)
      ? compact[binding.arrayIndex]
      : uniforms[binding.opacityUniform]?.value ?? 0,
  ) > 0.0001) ?? [];
}

/** Merged UV rows intentionally suppress projections below them. A projection
 * benchmark must uncover those rows before measuring, then restore its snapshot. */
export function performanceScenarioOccludingUvIds(
  layers: readonly Layer[],
  objectId?: string,
) {
  return layers.filter(layer =>
    (!objectId || !layer.objectId || layer.objectId === objectId) &&
    layer.type === 'uv' && layer.role !== 'content-aware-underlay',
  ).map(layer => layer.id);
}
