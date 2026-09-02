export type LocalRepaintBackgroundSourceIdentity = {
  generationId?: string;
  objectId?: string;
  targetLayerId?: string;
  /** A selected persisted repaint row owns the renderer until editing leaves it. */
  projectionLayerId?: string;
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

  // A persisted repaint selected for editing is an explicit user-owned source.
  // Background staging of the newest generation must never replace it, even
  // when that source was restored with autoActivate=false or another result
  // finishes while the user is working on the selected row.
  if (currentSource.projectionLayerId) return 'preserve-current-source';

  // A newly completed generation is the only passive flow allowed to replace
  // another live source. Once consumed, selecting a historical repaint keeps
  // ownership until the user explicitly chooses a different result.
  return pendingGenerationId === nextSource.generationId || currentSource.autoActivate === false
    ? 'stage-latest-generation'
    : 'preserve-current-source';
}
