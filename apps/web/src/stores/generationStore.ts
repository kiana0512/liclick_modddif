import { create } from 'zustand';
import type { Generation } from '@/types/generation';

type GenerationStore = {
  generations: Generation[];
  currentGeneration?: Generation;
  isGenerating: boolean;
  start: () => void;
  addGeneration: (generation: Generation) => void;
};

export const useGenerationStore = create<GenerationStore>((set) => ({
  generations: [],
  currentGeneration: undefined,
  isGenerating: false,
  start: () => set({ isGenerating: true }),
  addGeneration: (generation) =>
    set((state) => ({
      generations: [generation, ...state.generations],
      currentGeneration: generation,
      isGenerating: false,
    })),
}));
