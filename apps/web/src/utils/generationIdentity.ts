import type { Generation } from '@/types/generation';

function metadataId(generation: Generation, key: string) {
  const value = generation.metadata[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
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
  return generationIdentityIds(left).some((id) => rightIds.has(id));
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
  return [
    generation,
    ...generations.filter((current) => !generationsReferToSameJob(current, generation)),
  ];
}
