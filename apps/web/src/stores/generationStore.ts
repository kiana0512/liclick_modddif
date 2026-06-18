import { create } from 'zustand';
import type { Capture } from '@/types/capture';
import type { Generation } from '@/types/generation';

type GenerationStore = {
  generations: Generation[];
  currentGeneration?: Generation;
  lastCapture?: Capture;
  isGenerating: boolean;
  start: () => void;
  finish: () => void;
  addGeneration: (generation: Generation) => void;
  setLastCapture: (capture: Capture) => void;
  setGenerations: (generations: Generation[]) => void;
};

export const useGenerationStore = create<GenerationStore>((set) => ({
  generations: [],
  currentGeneration: undefined,
  lastCapture: undefined,
  isGenerating: false,
  start: () => set({ isGenerating: true }),
  finish: () => set({ isGenerating: false }),
  addGeneration: (generation) =>
    set((state) => ({
      generations: [generation, ...state.generations],
      currentGeneration: generation,
      isGenerating: false,
    })),
  setLastCapture: (lastCapture) => set({ lastCapture }),
  setGenerations: (generations) => set({ generations, currentGeneration: generations[0] }),
}));
