import type { Generation } from '@/types/generation';

/** SINGLE-VIEW-AUTO-PROJECTION v1.2.0. A commit remains consumed after deletion. */
export function hasProjectionCommit(generation: Generation) {
  return Boolean(generation.metadata.projectedLayerId || generation.metadata.projectionCommittedAt);
}

export function needsSingleViewAutoProjection(generation: Generation, projectId: string) {
  return Boolean(
    projectId &&
      generation.metadata.projectId === projectId &&
      ((generation.mode === 'single' && generation.metadata.multiview !== true) ||
        (generation.mode === 'multiview' && generation.metadata.multiview === true &&
          generation.metadata.autoProjectExpected === true)) &&
      generation.metadata.workflow === 'texture-map' &&
      generation.status === 'succeeded' &&
      generation.resultUrl &&
      generation.metadata.cancelled !== true &&
      !hasProjectionCommit(generation),
  );
}

export function withProjectionCommit(generation: Generation, layerId: string): Generation {
  return {
    ...generation,
    metadata: {
      ...generation.metadata,
      autoProjectExpected: true,
      projectedLayerId: layerId,
      projectionCommittedAt: generation.metadata.projectionCommittedAt ?? new Date().toISOString(),
      projectionError: undefined,
    },
  };
}
