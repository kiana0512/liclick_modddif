import type { ReferenceImage } from '@/types/project';
import type { Generation } from '@/types/generation';

export type ReferenceGroupGenerationState = {
  groupId: string;
  status: 'generating' | 'failed';
  error?: string;
};

export function referenceGroupId(reference: ReferenceImage) {
  return reference.referenceGroupId ?? reference.id;
}

/** REFERENCE-GROUP-BINDING/1.1.0: recovery follows request order, never completion order. */
export function latestPairedGenerations(generations: Generation[], projectId?: string) {
  const latest = new Map<string, Generation>();
  const started = (generation: Generation) => Date.parse(String(generation.metadata.startedAt)) || 0;
  for (const generation of generations) {
    const { referenceRole, sourceReferenceId, projectId: owner } = generation.metadata;
    if (referenceRole !== 'multi-view' || typeof sourceReferenceId !== 'string' ||
      (owner && owner !== projectId)) continue;
    const previous = latest.get(sourceReferenceId);
    if (!previous || started(generation) > started(previous) ||
      (started(generation) === started(previous) && generation.id > previous.id)) {
      latest.set(sourceReferenceId, generation);
    }
  }
  return [...latest.values()];
}

export function replacePairedReference(
  references: ReferenceImage[], source: ReferenceImage, result: ReferenceImage,
) {
  const groupId = referenceGroupId(source);
  return [
    { ...result, referenceGroupId: groupId, referenceRole: 'multi-view' as const,
      derivedFromReferenceId: source.id, isPrimary: true },
    ...references.filter(reference => reference.referenceRole !== 'multi-view' ||
      (referenceGroupId(reference) !== groupId && reference.derivedFromReferenceId !== source.id))
      .map(reference => ({ ...reference, isPrimary: false,
        ...(reference.id === source.id ? { referenceGroupId: groupId } : {}) })),
  ];
}
