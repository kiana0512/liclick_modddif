import { create } from 'zustand';
import type { ReferenceImage } from '@/types/project';
import { createId } from '@/utils/id';

const legacyMockReferenceIds = new Set(['ref-marble-01', 'ref-fabric-01']);

function withoutLegacyMockReferences(references: ReferenceImage[]) {
  return references.filter((reference) => !legacyMockReferenceIds.has(reference.id));
}

function asProjectReference(reference: ReferenceImage): ReferenceImage {
  const projectReference = { ...reference };
  delete projectReference.objectId;
  return projectReference;
}

type ReferenceStore = {
  references: ReferenceImage[];
  selectedReferenceIds: string[];
  setReferences: (references: ReferenceImage[]) => void;
  addReferences: (references: ReferenceImage[]) => void;
  setSelectedReferences: (referenceIds: string[]) => void;
  toggleReference: (referenceId: string, selectionMode?: 'multiple' | 'single') => void;
  renameReference: (referenceId: string, name: string) => void;
  duplicateReference: (referenceId: string) => void;
  deleteReference: (referenceId: string) => void;
};

export const useReferenceStore = create<ReferenceStore>((set) => ({
  references: [],
  selectedReferenceIds: [],
  setReferences: (references) =>
    set(() => {
      const nextReferences = withoutLegacyMockReferences(references).map(asProjectReference);
      return {
        references: nextReferences,
        selectedReferenceIds: nextReferences.filter((reference) => reference.isPrimary).map((reference) => reference.id),
      };
    }),
  addReferences: (references) =>
    set((state) => {
      const projectReferences = references.map(asProjectReference);
      const selectedReferenceIds = [
        ...projectReferences.map((reference) => reference.id),
        ...state.selectedReferenceIds,
      ];
      return {
        references: [...projectReferences.map((reference) => ({ ...reference, isPrimary: true })), ...state.references],
        selectedReferenceIds,
      };
    }),
  setSelectedReferences: (referenceIds) =>
    set((state) => {
      const availableIds = new Set(state.references.map((reference) => reference.id));
      const selectedReferenceIds = referenceIds.filter((id, index) => availableIds.has(id) && referenceIds.indexOf(id) === index);
      return {
        selectedReferenceIds,
        references: state.references.map((reference) => ({
          ...reference,
          isPrimary: selectedReferenceIds.includes(reference.id),
        })),
      };
    }),
  toggleReference: (referenceId, selectionMode = 'multiple') =>
    set((state) => {
      const selectedReferenceIds =
        selectionMode === 'single'
          ? state.selectedReferenceIds.includes(referenceId)
            ? []
            : [referenceId]
          : state.selectedReferenceIds.includes(referenceId)
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
      const projectReference = asProjectReference(reference);
      const duplicated = {
        ...projectReference,
        id: createId('reference'),
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
