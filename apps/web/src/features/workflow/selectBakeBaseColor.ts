import type { BakedTexture } from '@/engine/bake/uvBakeTypes';
import { isLocalRepaintProjectedLayer } from '@/engine/bake/projectedOverlayComposition';
import {
  isContentAwareUvUnderlay,
  UV_MERGE_COMPOSITION_VERSION,
} from '@/engine/layers/mergeUvComposition';
import type { Layer } from '@/types/layer';
import type { TextureBakeHandoff } from '@/types/project';

export type BakeBaseColorSource = {
  name: string;
  imageUrl: string;
};

type BakeBaseColorProject = {
  layers: readonly Layer[];
  bakedTextures: readonly BakedTexture[];
};

type BakeEntryProject = {
  layers: readonly Layer[];
  activeObjectId?: string;
  bakeWorkspace?: {
    selectedObjectId?: string;
  };
};

type BakeMergeModel = {
  objectId: string;
  restoreStage?: 'bounds' | 'outline' | 'full';
};

export type BakeUvMergePlan =
  | {
      action: 'reuse';
      objectId: string;
      mergedLayer: Layer;
      baseUvLayerId: string;
      sourceLayerIds: [];
      projectedLayerIds: [];
      uvUnderlayLayerIds: [];
    }
  | {
      action: 'merge';
      objectId: string;
      mergedLayer?: Layer;
      baseUvLayerId?: string;
      sourceLayerIds: string[];
      projectedLayerIds: string[];
      uvUnderlayLayerIds: string[];
      reason: 'missing-merged-uv' | 'visible-layer-delta';
    }
  | {
      action: 'missing';
      objectId?: string;
      sourceLayerIds: [];
      projectedLayerIds: [];
      uvUnderlayLayerIds: [];
      reason: 'missing-object' | 'no-visible-merged-or-projected-source';
    };

function timestamp(value: string | undefined) {
  const parsed = value ? Date.parse(value) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : Number.NEGATIVE_INFINITY;
}

function compareLayers(left: Layer, right: Layer) {
  if (left.order !== right.order) return left.order - right.order;
  const contentRevisionDelta = (right.contentRevision ?? 0) - (left.contentRevision ?? 0);
  if (contentRevisionDelta !== 0) return contentRevisionDelta;
  return timestamp(right.createdAt) - timestamp(left.createdAt);
}

export function findMergedUvBakeLayer(
  layers: readonly Layer[],
  objectId: string | undefined,
) {
  if (!objectId) return undefined;
  return layers
    .filter(
      (layer) =>
        layer.objectId === objectId &&
        layer.type === 'uv' &&
        layer.role === 'merged-uv' &&
        layer.visible &&
        Boolean(layer.imageUrl),
    )
    .sort(compareLayers)[0];
}

export function findVisibleProjectedLayerIdsForBake(
  layers: readonly Layer[],
  objectId: string | undefined,
) {
  if (!objectId) return [];
  return layers
    .filter(
      (layer) =>
        layer.type === 'projected' &&
        layer.visible &&
        Boolean(layer.imageUrl && layer.camera) &&
        (!layer.objectId || layer.objectId === objectId),
    )
    .map((layer) => layer.id);
}

function findVisibleContentAwareUvLayerIdsForBake(
  layers: readonly Layer[],
  objectId: string | undefined,
) {
  if (!objectId) return [];
  return layers
    .filter(
      (layer) =>
        layer.visible &&
        Boolean(layer.imageUrl) &&
        isContentAwareUvUnderlay(layer) &&
        (!layer.objectId || layer.objectId === objectId),
    )
    .map((layer) => layer.id);
}

/**
 * Resolves whether Bake can reuse the current flattened UV layer or must
 * return to the editor and atomically merge the visible authored deltas.
 * Existing merged UV color is the merge base, never a consumable source.
 */
export function resolveBakeUvMergePlan(
  layers: readonly Layer[],
  objectId: string | undefined,
): BakeUvMergePlan {
  if (!objectId) {
    return {
      action: 'missing',
      sourceLayerIds: [],
      projectedLayerIds: [],
      uvUnderlayLayerIds: [],
      reason: 'missing-object',
    };
  }

  const mergedLayer = findMergedUvBakeLayer(layers, objectId);
  const visibleProjectedLayerIds = findVisibleProjectedLayerIdsForBake(layers, objectId);
  // Versionless merged UV layers may have been produced by the old
  // order-independent bake, which could discard a local-repaint replacement.
  // Replay only those durable hidden patches over the existing merged base;
  // once the editor publishes the current version this migration is inert.
  const legacyLocalRepaintLayerIds =
    mergedLayer && mergedLayer.uvMergeVersion !== UV_MERGE_COMPOSITION_VERSION
      ? layers
          .filter(
            (layer) =>
              !layer.visible &&
              Boolean(layer.imageUrl && layer.camera) &&
              (!layer.objectId || layer.objectId === objectId) &&
              isLocalRepaintProjectedLayer(layer),
          )
          .map((layer) => layer.id)
      : [];
  const projectedLayerIds = [
    ...visibleProjectedLayerIds,
    ...legacyLocalRepaintLayerIds.filter(
      (layerId) => !visibleProjectedLayerIds.includes(layerId),
    ),
  ];
  const uvUnderlayLayerIds = findVisibleContentAwareUvLayerIdsForBake(layers, objectId);
  const sourceLayerIds = [...projectedLayerIds, ...uvUnderlayLayerIds];

  if (mergedLayer && sourceLayerIds.length === 0) {
    return {
      action: 'reuse',
      objectId,
      mergedLayer,
      baseUvLayerId: mergedLayer.id,
      sourceLayerIds: [],
      projectedLayerIds: [],
      uvUnderlayLayerIds: [],
    };
  }

  // A content-aware layer is a sparse underlay. Without either an existing
  // merged base or a projected front layer it cannot form a complete BaseColor.
  if (projectedLayerIds.length > 0 || (mergedLayer && uvUnderlayLayerIds.length > 0)) {
    return {
      action: 'merge',
      objectId,
      mergedLayer,
      baseUvLayerId: mergedLayer?.id,
      sourceLayerIds,
      projectedLayerIds,
      uvUnderlayLayerIds,
      reason: mergedLayer ? 'visible-layer-delta' : 'missing-merged-uv',
    };
  }

  return {
    action: 'missing',
    objectId,
    sourceLayerIds: [],
    projectedLayerIds: [],
    uvUnderlayLayerIds: [],
    reason: 'no-visible-merged-or-projected-source',
  };
}

/**
 * Automatic workflow handoffs can mount the texture editor while its model is
 * still only a bounds/outline placeholder. UV baking must wait for the full
 * mesh; manual merges naturally happen after this restoration has completed.
 */
export function isBakeMergeModelReady(
  model: BakeMergeModel | undefined,
  objectId: string | undefined,
) {
  return Boolean(
    model &&
      objectId &&
      model.objectId === objectId &&
      (!model.restoreStage || model.restoreStage === 'full'),
  );
}

export function hasWorkflowBakeBaseColor(
  layers: readonly Layer[],
  objectId: string,
  handoff?: TextureBakeHandoff,
) {
  return Boolean(
    (handoff?.objectId === objectId && handoff.baseColor?.imageUrl) ||
      resolveBakeUvMergePlan(layers, objectId).action === 'reuse',
  );
}

/**
 * All workflow entrances use this guard before opening Bake. A handoff Base
 * Color is already final; otherwise the preferred object must have a durable
 * merged UV layer. When an older project has no selected-object metadata, any
 * merged UV layer is accepted and Bake will resolve its object normally.
 */
export function requiresTextureUvMergeBeforeBake(
  project: BakeEntryProject,
  handoff?: TextureBakeHandoff,
) {
  if (handoff?.baseColor?.imageUrl) return false;
  const preferredObjectIds = [
    handoff?.objectId,
    project.activeObjectId,
    project.bakeWorkspace?.selectedObjectId,
  ].filter((objectId): objectId is string => Boolean(objectId));
  if (preferredObjectIds.length > 0) {
    return !preferredObjectIds.some((objectId) =>
      resolveBakeUvMergePlan(project.layers, objectId).action === 'reuse',
    );
  }
  const mergedObjectIds = new Set(
    project.layers
      .filter(
        (layer) =>
          layer.objectId &&
          layer.type === 'uv' &&
          layer.role === 'merged-uv' &&
          layer.visible &&
          Boolean(layer.imageUrl),
      )
      .map((layer) => layer.objectId as string),
  );
  return ![...mergedObjectIds].some(
    (objectId) => resolveBakeUvMergePlan(project.layers, objectId).action === 'reuse',
  );
}

/**
 * Resolve the Base Color that belongs to the texture -> bake workflow.
 * A flattened UV layer is authoritative: projected layers and the imported
 * Base texture are editing inputs, not valid final bake material inputs.
 */
export function selectBakeBaseColor(
  project: BakeBaseColorProject | undefined,
  objectId: string | undefined,
  handoff?: TextureBakeHandoff,
): BakeBaseColorSource | undefined {
  if (!objectId) return undefined;
  if (handoff?.objectId === objectId && handoff.baseColor?.imageUrl) {
    return handoff.baseColor;
  }

  const mergedLayer = findMergedUvBakeLayer(project?.layers ?? [], objectId);
  if (mergedLayer) return { name: mergedLayer.name, imageUrl: mergedLayer.imageUrl };

  const bakedTexture = [...(project?.bakedTextures ?? [])]
    .filter((texture) => texture.objectId === objectId && Boolean(texture.imageUrl))
    .sort((left, right) => timestamp(right.createdAt) - timestamp(left.createdAt))[0];
  if (bakedTexture) return { name: 'Base Color', imageUrl: bakedTexture.imageUrl };

  const importedBaseColor = [...(project?.layers ?? [])]
    .filter(
      (layer) =>
        layer.objectId === objectId &&
        layer.type === 'uv' &&
        layer.role === 'base-color' &&
        Boolean(layer.imageUrl),
    )
    .sort(compareLayers)[0];
  return importedBaseColor
    ? { name: importedBaseColor.name, imageUrl: importedBaseColor.imageUrl }
    : undefined;
}
