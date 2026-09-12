import type { ReferenceImage } from '@/types/project';

function isMultiview(reference: ReferenceImage) {
  return reference.referenceRole === 'multi-view';
}

function referenceGroupId(reference: ReferenceImage) {
  return reference.referenceGroupId ?? reference.id;
}

/**
 * Resolve the material input exactly once at the submit boundary.
 *
 * An explicit UI selection is authoritative. A selected single-view image
 * resolves to its durable paired multi-view image when that image still exists
 * in the same reference group. If the user deleted the paired image, the
 * selected single-view image is returned so the caller creates a fresh pair.
 * Generation history is only a compatibility fallback for projects that do
 * not currently have a selected reference.
 */
export function resolveLocalRepaintMaterialReference(input: {
  references: ReferenceImage[];
  selectedReferenceIds: string[];
  historicalReferenceId?: string;
}) {
  const selectedReference = input.selectedReferenceIds
    .map((id) => input.references.find((reference) => reference.id === id))
    .find((reference): reference is ReferenceImage => Boolean(reference));

  if (selectedReference) {
    if (isMultiview(selectedReference)) return { ...selectedReference };
    const selectedGroupId = referenceGroupId(selectedReference);
    const pairedMultiview = input.references.find(
      (reference) =>
        isMultiview(reference) && referenceGroupId(reference) === selectedGroupId,
    );
    return { ...(pairedMultiview ?? selectedReference) };
  }

  const historicalReference = input.historicalReferenceId
    ? input.references.find(
        (reference) =>
          reference.id === input.historicalReferenceId && isMultiview(reference),
      )
    : undefined;
  return historicalReference ? { ...historicalReference } : undefined;
}
