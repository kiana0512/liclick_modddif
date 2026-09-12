import { usesCaptureMaskTextureProjection } from '@/engine/generation/textureProjectionPolicy';
import { create } from 'zustand';
import { v4 as uuid } from 'uuid';
import type { Capture } from '@/types/capture';
import type { Generation } from '@/types/generation';
import type { Layer, LayerAdjustments } from '@/types/layer';
import { markPerformanceEvent } from '@/engine/performance/performanceTimeline';
import { isContentAwareEraserUnderlay } from '@/engine/paint/eraserTargetPolicy';
import { prepareUvMergeConsumption } from '@/engine/layers/uvMergeConsumption';
import { expandAuthoredLayerVisibilityIds } from '@/engine/layers/layerVisibility';
import { isViewportInteractionBusy } from '@/engine/viewport/viewportInteractionState';
import { SINGLE_VIEW_MINIMUM_PROJECTION_FACING } from '@/engine/projection/projectionTypes';
import { useSceneStore } from './sceneStore';

type LayerStore = {
  layers: Layer[];
  activeProjectedLayerId?: string;
  projectedPreviewBatchDepth: number;
  projectedPreviewLayers?: Layer[];
  setLayers: (layers: Layer[]) => void;
  beginProjectedPreviewBatch: () => void;
  endProjectedPreviewBatch: () => void;
  addEmptyLayer: (input?: {
    name?: string;
    objectId?: string;
    role?: Layer['role'];
    generationId?: string;
  }) => Layer;
  addUvLayer: (input: {
    name?: string;
    imageUrl: string;
    objectId?: string;
    bakedTextureId?: string;
    role?: Layer['role'];
  }) => Layer;
  mergeLayersIntoUvLayer: (input: {
    sourceLayerIds: string[];
    imageUrl: string;
    objectId?: string;
    targetUvLayerId?: string;
    name?: string;
    renderedColor?: boolean;
    renderedColorMaskUrl?: string;
    role?: Layer['role'];
    uvMergeVersion?: number;
  }) => Layer;
  addProjectedLayerFromGeneration: (
    generation: Generation,
    capture?: Capture,
    objectId?: string,
    layerId?: string,
  ) => Layer;
  toggleLayer: (layerId: string) => void;
  setLayerVisibility: (layerIds: string[], visible: boolean) => void;
  setOpacity: (layerId: string, opacity: number) => void;
  setStrength: (layerId: string, strength: number) => void;
  setBlendMode: (layerId: string, blendMode: Layer['blendMode']) => void;
  setLayerAdjustment: (layerId: string, key: keyof LayerAdjustments, value: number) => void;
  resetLayerAdjustments: (layerId: string) => void;
  setActiveLayer: (layerId: string) => void;
  renameLayer: (layerId: string, name: string) => void;
  updateLayerImage: (layerId: string, imageUrl: string) => void;
  updateLayer: (layerId: string, patch: Partial<Layer>) => void;
  duplicateLayer: (layerId: string) => void;
  duplicateContentAwareLayerAsEditableUv: (layerId: string) => Layer | undefined;
  moveLayer: (layerId: string, direction: 'up' | 'down') => void;
  reorderLayer: (layerId: string, targetLayerId: string, placement?: 'before' | 'after') => void;
  markLayerBaked: (layerId: string, bakedTextureId: string, bakedAt: string) => void;
  markLayersBaked: (layerIds: string[], bakedTextureId: string, bakedAt: string) => void;
  deleteLayer: (layerId: string) => void;
  deleteLayers: (layerIds: string[]) => void;
};

const legacyTransparentImage =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGJ5JrGJQAAAABJRU5ErkJggg==';

function createEmptyLayer(
  input: {
    name?: string;
    objectId?: string;
    role?: Layer['role'];
    generationId?: string;
  } = {},
): Layer {
  return {
    id: uuid(),
    name: input.name ?? 'New layer',
    type: 'uv',
    role: input.role,
    imageUrl: '',
    objectId: input.objectId ?? useSceneStore.getState().selectedObjectId,
    generationId: input.generationId,
    visible: true,
    opacity: 1,
    strength: 1,
    blendMode: 'normal',
    adjustments: { hue: 0, saturation: 0, lightness: 0 },
    order: 0,
    createdAt: new Date().toISOString(),
  };
}

function ensureSelectedObjectHasLayer(layers: Layer[]) {
  const selectedObjectId = useSceneStore.getState().selectedObjectId;
  const hasLayerForSelectedObject = layers.some(
    (layer) => !layer.objectId || layer.objectId === selectedObjectId,
  );
  if (hasLayerForSelectedObject) return layers;
  return [createEmptyLayer({ objectId: selectedObjectId }), ...layers];
}

function withOrder(layers: Layer[]) {
  return layers.map((layer, index) => ({ ...layer, order: index }));
}

function getProjectedCameraViewLabel(layer: Layer) {
  const camera = layer.camera;
  if (!camera) return undefined;
  const x = camera.position[0] - camera.target[0];
  const y = camera.position[1] - camera.target[1];
  const z = camera.position[2] - camera.target[2];
  const absoluteX = Math.abs(x);
  const absoluteY = Math.abs(y);
  const absoluteZ = Math.abs(z);
  if (absoluteY > Math.max(absoluteX, absoluteZ) * 1.15) return y >= 0 ? '顶' : '底';
  if (Math.min(absoluteX, absoluteZ) > Math.max(absoluteX, absoluteZ) * 0.55) {
    return `${x < 0 ? '左' : '右'}${z >= 0 ? '前' : '后'}`;
  }
  if (absoluteX > absoluteZ) return x < 0 ? '左' : '右';
  return z >= 0 ? '前' : '后';
}

function normalizeProjectedLayerName(layer: Layer) {
  if (layer.type !== 'projected' || !/^Projected(?::| Layer)/.test(layer.name)) return layer.name;
  const label = getProjectedCameraViewLabel(layer);
  return label ? `投射贴图 · ${label}` : layer.name;
}

function normalizeLayer(layer: Layer) {
  const legacyLayer = layer as Layer & { projectionCompositeMode?: string };
  const { projectionCompositeMode: legacyProjectionCompositeMode, ...layerWithoutLegacyMode } =
    legacyLayer;
  const imageUrl = typeof layer.imageUrl === 'string' ? layer.imageUrl : '';
  const name = normalizeProjectedLayerName(layer);
  const legacySingleViewPriority =
    layer.type === 'projected' &&
    Boolean(layer.generationId) &&
    name === '投射贴图 · 当前视角' &&
    !layer.replacementTargetLayerId;
  const canonicalSingleViewProjection =
    layer.type === 'projected' &&
    Boolean(layer.generationId) &&
    layer.projectionCoverageMode === 'capture-mask' &&
    !layer.replacementTargetLayerId;
  const singleViewGeneratedProjection =
    layer.type === 'projected' &&
    Boolean(layer.generationId) &&
    (canonicalSingleViewProjection ||
      legacyProjectionCompositeMode === 'single-view-priority-v1' ||
      legacySingleViewPriority) &&
    !layer.replacementTargetLayerId;
  return {
    ...layerWithoutLegacyMode,
    name,
    imageUrl: imageUrl === legacyTransparentImage ? '' : imageUrl,
    adjustments: {
      hue: layer.adjustments?.hue ?? 0,
      saturation: layer.adjustments?.saturation ?? 0,
      lightness: layer.adjustments?.lightness ?? 0,
    },
    strength: layer.strength ?? 1,
    // ALG-PROJ-005 v3 retires the old source-over priority branch. Saved
    // single-view rows are upgraded lazily into the same quality candidate
    // pool as multiview rows while retaining their authored capture footprint.
    projectionCoverageMode: singleViewGeneratedProjection
      ? 'capture-mask'
      : layer.projectionCoverageMode,
    ignoreSourceAlpha: singleViewGeneratedProjection ? true : layer.ignoreSourceAlpha,
    minimumProjectionFacing: singleViewGeneratedProjection
      ? SINGLE_VIEW_MINIMUM_PROJECTION_FACING
      : layer.minimumProjectionFacing,
    projectionVisibilityPolicy: singleViewGeneratedProjection
      ? 'standard'
      : layer.projectionVisibilityPolicy,
  };
}

function getObjectMatrixWorld(generation: Generation) {
  const value = generation.metadata.objectMatrixWorld;
  if (!Array.isArray(value) || value.length !== 16) return undefined;
  return value.every((item) => typeof item === 'number') ? value : undefined;
}

function isBakeParticipant(layer: Layer) {
  return layer.type === 'projected' && Boolean(layer.imageUrl && layer.camera);
}

function markVisibleStackNeedsRebake(layers: Layer[]) {
  return layers.map((layer) =>
    isBakeParticipant(layer) && layer.isBaked ? { ...layer, needsRebake: true } : layer,
  );
}

function isLocalRepaintRuntimeLayer(layer: Layer) {
  return Boolean(layer.replacementTargetLayerId) && !layer.isBaked;
}

let projectedPreviewReleaseRevision = 0;

export const useLayerStore = create<LayerStore>((set, get) => ({
  layers: [],
  activeProjectedLayerId: undefined,
  projectedPreviewBatchDepth: 0,
  projectedPreviewLayers: undefined,
  setLayers: (layers) =>
    set({
      layers: withOrder(layers.map(normalizeLayer)),
      activeProjectedLayerId: layers.find((layer) => layer.visible)?.id,
    }),
  beginProjectedPreviewBatch: () =>
    set((state) => ({
      projectedPreviewBatchDepth: state.projectedPreviewBatchDepth + 1,
      projectedPreviewLayers:
        state.projectedPreviewBatchDepth === 0 ? state.layers : state.projectedPreviewLayers,
    })),
  endProjectedPreviewBatch: () => {
    const revision = ++projectedPreviewReleaseRevision;
    const nextDepth = Math.max(0, get().projectedPreviewBatchDepth - 1);
    set({ projectedPreviewBatchDepth: nextDepth });
    if (nextDepth > 0) return;

    const releaseWhenIdle = () => {
      if (revision !== projectedPreviewReleaseRevision) return;
      const state = get();
      if (state.projectedPreviewBatchDepth > 0) return;
      if (isViewportInteractionBusy()) {
        window.setTimeout(releaseWhenIdle, 24);
        return;
      }
      if (state.projectedPreviewLayers) set({ projectedPreviewLayers: undefined });
    };
    releaseWhenIdle();
  },
  addEmptyLayer: (input) => {
    const layer = createEmptyLayer(input);

    set((state) => ({
      layers: withOrder([layer, ...state.layers]),
      activeProjectedLayerId: layer.id,
    }));

    return layer;
  },
  addProjectedLayerFromGeneration: (generation, capture, objectId, layerId) => {
    const captureMaskTexture = usesCaptureMaskTextureProjection(generation);
    const captureMaskUrl = captureMaskTexture ? capture?.maskUrl : undefined;
    const cameraViewLabel =
      typeof generation.metadata.cameraViewLabel === 'string'
        ? generation.metadata.cameraViewLabel.trim()
        : '';
    const layer: Layer = {
      id: layerId ?? uuid(),
      name: cameraViewLabel
        ? `投射贴图 · ${cameraViewLabel}`
        : generation.prompt
          ? `Projected: ${generation.prompt.slice(0, 24)}`
          : 'Projected Layer',
      type: 'projected',
      imageUrl: generation.resultUrl ?? '',
      objectId: objectId ?? capture?.objectId,
      objectMatrixWorld: getObjectMatrixWorld(generation),
      camera: capture?.camera,
      // Texture providers may return an opaque RGB PNG. Persist the exact
      // capture silhouette instead of asking provider-specific alpha to define
      // the projection footprint.
      maskUrl: captureMaskUrl,
      maskSpace: captureMaskUrl ? 'projection' : undefined,
      depthUrl: capture?.depthUrl,
      depthEncoding: capture?.depthEncoding,
      generationId: generation.id,
      projectionCoverageMode: captureMaskTexture
        ? 'capture-mask'
        : generation.metadata.alphaMode === 'geometry-mask-separated'
          ? 'source-alpha-depth'
          : undefined,
      // Single and multiview results share geometry coverage and quality blending.
      ignoreSourceAlpha: captureMaskTexture ? true : undefined,
      minimumProjectionFacing: captureMaskTexture
        ? SINGLE_VIEW_MINIMUM_PROJECTION_FACING
        : undefined,
      projectionVisibilityPolicy: captureMaskTexture ? 'standard' : undefined,
      captureId: capture?.id ?? generation.captureId,
      visible: true,
      opacity: 1,
      strength: 1,
      blendMode: 'normal',
      adjustments: { hue: 0, saturation: 0, lightness: 0 },
      order: get().layers.length,
      createdAt: new Date().toISOString(),
    };

    set((state) => ({
      layers: withOrder([layer, ...state.layers]),
      activeProjectedLayerId: layer.id,
    }));

    return layer;
  },
  addUvLayer: (input) => {
    const layer: Layer = {
      id: uuid(),
      name: input.name ?? 'UV Repair Layer',
      type: 'uv',
      role: input.role,
      imageUrl: input.imageUrl,
      objectId: input.objectId ?? useSceneStore.getState().selectedObjectId,
      visible: true,
      opacity: 1,
      strength: 1,
      blendMode: 'normal',
      adjustments: { hue: 0, saturation: 0, lightness: 0 },
      order: 0,
      bakedTextureId: input.bakedTextureId,
      bakedAt: input.bakedTextureId ? new Date().toISOString() : undefined,
      isBaked: Boolean(input.bakedTextureId),
      needsRebake: false,
      createdAt: new Date().toISOString(),
    };
    set((state) => ({
      layers: withOrder([layer, ...state.layers]),
      activeProjectedLayerId: layer.id,
    }));
    return layer;
  },
  mergeLayersIntoUvLayer: (input) => {
    let mergedLayer: Layer | undefined;
    set((state) => {
      const { layers: nextLayers, insertIndex } = prepareUvMergeConsumption(state.layers, input);
      const createdAt = new Date().toISOString();

      if (input.targetUvLayerId) {
        nextLayers.forEach((layer, index) => {
          if (layer.id !== input.targetUvLayerId) return;
          mergedLayer = {
            ...layer,
            type: 'uv',
            name: layer.name || input.name || 'Merged UV Layer',
            imageUrl: input.imageUrl,
            objectId: input.objectId ?? layer.objectId,
            renderedColor: input.renderedColor,
            renderedColorMaskUrl: input.renderedColorMaskUrl,
            role: input.role ?? layer.role,
            uvMergeVersion: input.uvMergeVersion,
            visible: true,
            opacity: 1,
            strength: 1,
            blendMode: 'normal',
            isBaked: false,
            needsRebake: false,
            contentRevision: (layer.contentRevision ?? 0) + 1,
          };
          nextLayers[index] = mergedLayer;
        });
      }

      if (!mergedLayer) {
        mergedLayer = {
          id: uuid(),
          name: input.name ?? 'Merged UV Layer',
          type: 'uv',
          imageUrl: input.imageUrl,
          objectId: input.objectId ?? useSceneStore.getState().selectedObjectId,
          renderedColor: input.renderedColor,
          renderedColorMaskUrl: input.renderedColorMaskUrl,
          role: input.role,
          uvMergeVersion: input.uvMergeVersion,
          visible: true,
          opacity: 1,
          strength: 1,
          blendMode: 'normal',
          adjustments: { hue: 0, saturation: 0, lightness: 0 },
          order: insertIndex,
          isBaked: false,
          needsRebake: false,
          contentRevision: 1,
          createdAt,
        };
        nextLayers.splice(Math.min(insertIndex, nextLayers.length), 0, mergedLayer);
      }

      return {
        layers: withOrder(nextLayers),
        activeProjectedLayerId: mergedLayer?.id,
      };
    });
    return mergedLayer!;
  },
  toggleLayer: (layerId) => {
    const target = get().layers.find((layer) => layer.id === layerId);
    if (!target) return;
    const affectedIds = expandAuthoredLayerVisibilityIds(get().layers, [layerId]);
    const affectedIdSet = new Set(affectedIds);
    const nextVisible = !target.visible;
    markPerformanceEvent('layers', 'toggle-layer', {
      layerId,
      layerType: target?.type,
      affectedLayerIds: affectedIds,
      nextVisible,
    });
    if (
      !nextVisible &&
      get().activeProjectedLayerId &&
      affectedIdSet.has(get().activeProjectedLayerId!)
    ) {
      useSceneStore.getState().setPaintTool('none');
    }
    set((state) => {
      const layers = state.layers.map((layer) =>
        affectedIdSet.has(layer.id) && layer.visible !== nextVisible
          ? { ...layer, visible: nextVisible }
          : layer,
      );
      const activeLayer = layers.find(
        (layer) => layer.id === state.activeProjectedLayerId && layer.visible,
      );
      return {
        layers,
        activeProjectedLayerId: activeLayer?.id ?? layers.find((layer) => layer.visible)?.id,
      };
    });
  },
  setLayerVisibility: (layerIds, visible) => {
    const currentLayers = get().layers;
    const layerIdSet = new Set(layerIds);
    if (!currentLayers.some((layer) => layerIdSet.has(layer.id) && layer.visible !== visible)) {
      return;
    }
    markPerformanceEvent('layers', 'set-layer-visibility', {
      layerIds,
      layerTypes: layerIds.map(
        (layerId) => currentLayers.find((layer) => layer.id === layerId)?.type ?? 'missing',
      ),
      visible,
    });
    if (
      !visible &&
      get().activeProjectedLayerId &&
      layerIds.includes(get().activeProjectedLayerId!)
    ) {
      useSceneStore.getState().setPaintTool('none');
    }
    set((state) => {
      const layers = state.layers.map((layer) =>
        layerIdSet.has(layer.id) && layer.visible !== visible ? { ...layer, visible } : layer,
      );
      const activeLayer = layers.find(
        (layer) => layer.id === state.activeProjectedLayerId && layer.visible,
      );
      return {
        layers,
        activeProjectedLayerId: activeLayer?.id ?? layers.find((layer) => layer.visible)?.id,
      };
    });
  },
  setOpacity: (layerId, opacity) =>
    set((state) => ({
      layers: state.layers.map((layer) =>
        layer.id === layerId
          ? { ...layer, opacity, needsRebake: layer.isBaked ? true : layer.needsRebake }
          : layer,
      ),
    })),
  setStrength: (layerId, strength) =>
    set((state) => ({
      layers: state.layers.map((layer) =>
        layer.id === layerId
          ? { ...layer, strength, needsRebake: layer.isBaked ? true : layer.needsRebake }
          : layer,
      ),
    })),
  setBlendMode: (layerId, blendMode) =>
    set((state) => ({
      layers: state.layers.map((layer) =>
        layer.id === layerId
          ? { ...layer, blendMode, needsRebake: layer.isBaked ? true : layer.needsRebake }
          : layer,
      ),
    })),
  setLayerAdjustment: (layerId, key, value) =>
    set((state) => ({
      layers: state.layers.map((layer) =>
        layer.id === layerId
          ? {
              ...layer,
              adjustments: {
                hue: layer.adjustments?.hue ?? 0,
                saturation: layer.adjustments?.saturation ?? 0,
                lightness: layer.adjustments?.lightness ?? 0,
                [key]: value,
              },
              needsRebake: layer.isBaked ? true : layer.needsRebake,
            }
          : layer,
      ),
    })),
  resetLayerAdjustments: (layerId) =>
    set((state) => ({
      layers: state.layers.map((layer) =>
        layer.id === layerId
          ? {
              ...layer,
              adjustments: { hue: 0, saturation: 0, lightness: 0 },
              needsRebake: layer.isBaked ? true : layer.needsRebake,
            }
          : layer,
      ),
    })),
  setActiveLayer: (layerId) =>
    set((state) => ({
      activeProjectedLayerId:
        state.layers.find((layer) => layer.id === layerId)?.id ?? state.activeProjectedLayerId,
    })),
  renameLayer: (layerId, name) =>
    set((state) => ({
      layers: state.layers.map((layer) => (layer.id === layerId ? { ...layer, name } : layer)),
    })),
  updateLayerImage: (layerId, imageUrl) =>
    set((state) => ({
      layers: state.layers.map((layer) =>
        layer.id === layerId
          ? { ...layer, imageUrl, needsRebake: layer.isBaked ? true : layer.needsRebake }
          : layer,
      ),
    })),
  updateLayer: (layerId, patch) =>
    set((state) => ({
      layers: state.layers.map((layer) => (layer.id === layerId ? { ...layer, ...patch } : layer)),
    })),
  duplicateLayer: (layerId) =>
    set((state) => {
      const index = state.layers.findIndex((layer) => layer.id === layerId);
      if (index < 0) return state;
      const source = state.layers[index];
      const layer: Layer = {
        ...source,
        id: uuid(),
        name: `${source.name} Copy`,
        isBaked: false,
        needsRebake: false,
        bakedAt: undefined,
        bakedTextureId: undefined,
        createdAt: new Date().toISOString(),
      };
      const layers = [...state.layers];
      layers.splice(index + 1, 0, layer);
      return { layers: withOrder(layers), activeProjectedLayerId: layer.id };
    }),
  duplicateContentAwareLayerAsEditableUv: (layerId) => {
    const source = get().layers.find((layer) => layer.id === layerId);
    if (!source || !source.imageUrl || !isContentAwareEraserUnderlay(source)) return undefined;
    const layer: Layer = {
      ...source,
      id: uuid(),
      name: `${source.name} · 可编辑副本`,
      type: 'uv',
      role: undefined,
      generationId: undefined,
      bakedTextureId: undefined,
      bakedAt: undefined,
      isBaked: false,
      needsRebake: false,
      contentRevision: 1,
      createdAt: new Date().toISOString(),
    };
    set((state) => {
      const sourceIndex = state.layers.findIndex((item) => item.id === layerId);
      if (sourceIndex < 0) return state;
      const layers = [...state.layers];
      layers.splice(sourceIndex, 0, layer);
      return { layers: withOrder(layers), activeProjectedLayerId: layer.id };
    });
    return layer;
  },
  moveLayer: (layerId, direction) =>
    set((state) => {
      const index = state.layers.findIndex((layer) => layer.id === layerId);
      const targetIndex = direction === 'up' ? index - 1 : index + 1;
      if (index < 0 || targetIndex < 0 || targetIndex >= state.layers.length) return state;
      const layers = [...state.layers];
      const [layer] = layers.splice(index, 1);
      layers.splice(targetIndex, 0, layer);
      return { layers: markVisibleStackNeedsRebake(withOrder(layers)) };
    }),
  reorderLayer: (layerId, targetLayerId, placement = 'before') =>
    set((state) => {
      if (layerId === targetLayerId) return state;
      const sourceIndex = state.layers.findIndex((layer) => layer.id === layerId);
      const targetIndex = state.layers.findIndex((layer) => layer.id === targetLayerId);
      if (sourceIndex < 0 || targetIndex < 0) return state;
      const layers = [...state.layers];
      const [layer] = layers.splice(sourceIndex, 1);
      const nextTargetIndex = layers.findIndex((item) => item.id === targetLayerId);
      layers.splice(placement === 'after' ? nextTargetIndex + 1 : nextTargetIndex, 0, layer);
      return { layers: markVisibleStackNeedsRebake(withOrder(layers)) };
    }),
  markLayerBaked: (layerId, bakedTextureId, bakedAt) =>
    set((state) => ({
      layers: state.layers.map((layer) =>
        layer.id === layerId
          ? { ...layer, bakedTextureId, bakedAt, isBaked: true, needsRebake: false }
          : layer,
      ),
    })),
  markLayersBaked: (layerIds, bakedTextureId, bakedAt) =>
    set((state) => {
      const layerIdSet = new Set(layerIds);
      return {
        layers: state.layers.map((layer) =>
          layerIdSet.has(layer.id)
            ? { ...layer, bakedTextureId, bakedAt, isBaked: true, needsRebake: false }
            : layer,
        ),
      };
    }),
  deleteLayer: (layerId) =>
    set((state) => {
      const removedLayer = state.layers.find((layer) => layer.id === layerId);
      const layers = ensureSelectedObjectHasLayer(
        state.layers.filter((layer) => layer.id !== layerId),
      );
      const orderedLayers = withOrder(layers);
      return {
        layers:
          removedLayer && isLocalRepaintRuntimeLayer(removedLayer)
            ? orderedLayers
            : markVisibleStackNeedsRebake(orderedLayers),
        activeProjectedLayerId: layers.find((layer) => layer.visible)?.id,
      };
    }),
  deleteLayers: (layerIds) =>
    set((state) => {
      const layerIdSet = new Set(layerIds);
      const removedLayers = state.layers.filter((layer) => layerIdSet.has(layer.id));
      const layers = ensureSelectedObjectHasLayer(
        state.layers.filter((layer) => !layerIdSet.has(layer.id)),
      );
      const orderedLayers = withOrder(layers);
      const removesOnlyLocalRepaintLayers =
        removedLayers.length > 0 && removedLayers.every(isLocalRepaintRuntimeLayer);
      return {
        layers: removesOnlyLocalRepaintLayers
          ? orderedLayers
          : markVisibleStackNeedsRebake(orderedLayers),
        activeProjectedLayerId: layers.find((layer) => layer.visible)?.id,
      };
    }),
}));
