export const PROJECT_REVISION_SCHEMA_VERSION = 1 as const;

export type ProjectRevision = {
  schemaVersion: typeof PROJECT_REVISION_SCHEMA_VERSION;
  id: string;
  number: number;
  parentRevisionId?: string;
  savedAt: string;
};

export type NextProjectRevisionInput = {
  id: string;
  savedAt: string;
};

const revisionIdPattern = /^revision-[a-zA-Z0-9_-]{8,128}$/;

export function isProjectRevision(value: unknown): value is ProjectRevision {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const revision = value as Partial<ProjectRevision>;
  return (
    revision.schemaVersion === PROJECT_REVISION_SCHEMA_VERSION &&
    typeof revision.id === 'string' &&
    revisionIdPattern.test(revision.id) &&
    Number.isSafeInteger(revision.number) &&
    (revision.number ?? 0) >= 1 &&
    (revision.parentRevisionId === undefined ||
      (typeof revision.parentRevisionId === 'string' &&
        revisionIdPattern.test(revision.parentRevisionId))) &&
    typeof revision.savedAt === 'string' &&
    Number.isFinite(Date.parse(revision.savedAt))
  );
}

export function nextProjectRevision(
  current: ProjectRevision | undefined,
  input: NextProjectRevisionInput,
): ProjectRevision {
  if (!revisionIdPattern.test(input.id)) throw new Error('Project revision id is invalid.');
  if (!Number.isFinite(Date.parse(input.savedAt))) {
    throw new Error('Project revision savedAt is invalid.');
  }
  return {
    schemaVersion: PROJECT_REVISION_SCHEMA_VERSION,
    id: input.id,
    number: (current?.number ?? 0) + 1,
    ...(current ? { parentRevisionId: current.id } : {}),
    savedAt: new Date(input.savedAt).toISOString(),
  };
}

export function projectRevisionMatches(
  expectedRevisionId: string | undefined,
  current: ProjectRevision | undefined,
) {
  return expectedRevisionId !== undefined && current !== undefined
    ? expectedRevisionId === current.id
    : expectedRevisionId === undefined && current === undefined;
}
