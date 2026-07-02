import type { BakedTexture } from './uvBakeTypes';
import type { Project } from '@/types/project';
import type { Layer } from '@/types/layer';

const MIN_REUSABLE_LAYER_STACK_COVERAGE_RATIO = 0.001;
const inFlightLayerStackBakes = new Map<string, Promise<BakedTexture | undefined>>();

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

function objectMatches(texture: BakedTexture, objectId?: string) {
  return objectId === undefined || texture.objectId === objectId;
}

function cacheKeyMatches(texture: BakedTexture, cacheKey?: string) {
  return cacheKey === undefined || texture.cacheKey === cacheKey;
}

function resolutionMatches(texture: BakedTexture, expectedResolution?: number) {
  return expectedResolution === undefined || (texture.width === expectedResolution && texture.height === expectedResolution);
}

function hasReusableCoverage(texture: BakedTexture) {
  return (texture.coverageRatio ?? texture.report?.coverageRatio ?? 0) >= MIN_REUSABLE_LAYER_STACK_COVERAGE_RATIO;
}

function getStableLayerAssetKey(url: string | undefined) {
  if (!url) return '';
  if (url.startsWith('blob:')) return '';
  const workspaceIndex = url.indexOf('/workspace/');
  if (workspaceIndex >= 0) return url.slice(workspaceIndex + '/workspace/'.length);
  return url;
}

export function findExactLayerStackTexture(
  project: Project | undefined,
  visibleLayers: Layer[],
  expectedResolution?: number,
  objectId?: string,
  cacheKey?: string,
) {
  if (!project || visibleLayers.length === 0) return undefined;
  const visibleLayerIds = visibleLayers.map((layer) => layer.id);
  return (
    project.bakedTextures.find(
      (texture) =>
        objectMatches(texture, objectId) &&
        cacheKeyMatches(texture, cacheKey) &&
        hasReusableCoverage(texture) &&
        resolutionMatches(texture, expectedResolution) &&
        layerIdsMatch(getBakedTextureLayerIds(texture), visibleLayerIds),
    ) ??
    project.bakedTextures.find(
      (texture) =>
        objectMatches(texture, objectId) &&
        cacheKeyMatches(texture, cacheKey) &&
        hasReusableCoverage(texture) &&
        resolutionMatches(texture, expectedResolution) &&
        usesOrderIndependentStack(texture) && layerIdSetsMatch(getBakedTextureLayerIds(texture), visibleLayerIds),
    )
  );
}

export function findBaseLayerStackTexture(project: Project | undefined, visibleLayers: Layer[], objectId?: string) {
  if (!project || visibleLayers.length < 2) return undefined;
  const visibleLayerIds = visibleLayers.map((layer) => layer.id);
  const rebakeLayerIds = new Set(visibleLayers.filter((layer) => layer.needsRebake).map((layer) => layer.id));

  let bestTexture: BakedTexture | undefined;
  let bestLayerCount = 0;
  for (const texture of project.bakedTextures) {
    if (!objectMatches(texture, objectId)) continue;
    if (!hasReusableCoverage(texture)) continue;
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

export function canUseLayerStackCache(
  visibleLayers: Layer[],
  texture: BakedTexture | undefined,
  expectedResolution?: number,
  objectId?: string,
  cacheKey?: string,
) {
  if (!texture) return false;
  if (!objectMatches(texture, objectId)) return false;
  if (!cacheKeyMatches(texture, cacheKey)) return false;
  if (!hasReusableCoverage(texture)) return false;
  if (!resolutionMatches(texture, expectedResolution)) return false;
  const sourceLayerIds = getBakedTextureLayerIds(texture);
  if (sourceLayerIds.length !== visibleLayers.length) return false;
  if (visibleLayers.some((layer) => layer.needsRebake)) return false;
  const visibleLayerIds = visibleLayers.map((layer) => layer.id);
  if (layerIdsMatch(sourceLayerIds, visibleLayerIds)) return true;
  return usesOrderIndependentStack(texture) && layerIdSetsMatch(sourceLayerIds, visibleLayerIds);
}

export function getProjectedLayerStackSignature(
  projectId: string | undefined,
  objectId: string,
  resolution: string | number,
  stack: Layer[],
) {
  return [
    projectId ?? 'no-project',
    objectId,
    resolution,
    ...stack.map((layer) =>
      [
        layer.id,
        getStableLayerAssetKey(layer.imageUrl),
        getStableLayerAssetKey(layer.maskUrl),
        getStableLayerAssetKey(layer.depthUrl),
        layer.visible ? 1 : 0,
        layer.opacity,
        layer.strength ?? 1,
        layer.blendMode,
        layer.adjustments?.hue ?? 0,
        layer.adjustments?.saturation ?? 0,
        layer.adjustments?.lightness ?? 0,
      ].join(':'),
    ),
  ].join('|');
}

export function getLayerStackBakeInFlight(signature: string) {
  return inFlightLayerStackBakes.get(signature);
}

export function registerLayerStackBakeInFlight(signature: string, promise: Promise<BakedTexture | undefined>) {
  inFlightLayerStackBakes.set(signature, promise);
  void promise.finally(() => {
    if (inFlightLayerStackBakes.get(signature) === promise) {
      inFlightLayerStackBakes.delete(signature);
    }
  });
  return promise;
}
