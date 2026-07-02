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

function layerIdSetsMatch(a: string[], b: string[]) {
  if (a.length !== b.length) return false;
  const bIds = new Set(b);
  return a.every((layerId) => bIds.has(layerId));
}

function usesOrderIndependentStack(texture: BakedTexture) {
  const sourceLayerIds = getBakedTextureLayerIds(texture);
  if (sourceLayerIds.length <= 1) return true;
  return (
    texture.report?.warnings?.some((warning) =>
      warning.includes('order-independent loose coverage with strict quality blend') ||
      warning.includes('order-independent visibility-gated quality blend'),
    ) ?? false
  );
}

function isPrefixStack(sourceLayerIds: string[], visibleLayerIds: string[]) {
  if (sourceLayerIds.length === 0 || sourceLayerIds.length >= visibleLayerIds.length) return false;
  return sourceLayerIds.every((layerId, index) => layerId === visibleLayerIds[index]);
}

function resolutionMatches(texture: BakedTexture, expectedResolution?: number) {
  return expectedResolution === undefined || (texture.width === expectedResolution && texture.height === expectedResolution);
}

export function findExactLayerStackTexture(project: Project | undefined, visibleLayers: Layer[], expectedResolution?: number) {
  if (!project || visibleLayers.length === 0) return undefined;
  const visibleLayerIds = visibleLayers.map((layer) => layer.id);
  return (
    project.bakedTextures.find((texture) => resolutionMatches(texture, expectedResolution) && layerIdsMatch(getBakedTextureLayerIds(texture), visibleLayerIds)) ??
    project.bakedTextures.find(
      (texture) =>
        resolutionMatches(texture, expectedResolution) &&
        usesOrderIndependentStack(texture) && layerIdSetsMatch(getBakedTextureLayerIds(texture), visibleLayerIds),
    )
  );
}

export function findBaseLayerStackTexture(project: Project | undefined, visibleLayers: Layer[]) {
  if (!project || visibleLayers.length < 2) return undefined;
  const visibleLayerIds = visibleLayers.map((layer) => layer.id);
  const rebakeLayerIds = new Set(visibleLayers.filter((layer) => layer.needsRebake).map((layer) => layer.id));

  let bestTexture: BakedTexture | undefined;
  let bestLayerCount = 0;
  for (const texture of project.bakedTextures) {
    const sourceLayerIds = getBakedTextureLayerIds(texture);
    if (sourceLayerIds.length > 1 && !usesOrderIndependentStack(texture)) continue;
    if (!isPrefixStack(sourceLayerIds, visibleLayerIds)) continue;
    if (sourceLayerIds.some((layerId) => rebakeLayerIds.has(layerId))) continue;
    if (sourceLayerIds.length <= bestLayerCount) continue;
    bestTexture = texture;
    bestLayerCount = sourceLayerIds.length;
  }
  return bestTexture;
}

export function canUseLayerStackCache(visibleLayers: Layer[], texture: BakedTexture | undefined, expectedResolution?: number) {
  if (!texture) return false;
  if (!resolutionMatches(texture, expectedResolution)) return false;
  const sourceLayerIds = getBakedTextureLayerIds(texture);
  if (sourceLayerIds.length !== visibleLayers.length) return false;
  if (sourceLayerIds.length > 1 && !usesOrderIndependentStack(texture)) return false;
  if (visibleLayers.some((layer) => layer.needsRebake)) return false;
  const visibleLayerIds = visibleLayers.map((layer) => layer.id);
  return (
    layerIdsMatch(sourceLayerIds, visibleLayerIds) ||
    (usesOrderIndependentStack(texture) && layerIdSetsMatch(sourceLayerIds, visibleLayerIds))
  );
}
