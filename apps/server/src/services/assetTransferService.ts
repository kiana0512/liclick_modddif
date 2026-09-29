import { createHash } from 'node:crypto';
import path from 'node:path';
import {
  ASSET_TRANSFER_PROTOCOL_VERSION,
  type AssetTransferCategory,
  type CompleteAssetUploadIntent,
  type CreateAssetUploadIntent,
} from '@liclick/contracts';
import { serverConfig } from '../config.js';
import { projectRepository } from '../repositories/projectRepository.js';
import { postgresControlRepository } from '../repositories/postgresControlRepository.js';
import type { SavedAsset } from '../types/asset.js';
import { ObjectIntegrityError, verifyObjectIntegrity } from './objectIntegrityService.js';
import { createS3Presigner } from './s3PresignedUrlService.js';
import {
  createId,
  ensureDir,
  readJsonFile,
  slugify,
  writeJsonFile,
} from './workspaceService.js';

type StoredAssetTransfer = {
  schemaVersion: 1;
  intentId: string;
  assetId: string;
  userId: string;
  projectId: string;
  category: AssetTransferCategory;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  sha256: string;
  objectKey: string;
  status: 'pending' | 'verified';
  createdAt: string;
  expiresAt: string;
  verifiedAt?: string;
};

export class AssetTransferError extends Error {
  constructor(
    message: string,
    readonly statusCode: number,
    readonly code: string,
  ) {
    super(message);
    this.name = 'AssetTransferError';
  }
}

function assertObjectStorageConfigured() {
  if (!serverConfig.objectStorage.enabled) {
    throw new AssetTransferError(
      'Cloud object storage is not configured.',
      503,
      'OBJECT_STORAGE_UNAVAILABLE',
    );
  }
  return serverConfig.objectStorage;
}

function userStorageKey(userId: string) {
  return createHash('sha256').update(userId).digest('hex');
}

function transferRoot(userId: string) {
  return path.join(
    serverConfig.workspaceDir,
    'asset-transfers',
    'users',
    userStorageKey(userId),
  );
}

function intentPath(userId: string, intentId: string) {
  return path.join(transferRoot(userId), 'intents', `${intentId}.json`);
}

function assetPath(userId: string, assetId: string) {
  return path.join(transferRoot(userId), 'assets', `${assetId}.json`);
}

function safeObjectFilename(filename: string) {
  const parsed = path.parse(filename);
  const extension = parsed.ext.replace(/[^a-zA-Z0-9.]/g, '').toLowerCase().slice(0, 16);
  return `${slugify(parsed.name).slice(0, 80)}${extension}`;
}

function checksumBase64(sha256: string) {
  return Buffer.from(sha256, 'hex').toString('base64');
}

function presigner() {
  const config = assertObjectStorageConfigured();
  return createS3Presigner(config);
}

// For requests this server makes itself, rather than URLs handed to a browser.
// Defaults to the same endpoint, so behaviour is unchanged unless
// LICLICK_OBJECT_STORAGE_INTERNAL_ENDPOINT is set; when it is, verification
// reaches the storage service directly instead of looping back out through
// the public ingress (and stops depending on public DNS/TLS resolving from
// inside the cluster). The signature covers `host`, so this must be signed
// against whichever endpoint the request is actually sent to.
function internalPresigner() {
  const config = assertObjectStorageConfigured();
  return createS3Presigner({ ...config, endpoint: config.internalEndpoint });
}

function objectKeyFor(input: {
  userId: string;
  projectId: string;
  assetId: string;
  filename: string;
}) {
  return [
    'users',
    userStorageKey(input.userId),
    'projects',
    input.projectId,
    input.assetId,
    safeObjectFilename(input.filename),
  ].join('/');
}

function durableAssetUrl(projectId: string, assetId: string) {
  const base = serverConfig.publicWorkspaceUrl.replace(/\/$/, '');
  return `${base}/api/projects/${encodeURIComponent(projectId)}/assets/${encodeURIComponent(assetId)}/content`;
}

function savedAsset(record: StoredAssetTransfer): SavedAsset {
  return {
    category: record.category,
    relativePath: `objects/${record.assetId}`,
    url: durableAssetUrl(record.projectId, record.assetId),
  };
}

async function readIntent(userId: string, intentId: string) {
  if (postgresControlRepository) {
    return postgresControlRepository.getAssetTransferByIntent<StoredAssetTransfer>(userId, intentId);
  }
  return readJsonFile<StoredAssetTransfer | undefined>(intentPath(userId, intentId), undefined);
}

async function persistTransfer(record: StoredAssetTransfer) {
  if (postgresControlRepository) {
    await postgresControlRepository.putAssetTransfer(record);
    return;
  }
  await ensureDir(path.dirname(intentPath(record.userId, record.intentId)));
  await writeJsonFile(intentPath(record.userId, record.intentId), record);
  if (record.status === 'verified') {
    await ensureDir(path.dirname(assetPath(record.userId, record.assetId)));
    await writeJsonFile(assetPath(record.userId, record.assetId), record);
  }
}

export async function createAssetUploadIntent(
  userId: string,
  projectId: string,
  input: CreateAssetUploadIntent,
) {
  const config = assertObjectStorageConfigured();
  if (!(await projectRepository.findSlug(userId, projectId))) return undefined;
  const intentId = createId('intent');
  const assetId = createId('asset');
  const now = new Date();
  const expiresAt = new Date(now.getTime() + config.signedUrlTtlSeconds * 1000);
  const objectKey = objectKeyFor({ userId, projectId, assetId, filename: input.filename });
  const checksum = checksumBase64(input.sha256);
  const uploadHeaders = {
    'content-type': input.mimeType,
    'x-amz-checksum-sha256': checksum,
    'x-amz-meta-liclick-sha256': input.sha256,
  };
  const record: StoredAssetTransfer = {
    schemaVersion: 1,
    intentId,
    assetId,
    userId,
    projectId,
    category: input.category,
    filename: input.filename,
    mimeType: input.mimeType,
    sizeBytes: input.sizeBytes,
    sha256: input.sha256,
    objectKey,
    status: 'pending',
    createdAt: now.toISOString(),
    expiresAt: expiresAt.toISOString(),
  };
  await persistTransfer(record);
  return {
    protocolVersion: ASSET_TRANSFER_PROTOCOL_VERSION,
    intentId,
    assetId,
    projectId,
    category: input.category,
    filename: input.filename,
    mimeType: input.mimeType,
    sizeBytes: input.sizeBytes,
    sha256: input.sha256,
    upload: {
      method: 'PUT' as const,
      url: presigner()({
        method: 'PUT',
        objectKey,
        expiresInSeconds: config.signedUrlTtlSeconds,
        headers: uploadHeaders,
        now,
      }),
      headers: uploadHeaders,
      expiresAt: expiresAt.toISOString(),
    },
  };
}

export async function saveProxiedObjectStorageAsset(input: {
  userId: string;
  projectId: string;
  category: AssetTransferCategory;
  filename: string;
  mimeType: string;
  buffer: Buffer;
}): Promise<SavedAsset | undefined> {
  const sha256 = createHash('sha256').update(input.buffer).digest('hex');
  const intent = await createAssetUploadIntent(input.userId, input.projectId, {
    protocolVersion: ASSET_TRANSFER_PROTOCOL_VERSION,
    category: input.category,
    filename: input.filename,
    mimeType: input.mimeType,
    sizeBytes: input.buffer.byteLength,
    sha256,
  });
  if (!intent) return undefined;
  const upload = await fetch(intent.upload.url, {
    method: intent.upload.method,
    headers: intent.upload.headers,
    body: Uint8Array.from(input.buffer),
  });
  if (!upload.ok) {
    throw new AssetTransferError(
      `Object storage proxy upload failed (${upload.status}).`,
      502,
      'ASSET_PROXY_UPLOAD_FAILED',
    );
  }
  const result = await completeAssetUploadIntent(
    input.userId,
    input.projectId,
    intent.intentId,
    {
      protocolVersion: ASSET_TRANSFER_PROTOCOL_VERSION,
      assetId: intent.assetId,
      sha256,
    },
  );
  return result.asset;
}

const pendingCompletions = new Map<string, Promise<{ asset: SavedAsset; replayed: boolean }>>();

export async function completeAssetUploadIntent(
  userId: string,
  projectId: string,
  intentId: string,
  input: CompleteAssetUploadIntent,
) {
  const config = assertObjectStorageConfigured();
  const record = await readIntent(userId, intentId);
  if (!record || record.projectId !== projectId || record.assetId !== input.assetId) {
    throw new AssetTransferError('Asset upload intent was not found.', 404, 'ASSET_INTENT_NOT_FOUND');
  }
  if (record.sha256 !== input.sha256) {
    throw new AssetTransferError('Asset upload checksum does not match the intent.', 409, 'ASSET_CHECKSUM_MISMATCH');
  }
  if (record.status === 'verified') {
    await persistTransfer(record);
    return { asset: savedAsset(record), replayed: true };
  }
  if (Date.parse(record.expiresAt) < Date.now()) {
    throw new AssetTransferError('Asset upload intent has expired.', 410, 'ASSET_INTENT_EXPIRED');
  }
  const key = JSON.stringify([userId, projectId, intentId]);
  const existing = pendingCompletions.get(key);
  if (existing) return existing;
  const completion = (async () => {
    try {
      await verifyObjectIntegrity({
        ...record,
        url: (method, headers) => internalPresigner()({
          method, headers, objectKey: record.objectKey,
          expiresInSeconds: Math.min(120, config.signedUrlTtlSeconds),
        }),
      });
    } catch (error) {
      if (error instanceof ObjectIntegrityError) {
        throw new AssetTransferError(error.message, error.statusCode, error.code);
      }
      throw error;
    }
    const verified: StoredAssetTransfer = {
      ...record,
      status: 'verified',
      verifiedAt: new Date().toISOString(),
    };
    await persistTransfer(verified);
    return { asset: savedAsset(verified), replayed: false };
  })();
  pendingCompletions.set(key, completion);
  try { return await completion; }
  finally { if (pendingCompletions.get(key) === completion) pendingCompletions.delete(key); }

}

export async function createAssetDownloadUrl(
  userId: string,
  projectId: string,
  assetId: string,
) {
  const config = assertObjectStorageConfigured();
  const record = await readVerifiedAssetTransfer(userId, projectId, assetId);
  if (!record) return undefined;
  return presigner()({
    method: 'GET',
    objectKey: record.objectKey,
    expiresInSeconds: Math.min(300, config.signedUrlTtlSeconds),
  });
}

async function readVerifiedAssetTransfer(userId: string, projectId: string, assetId: string) {
  const record = postgresControlRepository
    ? await postgresControlRepository.getAssetTransferByAsset<StoredAssetTransfer>(userId, assetId)
    : await readJsonFile<StoredAssetTransfer | undefined>(assetPath(userId, assetId), undefined);
  return record?.projectId === projectId && record.status === 'verified' ? record : undefined;
}

/** Same-origin fallback for a browser whose signed public GET is blocked by CORS. */
export async function createInternalAssetDownload(
  userId: string,
  projectId: string,
  assetId: string,
) {
  const config = assertObjectStorageConfigured();
  const record = await readVerifiedAssetTransfer(userId, projectId, assetId);
  if (!record) return undefined;
  return {
    url: internalPresigner()({
      method: 'GET',
      objectKey: record.objectKey,
      expiresInSeconds: Math.min(120, config.signedUrlTtlSeconds),
    }),
    mimeType: record.mimeType,
    sizeBytes: record.sizeBytes,
  };
}

export async function deleteObjectStorageObject(objectKey: string) {
  const config = assertObjectStorageConfigured();
  if (
    !objectKey ||
    objectKey.startsWith('/') ||
    objectKey.includes('\\') ||
    objectKey.split('/').some((segment) => !segment || segment === '.' || segment === '..')
  ) {
    throw new AssetTransferError('Object storage key is invalid.', 400, 'ASSET_OBJECT_KEY_INVALID');
  }
  const deleteUrl = presigner()({
    method: 'DELETE',
    objectKey,
    expiresInSeconds: Math.min(120, config.signedUrlTtlSeconds),
  });
  let lastStatus = 0;
  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const response = await fetch(deleteUrl, {
        method: 'DELETE',
        signal: AbortSignal.timeout(30_000),
      });
      lastStatus = response.status;
      if (response.ok || response.status === 404) return;
      if (response.status !== 429 && response.status < 500) break;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 100 * 2 ** attempt));
  }
  throw new AssetTransferError(
    `Object storage delete failed (${lastStatus || (lastError instanceof Error ? lastError.message : 'network error')}).`,
    502,
    'ASSET_OBJECT_DELETE_FAILED',
  );
}
