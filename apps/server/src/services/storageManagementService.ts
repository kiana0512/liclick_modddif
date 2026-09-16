import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import type { Dirent } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import readline from 'node:readline';
import {
  STORAGE_INVENTORY_RULE_VERSION,
  STORAGE_OVERVIEW_SCHEMA_VERSION,
  type StorageBackend,
  type StorageBucketId,
  type StorageBucketSummary,
  type StorageCleanupJob,
  type StorageOverview,
  type StoragePurgeJob,
  type StorageQuarantineStatus,
  type StorageScanPhase,
} from '@liclick/contracts';
import {
  postgresAssetStorageRepository,
  type LegacyStorageAsset,
  type StorageDocumentCursor,
  type StorageDocumentKind,
  type StorageInventoryCandidate,
} from '../repositories/postgresAssetStorageRepository.js';
import {
  ensureDir,
  getUserDir,
  getUserProjectsDir,
  getUsersDir,
  readJsonFile,
  writeJsonFile,
} from './workspaceService.js';
import {
  runWithWorkspaceAssetMutationLock,
  workspaceAssetMutationKey,
} from './workspaceAssetMutationCoordinator.js';

const assetCategories = new Set([
  'models',
  'references',
  'captures',
  'generations',
  'layers',
  'baked',
]);
const cloudAssetIdPattern = /(?:\/assets\/|objects\/)(asset-[a-zA-Z0-9_-]{8,128})(?:\/content)?/g;
const localAssetPathPattern = /assets\/(models|references|captures|generations|layers|baked)\/([^"'<>\s?#]+)/g;
const localSnapshotFilename = 'inventory-v1.json';
const inventoryCandidateDirectoryName = 'inventory-candidates';
const cleanupJobDirectoryName = 'cleanup-jobs';
const purgeJobDirectoryName = 'purge-jobs';
const quarantineDirectoryName = 'storage-quarantine';
const purgeDirectoryName = 'storage-purge';
const scanPromises = new Map<string, Promise<StorageOverview>>();
const scanProgress = new Map<string, StorageOverview>();
const scanFailures = new Map<string, StorageOverview>();
const cleanupPromises = new Map<string, Promise<void>>();
const cleanupStartPromises = new Map<string, Promise<StorageCleanupJob | undefined>>();
const purgePromises = new Map<string, Promise<void>>();
const purgeStartPromises = new Map<string, Promise<StoragePurgeJob | undefined>>();
const interruptedCleanupUsers = new Set<string>();

type MutableBucket = StorageBucketSummary;
type LocalCandidate = {
  relativePath: string;
  sizeBytes: number;
  modifiedAtMs: number;
};

type InventoryResult = {
  overview: StorageOverview;
  cloudCandidates: StorageInventoryCandidate[];
};

function backend(): StorageBackend {
  return postgresAssetStorageRepository ? 'cloud-object-storage' : 'workspace-file';
}

function emptyBuckets(): Record<StorageBucketId, MutableBucket> {
  return {
    'project-resources': {
      id: 'project-resources',
      bytes: 0,
      itemCount: 0,
      reclaimable: false,
      protected: true,
    },
    history: {
      id: 'history',
      bytes: 0,
      itemCount: 0,
      reclaimable: false,
      protected: true,
    },
    temporary: {
      id: 'temporary',
      bytes: 0,
      itemCount: 0,
      reclaimable: true,
      protected: false,
    },
    trash: {
      id: 'trash',
      bytes: 0,
      itemCount: 0,
      reclaimable: false,
      protected: true,
    },
  };
}

function addToBucket(bucket: MutableBucket, bytes: number) {
  bucket.bytes += bytes;
  bucket.itemCount += 1;
}

function statConcurrency() {
  const value = Number(process.env.LICLICK_STORAGE_STAT_CONCURRENCY ?? 64);
  if (!Number.isFinite(value)) return 64;
  return Math.max(4, Math.min(128, Math.trunc(value)));
}

function moveConcurrency() {
  const value = Number(process.env.LICLICK_STORAGE_MOVE_CONCURRENCY ?? 32);
  if (!Number.isFinite(value)) return 32;
  return Math.max(2, Math.min(64, Math.trunc(value)));
}

function recentAssetProtectionMs() {
  const minutes = Number(process.env.LICLICK_STORAGE_RECENT_ASSET_PROTECTION_MINUTES ?? 60);
  if (!Number.isFinite(minutes)) return 60 * 60_000;
  return Math.max(15, Math.min(24 * 60, Math.trunc(minutes))) * 60_000;
}

function fastGroupMinimumFiles() {
  const value = Number(process.env.LICLICK_STORAGE_FAST_GROUP_MIN_FILES ?? 10_000);
  if (!Number.isFinite(value)) return 10_000;
  return Math.max(4, Math.min(100_000, Math.trunc(value)));
}

function scanningOverview(storageBackend = backend()): StorageOverview {
  return {
    schemaVersion: STORAGE_OVERVIEW_SCHEMA_VERSION,
    ruleVersion: STORAGE_INVENTORY_RULE_VERSION,
    backend: storageBackend,
    status: 'scanning',
    quarantineDays: getQuarantineDays(),
    buckets: Object.values(emptyBuckets()),
  };
}

function failedOverview(storageBackend: StorageBackend, issue: string): StorageOverview {
  return {
    ...scanningOverview(storageBackend),
    status: 'failed',
    issue,
  };
}

function createScanningProgress(input: {
  backend: StorageBackend;
  buckets: Record<StorageBucketId, MutableBucket>;
  scanId: string;
  startedAt: string;
  phase: StorageScanPhase;
  scannedItemCount: number;
}) {
  const buckets = Object.values(input.buckets).map((bucket) => ({ ...bucket }));
  return {
    schemaVersion: STORAGE_OVERVIEW_SCHEMA_VERSION,
    ruleVersion: STORAGE_INVENTORY_RULE_VERSION,
    backend: input.backend,
    status: 'scanning',
    quarantineDays: getQuarantineDays(),
    scanId: input.scanId,
    scanPhase: input.phase,
    scanStartedAt: input.startedAt,
    scannedItemCount: input.scannedItemCount,
    usedBytes: buckets.reduce((total, bucket) => total + bucket.bytes, 0),
    reclaimableBytes: input.buckets.temporary.bytes,
    buckets,
  } satisfies StorageOverview;
}

function extractCloudAssetIds(value: unknown) {
  const serialized = JSON.stringify(value) ?? '';
  const result = new Set<string>();
  for (const match of serialized.matchAll(cloudAssetIdPattern)) {
    if (match[1]) result.add(match[1]);
  }
  return result;
}

function normalizeLocalAssetPath(category: string, encodedName: string) {
  if (!assetCategories.has(category)) return undefined;
  let name = encodedName.replaceAll('\\\\', '/').replaceAll('\\', '/');
  try {
    name = decodeURIComponent(name);
  } catch {
    return undefined;
  }
  name = name.split('/').filter(Boolean).join('/');
  if (!name || name.includes('../') || path.posix.isAbsolute(name)) return undefined;
  return `assets/${category}/${name}`;
}

function extractLocalAssetPaths(content: string) {
  const result = new Set<string>();
  for (const match of content.matchAll(localAssetPathPattern)) {
    const normalized = normalizeLocalAssetPath(match[1] ?? '', match[2] ?? '');
    if (normalized) result.add(normalized);
  }
  return result;
}

async function visitFiles(
  root: string,
  visitor: (file: {
    absolutePath: string;
    relativePath: string;
    sizeBytes: number;
    modifiedAtMs: number;
  }) => void | Promise<void>,
  onSymbolicLink?: (absolutePath: string) => void,
) {
  const stack = [root];
  const concurrency = statConcurrency();
  while (stack.length > 0) {
    const directory = stack.pop();
    if (!directory) continue;
    let handle;
    try {
      handle = await fs.opendir(directory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw error;
    }
    let files: Array<{ absolutePath: string; relativePath: string }> = [];
    const flush = async () => {
      if (files.length === 0) return;
      const batch = files;
      files = [];
      const measured = await Promise.all(
        batch.map(async (file) => {
          try {
            const stat = await fs.stat(file.absolutePath);
            return { ...file, sizeBytes: stat.size, modifiedAtMs: stat.mtimeMs };
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
            throw error;
          }
        }),
      );
      for (const file of measured) {
        if (file) await visitor(file);
      }
    };
    for await (const entry of handle) {
      const absolutePath = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) {
        onSymbolicLink?.(absolutePath);
        continue;
      }
      if (entry.isDirectory()) {
        stack.push(absolutePath);
        continue;
      }
      if (!entry.isFile()) continue;
      files.push({
        absolutePath,
        relativePath: path.relative(root, absolutePath).replaceAll('\\', '/'),
      });
      if (files.length >= concurrency) await flush();
    }
    await flush();
  }
}

function localStorageMetadataDir(userId: string) {
  return path.join(getUserDir(userId), 'storage');
}

function localSnapshotPath(userId: string) {
  return path.join(localStorageMetadataDir(userId), localSnapshotFilename);
}

function localCleanupJobPath(userId: string, jobId: string) {
  return path.join(localStorageMetadataDir(userId), cleanupJobDirectoryName, `${jobId}.json`);
}

function localPurgeJobPath(userId: string, jobId: string) {
  return path.join(localStorageMetadataDir(userId), purgeJobDirectoryName, `${jobId}.json`);
}

async function listLocalCleanupJobs(userId: string) {
  const directory = path.join(localStorageMetadataDir(userId), cleanupJobDirectoryName);
  let entries: Dirent[];
  try {
    entries = await fs.readdir(directory, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  const jobs = await Promise.all(
    entries.map(async (entry) => {
      if (!entry.isFile() || !/^cleanup-[a-zA-Z0-9_-]{8,128}\.json$/.test(entry.name)) {
        return undefined;
      }
      return readJsonFile<StorageCleanupJob | undefined>(path.join(directory, entry.name), undefined);
    }),
  );
  return jobs.filter((job): job is StorageCleanupJob => Boolean(job));
}

async function getActiveLocalCleanupJob(userId: string) {
  const active = (await listLocalCleanupJobs(userId))
    .filter((job) => job.status === 'queued' || job.status === 'running')
    .sort((left, right) => Date.parse(left.createdAt) - Date.parse(right.createdAt));
  return active[0];
}

async function listLocalPurgeJobs(userId: string) {
  const directory = path.join(localStorageMetadataDir(userId), purgeJobDirectoryName);
  let entries: Dirent[];
  try {
    entries = await fs.readdir(directory, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  const jobs = await Promise.all(
    entries.map(async (entry) => {
      if (!entry.isFile() || !/^purge-[a-zA-Z0-9_-]{8,128}\.json$/.test(entry.name)) {
        return undefined;
      }
      return readJsonFile<StoragePurgeJob | undefined>(path.join(directory, entry.name), undefined);
    }),
  );
  return jobs.filter((job): job is StoragePurgeJob => Boolean(job));
}

async function getActiveLocalPurgeJob(userId: string) {
  const active = (await listLocalPurgeJobs(userId))
    .filter((job) => job.status === 'queued' || job.status === 'running')
    .sort((left, right) => Date.parse(left.createdAt) - Date.parse(right.createdAt));
  return active[0];
}

export async function initializeStorageManagement() {
  if (postgresAssetStorageRepository) return;
  let users: Dirent[];
  try {
    users = await fs.readdir(getUsersDir(), { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  for (const user of users) {
    if (!user.isDirectory() || user.isSymbolicLink()) continue;
    const jobs = await listLocalCleanupJobs(user.name);
    const interrupted = jobs.filter(
      (job) => job.status === 'queued' || job.status === 'running',
    );
    if (interrupted.length > 0) {
      interruptedCleanupUsers.add(user.name);
      await Promise.all(
        interrupted.map((job) =>
          writeJsonFile(localCleanupJobPath(user.name, job.jobId), {
            ...job,
            status: 'failed',
            phase: undefined,
            updatedAt: new Date().toISOString(),
            error:
              'Cleanup was interrupted by a service restart. Already quarantined files remain recoverable; a fresh scan will continue with only the remaining candidates.',
          } satisfies StorageCleanupJob),
        ),
      );
    }
    const purgeJobs = await listLocalPurgeJobs(user.name);
    for (const purgeJob of purgeJobs) {
      if (purgeJob.status === 'queued' || purgeJob.status === 'running') {
        scheduleLocalPurge(user.name, purgeJob);
      }
    }
  }
}

function localInventoryCandidateManifestPath(userId: string, scanId: string) {
  return path.join(
    localStorageMetadataDir(userId),
    inventoryCandidateDirectoryName,
    `${scanId}.ndjson`,
  );
}

async function readLocalReferenceSets(projectDirectory: string) {
  const current = new Set<string>();
  const retained = new Set<string>();
  let metadataBytes = 0;
  let metadataCount = 0;
  const stack = [projectDirectory];
  while (stack.length > 0) {
    const directory = stack.pop();
    if (!directory) continue;
    let entries;
    try {
      entries = await fs.readdir(directory, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw error;
    }
    for (const entry of entries) {
      const absolutePath = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        if (entry.name === 'assets') continue;
        stack.push(absolutePath);
        continue;
      }
      if (!entry.isFile() || !/\.(?:json|bak)$/i.test(entry.name)) continue;
      const stat = await fs.stat(absolutePath);
      if (stat.size > 128 * 1024 * 1024) {
        throw new Error(`Project metadata is too large to scan safely: ${absolutePath}`);
      }
      const content = await fs.readFile(absolutePath, 'utf8');
      metadataBytes += stat.size;
      metadataCount += 1;
      const references = extractLocalAssetPaths(content);
      const isCurrent = path.dirname(absolutePath) === projectDirectory && /\.json$/i.test(entry.name);
      for (const reference of references) {
        retained.add(reference);
        if (isCurrent) current.add(reference);
      }
    }
  }
  return { current, retained, metadataBytes, metadataCount };
}

async function summarizeLocalQuarantine(userId: string) {
  const [cleanupJobs, purgeJobs] = await Promise.all([
    listLocalCleanupJobs(userId),
    listLocalPurgeJobs(userId),
  ]);
  const claimedCleanupJobIds = new Set(
    purgeJobs.flatMap((job) => job.cleanupJobIds),
  );
  const quarantine = cleanupJobs.reduce(
    (summary, job) => {
      if (claimedCleanupJobIds.has(job.jobId)) return summary;
      summary.bytes += Math.max(0, job.processedBytes);
      summary.itemCount += Math.max(0, job.processedCount);
      return summary;
    },
    { bytes: 0, itemCount: 0 },
  );
  const detached = purgeJobs.reduce(
    (summary, job) => {
      if (job.status === 'completed') return summary;
      summary.bytes += Math.max(0, job.targetBytes);
      summary.itemCount += Math.max(0, job.targetCount);
      return summary;
    },
    { bytes: 0, itemCount: 0 },
  );
  const retryable = purgeJobs.reduce(
    (summary, job) => {
      if (job.status !== 'failed') return summary;
      summary.bytes += Math.max(0, job.targetBytes);
      summary.itemCount += Math.max(0, job.targetCount);
      return summary;
    },
    { bytes: 0, itemCount: 0 },
  );
  return {
    quarantineBytes: quarantine.bytes,
    quarantineItemCount: quarantine.itemCount,
    retainedBytes: quarantine.bytes + detached.bytes,
    retainedItemCount: quarantine.itemCount + detached.itemCount,
    retryablePurgeBytes: retryable.bytes,
    retryablePurgeItemCount: retryable.itemCount,
  };
}

async function scanLocalStorage(
  userId: string,
  scanId: string,
  onCandidate?: (candidate: LocalCandidate) => void | Promise<void>,
  onProgress?: (overview: StorageOverview) => void,
  startedAt = new Date().toISOString(),
): Promise<InventoryResult> {
  const buckets = emptyBuckets();
  const recentProtectionBoundary = Date.parse(startedAt) - recentAssetProtectionMs();
  let scannedItemCount = 0;
  let lastProgressAt = 0;
  const reportProgress = (phase: StorageScanPhase, force = false) => {
    const now = Date.now();
    if (!force && scannedItemCount % 2_048 !== 0 && now - lastProgressAt < 500) return;
    lastProgressAt = now;
    onProgress?.(
      createScanningProgress({
        backend: 'workspace-file',
        buckets,
        scanId,
        startedAt,
        phase,
        scannedItemCount,
      }),
    );
  };
  reportProgress('references', true);
  const projectsRoot = getUserProjectsDir(userId);
  let projectEntries: Dirent[];
  try {
    projectEntries = await fs.readdir(projectsRoot, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    projectEntries = [];
  }
  for (const projectEntry of projectEntries) {
    if (!projectEntry.isDirectory() || projectEntry.isSymbolicLink()) continue;
    const projectDirectory = path.join(projectsRoot, projectEntry.name);
    const references = await readLocalReferenceSets(projectDirectory);
    scannedItemCount += references.metadataCount;
    reportProgress('references');
    const assetRoot = path.join(projectDirectory, 'assets');
    await visitFiles(assetRoot, async (file) => {
      const projectRelativePath = `assets/${file.relativePath}`;
      if (references.current.has(projectRelativePath)) {
        addToBucket(buckets['project-resources'], file.sizeBytes);
      } else if (references.retained.has(projectRelativePath)) {
        addToBucket(buckets.history, file.sizeBytes);
      } else if (file.modifiedAtMs >= recentProtectionBoundary) {
        addToBucket(buckets['project-resources'], file.sizeBytes);
      } else {
        addToBucket(buckets.temporary, file.sizeBytes);
        if (onCandidate) {
          await onCandidate({
            relativePath: path
              .relative(projectsRoot, file.absolutePath)
              .replaceAll('\\', '/'),
            sizeBytes: file.sizeBytes,
            modifiedAtMs: file.modifiedAtMs,
          });
        }
      }
      scannedItemCount += 1;
      reportProgress('assets');
    });
    buckets.history.bytes += references.metadataBytes;
    buckets.history.itemCount += references.metadataCount;
  }

  await visitFiles(path.join(getUserDir(userId), 'trash'), (file) => {
    addToBucket(buckets.trash, file.sizeBytes);
    scannedItemCount += 1;
    reportProgress('retention');
  });
  const quarantine = await summarizeLocalQuarantine(userId);
  buckets.trash.bytes += quarantine.retainedBytes;
  buckets.trash.itemCount += quarantine.retainedItemCount;
  scannedItemCount += quarantine.retainedItemCount;
  reportProgress('retention', true);
  await visitFiles(path.join(getUserDir(userId), 'recoveries'), (file) => {
    addToBucket(buckets['project-resources'], file.sizeBytes);
    scannedItemCount += 1;
    reportProgress('retention');
  });
  reportProgress('persisting', true);

  const bucketList = Object.values(buckets);
  const completedAt = new Date().toISOString();
  return {
    overview: {
      schemaVersion: STORAGE_OVERVIEW_SCHEMA_VERSION,
      ruleVersion: STORAGE_INVENTORY_RULE_VERSION,
      backend: 'workspace-file',
      status: 'ready',
      quarantineDays: getQuarantineDays(),
      scanId,
      usedBytes: bucketList.reduce((total, bucket) => total + bucket.bytes, 0),
      reclaimableBytes: buckets.temporary.bytes,
      lastScannedAt: completedAt,
      buckets: bucketList,
    },
    cloudCandidates: [],
  };
}

function classifyCloudAsset(
  asset: LegacyStorageAsset,
): StorageBucketId {
  if (asset.quarantined) return 'trash';
  return asset.referenceBucket ?? 'temporary';
}

function cloudDocumentPageSize() {
  const configured = Number(process.env.LICLICK_STORAGE_DOCUMENT_PAGE_SIZE ?? 8);
  if (!Number.isFinite(configured)) return 8;
  return Math.max(1, Math.min(32, Math.trunc(configured)));
}

function cloudAssetPageSize() {
  const configured = Number(process.env.LICLICK_STORAGE_ASSET_PAGE_SIZE ?? 256);
  if (!Number.isFinite(configured)) return 256;
  return Math.max(16, Math.min(512, Math.trunc(configured)));
}

function referenceBucket(kind: StorageDocumentKind): Exclude<StorageBucketId, 'temporary'> {
  if (kind === 'current') return 'project-resources';
  return kind;
}

async function scanCloudStorage(userId: string, scanId: string): Promise<InventoryResult> {
  if (!postgresAssetStorageRepository) throw new Error('Cloud storage repository is unavailable.');
  await postgresAssetStorageRepository.beginInventoryScan(userId, scanId);
  const startedAt = scanProgress.get(userId)?.scanStartedAt ?? new Date().toISOString();
  const buckets = emptyBuckets();
  let scannedItemCount = 0;
  const reportProgress = (phase: StorageScanPhase) => {
    scanProgress.set(userId, createScanningProgress({
      backend: 'cloud-object-storage',
      buckets,
      scanId,
      startedAt,
      phase,
      scannedItemCount,
    }));
  };
  for (const kind of ['current', 'history', 'trash'] satisfies StorageDocumentKind[]) {
    let cursor: StorageDocumentCursor | undefined;
    do {
      const page = await postgresAssetStorageRepository.listStorageDocumentPage(
        userId,
        kind,
        cursor,
        cloudDocumentPageSize(),
      );
      const bucket = referenceBucket(kind);
      let references: Array<{
        assetId: string;
        bucketId: Exclude<StorageBucketId, 'temporary'>;
      }> = [];
      for (const document of page.documents) {
        for (const assetId of document.assetIds) {
          references.push({ assetId, bucketId: bucket });
          if (references.length >= 1_000) {
            await postgresAssetStorageRepository.appendInventoryReferences({
              userId,
              scanId,
              references,
            });
            references = [];
          }
        }
        scannedItemCount += 1;
      }
      await postgresAssetStorageRepository.appendInventoryReferences({
        userId,
        scanId,
        references,
      });
      reportProgress('references');
      cursor = page.nextCursor;
      await new Promise<void>((resolve) => setImmediate(resolve));
    } while (cursor);
  }
  let assetCursor: string | undefined;
  do {
    const page = await postgresAssetStorageRepository.listLegacyAssetPage(
      userId,
      scanId,
      assetCursor,
      cloudAssetPageSize(),
    );
    const candidates: StorageInventoryCandidate[] = [];
    for (const asset of page.assets) {
      const bucketId = classifyCloudAsset(asset);
      addToBucket(buckets[bucketId], asset.sizeBytes);
      if (bucketId === 'temporary') {
        candidates.push({
          candidateId: `candidate-${asset.assetId}`,
          assetId: asset.assetId,
          projectId: asset.projectId,
          category: asset.category,
          sizeBytes: asset.sizeBytes,
          proof: {
            ruleVersion: STORAGE_INVENTORY_RULE_VERSION,
            reason: 'not-referenced-by-current-retained-or-trash-project-document',
            objectKeySha256: createHash('sha256').update(asset.objectKey).digest('hex'),
          },
        });
      }
      scannedItemCount += 1;
    }
    await postgresAssetStorageRepository.appendInventoryCandidates({
      userId,
      scanId,
      createdAt: startedAt,
      candidates,
    });
    reportProgress('assets');
    assetCursor = page.nextCursor;
    await new Promise<void>((resolve) => setImmediate(resolve));
  } while (assetCursor);
  const bucketList = Object.values(buckets);
  const completedAt = new Date().toISOString();
  return {
    overview: {
      schemaVersion: STORAGE_OVERVIEW_SCHEMA_VERSION,
      ruleVersion: STORAGE_INVENTORY_RULE_VERSION,
      backend: 'cloud-object-storage',
      status: 'ready',
      quarantineDays: getQuarantineDays(),
      scanId,
      usedBytes: bucketList.reduce((total, bucket) => total + bucket.bytes, 0),
      reclaimableBytes: buckets.temporary.bytes,
      lastScannedAt: completedAt,
      buckets: bucketList,
    },
    cloudCandidates: [],
  };
}

async function persistInventory(userId: string, result: InventoryResult, startedAt: string) {
  if (postgresAssetStorageRepository) {
    await postgresAssetStorageRepository.completeInventoryScan({
      userId,
      overview: result.overview,
      startedAt,
    });
    return;
  }
  await ensureDir(localStorageMetadataDir(userId));
  await writeJsonFile(localSnapshotPath(userId), result.overview);
}

async function discardFailedInventory(userId: string, scanId: string) {
  if (!postgresAssetStorageRepository) return;
  try {
    await postgresAssetStorageRepository.discardInventoryScan(userId, scanId);
  } catch {
    // A later scan removes orphan staging rows without touching the current snapshot.
  }
}

async function discardStaleLocalCandidateManifests(userId: string, retainedScanId: string) {
  const directory = path.join(localStorageMetadataDir(userId), inventoryCandidateDirectoryName);
  let entries: Dirent[];
  try {
    entries = await fs.readdir(directory, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  const retainedFilename = `${retainedScanId}.ndjson`;
  await Promise.all(
    entries.map(async (entry) => {
      if (!entry.isFile() || entry.name === retainedFilename) return;
      if (!entry.name.endsWith('.ndjson') && !entry.name.endsWith('.tmp')) return;
      await fs.unlink(path.join(directory, entry.name)).catch(() => undefined);
    }),
  );
}

async function runStorageScan(userId: string) {
  const scanId = `scan-${randomUUID()}`;
  const startedAt = new Date().toISOString();
  scanProgress.set(userId, {
    ...scanningOverview(),
    scanId,
    scanStartedAt: startedAt,
    scanPhase: 'references',
    scannedItemCount: 0,
  });
  try {
    const result = postgresAssetStorageRepository
      ? await scanCloudStorage(userId, scanId)
      : await scanLocalStorageToManifest(
          userId,
          scanId,
          localInventoryCandidateManifestPath(userId, scanId),
          (overview) => scanProgress.set(userId, overview),
          startedAt,
        );
    result.overview.scanDurationMs = Math.max(0, Date.now() - Date.parse(startedAt));
    scanProgress.set(userId, {
      ...result.overview,
      status: 'scanning',
      scanPhase: 'persisting',
      scanStartedAt: startedAt,
    });
    await persistInventory(userId, result, startedAt);
    if (!postgresAssetStorageRepository) {
      await discardStaleLocalCandidateManifests(userId, scanId);
    }
    scanFailures.delete(userId);
    return result.overview;
  } catch (error) {
    await discardFailedInventory(userId, scanId);
    const rawIssue = error instanceof Error ? error.message : 'Storage inventory failed.';
    const issue = /statement timeout|canceling statement due to statement timeout/i.test(rawIssue)
      ? '云端存储扫描超过 45 秒，已安全停止本轮扫描；没有移动或删除资产，请稍后重新扫描。'
      : rawIssue;
    const overview = failedOverview(
      backend(),
      issue,
    );
    if (!postgresAssetStorageRepository) {
      await ensureDir(localStorageMetadataDir(userId));
      await writeJsonFile(localSnapshotPath(userId), overview);
    }
    scanFailures.set(userId, overview);
    return overview;
  }
}

export function startStorageScan(userId: string) {
  const existing = scanPromises.get(userId);
  if (existing) return existing;
  scanFailures.delete(userId);
  const promise = runStorageScan(userId).finally(() => {
    if (scanPromises.get(userId) === promise) {
      scanPromises.delete(userId);
      scanProgress.delete(userId);
    }
  });
  scanPromises.set(userId, promise);
  return promise;
}

export async function getStorageOverview(userId: string): Promise<StorageOverview> {
  const activeScan = scanPromises.get(userId);
  if (activeScan) return scanProgress.get(userId) ?? scanningOverview();
  const failedScan = scanFailures.get(userId);
  if (failedScan) return failedScan;
  if (interruptedCleanupUsers.delete(userId)) {
    void startStorageScan(userId);
    return scanProgress.get(userId) ?? scanningOverview();
  }
  let existing: StorageOverview | undefined;
  try {
    existing = postgresAssetStorageRepository
      ? await postgresAssetStorageRepository.getLatestOverview(userId)
      : await readJsonFile<StorageOverview | undefined>(localSnapshotPath(userId), undefined);
  } catch (error) {
    return failedOverview(
      backend(),
      error instanceof Error ? error.message : 'Could not read storage inventory.',
    );
  }
  if (existing) {
    if (existing.ruleVersion !== STORAGE_INVENTORY_RULE_VERSION) {
      void startStorageScan(userId);
      return scanProgress.get(userId) ?? scanningOverview(existing.backend);
    }
    return existing;
  }
  void startStorageScan(userId);
  return scanningOverview();
}

function getQuarantineDays() {
  const value = Number(process.env.LICLICK_STORAGE_QUARANTINE_DAYS ?? 7);
  if (!Number.isFinite(value) || value < 1 || value > 90) return 7;
  return Math.trunc(value);
}

async function scanLocalStorageToManifest(
  userId: string,
  scanId: string,
  manifestPath: string,
  onProgress?: (overview: StorageOverview) => void,
  startedAt?: string,
) {
  await ensureDir(path.dirname(manifestPath));
  const temporaryPath = `${manifestPath}.${randomUUID()}.tmp`;
  const handle = await fs.open(temporaryPath, 'wx');
  let pendingLines: string[] = [];
  const flush = async () => {
    if (pendingLines.length === 0) return;
    const chunk = `${pendingLines.join('\n')}\n`;
    pendingLines = [];
    await handle.appendFile(chunk, 'utf8');
  };
  try {
    const result = await scanLocalStorage(
      userId,
      scanId,
      async (candidate) => {
        pendingLines.push(JSON.stringify(candidate));
        if (pendingLines.length >= 512) await flush();
      },
      onProgress,
      startedAt,
    );
    await flush();
    await handle.sync();
    await handle.close();
    await fs.rename(temporaryPath, manifestPath);
    return result;
  } catch (error) {
    await handle.close().catch(() => undefined);
    await fs.unlink(temporaryPath).catch(() => undefined);
    throw error;
  }
}

async function readLocalReferencesByProject(userId: string) {
  const projectsRoot = getUserProjectsDir(userId);
  const references = new Map<string, Set<string>>();
  let entries: Dirent[];
  try {
    entries = await fs.readdir(projectsRoot, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return references;
    throw error;
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
    const projectReferences = await readLocalReferenceSets(path.join(projectsRoot, entry.name));
    references.set(entry.name, projectReferences.retained);
  }
  return references;
}

function resolveLocalCandidate(input: {
  candidate: LocalCandidate;
  projectsRoot: string;
  quarantineRoot: string;
  referencesByProject: Map<string, Set<string>>;
}) {
  const source = path.resolve(input.projectsRoot, input.candidate.relativePath);
  const sourceRelative = path.relative(input.projectsRoot, source);
  if (
    !sourceRelative ||
    sourceRelative === '..' ||
    sourceRelative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(sourceRelative)
  ) {
    return undefined;
  }
  const normalizedParts = input.candidate.relativePath.split('/').filter(Boolean);
  const projectName = normalizedParts.shift();
  const projectRelativePath = normalizedParts.join('/');
  if (
    !projectName ||
    !projectRelativePath.startsWith('assets/') ||
    input.referencesByProject.get(projectName)?.has(projectRelativePath)
  ) {
    return undefined;
  }
  const destination = path.resolve(input.quarantineRoot, sourceRelative);
  const destinationRelative = path.relative(input.quarantineRoot, destination);
  if (
    destinationRelative === '..' ||
    destinationRelative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(destinationRelative)
  ) {
    return undefined;
  }
  return { source, destination };
}

function localCandidateGroupKey(candidate: LocalCandidate) {
  const parts = candidate.relativePath.split('/').filter(Boolean);
  if (parts.length < 4 || parts[1] !== 'assets' || !assetCategories.has(parts[2] ?? '')) {
    return undefined;
  }
  return parts.slice(0, 3).join('/');
}

function isPathInside(root: string, candidate: string) {
  const relative = path.relative(root, candidate);
  return Boolean(
    relative &&
      relative !== '..' &&
      !relative.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relative),
  );
}

async function removeCleanupStaging(stagingRoot: string, target: string) {
  const resolvedRoot = path.resolve(stagingRoot);
  const resolvedTarget = path.resolve(target);
  if (!isPathInside(resolvedRoot, resolvedTarget)) {
    throw new Error('Refused to remove an invalid cleanup staging path.');
  }
  await fs.rm(resolvedTarget, { recursive: true, force: true });
}

async function renameWithTransientRetry(source: string, destination: string) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await fs.rename(source, destination);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if ((code !== 'EPERM' && code !== 'EBUSY') || attempt >= 4) throw error;
      await new Promise<void>((resolve) => setTimeout(resolve, 75 * 2 ** attempt));
    }
  }
}

async function tryFastQuarantineGroup(input: {
  userId: string;
  jobId: string;
  candidates: LocalCandidate[];
  projectsRoot: string;
  quarantineRoot: string;
}) {
  const minimumFiles = fastGroupMinimumFiles();
  if (input.candidates.length < minimumFiles) return undefined;
  const groupKey = localCandidateGroupKey(input.candidates[0] as LocalCandidate);
  if (!groupKey || input.candidates.some((candidate) => localCandidateGroupKey(candidate) !== groupKey)) {
    return undefined;
  }
  const [projectSlug, , category] = groupKey.split('/');
  if (!projectSlug || !category) return undefined;
  const sourceRoot = path.resolve(input.projectsRoot, groupKey);
  const destinationRoot = path.resolve(input.quarantineRoot, groupKey);
  const stagingBase = path.resolve(localStorageMetadataDir(input.userId), 'cleanup-staging');
  const stagingRoot = path.resolve(stagingBase, input.jobId, projectSlug, category);
  if (
    !isPathInside(input.projectsRoot, sourceRoot) ||
    !isPathInside(input.quarantineRoot, destinationRoot) ||
    !isPathInside(stagingBase, stagingRoot)
  ) {
    return undefined;
  }
  const mutationKey = workspaceAssetMutationKey({ userId: input.userId, projectSlug, category });
  return runWithWorkspaceAssetMutationLock(mutationKey, async () => {
    const referencesBeforeInventory = await readLocalReferenceSets(
      path.join(input.projectsRoot, projectSlug),
    );
    const candidateByPath = new Map(
      input.candidates.map((candidate) => [candidate.relativePath, candidate]),
    );
    const protectedFiles: Array<{ absolutePath: string; relativePath: string }> = [];
    let processedBytes = 0;
    let processedCount = 0;
    let unsafeEntry = false;
    await visitFiles(
      sourceRoot,
      (file) => {
        const candidatePath = `${groupKey}/${file.relativePath}`;
        const candidate = candidateByPath.get(candidatePath);
        const projectRelativePath = candidatePath.split('/').slice(1).join('/');
        if (
          candidate &&
          !referencesBeforeInventory.retained.has(projectRelativePath) &&
          candidate.sizeBytes === file.sizeBytes &&
          Math.trunc(candidate.modifiedAtMs) === Math.trunc(file.modifiedAtMs)
        ) {
          processedBytes += candidate.sizeBytes;
          processedCount += 1;
          candidateByPath.delete(candidatePath);
        } else {
          protectedFiles.push({
            absolutePath: file.absolutePath,
            relativePath: file.relativePath,
          });
        }
      },
      () => {
        unsafeEntry = true;
      },
    );
    const totalFiles = processedCount + protectedFiles.length;
    if (
      unsafeEntry ||
      processedCount < minimumFiles ||
      processedCount / Math.max(1, totalFiles) < 0.8
    ) {
      return undefined;
    }
    try {
      await fs.access(destinationRoot);
      return undefined;
    } catch {
      // A unique job destination should not exist before the atomic directory move.
    }
    await removeCleanupStaging(stagingBase, stagingRoot);
    await ensureDir(stagingRoot);
    try {
      for (let offset = 0; offset < protectedFiles.length; offset += moveConcurrency()) {
        const batch = protectedFiles.slice(offset, offset + moveConcurrency());
        await Promise.all(
          batch.map(async (file) => {
            const stagedPath = path.join(stagingRoot, file.relativePath);
            await ensureDir(path.dirname(stagedPath));
            await fs.link(file.absolutePath, stagedPath);
          }),
        );
      }
      const refreshedReferences = await readLocalReferenceSets(
        path.join(input.projectsRoot, projectSlug),
      );
      const newlyProtected = input.candidates.some((candidate) => {
        const parts = candidate.relativePath.split('/').filter(Boolean);
        const projectRelativePath = parts.slice(1).join('/');
        return (
          refreshedReferences.retained.has(projectRelativePath) &&
          !referencesBeforeInventory.retained.has(projectRelativePath)
        );
      });
      if (newlyProtected) {
        await removeCleanupStaging(stagingBase, stagingRoot);
        return undefined;
      }
      await ensureDir(path.dirname(destinationRoot));
      await renameWithTransientRetry(sourceRoot, destinationRoot);
      try {
        await renameWithTransientRetry(stagingRoot, sourceRoot);
      } catch (error) {
        await renameWithTransientRetry(destinationRoot, sourceRoot);
        throw error;
      }
      for (let offset = 0; offset < protectedFiles.length; offset += moveConcurrency()) {
        const batch = protectedFiles.slice(offset, offset + moveConcurrency());
        await Promise.all(
          batch.map((file) =>
            fs.unlink(path.join(destinationRoot, file.relativePath)).catch(() => undefined),
          ),
        );
      }
      return {
        processedBytes,
        processedCount,
        skippedCount: input.candidates.length - processedCount,
      };
    } catch (error) {
      await removeCleanupStaging(stagingBase, stagingRoot).catch(() => undefined);
      if (
        (error as NodeJS.ErrnoException).code === 'EPERM' ||
        (error as NodeJS.ErrnoException).code === 'EBUSY' ||
        (error as NodeJS.ErrnoException).code === 'EXDEV'
      ) {
        return undefined;
      }
      throw error;
    }
  });
}

async function runLocalCleanup(userId: string, job: StorageCleanupJob) {
  const jobPath = localCleanupJobPath(userId, job.jobId);
  const manifestPath = localInventoryCandidateManifestPath(userId, job.scanId);
  const running: StorageCleanupJob = {
    ...job,
    status: 'running',
    phase: 'verifying',
    updatedAt: new Date().toISOString(),
  };
  await writeJsonFile(jobPath, running);
  try {
    await fs.access(manifestPath);
    const referencesByProject = await readLocalReferencesByProject(userId);
    const quarantining: StorageCleanupJob = {
      ...running,
      phase: 'quarantining',
      verifiedCount: job.candidateCount,
      updatedAt: new Date().toISOString(),
    };
    await writeJsonFile(jobPath, quarantining);
    const projectsRoot = path.resolve(getUserProjectsDir(userId));
    const quarantineRoot = path.resolve(
      getUserDir(userId),
      quarantineDirectoryName,
      job.jobId,
      'projects',
    );
    let processedBytes = 0;
    let processedCount = 0;
    let skippedCount = 0;
    let inspectedCount = 0;
    let lastProgressWriteAt = 0;
    const ensuredDirectories = new Map<string, Promise<void>>();
    const ensureDestinationDirectory = (directory: string) => {
      const existing = ensuredDirectories.get(directory);
      if (existing) return existing;
      const pending = ensureDir(directory);
      ensuredDirectories.set(directory, pending);
      return pending;
    };
    const lines = readline.createInterface({
      input: createReadStream(manifestPath, { encoding: 'utf8' }),
      crlfDelay: Infinity,
    });
    let batch: LocalCandidate[] = [];
    const writeProgress = async (force = false) => {
      const now = Date.now();
      if (!force && inspectedCount % 2_048 !== 0 && now - lastProgressWriteAt < 1_000) return;
      lastProgressWriteAt = now;
      await writeJsonFile(jobPath, {
        ...quarantining,
        processedBytes,
        processedCount,
        skippedCount,
        verifiedCount: inspectedCount,
        updatedAt: new Date(now).toISOString(),
      });
    };
    const flushBatch = async () => {
      if (batch.length === 0) return;
      const candidates = batch;
      batch = [];
      const results = await Promise.allSettled(
        candidates.map(async (candidate) => {
          const resolved = resolveLocalCandidate({
            candidate,
            projectsRoot,
            quarantineRoot,
            referencesByProject,
          });
          if (!resolved) return { moved: false, bytes: 0 };
          let sourceStat;
          try {
            sourceStat = await fs.lstat(resolved.source);
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
              return { moved: false, bytes: 0 };
            }
            throw error;
          }
          if (
            !sourceStat.isFile() ||
            sourceStat.isSymbolicLink() ||
            sourceStat.size !== candidate.sizeBytes ||
            Math.trunc(sourceStat.mtimeMs) !== Math.trunc(candidate.modifiedAtMs)
          ) {
            return { moved: false, bytes: 0 };
          }
          await ensureDestinationDirectory(path.dirname(resolved.destination));
          try {
            await fs.rename(resolved.source, resolved.destination);
            return { moved: true, bytes: candidate.sizeBytes };
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
              return { moved: false, bytes: 0 };
            }
            throw error;
          }
        }),
      );
      inspectedCount += results.length;
      const rejected = results.find(
        (result): result is PromiseRejectedResult => result.status === 'rejected',
      );
      for (const result of results) {
        if (result.status !== 'fulfilled') continue;
        if (result.value.moved) {
          processedBytes += result.value.bytes;
          processedCount += 1;
        } else {
          skippedCount += 1;
        }
      }
      await writeProgress(Boolean(rejected));
      if (rejected) throw rejected.reason;
    };
    let group: LocalCandidate[] = [];
    let groupKey: string | undefined;
    const flushGroup = async () => {
      if (group.length === 0) return;
      const candidates = group;
      group = [];
      const fastResult = await tryFastQuarantineGroup({
        userId,
        jobId: job.jobId,
        candidates,
        projectsRoot,
        quarantineRoot,
      });
      if (fastResult) {
        processedBytes += fastResult.processedBytes;
        processedCount += fastResult.processedCount;
        skippedCount += fastResult.skippedCount;
        inspectedCount += candidates.length;
        await writeProgress(true);
        return;
      }
      for (const candidate of candidates) {
        batch.push(candidate);
        if (batch.length >= moveConcurrency()) await flushBatch();
      }
    };
    for await (const line of lines) {
      if (!line) continue;
      const candidate = JSON.parse(line) as LocalCandidate;
      const nextGroupKey = localCandidateGroupKey(candidate);
      if (group.length > 0 && nextGroupKey !== groupKey) await flushGroup();
      groupKey = nextGroupKey;
      group.push(candidate);
    }
    await flushGroup();
    await flushBatch();
    const completedAt = new Date().toISOString();
    await writeJsonFile(jobPath, {
      ...quarantining,
      status: 'completed',
      phase: undefined,
      processedBytes,
      processedCount,
      skippedCount,
      updatedAt: completedAt,
      completedAt,
    } satisfies StorageCleanupJob);
    await startStorageScan(userId);
  } catch (error) {
    await writeJsonFile(jobPath, {
      ...running,
      status: 'failed',
      updatedAt: new Date().toISOString(),
      error: error instanceof Error ? error.message : 'Storage cleanup failed.',
    } satisfies StorageCleanupJob);
  }
}

async function startStorageCleanupUnlocked(input: {
  userId: string;
  scanId: string;
  idempotencyKey: string;
}) {
  const receiptHash = createHash('sha256').update(input.idempotencyKey).digest('hex').slice(0, 32);
  const localJobId = `cleanup-${receiptHash}`;
  const replayed = postgresAssetStorageRepository
    ? await postgresAssetStorageRepository.getCleanupJobByIdempotency(
        input.userId,
        input.idempotencyKey,
      )
    : await readJsonFile<StorageCleanupJob | undefined>(
        localCleanupJobPath(input.userId, localJobId),
        undefined,
      );
  if (replayed) return replayed;
  if (!postgresAssetStorageRepository) {
    const active = await getActiveLocalCleanupJob(input.userId);
    if (active) return active;
    if (await getActiveLocalPurgeJob(input.userId)) return undefined;
  }
  const latest = await getStorageOverview(input.userId);
  if (latest.status !== 'ready' || latest.scanId !== input.scanId) return undefined;
  const now = new Date().toISOString();
  if (postgresAssetStorageRepository) {
    const deleteAfter = new Date(
      Date.now() + getQuarantineDays() * 24 * 60 * 60 * 1000,
    ).toISOString();
    const job = await postgresAssetStorageRepository.createQuarantineJob({
      userId: input.userId,
      scanId: input.scanId,
      idempotencyKey: input.idempotencyKey,
      jobId: `cleanup-${randomUUID()}`,
      now,
      deleteAfter,
    });
    if (job) void startStorageScan(input.userId);
    return job;
  }

  const jobId = localJobId;
  const jobPath = localCleanupJobPath(input.userId, jobId);
  try {
    await fs.access(localInventoryCandidateManifestPath(input.userId, input.scanId));
  } catch {
    return undefined;
  }
  const candidateCount =
    latest.buckets.find((bucket) => bucket.id === 'temporary')?.itemCount ?? 0;
  const job: StorageCleanupJob = {
    schemaVersion: 1,
    jobId,
    scanId: input.scanId,
    status: 'queued',
    backend: 'workspace-file',
    candidateBytes: latest.reclaimableBytes ?? 0,
    candidateCount,
    processedBytes: 0,
    processedCount: 0,
    skippedCount: 0,
    quarantineDays: getQuarantineDays(),
    createdAt: now,
    updatedAt: now,
  };
  await ensureDir(path.dirname(jobPath));
  await writeJsonFile(jobPath, job);
  const cleanupPromise = runLocalCleanup(input.userId, job).finally(() => {
    if (cleanupPromises.get(jobId) === cleanupPromise) cleanupPromises.delete(jobId);
  });
  cleanupPromises.set(jobId, cleanupPromise);
  return job;
}

export function startStorageCleanup(input: {
  userId: string;
  scanId: string;
  idempotencyKey: string;
}) {
  const existing = cleanupStartPromises.get(input.userId);
  if (existing) return existing;
  const promise = startStorageCleanupUnlocked(input).finally(() => {
    if (cleanupStartPromises.get(input.userId) === promise) {
      cleanupStartPromises.delete(input.userId);
    }
  });
  cleanupStartPromises.set(input.userId, promise);
  return promise;
}

export async function getActiveStorageCleanupJob(userId: string) {
  if (postgresAssetStorageRepository) return undefined;
  return getActiveLocalCleanupJob(userId);
}

export async function getStorageCleanupJob(userId: string, jobId: string) {
  if (!/^cleanup-[a-zA-Z0-9_-]{8,128}$/.test(jobId)) return undefined;
  return postgresAssetStorageRepository
    ? postgresAssetStorageRepository.getCleanupJob(userId, jobId)
    : readJsonFile<StorageCleanupJob | undefined>(localCleanupJobPath(userId, jobId), undefined);
}

function localDetachedPurgePath(userId: string, jobId: string) {
  return path.join(getUserDir(userId), purgeDirectoryName, jobId);
}

async function pathExists(target: string) {
  try {
    await fs.access(target);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

async function runLocalPurge(userId: string, job: StoragePurgeJob) {
  const jobPath = localPurgeJobPath(userId, job.jobId);
  const sourceRoot = path.join(getUserDir(userId), quarantineDirectoryName);
  const detachedRoot = localDetachedPurgePath(userId, job.jobId);
  const running: StoragePurgeJob = {
    ...job,
    status: 'running',
    phase: 'detaching',
    updatedAt: new Date().toISOString(),
    error: undefined,
  };
  await writeJsonFile(jobPath, running);
  let detachedAt = running.detachedAt;
  try {
    await ensureDir(path.dirname(detachedRoot));
    if (!(await pathExists(detachedRoot)) && (await pathExists(sourceRoot))) {
      await renameWithTransientRetry(sourceRoot, detachedRoot);
    }
    await ensureDir(sourceRoot);
    detachedAt ??= new Date().toISOString();
    const deleting: StoragePurgeJob = {
      ...running,
      phase: 'deleting',
      detachedAt,
      updatedAt: detachedAt,
    };
    await writeJsonFile(jobPath, deleting);
    await fs.rm(detachedRoot, {
      recursive: true,
      force: true,
      maxRetries: 10,
      retryDelay: 250,
    });
    const completedAt = new Date().toISOString();
    await writeJsonFile(jobPath, {
      ...deleting,
      status: 'completed',
      phase: undefined,
      updatedAt: completedAt,
      completedAt,
    } satisfies StoragePurgeJob);
    await startStorageScan(userId);
  } catch (error) {
    await writeJsonFile(jobPath, {
      ...running,
      status: 'failed',
      phase: undefined,
      detachedAt,
      updatedAt: new Date().toISOString(),
      error: error instanceof Error ? error.message : 'Storage purge failed.',
    } satisfies StoragePurgeJob);
  }
}

function scheduleLocalPurge(userId: string, job: StoragePurgeJob) {
  if (purgePromises.has(job.jobId)) return;
  const promise = runLocalPurge(userId, job).finally(() => {
    if (purgePromises.get(job.jobId) === promise) purgePromises.delete(job.jobId);
  });
  purgePromises.set(job.jobId, promise);
}

async function startStoragePurgeUnlocked(input: {
  userId: string;
  idempotencyKey: string;
}) {
  if (postgresAssetStorageRepository) return undefined;
  const receiptHash = createHash('sha256').update(input.idempotencyKey).digest('hex').slice(0, 32);
  const jobId = `purge-${receiptHash}`;
  const replayed = await readJsonFile<StoragePurgeJob | undefined>(
    localPurgeJobPath(input.userId, jobId),
    undefined,
  );
  if (replayed) return replayed;
  const active = await getActiveLocalPurgeJob(input.userId);
  if (active) return active;
  if (await getActiveLocalCleanupJob(input.userId)) return undefined;
  const [cleanupJobs, purgeJobs, quarantine] = await Promise.all([
    listLocalCleanupJobs(input.userId),
    listLocalPurgeJobs(input.userId),
    summarizeLocalQuarantine(input.userId),
  ]);
  const retryable = purgeJobs
    .filter((job) => job.status === 'failed')
    .sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt));
  for (const failedJob of retryable) {
    if (!(await pathExists(localDetachedPurgePath(input.userId, failedJob.jobId)))) continue;
    const requeued: StoragePurgeJob = {
      ...failedJob,
      status: 'queued',
      phase: undefined,
      updatedAt: new Date().toISOString(),
      completedAt: undefined,
      error: undefined,
    };
    await writeJsonFile(localPurgeJobPath(input.userId, failedJob.jobId), requeued);
    scheduleLocalPurge(input.userId, requeued);
    return requeued;
  }
  if (quarantine.quarantineItemCount === 0 || quarantine.quarantineBytes === 0) return undefined;
  const claimedCleanupJobIds = new Set(purgeJobs.flatMap((job) => job.cleanupJobIds));
  const cleanupJobIds = cleanupJobs
    .filter((job) => job.processedCount > 0 && !claimedCleanupJobIds.has(job.jobId))
    .map((job) => job.jobId);
  if (cleanupJobIds.length === 0) return undefined;
  const now = new Date().toISOString();
  const job: StoragePurgeJob = {
    schemaVersion: 1,
    jobId,
    status: 'queued',
    backend: 'workspace-file',
    cleanupJobIds,
    targetBytes: quarantine.quarantineBytes,
    targetCount: quarantine.quarantineItemCount,
    createdAt: now,
    updatedAt: now,
  };
  await ensureDir(path.dirname(localPurgeJobPath(input.userId, jobId)));
  await writeJsonFile(localPurgeJobPath(input.userId, jobId), job);
  scheduleLocalPurge(input.userId, job);
  return job;
}

export function startStoragePurge(input: { userId: string; idempotencyKey: string }) {
  const existing = purgeStartPromises.get(input.userId);
  if (existing) return existing;
  const promise = startStoragePurgeUnlocked(input).finally(() => {
    if (purgeStartPromises.get(input.userId) === promise) {
      purgeStartPromises.delete(input.userId);
    }
  });
  purgeStartPromises.set(input.userId, promise);
  return promise;
}

export async function getStoragePurgeJob(userId: string, jobId: string) {
  if (!/^purge-[a-zA-Z0-9_-]{8,128}$/.test(jobId) || postgresAssetStorageRepository) {
    return undefined;
  }
  return readJsonFile<StoragePurgeJob | undefined>(localPurgeJobPath(userId, jobId), undefined);
}

export async function getStorageQuarantineStatus(
  userId: string,
): Promise<StorageQuarantineStatus> {
  if (postgresAssetStorageRepository) {
    const overview = await getStorageOverview(userId);
    const trash = overview.buckets.find((bucket) => bucket.id === 'trash');
    return {
      backend: 'cloud-object-storage',
      bytes: trash?.bytes ?? 0,
      itemCount: trash?.itemCount ?? 0,
      purgeSupported: false,
      purgeUnavailableReason:
        'Cloud physical purge requires the production object lifecycle worker.',
    };
  }
  const [summary, activePurgeJob] = await Promise.all([
    summarizeLocalQuarantine(userId),
    getActiveLocalPurgeJob(userId),
  ]);
  return {
    backend: 'workspace-file',
    bytes: summary.quarantineBytes + summary.retryablePurgeBytes,
    itemCount: summary.quarantineItemCount + summary.retryablePurgeItemCount,
    purgeSupported: true,
    activePurgeJob,
  };
}

export const storageManagementInternals = {
  extractCloudAssetIds,
  extractLocalAssetPaths,
  normalizeLocalAssetPath,
};
