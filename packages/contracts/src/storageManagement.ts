export const STORAGE_OVERVIEW_SCHEMA_VERSION = 1 as const;
export const STORAGE_INVENTORY_RULE_VERSION = 'STORAGE-INVENTORY-001/4' as const;

export const STORAGE_BUCKET_IDS = [
  'project-resources',
  'history',
  'temporary',
  'trash',
] as const;

export type StorageBucketId = (typeof STORAGE_BUCKET_IDS)[number];
export type StorageBackend = 'workspace-file' | 'cloud-object-storage';
export type StorageOverviewStatus = 'ready' | 'scanning' | 'failed' | 'unavailable';
export type StorageScanPhase = 'references' | 'assets' | 'retention' | 'persisting';

export type StorageBucketSummary = {
  id: StorageBucketId;
  bytes: number;
  itemCount: number;
  reclaimable: boolean;
  protected: boolean;
};

export type StorageOverview = {
  schemaVersion: typeof STORAGE_OVERVIEW_SCHEMA_VERSION;
  ruleVersion: typeof STORAGE_INVENTORY_RULE_VERSION;
  backend: StorageBackend;
  status: StorageOverviewStatus;
  scanId?: string;
  usedBytes?: number;
  reclaimableBytes?: number;
  quarantineDays?: number;
  scanPhase?: StorageScanPhase;
  scanStartedAt?: string;
  scannedItemCount?: number;
  scanDurationMs?: number;
  lastScannedAt?: string;
  buckets: StorageBucketSummary[];
  issue?: string;
};

export type StartStorageScanResponse = {
  accepted: boolean;
  overview: StorageOverview;
};

export type StartStorageCleanupRequest = {
  scanId: string;
  idempotencyKey: string;
};

export type StorageCleanupJobStatus = 'queued' | 'running' | 'completed' | 'failed';
export type StorageCleanupJobPhase = 'verifying' | 'quarantining';

export type StorageCleanupJob = {
  schemaVersion: 1;
  jobId: string;
  scanId: string;
  status: StorageCleanupJobStatus;
  phase?: StorageCleanupJobPhase;
  backend: StorageBackend;
  candidateBytes: number;
  candidateCount: number;
  processedBytes: number;
  processedCount: number;
  skippedCount: number;
  verifiedCount?: number;
  quarantineDays?: number;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
  error?: string;
};

export type StoragePurgeJobStatus = 'queued' | 'running' | 'completed' | 'failed';
export type StoragePurgeJobPhase = 'detaching' | 'deleting';

export type StoragePurgeJob = {
  schemaVersion: 1;
  jobId: string;
  status: StoragePurgeJobStatus;
  phase?: StoragePurgeJobPhase;
  backend: StorageBackend;
  cleanupJobIds: string[];
  targetBytes: number;
  targetCount: number;
  createdAt: string;
  updatedAt: string;
  detachedAt?: string;
  completedAt?: string;
  error?: string;
};

export type StorageQuarantineStatus = {
  backend: StorageBackend;
  bytes: number;
  itemCount: number;
  purgeSupported: boolean;
  purgeUnavailableReason?: string;
  activePurgeJob?: StoragePurgeJob;
};

export type StartStoragePurgeRequest = {
  idempotencyKey: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

export function parseStartStorageCleanupRequest(value: unknown): StartStorageCleanupRequest {
  if (!isRecord(value)) throw new Error('Storage cleanup request must be an object.');
  const scanId = typeof value.scanId === 'string' ? value.scanId.trim() : '';
  const idempotencyKey =
    typeof value.idempotencyKey === 'string' ? value.idempotencyKey.trim() : '';
  if (!/^scan-[a-zA-Z0-9_-]{8,128}$/.test(scanId)) {
    throw new Error('Storage cleanup scanId is invalid.');
  }
  if (!/^[a-zA-Z0-9_-]{16,160}$/.test(idempotencyKey)) {
    throw new Error('Storage cleanup idempotencyKey is invalid.');
  }
  return { scanId, idempotencyKey };
}

export function parseStartStoragePurgeRequest(value: unknown): StartStoragePurgeRequest {
  if (!isRecord(value)) throw new Error('Storage purge request must be an object.');
  const idempotencyKey =
    typeof value.idempotencyKey === 'string' ? value.idempotencyKey.trim() : '';
  if (!/^[a-zA-Z0-9_-]{16,160}$/.test(idempotencyKey)) {
    throw new Error('Storage purge idempotencyKey is invalid.');
  }
  return { idempotencyKey };
}
