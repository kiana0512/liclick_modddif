import type { ReferenceImage } from '@/types/project';

export function referenceGroupId(reference: ReferenceImage) {
  return reference.referenceGroupId ?? reference.id;
}
