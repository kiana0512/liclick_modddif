import type { ReferenceImage } from '@/types/project';

function groupId(reference: ReferenceImage) {
  return reference.referenceGroupId ?? reference.id;
}

function isMultiview(reference: ReferenceImage) {
  return reference.referenceRole === 'multi-view';
}

/**
 * Resolve the material input exactly once at the submit boundary.
 *
 * An explicit UI selection is authoritative. When the selected item belongs
 * to a single/multi-view pair, the paired multi-view image is the material
 * input. Generation history is only a compatibility fallback for projects
 * that do not currently have a selected reference.
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
    const selectedGroupId = groupId(selectedReference);
    const pairedMultiview = input.references.find(
      (reference) => groupId(reference) === selectedGroupId && isMultiview(reference),
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

