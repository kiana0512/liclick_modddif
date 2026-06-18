import { create } from 'zustand';
import { mockReferences } from '@/mock/mockReferences';
import type { ReferenceImage } from '@/types/project';

type ReferenceStore = {
  references: ReferenceImage[];
  selectedReferenceIds: string[];
  toggleReference: (referenceId: string) => void;
};

export const useReferenceStore = create<ReferenceStore>((set) => ({
  references: mockReferences,
  selectedReferenceIds: [mockReferences[0]?.id ?? ''].filter(Boolean),
  toggleReference: (referenceId) =>
    set((state) => ({
      selectedReferenceIds: state.selectedReferenceIds.includes(referenceId)
        ? state.selectedReferenceIds.filter((id) => id !== referenceId)
        : [...state.selectedReferenceIds, referenceId],
    })),
}));
