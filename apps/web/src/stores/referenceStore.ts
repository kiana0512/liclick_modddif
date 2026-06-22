import { create } from 'zustand';
import type { ReferenceImage } from '@/types/project';

const legacyMockReferenceIds = new Set(['ref-marble-01', 'ref-fabric-01']);

function withoutLegacyMockReferences(references: ReferenceImage[]) {
  return references.filter((reference) => !legacyMockReferenceIds.has(reference.id));
}

type ReferenceStore = {
  references: ReferenceImage[];
  selectedReferenceIds: string[];
  setReferences: (references: ReferenceImage[]) => void;
  addReferences: (references: ReferenceImage[]) => void;
  toggleReference: (referenceId: string) => void;
  renameReference: (referenceId: string, name: string) => void;
  duplicateReference: (referenceId: string) => void;
  deleteReference: (referenceId: string) => void;
};

export const useReferenceStore = create<ReferenceStore>((set) => ({
  references: [],
  selectedReferenceIds: [],
  setReferences: (references) =>
    set(() => {
      const nextReferences = withoutLegacyMockReferences(references);
      return {
        references: nextReferences,
        selectedReferenceIds: nextReferences.filter((reference) => reference.isPrimary).map((reference) => reference.id),
      };
    }),
  addReferences: (references) =>
    set((state) => {
      const selectedReferenceIds = [
        ...references.map((reference) => reference.id),
        ...state.selectedReferenceIds,
      ];
      return {
        references: [...references.map((reference) => ({ ...reference, isPrimary: true })), ...state.references],
        selectedReferenceIds,
      };
    }),
  toggleReference: (referenceId) =>
    set((state) => {
      const selectedReferenceIds = state.selectedReferenceIds.includes(referenceId)
        ? state.selectedReferenceIds.filter((id) => id !== referenceId)
        : [...state.selectedReferenceIds, referenceId];
      return {
        selectedReferenceIds,
        references: state.references.map((reference) => ({
          ...reference,
          isPrimary: selectedReferenceIds.includes(reference.id),
        })),
      };
    }),
  renameReference: (referenceId, name) =>
    set((state) => ({
      references: state.references.map((reference) =>
        reference.id === referenceId ? { ...reference, name } : reference,
      ),
    })),
  duplicateReference: (referenceId) =>
    set((state) => {
      const reference = state.references.find((item) => item.id === referenceId);
      if (!reference) return state;
      const duplicated = {
        ...reference,
        id: `reference-${crypto.randomUUID()}`,
        name: `${reference.name} copy`,
        isPrimary: true,
      };
      return {
        references: [
          duplicated,
          ...state.references.map((item) => ({
            ...item,
            isPrimary: state.selectedReferenceIds.includes(item.id),
          })),
        ],
        selectedReferenceIds: [duplicated.id, ...state.selectedReferenceIds],
      };
    }),
  deleteReference: (referenceId) =>
    set((state) => ({
      references: state.references.filter((reference) => reference.id !== referenceId),
      selectedReferenceIds: state.selectedReferenceIds.filter((id) => id !== referenceId),
    })),
}));
