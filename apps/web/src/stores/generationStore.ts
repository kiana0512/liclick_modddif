import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { Capture } from '@/types/capture';
import type { Generation } from '@/types/generation';
import {
  generationsReferToSameJob,
  upsertGenerationByIdentity,
} from '@/utils/generationIdentity';

const generationStorageKeyV1 = 'liclick-generation-state-v1';
const generationStorageKeyV2 = 'liclick-generation-state-v2';

if (typeof window !== 'undefined') {
  window.localStorage.removeItem(generationStorageKeyV1);
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
  deleteObjectData: (objectId: string) => void;
};

function isPendingGeneration(generation: Generation, projectId?: string) {
  const sameProject = !projectId || generation.metadata.projectId === projectId;
  return (
    sameProject &&
    (generation.status === 'queued' || generation.status === 'running') &&
    !generation.resultUrl
  );
}

function isActiveGenerationRunning(generation?: Generation) {
  return Boolean(
    generation &&
    (generation.status === 'queued' || generation.status === 'running') &&
    !generation.resultUrl,
  );
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
          const generations = generation
            ? upsertGenerationByIdentity(state.generations, generation)
            : state.generations;
          return {
            generations,
            currentGeneration: generation ?? state.currentGeneration,
            isGenerating: true,
          };
        }),
      finish: () =>
        set((state) => ({
          isGenerating: state.generations.some((generation) =>
            isActiveGenerationRunning(generation),
          ),
        })),
      addGeneration: (generation) =>
        set((state) => {
          const generations = upsertGenerationByIdentity(state.generations, generation);
          return {
            generations,
            currentGeneration: generation,
            isGenerating: generations.some((item) => isActiveGenerationRunning(item)),
          };
        }),
      setLastCapture: (lastCapture) => set({ lastCapture }),
      setGenerations: (generations, projectId) =>
        set((state) => {
          const persistedPending = state.generations.filter((generation) =>
            isPendingGeneration(generation, projectId),
          );
          const mergedGenerations = generations.map((generation) => {
            const persisted = persistedPending.find((item) =>
              generationsReferToSameJob(item, generation),
            );
            if (!persisted || !isPendingGeneration(generation, projectId)) return generation;
            return {
              ...generation,
              ...persisted,
              metadata: {
                ...generation.metadata,
                ...persisted.metadata,
              },
            };
          });
          const pendingMissingFromProject = persistedPending.filter(
            (generation) =>
              !mergedGenerations.some((item) => generationsReferToSameJob(item, generation)),
          );
          const nextGenerations = [...pendingMissingFromProject, ...mergedGenerations];
          const restoredCurrentGeneration = state.currentGeneration
            ? nextGenerations.find((generation) =>
                generationsReferToSameJob(generation, state.currentGeneration),
              )
            : undefined;
          return {
            generations: nextGenerations,
            currentGeneration: restoredCurrentGeneration ?? nextGenerations[0],
            isGenerating: nextGenerations.some((generation) =>
              isActiveGenerationRunning(generation),
            ),
          };
        }),
      deleteObjectData: (objectId) =>
        set((state) => {
          const generations = state.generations.filter(
            (generation) => generation.metadata.objectId !== objectId,
          );
          const currentGeneration =
            state.currentGeneration?.metadata.objectId === objectId
              ? generations[0]
              : state.currentGeneration;
          return {
            generations,
            currentGeneration,
            lastCapture:
              state.lastCapture?.objectId === objectId ? undefined : state.lastCapture,
            isGenerating: generations.some((generation) =>
              isActiveGenerationRunning(generation),
            ),
          };
        }),
    }),
    {
      name: generationStorageKeyV2,
      partialize: (state) => ({
        generations: state.generations.filter(
          (generation) => generation.status === 'queued' || generation.status === 'running',
        ),
        currentGeneration:
          state.currentGeneration &&
          (state.currentGeneration.status === 'queued' ||
            state.currentGeneration.status === 'running')
            ? state.currentGeneration
            : undefined,
        lastCapture: undefined,
        isGenerating: false,
      }),
    },
  ),
);
