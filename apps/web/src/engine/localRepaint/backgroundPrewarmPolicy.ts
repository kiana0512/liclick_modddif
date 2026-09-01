export type LocalRepaintBackgroundSourceIdentity = {
  generationId?: string;
  objectId?: string;
  targetLayerId?: string;
};

export type LocalRepaintBackgroundPrewarmDisposition =
  | 'already-staged'
  | 'preserve-current-source'
  | 'stage-latest-generation';

export function resolveLocalRepaintBackgroundPrewarmDisposition(input: {
  currentSource?: LocalRepaintBackgroundSourceIdentity;
  nextSource: Required<LocalRepaintBackgroundSourceIdentity>;
  pendingGenerationId?: string;
}): LocalRepaintBackgroundPrewarmDisposition {
  const { currentSource, nextSource, pendingGenerationId } = input;
  if (!currentSource) return 'stage-latest-generation';
  if (
    currentSource.generationId === nextSource.generationId &&
    currentSource.objectId === nextSource.objectId &&
    currentSource.targetLayerId === nextSource.targetLayerId
  ) {
    return 'already-staged';
  }

  // A newly completed generation is the only passive flow allowed to replace
  // another live source. Once consumed, selecting a historical repaint keeps
  // ownership until the user explicitly chooses a different result.
  return pendingGenerationId === nextSource.generationId
    ? 'stage-latest-generation'
    : 'preserve-current-source';
}
