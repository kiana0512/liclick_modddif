import type { BakedTexture } from './uvBakeTypes';
import type { Project } from '@/types/project';
import type { Layer } from '@/types/layer';

export function getVisibleProjectedLayerStack(layers: Layer[], objectId: string) {
  return layers
    .filter(
      (layer) =>
        layer.type === 'projected' &&
        layer.visible &&
        layer.imageUrl &&
        layer.camera &&
        (!layer.objectId || layer.objectId === objectId),
    )
    .sort((a, b) => b.order - a.order);
}

export function getBakedTextureLayerIds(texture: BakedTexture) {
  return texture.sourceLayerIds ?? [texture.sourceLayerId];
}

function layerIdsMatch(a: string[], b: string[]) {
  return a.length === b.length && a.every((layerId, index) => layerId === b[index]);
}

function isPrefixStack(sourceLayerIds: string[], visibleLayerIds: string[]) {
  if (sourceLayerIds.length === 0 || sourceLayerIds.length >= visibleLayerIds.length) return false;
  return sourceLayerIds.every((layerId, index) => layerId === visibleLayerIds[index]);
}

export function findExactLayerStackTexture(project: Project | undefined, visibleLayers: Layer[]) {
  if (!project || visibleLayers.length === 0) return undefined;
  const visibleLayerIds = visibleLayers.map((layer) => layer.id);
  return project.bakedTextures.find((texture) => layerIdsMatch(getBakedTextureLayerIds(texture), visibleLayerIds));
}

export function findBaseLayerStackTexture(project: Project | undefined, visibleLayers: Layer[]) {
  if (!project || visibleLayers.length < 2) return undefined;
  const visibleLayerIds = visibleLayers.map((layer) => layer.id);
  const rebakeLayerIds = new Set(visibleLayers.filter((layer) => layer.needsRebake).map((layer) => layer.id));

  let bestTexture: BakedTexture | undefined;
  let bestLayerCount = 0;
  for (const texture of project.bakedTextures) {
    const sourceLayerIds = getBakedTextureLayerIds(texture);
    if (!isPrefixStack(sourceLayerIds, visibleLayerIds)) continue;
    if (sourceLayerIds.some((layerId) => rebakeLayerIds.has(layerId))) continue;
    if (sourceLayerIds.length <= bestLayerCount) continue;
    bestTexture = texture;
    bestLayerCount = sourceLayerIds.length;
  }
  return bestTexture;
}

export function canUseLayerStackCache(visibleLayers: Layer[], texture: BakedTexture | undefined) {
  if (!texture) return false;
  const sourceLayerIds = getBakedTextureLayerIds(texture);
  if (sourceLayerIds.length !== visibleLayers.length) return false;
  return visibleLayers.every((layer, index) => layer.id === sourceLayerIds[index] && !layer.needsRebake);
}
