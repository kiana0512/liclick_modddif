import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { Capture } from '@/types/capture';
import type { Generation } from '@/types/generation';

const generationStorageKeyV1 = 'liclick-generation-state-v1';
const generationStorageKeyV2 = 'liclick-generation-state-v2';

if (typeof window !== 'undefined') {
  window.localStorage.removeItem(generationStorageKeyV1);
  window.localStorage.removeItem(generationStorageKeyV2);
}

type GenerationStore = {
  generations: Generation[];
  currentGeneration?: Generation;
  lastCapture?: Capture;
  isGenerating: boolean;
  start: (generation?: Generation) => void;
  finish: () => void;
  addGeneration: (generation: Generation) => void;
  setLastCapture: (capture: Capture) => void;
  setGenerations: (generations: Generation[], projectId?: string) => void;
};

function isPendingGeneration(generation: Generation, projectId?: string) {
  const sameProject = !projectId || generation.metadata.projectId === projectId;
  return sameProject && (generation.status === 'queued' || generation.status === 'running') && !generation.resultUrl;
}

function isActiveGenerationRunning(generation?: Generation) {
  return Boolean(generation && (generation.status === 'queued' || generation.status === 'running') && !generation.resultUrl);
}

function upsertGeneration(generations: Generation[], generation: Generation) {
  const exists = generations.some((item) => item.id === generation.id);
  return exists ? generations.map((item) => (item.id === generation.id ? generation : item)) : [generation, ...generations];
}

export const useGenerationStore = create<GenerationStore>()(
  persist(
    (set) => ({
      generations: [],
      currentGeneration: undefined,
      lastCapture: undefined,
      isGenerating: false,
      start: (generation) =>
        set((state) => {
          const generations = generation ? upsertGeneration(state.generations, generation) : state.generations;
          return {
            generations,
            currentGeneration: generation ?? state.currentGeneration,
            isGenerating: true,
          };
        }),
      finish: () => set({ isGenerating: false }),
      addGeneration: (generation) =>
        set((state) => {
          const generations = upsertGeneration(state.generations, generation);
          return {
            generations,
            currentGeneration: generation,
            isGenerating: isActiveGenerationRunning(generation),
          };
        }),
      setLastCapture: (lastCapture) => set({ lastCapture }),
      setGenerations: (generations, projectId) =>
        set((state) => {
          const pending = state.generations.filter((generation) =>
            isPendingGeneration(generation, projectId) && !generations.some((item) => item.id === generation.id),
          );
          const nextGenerations = [...pending, ...generations];
          return {
            generations: nextGenerations,
            currentGeneration: nextGenerations[0],
            isGenerating: state.isGenerating || isActiveGenerationRunning(nextGenerations[0]),
          };
        }),
    }),
    {
      name: generationStorageKeyV2,
      partialize: (state) => ({
        generations: state.generations.filter((generation) => generation.status === 'queued' || generation.status === 'running'),
        currentGeneration:
          state.currentGeneration && (state.currentGeneration.status === 'queued' || state.currentGeneration.status === 'running')
            ? state.currentGeneration
            : undefined,
        lastCapture: undefined,
        isGenerating: false,
      }),
    },
  ),
);
