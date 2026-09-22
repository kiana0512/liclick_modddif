import type { ReferenceImage } from '@/types/project';

/** Explicit selection is authoritative, including single-view references. */
export function resolveLocalRepaintMaterialReference(input: {
  references: ReferenceImage[];
  selectedReferenceIds: string[];
  historicalReferenceId?: string;
}) {
  const selectedReference = input.selectedReferenceIds
    .map((id) => input.references.find((reference) => reference.id === id))
    .find((reference): reference is ReferenceImage => Boolean(reference));

  if (selectedReference) {
    return { ...selectedReference };
  }

  const historicalReference = input.historicalReferenceId
    ? input.references.find(
        (reference) =>
          reference.id === input.historicalReferenceId,
      )
    : undefined;
  return historicalReference ? { ...historicalReference } : undefined;
}
