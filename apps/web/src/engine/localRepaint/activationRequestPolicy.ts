import type { Generation } from '@/types/generation';

export type LocalRepaintActivationDisposition =
  | 'activate-now'
  | 'queue-until-unlocked'
  | 'blocked-generation-running'
  | 'blocked-no-result'
  | 'blocked-operation';

export function resolveLocalRepaintActivationDisposition(input: {
  localRepaintReady: boolean;
  operationLocked: boolean;
  localGenerationRunning: boolean;
  canQueueDuringTransition: boolean;
}): LocalRepaintActivationDisposition {
  if (!input.localRepaintReady) {
    if (input.canQueueDuringTransition) return 'queue-until-unlocked';
    return input.localGenerationRunning ? 'blocked-generation-running' : 'blocked-no-result';
  }
  if (!input.operationLocked) return 'activate-now';
  return input.canQueueDuringTransition ? 'queue-until-unlocked' : 'blocked-operation';
}

export type LocalRepaintActivationRequest = {
  generationId?: string;
  targetLayerId?: string;
  requestedAt: number;
};

type LocalRepaintResidentMarker = {
  generationId?: string;
  targetLayerId?: string;
};

export function createLocalRepaintActivationRequest(input: {
  generationId?: string;
  targetLayerId?: string;
  now?: number;
}): LocalRepaintActivationRequest {
  return {
    generationId: input.generationId,
    targetLayerId: input.targetLayerId,
    requestedAt: input.now ?? Date.now(),
  };
}

/**
 * A request created while generation is still finishing intentionally has no
 * generation id. Once the result settles EditorPage upgrades it to an exact
 * generation-scoped request before renderer events can unlock the brush.
 */
export function localRepaintActivationRequestMatches(
  request: LocalRepaintActivationRequest | undefined,
  marker: LocalRepaintResidentMarker,
) {
  if (!request) return false;
  if (request.generationId && request.generationId !== marker.generationId) return false;
  if (request.targetLayerId && request.targetLayerId !== marker.targetLayerId) return false;
  return Boolean(marker.generationId);
}

function generationRecencyTimestamp(generation: Generation) {
  const completedAt = generation.metadata.completedAt;
  const startedAt = generation.metadata.startedAt;
  const completedTimestamp = typeof completedAt === 'string' ? Date.parse(completedAt) : Number.NaN;
  const startedTimestamp = typeof startedAt === 'string' ? Date.parse(startedAt) : Number.NaN;
  if (Number.isFinite(completedTimestamp)) return completedTimestamp;
  if (Number.isFinite(startedTimestamp)) return startedTimestamp;
  return Number.NEGATIVE_INFINITY;
}

/** Keep preload, activation and replay on one deterministic generation. */
export function selectPreferredLocalRepaintGeneration(
  generations: Generation[],
  matches: (generation: Generation) => boolean,
  preferredGenerationId?: string,
) {
  const preferred = preferredGenerationId
    ? generations.find(
        (generation) => generation.id === preferredGenerationId && matches(generation),
      )
    : undefined;
  if (preferred) return preferred;
  return generations.reduce<Generation | undefined>((latest, generation) => {
    if (!matches(generation)) return latest;
    if (!latest) return generation;
    return generationRecencyTimestamp(generation) > generationRecencyTimestamp(latest)
      ? generation
      : latest;
  }, undefined);
}
