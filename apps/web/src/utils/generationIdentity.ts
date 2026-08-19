import type { Generation } from '@/types/generation';

function metadataId(generation: Generation, key: string) {
  const value = generation.metadata[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function metadataValuesDoNotConflict(left: Generation, right: Generation, key: string) {
  const leftValue = metadataId(left, key);
  const rightValue = metadataId(right, key);
  return !leftValue || !rightValue || leftValue === rightValue;
}

function isLocalRepaintGeneration(generation: Generation) {
  return generation.metadata.workflow === 'local-repaint';
}

function generationResolutionRank(generation: Generation) {
  if (generation.resultUrl) return 4;
  if (generation.status === 'succeeded') return 3;
  if (generation.status === 'failed') return 2;
  if (generation.status === 'idle') return 1;
  return 0;
}

function mergeGenerationRecords(preferred: Generation, fallback: Generation): Generation {
  const metadata = {
    ...fallback.metadata,
    ...preferred.metadata,
  };
  (['clientGenerationId', 'serverJobId', 'taskId'] as const).forEach((key) => {
    const identity = metadataId(preferred, key) ?? metadataId(fallback, key);
    if (identity) metadata[key] = identity;
  });
  return {
    ...fallback,
    ...preferred,
    referenceIds:
      preferred.referenceIds.length > 0 ? preferred.referenceIds : fallback.referenceIds,
    captureId: preferred.captureId ?? fallback.captureId,
    resultUrl: preferred.resultUrl ?? fallback.resultUrl,
    metadata,
  };
}

export function generationIdentityIds(generation: Generation | undefined) {
  if (!generation) return [];
  return [
    ...new Set(
      [
        generation.id,
        metadataId(generation, 'clientGenerationId'),
        metadataId(generation, 'serverJobId'),
        metadataId(generation, 'taskId'),
      ].filter((value): value is string => Boolean(value)),
    ),
  ];
}

export function generationsReferToSameJob(
  left: Generation | undefined,
  right: Generation | undefined,
) {
  if (!left || !right) return false;
  const rightIds = new Set(generationIdentityIds(right));
  if (generationIdentityIds(left).some((id) => rightIds.has(id))) return true;

  // Older ModelView responses were occasionally archived under the remote id
  // instead of the client id. A repaint capture is created once per request,
  // so it is a safe legacy identity as long as project/object metadata does not
  // conflict. This lets a completed result evict its stale `running` alias.
  return Boolean(
    isLocalRepaintGeneration(left) &&
      isLocalRepaintGeneration(right) &&
      left.captureId &&
      left.captureId === right.captureId &&
      metadataValuesDoNotConflict(left, right, 'projectId') &&
      metadataValuesDoNotConflict(left, right, 'objectId'),
  );
}

export function generationBelongsToProject(generation: Generation, projectId: string) {
  const metadataProjectId = metadataId(generation, 'projectId');
  // Legacy project files predate projectId metadata, so only exclude records
  // that explicitly belong to a different project.
  return !metadataProjectId || metadataProjectId === projectId;
}

/**
 * LiClick exposes client, local-server and remote-task ids at different phases.
 * Collapse all aliases into one canonical record so an old running item cannot
 * remain in front of the completed result.
 */
export function upsertGenerationByIdentity(
  generations: Generation[],
  generation: Generation,
) {
  return collapseGenerationRecords([generation, ...generations]);
}

/**
 * Remove identity aliases across an entire restored list. A terminal record
 * always wins over a queued/running record, even when the stale alias appears
 * first in localStorage.
 */
export function collapseGenerationRecords(generations: Generation[]) {
  const collapsed: Generation[] = [];
  generations.forEach((generation) => {
    const existingIndex = collapsed.findIndex((current) =>
      generationsReferToSameJob(current, generation),
    );
    if (existingIndex < 0) {
      collapsed.push(generation);
      return;
    }

    const existing = collapsed[existingIndex]!;
    collapsed[existingIndex] =
      generationResolutionRank(generation) > generationResolutionRank(existing)
        ? mergeGenerationRecords(generation, existing)
        : mergeGenerationRecords(existing, generation);
  });
  return collapsed;
}
