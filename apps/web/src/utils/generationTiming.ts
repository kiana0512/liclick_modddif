import type { Generation } from '@/types/generation';

type GenerationMetadata = Generation['metadata'];

function getValidStartedAt(metadata: GenerationMetadata) {
  const startedAt = metadata.startedAt;
  return typeof startedAt === 'string' && Number.isFinite(Date.parse(startedAt))
    ? startedAt
    : undefined;
}

export function getGenerationStartedAt(generation: Pick<Generation, 'metadata'>) {
  const startedAt = getValidStartedAt(generation.metadata);
  return startedAt ? Date.parse(startedAt) : Number.NaN;
}

export function mergeGenerationMetadataPreservingStartedAt(
  pendingMetadata: GenerationMetadata,
  submittedMetadata: GenerationMetadata,
) {
  const startedAt =
    getValidStartedAt(submittedMetadata) ?? getValidStartedAt(pendingMetadata);

  return {
    ...pendingMetadata,
    ...submittedMetadata,
    ...(startedAt ? { startedAt } : {}),
  };
}
