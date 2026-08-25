import type { ReferenceImage } from '@/types/project';

export type ReferenceGroupGenerationState = {
  groupId: string;
  status: 'generating' | 'failed';
  error?: string;
};

export function referenceGroupId(reference: ReferenceImage) {
  return reference.referenceGroupId ?? reference.id;
}
