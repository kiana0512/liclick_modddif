import path from 'node:path';
import { serverConfig } from '../config.js';
import { readJsonFile, writeJsonFile } from './workspaceService.js';

export type AssetHistoryMode = 'uv' | 'retopology';

export type AssetHistoryParameter = {
  label: string;
  value: string;
};

export type AssetHistoryArtifact = {
  id: string;
  label: string;
  filename: string;
  sizeBytes: number;
  contentType?: string;
  sha256?: string;
};

export type AssetJobHistoryRecord = {
  userId: string;
  createdAt: string;
  updatedAt?: string;
  finishedAt?: string;
  mode?: AssetHistoryMode;
  sourceName?: string;
  parameters?: AssetHistoryParameter[];
  status?: string;
  progress?: number;
  error?: string;
  artifacts?: AssetHistoryArtifact[];
  batchId?: string;
  batchIndex?: number;
  batchSize?: number;
};

export type AssetHistoryRegistration = {
  mode: AssetHistoryMode;
  sourceName: string;
  parameters: AssetHistoryParameter[];
  batchId?: string;
  batchIndex?: number;
  batchSize?: number;
};

type AssetJobOwnershipDatabase = {
  jobs: Record<string, AssetJobHistoryRecord>;
};

const ownershipFile = path.join(
  serverConfig.workspaceDir,
  'config',
  'asset-processing-jobs.json',
);
let cachedDatabase: AssetJobOwnershipDatabase | undefined;
let writeQueue = Promise.resolve();

function cleanText(value: unknown, maximumLength: number) {
  if (typeof value !== 'string') return undefined;
  const clean = Array.from(value, (character) => {
    const code = character.codePointAt(0) ?? 0;
    return code <= 31 || code === 127 ? ' ' : character;
  }).join('').trim().slice(0, maximumLength);
  return clean || undefined;
}

function cleanDate(value: unknown) {
  const clean = cleanText(value, 64);
  return clean && Number.isFinite(Date.parse(clean)) ? clean : undefined;
}

function cleanSourceName(value: unknown) {
  const clean = cleanText(value, 180)?.replaceAll('\\', '/').split('/').at(-1);
  return clean || undefined;
}

export function sanitizeAssetHistoryParameters(value: unknown) {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 40).flatMap((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return [];
    const record = entry as Record<string, unknown>;
    const label = cleanText(record.label, 80);
    const parameterValue = cleanText(record.value, 600);
    return label && parameterValue ? [{ label, value: parameterValue }] : [];
  });
}

function artifactIdentifier(record: Record<string, unknown>) {
  const direct = cleanText(record.artifact_id ?? record.id, 200);
  if (direct) return direct;
  const downloadUrl = cleanText(record.download_url, 2_048);
  if (!downloadUrl) return undefined;
  try {
    const pathname = new URL(downloadUrl, 'https://asset.invalid').pathname;
    const match = /\/artifacts\/([^/]+)\/?$/.exec(pathname);
    return match ? decodeURIComponent(match[1]).slice(0, 200) : undefined;
  } catch {
    return undefined;
  }
}

function sanitizeArtifacts(value: unknown) {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 80).flatMap((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return [];
    const record = entry as Record<string, unknown>;
    const id = artifactIdentifier(record);
    const filename = cleanSourceName(record.filename);
    if (!id || !filename) return [];
    const label = cleanText(record.label ?? record.name ?? record.role ?? record.kind, 120) ?? filename;
    const rawSize = Number(record.sizeBytes ?? record.size_bytes ?? 0);
    const sizeBytes = Number.isSafeInteger(rawSize) && rawSize >= 0 ? rawSize : 0;
    const contentType = cleanText(record.contentType ?? record.content_type, 160);
    const rawSha = cleanText(record.sha256, 64)?.toLowerCase();
    const sha256 = rawSha && /^[a-f0-9]{64}$/.test(rawSha) ? rawSha : undefined;
    return [{ id, label, filename, sizeBytes, ...(contentType ? { contentType } : {}), ...(sha256 ? { sha256 } : {}) }];
  });
}

function validMode(value: unknown): value is AssetHistoryMode {
  return value === 'uv' || value === 'retopology';
}

function inferredMode(value: unknown) {
  const kind = cleanText(value, 160)?.toLowerCase();
  if (!kind) return undefined;
  if (kind.includes('retop')) return 'retopology' as const;
  if (/(^|[-_ ])uv($|[-_ ])/.test(kind) || kind.includes('unwrap')) return 'uv' as const;
  return undefined;
}

function sanitizeStoredRecord(value: unknown): AssetJobHistoryRecord | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const userId = cleanText(record.userId, 240);
  const createdAt = cleanDate(record.createdAt);
  if (!userId || !createdAt) return undefined;
  const updatedAt = cleanDate(record.updatedAt);
  const finishedAt = cleanDate(record.finishedAt);
  const mode = validMode(record.mode) ? record.mode : undefined;
  const sourceName = cleanSourceName(record.sourceName);
  const parameters = sanitizeAssetHistoryParameters(record.parameters);
  const status = cleanText(record.status, 40);
  const rawProgress = Number(record.progress);
  const progress = Number.isFinite(rawProgress) ? Math.min(100, Math.max(0, rawProgress)) : undefined;
  const error = cleanText(record.error, 1_000);
  const artifacts = sanitizeArtifacts(record.artifacts);
  const batchId = cleanText(record.batchId, 240);
  const rawBatchIndex = Number(record.batchIndex);
  const rawBatchSize = Number(record.batchSize);
  const batchIndex = Number.isInteger(rawBatchIndex) && rawBatchIndex >= 0
    ? rawBatchIndex
    : undefined;
  const batchSize = Number.isInteger(rawBatchSize) && rawBatchSize > 0 && rawBatchSize <= 100
    ? rawBatchSize
    : undefined;
  return {
    userId,
    createdAt,
    ...(updatedAt ? { updatedAt } : {}),
    ...(finishedAt ? { finishedAt } : {}),
    ...(mode ? { mode } : {}),
    ...(sourceName ? { sourceName } : {}),
    ...(parameters.length ? { parameters } : {}),
    ...(status ? { status } : {}),
    ...(progress !== undefined ? { progress } : {}),
    ...(error ? { error } : {}),
    ...(artifacts.length ? { artifacts } : {}),
    ...(batchId ? { batchId } : {}),
    ...(batchIndex !== undefined ? { batchIndex } : {}),
    ...(batchSize !== undefined ? { batchSize } : {}),
  };
}

async function readOwnershipDatabase() {
  if (!cachedDatabase) {
    const database = await readJsonFile<AssetJobOwnershipDatabase>(ownershipFile, { jobs: {} });
    const jobs: Record<string, AssetJobHistoryRecord> = {};
    if (database.jobs && typeof database.jobs === 'object') {
      for (const [jobId, value] of Object.entries(database.jobs)) {
        const cleanJobId = cleanText(jobId, 200);
        const record = sanitizeStoredRecord(value);
        if (cleanJobId && record) jobs[cleanJobId] = record;
      }
    }
    cachedDatabase = { jobs };
  }
  return cachedDatabase;
}

async function mutateDatabase(
  mutation: (database: AssetJobOwnershipDatabase) => AssetJobOwnershipDatabase,
) {
  writeQueue = writeQueue.catch(() => undefined).then(async () => {
    const database = await readOwnershipDatabase();
    const nextDatabase = mutation(database);
    await writeJsonFile(ownershipFile, nextDatabase);
    cachedDatabase = nextDatabase;
  });
  await writeQueue;
}

export async function registerAssetJobOwner(
  jobId: string,
  userId: string,
  registration?: AssetHistoryRegistration,
) {
  const normalizedJobId = cleanText(jobId, 200);
  const normalizedUserId = cleanText(userId, 240);
  if (!normalizedJobId) throw new Error('Asset service did not return a job id.');
  if (!normalizedUserId) throw new Error('Authenticated user id is required.');

  await mutateDatabase((database) => {
    const current = database.jobs[normalizedJobId];
    if (current && current.userId !== normalizedUserId) {
      throw new Error('Asset job is already registered to another user.');
    }
    const now = new Date().toISOString();
    const sourceName = cleanSourceName(registration?.sourceName);
    const parameters = sanitizeAssetHistoryParameters(registration?.parameters);
    const batchId = cleanText(registration?.batchId, 240);
    const batchIndex = Number.isInteger(registration?.batchIndex) && registration!.batchIndex! >= 0
      ? registration!.batchIndex
      : undefined;
    const batchSize = Number.isInteger(registration?.batchSize) && registration!.batchSize! > 0 && registration!.batchSize! <= 100
      ? registration!.batchSize
      : undefined;
    return {
      jobs: {
        ...database.jobs,
        [normalizedJobId]: {
          ...(current ?? { userId: normalizedUserId, createdAt: now }),
          userId: normalizedUserId,
          updatedAt: now,
          ...(registration
            ? {
                mode: registration.mode,
                ...(sourceName ? { sourceName } : {}),
                parameters,
                ...(batchId ? { batchId } : {}),
                ...(batchIndex !== undefined ? { batchIndex } : {}),
                ...(batchSize !== undefined ? { batchSize } : {}),
              }
            : {}),
        },
      },
    };
  });
}

export async function updateAssetJobSnapshot(
  jobId: string,
  userId: string,
  payload: unknown,
) {
  const normalizedJobId = cleanText(jobId, 200);
  const normalizedUserId = cleanText(userId, 240);
  if (!normalizedJobId || !normalizedUserId) return false;
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return false;
  const snapshot = payload as Record<string, unknown>;

  let updated = false;
  await mutateDatabase((database) => {
    const current = database.jobs[normalizedJobId];
    if (!current || current.userId !== normalizedUserId) return database;
    const status = cleanText(snapshot.status, 40);
    const rawProgress = Number(snapshot.progress);
    const progress = Number.isFinite(rawProgress)
      ? Math.min(100, Math.max(0, rawProgress))
      : current.progress;
    const nestedResult = snapshot.result && typeof snapshot.result === 'object' && !Array.isArray(snapshot.result)
      ? snapshot.result as Record<string, unknown>
      : undefined;
    const artifacts = sanitizeArtifacts(snapshot.artifacts ?? nestedResult?.artifacts);
    const rawError = snapshot.error && typeof snapshot.error === 'object' && !Array.isArray(snapshot.error)
      ? snapshot.error as Record<string, unknown>
      : undefined;
    const error = cleanText(rawError?.summary ?? rawError?.message ?? snapshot.error, 1_000);
    const terminal = status && ['SUCCEEDED', 'FAILED', 'CANCELLED'].includes(status.toUpperCase());
    const updatedAt = cleanDate(snapshot.updated_at) ?? new Date().toISOString();
    const finishedAt = terminal
      ? cleanDate(snapshot.finished_at) ?? current.finishedAt ?? updatedAt
      : current.finishedAt;
    const mode = current.mode ?? inferredMode(snapshot.kind);
    updated = true;
    return {
      jobs: {
        ...database.jobs,
        [normalizedJobId]: {
          ...current,
          updatedAt,
          ...(finishedAt ? { finishedAt } : {}),
          ...(mode ? { mode } : {}),
          ...(status ? { status } : {}),
          ...(progress !== undefined ? { progress } : {}),
          ...(error ? { error } : {}),
          ...(artifacts.length ? { artifacts } : {}),
        },
      },
    };
  });
  return updated;
}

export async function listAssetJobHistory(
  userId: string,
  mode: AssetHistoryMode | undefined,
  limit = 30,
) {
  const database = await readOwnershipDatabase();
  return Object.entries(database.jobs)
    .filter(([, record]) => record.userId === userId && (!mode || record.mode === mode))
    .sort(([leftId, left], [rightId, right]) => {
      const delta = Date.parse(right.createdAt) - Date.parse(left.createdAt);
      return Number.isFinite(delta) && delta !== 0 ? delta : rightId.localeCompare(leftId);
    })
    .slice(0, Math.min(100, Math.max(1, Math.trunc(limit) || 30)))
    .map(([jobId, record]) => ({ jobId, ...record }));
}

export async function userOwnsAssetJob(jobId: string, userId: string) {
  const database = await readOwnershipDatabase();
  return database.jobs[jobId]?.userId === userId;
}
