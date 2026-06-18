import { create } from 'zustand';
import { mockReferences } from '@/mock/mockReferences';
import type { ReferenceImage } from '@/types/project';

type ReferenceStore = {
  references: ReferenceImage[];
  selectedReferenceIds: string[];
  setReferences: (references: ReferenceImage[]) => void;
  addReferences: (references: ReferenceImage[]) => void;
  toggleReference: (referenceId: string) => void;
};

export const useReferenceStore = create<ReferenceStore>((set) => ({
  references: mockReferences,
  selectedReferenceIds: [mockReferences[0]?.id ?? ''].filter(Boolean),
  setReferences: (references) =>
    set({
      references,
      selectedReferenceIds: references.filter((reference) => reference.isPrimary).map((reference) => reference.id),
    }),
  addReferences: (references) =>
    set((state) => ({
      references: [...references, ...state.references],
      selectedReferenceIds: [
        ...references.map((reference) => reference.id),
        ...state.selectedReferenceIds,
      ],
    })),
  toggleReference: (referenceId) =>
    set((state) => ({
      selectedReferenceIds: state.selectedReferenceIds.includes(referenceId)
        ? state.selectedReferenceIds.filter((id) => id !== referenceId)
        : [...state.selectedReferenceIds, referenceId],
    })),
}));
