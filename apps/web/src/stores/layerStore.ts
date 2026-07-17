import { create } from 'zustand';
import { v4 as uuid } from 'uuid';
import type { Capture } from '@/types/capture';
import type { Generation } from '@/types/generation';
import type { Layer, LayerAdjustments } from '@/types/layer';
import { useSceneStore } from './sceneStore';

type LayerStore = {
  layers: Layer[];
  activeProjectedLayerId?: string;
  setLayers: (layers: Layer[]) => void;
  addEmptyLayer: () => Layer;
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
  }) => Layer;
  addProjectedLayerFromGeneration: (
    generation: Generation,
    capture?: Capture,
    objectId?: string,
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
  moveLayer: (layerId: string, direction: 'up' | 'down') => void;
  reorderLayer: (layerId: string, targetLayerId: string, placement?: 'before' | 'after') => void;
  markLayerBaked: (layerId: string, bakedTextureId: string, bakedAt: string) => void;
  markLayersBaked: (layerIds: string[], bakedTextureId: string, bakedAt: string) => void;
  deleteLayer: (layerId: string) => void;
  deleteLayers: (layerIds: string[]) => void;
};

type ProjectedLayerVisibilityGuard = (nextLayers: Layer[]) => boolean;

let projectedLayerVisibilityGuard: ProjectedLayerVisibilityGuard | undefined;

export function setProjectedLayerVisibilityGuard(guard?: ProjectedLayerVisibilityGuard) {
  projectedLayerVisibilityGuard = guard;
  return () => {
    if (projectedLayerVisibilityGuard === guard) projectedLayerVisibilityGuard = undefined;
  };
}

function canApplyProjectedVisibility(nextLayers: Layer[]) {
  return projectedLayerVisibilityGuard?.(nextLayers) ?? true;
}

const legacyTransparentImage =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGJ5JrGJQAAAABJRU5ErkJggg==';

function createEmptyLayer(objectId = useSceneStore.getState().selectedObjectId): Layer {
  return {
    id: uuid(),
    name: 'New layer',
    type: 'uv',
    imageUrl: '',
    objectId,
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
  return [createEmptyLayer(selectedObjectId), ...layers];
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
  return {
    ...layer,
    name: normalizeProjectedLayerName(layer),
    imageUrl: layer.imageUrl === legacyTransparentImage ? '' : layer.imageUrl,
    adjustments: {
      hue: layer.adjustments?.hue ?? 0,
      saturation: layer.adjustments?.saturation ?? 0,
      lightness: layer.adjustments?.lightness ?? 0,
    },
    strength: layer.strength ?? 1,
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

export const useLayerStore = create<LayerStore>((set, get) => ({
  layers: [],
  activeProjectedLayerId: undefined,
  setLayers: (layers) =>
    set({
      layers: withOrder(layers.map(normalizeLayer)),
      activeProjectedLayerId: layers.find((layer) => layer.visible)?.id,
    }),
  addEmptyLayer: () => {
    const layer = createEmptyLayer();

    set((state) => ({
      layers: withOrder([layer, ...state.layers]),
      activeProjectedLayerId: layer.id,
    }));

    return layer;
  },
  addProjectedLayerFromGeneration: (generation, capture, objectId) => {
    const cameraViewLabel =
      typeof generation.metadata.cameraViewLabel === 'string'
        ? generation.metadata.cameraViewLabel.trim()
        : '';
    const layer: Layer = {
      id: uuid(),
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
      maskUrl: capture?.maskUrl,
      depthUrl: capture?.depthUrl,
      generationId: generation.id,
      captureId: capture?.id ?? generation.captureId,
      visible: true,
      opacity: 1,
      strength: 1,
      blendMode: 'normal',
      adjustments: { hue: 0, saturation: 0, lightness: 0 },
      order: get().layers.length,
      createdAt: new Date().toISOString(),
    };

    let createdLayer = layer;
    set((state) => {
      const candidateLayers = withOrder([layer, ...state.layers]);
      if (canApplyProjectedVisibility(candidateLayers)) {
        return { layers: candidateLayers, activeProjectedLayerId: layer.id };
      }
      const hiddenLayer = { ...layer, visible: false };
      createdLayer = hiddenLayer;
      return {
        layers: withOrder([hiddenLayer, ...state.layers]),
        activeProjectedLayerId: state.activeProjectedLayerId,
      };
    });

    return createdLayer;
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
    const sourceLayerIdSet = new Set(input.sourceLayerIds);
    let mergedLayer: Layer | undefined;
    set((state) => {
      const sourceIndexes = state.layers
        .map((layer, index) => (sourceLayerIdSet.has(layer.id) ? index : -1))
        .filter((index) => index >= 0);
      const insertIndex = sourceIndexes.length > 0 ? Math.min(...sourceIndexes) : 0;
      const createdAt = new Date().toISOString();
      const nextLayers = state.layers.map((layer) =>
        sourceLayerIdSet.has(layer.id) && layer.id !== input.targetUvLayerId
          ? { ...layer, visible: false, needsRebake: false }
          : layer,
      );

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
            visible: true,
            opacity: 1,
            strength: 1,
            blendMode: 'normal',
            isBaked: false,
            needsRebake: false,
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
          visible: true,
          opacity: 1,
          strength: 1,
          blendMode: 'normal',
          adjustments: { hue: 0, saturation: 0, lightness: 0 },
          order: insertIndex,
          isBaked: false,
          needsRebake: false,
          createdAt,
        };
        nextLayers.splice(Math.min(insertIndex, nextLayers.length), 0, mergedLayer);
      }

      return {
        layers: withOrder(nextLayers),
        activeProjectedLayerId: nextLayers.find((layer) => layer.visible)?.id,
      };
    });
    return mergedLayer!;
  },
  toggleLayer: (layerId) =>
    set((state) => {
      const target = state.layers.find((layer) => layer.id === layerId);
      const nextVisible = !target?.visible;
      const layers = state.layers.map((layer) =>
        layer.id === layerId ? { ...layer, visible: nextVisible } : layer,
      );
      if (nextVisible && !canApplyProjectedVisibility(layers)) return state;
      return {
        layers,
        activeProjectedLayerId:
          layers.find((layer) => layer.id === layerId && layer.visible)?.id ??
          layers.find((layer) => layer.visible)?.id,
      };
    }),
  setLayerVisibility: (layerIds, visible) =>
    set((state) => {
      const layerIdSet = new Set(layerIds);
      const layers = state.layers.map((layer) =>
        layerIdSet.has(layer.id) ? { ...layer, visible } : layer,
      );
      if (visible && !canApplyProjectedVisibility(layers)) return state;
      const activeStillVisible = layers.some(
        (layer) => layer.id === state.activeProjectedLayerId && layer.visible,
      );
      return {
        layers,
        activeProjectedLayerId: activeStillVisible
          ? state.activeProjectedLayerId
          : layers.find((layer) => layer.visible)?.id,
      };
    }),
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
      const layers = ensureSelectedObjectHasLayer(
        state.layers.filter((layer) => layer.id !== layerId),
      );
      return {
        layers: markVisibleStackNeedsRebake(withOrder(layers)),
        activeProjectedLayerId: layers.find((layer) => layer.visible)?.id,
      };
    }),
  deleteLayers: (layerIds) =>
    set((state) => {
      const layerIdSet = new Set(layerIds);
      const layers = ensureSelectedObjectHasLayer(
        state.layers.filter((layer) => !layerIdSet.has(layer.id)),
      );
      return {
        layers: markVisibleStackNeedsRebake(withOrder(layers)),
        activeProjectedLayerId: layers.find((layer) => layer.visible)?.id,
      };
    }),
}));
