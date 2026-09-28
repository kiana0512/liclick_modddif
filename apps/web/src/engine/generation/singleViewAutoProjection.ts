import type { Generation } from '@/types/generation';
import { getPipelineTrace } from '@/engine/performance/tracing/pipelineTrace';

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

export interface ProjectionSaveObserver {
  onSaving?: () => void;
  onSaved?: (generation: Generation) => void;
}

/** SINGLE-VIEW-COMPLETION/1.0.0: reuse only an acknowledged projection checkpoint. */
export async function persistProjectionCommit(
  generation: Generation,
  layerId: string,
  sync: (generation: Generation) => void,
  save: () => Promise<void>,
  observer?: ProjectionSaveObserver,
) {
  const committed = withProjectionCommit(generation, layerId);
  sync(committed);
  observer?.onSaving?.();
  await save();
  if (import.meta.env.VITE_LICLICK_PIPELINE_TRACE_ENABLED === 'true') {
    const trace = getPipelineTrace(typeof generation.metadata.projectId === 'string' ? generation.metadata.projectId : undefined);
    trace?.begin('save.ack', trace.lookup(generation.id), 'sync')?.end();
    trace?.acknowledge(`projection:${generation.id}:${layerId}`);
  }
  observer?.onSaved?.(committed);
}

export function needsTextureCompletionCheckpoint(
  multiview: boolean,
  saved: boolean,
  completed: number,
  projected: number,
  failures: number,
) {
  return multiview || !saved || completed !== 1 || projected !== 1 || failures !== 0;
}
