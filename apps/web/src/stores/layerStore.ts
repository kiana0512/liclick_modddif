import { create } from 'zustand';
import { v4 as uuid } from 'uuid';
import type { Capture } from '@/types/capture';
import type { Generation } from '@/types/generation';
import type { Layer, LayerAdjustments } from '@/types/layer';

type LayerStore = {
  layers: Layer[];
  activeProjectedLayerId?: string;
  setLayers: (layers: Layer[]) => void;
  addProjectedLayerFromGeneration: (generation: Generation, capture?: Capture, objectId?: string) => Layer;
  toggleLayer: (layerId: string) => void;
  setOpacity: (layerId: string, opacity: number) => void;
  setLayerAdjustment: (layerId: string, key: keyof LayerAdjustments, value: number) => void;
  setActiveLayer: (layerId: string) => void;
  markLayerBaked: (layerId: string, bakedTextureId: string, bakedAt: string) => void;
  deleteLayer: (layerId: string) => void;
};

export const useLayerStore = create<LayerStore>((set, get) => ({
  layers: [],
  activeProjectedLayerId: undefined,
  setLayers: (layers) =>
    set({
      layers: layers.map((layer) => ({
        ...layer,
        adjustments: {
          hue: layer.adjustments?.hue ?? 0,
          saturation: layer.adjustments?.saturation ?? 0,
          lightness: layer.adjustments?.lightness ?? 0,
        },
      })),
      activeProjectedLayerId: layers.find((layer) => layer.type === 'projected' && layer.visible)?.id,
    }),
  addProjectedLayerFromGeneration: (generation, capture, objectId) => {
    const layer: Layer = {
      id: uuid(),
      name: generation.prompt ? `Projected: ${generation.prompt.slice(0, 24)}` : 'Projected Layer',
      type: 'projected',
      imageUrl: generation.resultUrl ?? '',
      objectId: objectId ?? capture?.objectId,
      camera: capture?.camera,
      maskUrl: capture?.maskUrl,
      depthUrl: capture?.depthUrl,
      generationId: generation.id,
      captureId: capture?.id ?? generation.captureId,
      visible: true,
      opacity: 1,
      blendMode: 'normal',
      adjustments: { hue: 0, saturation: 0, lightness: 0 },
      order: get().layers.length,
      createdAt: new Date().toISOString(),
    };

    set((state) => ({
      layers: [layer, ...state.layers],
      activeProjectedLayerId: layer.id,
    }));

    return layer;
  },
  toggleLayer: (layerId) =>
    set((state) => {
      const layers = state.layers.map((layer) =>
        layer.id === layerId ? { ...layer, visible: !layer.visible } : layer,
      );
      return {
        layers,
        activeProjectedLayerId:
          layers.find((layer) => layer.id === layerId && layer.visible && layer.type === 'projected')?.id ??
          layers.find((layer) => layer.type === 'projected' && layer.visible)?.id,
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
  setActiveLayer: (layerId) =>
    set((state) => ({
      activeProjectedLayerId:
        state.layers.find((layer) => layer.id === layerId && layer.type === 'projected')?.id ??
        state.activeProjectedLayerId,
    })),
  markLayerBaked: (layerId, bakedTextureId, bakedAt) =>
    set((state) => ({
      layers: state.layers.map((layer) =>
        layer.id === layerId
          ? { ...layer, bakedTextureId, bakedAt, isBaked: true, needsRebake: false }
          : layer,
      ),
    })),
  deleteLayer: (layerId) =>
    set((state) => {
      const layers = state.layers.filter((layer) => layer.id !== layerId);
      return {
        layers,
        activeProjectedLayerId: layers.find((layer) => layer.type === 'projected' && layer.visible)?.id,
      };
    }),
}));
