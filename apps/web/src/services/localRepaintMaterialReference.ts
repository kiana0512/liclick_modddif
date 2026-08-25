import type { ReferenceImage } from '@/types/project';

function isMultiview(reference: ReferenceImage) {
  return reference.referenceRole === 'multi-view';
}

/**
 * Resolve the material input exactly once at the submit boundary.
 *
 * An explicit UI selection is authoritative and is returned exactly as the
 * user selected it. The caller must convert a selected single-view image to a
 * fresh multi-view image before submitting local repaint. Generation history
 * is only a compatibility fallback for projects that do not currently have a
 * selected reference.
 */
export function resolveLocalRepaintMaterialReference(input: {
  references: ReferenceImage[];
  selectedReferenceIds: string[];
  historicalReferenceId?: string;
}) {
  const selectedReference = input.selectedReferenceIds
    .map((id) => input.references.find((reference) => reference.id === id))
    .find((reference): reference is ReferenceImage => Boolean(reference));

  if (selectedReference) return { ...selectedReference };

  const historicalReference = input.historicalReferenceId
    ? input.references.find(
        (reference) =>
          reference.id === input.historicalReferenceId && isMultiview(reference),
      )
    : undefined;
  return historicalReference ? { ...historicalReference } : undefined;
}
