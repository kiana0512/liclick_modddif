export type LocalRepaintBackgroundSourceIdentity = {
  generationId?: string;
  objectId?: string;
  targetLayerId?: string;
  /** False identifies a renderer-restored/passively staged source, not a user-owned edit. */
  autoActivate?: boolean;
};

export type LocalRepaintBackgroundPrewarmDisposition =
  | 'already-staged'
  | 'preserve-current-source'
  | 'stage-latest-generation';

export function resolveLocalRepaintBackgroundPrewarmDisposition(input: {
  currentSource?: LocalRepaintBackgroundSourceIdentity;
  nextSource: Required<
    Pick<LocalRepaintBackgroundSourceIdentity, 'generationId' | 'objectId' | 'targetLayerId'>
  >;
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
  return pendingGenerationId === nextSource.generationId || currentSource.autoActivate === false
    ? 'stage-latest-generation'
    : 'preserve-current-source';
}
