import { create } from 'zustand';
import { v4 as uuid } from 'uuid';
import { mockLayers } from '@/mock/mockLayers';
import type { Generation } from '@/types/generation';
import type { Layer } from '@/types/layer';

type LayerStore = {
  layers: Layer[];
  setLayers: (layers: Layer[]) => void;
  addProjectedLayerFromGeneration: (generation: Generation) => void;
  toggleLayer: (layerId: string) => void;
  setOpacity: (layerId: string, opacity: number) => void;
  deleteLayer: (layerId: string) => void;
};

export const useLayerStore = create<LayerStore>((set) => ({
  layers: mockLayers,
  setLayers: (layers) => set({ layers }),
  addProjectedLayerFromGeneration: (generation) =>
    set((state) => ({
      layers: [
        {
          id: uuid(),
          name: generation.prompt ? `Projected: ${generation.prompt.slice(0, 24)}` : 'Projected Layer',
          type: 'projected',
          imageUrl: generation.resultUrl ?? '',
          visible: true,
          opacity: 1,
          blendMode: 'normal',
          order: state.layers.length,
          createdAt: new Date().toISOString(),
        },
        ...state.layers,
      ],
    })),
  toggleLayer: (layerId) =>
    set((state) => ({
      layers: state.layers.map((layer) =>
        layer.id === layerId ? { ...layer, visible: !layer.visible } : layer,
      ),
    })),
  setOpacity: (layerId, opacity) =>
    set((state) => ({
      layers: state.layers.map((layer) => (layer.id === layerId ? { ...layer, opacity } : layer)),
    })),
  deleteLayer: (layerId) =>
    set((state) => ({ layers: state.layers.filter((layer) => layer.id !== layerId) })),
}));
