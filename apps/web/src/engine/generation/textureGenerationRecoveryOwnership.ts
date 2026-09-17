// TEXTURE-GENERATION-RECOVERY-OWNERSHIP/1.0.0
// A foreground texture sequence exclusively owns QA, retry and publication.
// Tickets also reject requests which crossed a complete foreground session.
export function createTextureGenerationRecoveryOwnership() {
  const projects = new Map<string, { revision: number; owners: Set<symbol> }>();
  return {
    begin(projectId: string) {
      const state = projects.get(projectId) ?? { revision: 0, owners: new Set<symbol>() };
      projects.set(projectId, state);
      const owner = Symbol();
      state.owners.add(owner);
      state.revision++;
      return () => {
        if (state.owners.delete(owner)) state.revision++;
      };
    },
    backgroundTicket(projectId: string | undefined, workflow: unknown) {
      if (!projectId || workflow !== 'texture-map') return () => true;
      const revision = projects.get(projectId)?.revision ?? 0;
      return () => {
        const state = projects.get(projectId);
        return !state?.owners.size && (state?.revision ?? 0) === revision;
      };
    },
  };
}

export function isRejectedTextureReturn(metadata: Record<string, unknown> | undefined) {
  return metadata?.returnQaRejected === true ||
    typeof metadata?.silhouetteRetryGenerationId === 'string';
}

export function textureReturnQaFailureMetadata(error: unknown): Record<string, unknown> {
  return error && typeof error === 'object' && 'code' in error &&
    error.code === 'GPT_RETURN_SILHOUETTE_MISMATCH'
    ? { returnQaRejected: true, returnQaErrorCode: error.code }
    : {};
}
