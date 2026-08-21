export const PROJECT_COMMAND_SCHEMA_VERSION = 1 as const;

export const PROJECT_COMMAND_KINDS = [
  'replace-project-document',
  'rename-project',
  'move-project',
] as const;

export type ProjectCommandKind = (typeof PROJECT_COMMAND_KINDS)[number];

type ProjectCommandBase<TKind extends ProjectCommandKind, TPayload> = {
  schemaVersion: typeof PROJECT_COMMAND_SCHEMA_VERSION;
  id: string;
  projectId: string;
  expectedRevisionId?: string;
  issuedAt: string;
  kind: TKind;
  payload: TPayload;
};

export type ReplaceProjectDocumentCommand = ProjectCommandBase<
  'replace-project-document',
  { document: Record<string, unknown> }
>;

export type RenameProjectCommand = ProjectCommandBase<
  'rename-project',
  { name: string }
>;

export type MoveProjectCommand = ProjectCommandBase<
  'move-project',
  { folderId: string | null }
>;

export type ProjectCommand =
  | ReplaceProjectDocumentCommand
  | RenameProjectCommand
  | MoveProjectCommand;

const commandIdPattern = /^command-[a-zA-Z0-9_-]{8,128}$/;
const projectIdPattern = /^project-[a-zA-Z0-9_-]{8,128}$/;
const revisionIdPattern = /^revision-[a-zA-Z0-9_-]{8,128}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function requiredString(record: Record<string, unknown>, key: string) {
  const value = record[key];
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${key} is required.`);
  return value.trim();
}

export function parseProjectCommand(value: unknown): ProjectCommand {
  if (!isRecord(value)) throw new Error('Project command must be an object.');
  if (value.schemaVersion !== PROJECT_COMMAND_SCHEMA_VERSION) {
    throw new Error(`Unsupported project command schema: ${String(value.schemaVersion)}.`);
  }
  const id = requiredString(value, 'id');
  const projectId = requiredString(value, 'projectId');
  const issuedAt = requiredString(value, 'issuedAt');
  const kind = value.kind;
  if (!commandIdPattern.test(id)) throw new Error('Project command id is invalid.');
  if (!projectIdPattern.test(projectId)) throw new Error('Project command projectId is invalid.');
  if (!Number.isFinite(Date.parse(issuedAt))) throw new Error('Project command issuedAt is invalid.');
  if (!PROJECT_COMMAND_KINDS.includes(kind as ProjectCommandKind)) {
    throw new Error(`Unsupported project command kind: ${String(kind)}.`);
  }
  const expectedRevisionId = value.expectedRevisionId;
  if (
    expectedRevisionId !== undefined &&
    (typeof expectedRevisionId !== 'string' || !revisionIdPattern.test(expectedRevisionId))
  ) {
    throw new Error('Project command expectedRevisionId is invalid.');
  }
  if (!isRecord(value.payload)) throw new Error('Project command payload must be an object.');

  const base = {
    schemaVersion: PROJECT_COMMAND_SCHEMA_VERSION,
    id,
    projectId,
    ...(typeof expectedRevisionId === 'string' ? { expectedRevisionId } : {}),
    issuedAt: new Date(issuedAt).toISOString(),
  } as const;

  if (kind === 'replace-project-document') {
    if (!isRecord(value.payload.document)) {
      throw new Error('replace-project-document requires a document object.');
    }
    return { ...base, kind, payload: { document: value.payload.document } };
  }
  if (kind === 'rename-project') {
    const name = requiredString(value.payload, 'name');
    if (name.length > 200) throw new Error('Project name exceeds 200 characters.');
    return { ...base, kind, payload: { name } };
  }
  const folderId = value.payload.folderId;
  if (folderId !== null && (typeof folderId !== 'string' || !folderId.trim())) {
    throw new Error('move-project folderId must be a string or null.');
  }
  return {
    ...base,
    kind: 'move-project',
    payload: { folderId: typeof folderId === 'string' ? folderId.trim() : null },
  };
}
