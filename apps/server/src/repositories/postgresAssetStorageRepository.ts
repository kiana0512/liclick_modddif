import type { StorageCleanupJob, StorageOverview } from '@liclick/contracts';
import {
  getSharedPgProjectSqlDatabase,
  type ProjectSqlConnection,
  type ProjectSqlDatabase,
} from './postgresProjectRepository.js';

export type LegacyStorageAsset = {
  assetId: string;
  projectId: string;
  category: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  sha256: string;
  objectKey: string;
  createdAt: string;
  quarantined: boolean;
};

export type StorageDocument = {
  ownerId: string;
  revisionId?: string;
  kind: 'current' | 'history' | 'trash';
  document: unknown;
};

export type StorageInventoryCandidate = {
  candidateId: string;
  assetId: string;
  projectId: string;
  category: string;
  sizeBytes: number;
  proof: Record<string, unknown>;
};

function validLegacyAsset(value: unknown): value is Omit<LegacyStorageAsset, 'quarantined'> {
  if (!value || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.assetId === 'string' &&
    typeof record.projectId === 'string' &&
    typeof record.category === 'string' &&
    typeof record.filename === 'string' &&
    typeof record.mimeType === 'string' &&
    typeof record.sizeBytes === 'number' &&
    Number.isSafeInteger(record.sizeBytes) &&
    record.sizeBytes > 0 &&
    typeof record.sha256 === 'string' &&
    /^[a-f0-9]{64}$/.test(record.sha256) &&
    typeof record.objectKey === 'string' &&
    typeof record.createdAt === 'string'
  );
}

async function insertCandidates(
  connection: ProjectSqlConnection,
  userId: string,
  scanId: string,
  createdAt: string,
  candidates: StorageInventoryCandidate[],
) {
  for (const candidate of candidates) {
    await connection.query(
      `INSERT INTO asset_storage_inventory_candidates (
         user_id, scan_id, candidate_id, asset_id, project_id, category,
         size_bytes, proof_json, created_at
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9::timestamptz)`,
      [
        userId,
        scanId,
        candidate.candidateId,
        candidate.assetId,
        candidate.projectId,
        candidate.category,
        candidate.sizeBytes,
        candidate.proof,
        createdAt,
      ],
    );
  }
}

export function createPostgresAssetStorageRepository(database: ProjectSqlDatabase) {
  return {
    async getLatestOverview(userId: string) {
      const result = await database.query<{ snapshot_json: StorageOverview }>(
        `SELECT snapshot_json FROM asset_storage_inventory_snapshots WHERE user_id=$1`,
        [userId],
      );
      return result.rows[0]?.snapshot_json;
    },

    async listLegacyAssets(userId: string) {
      const result = await database.query<{ record_json: unknown; quarantined: boolean }>(
        `SELECT t.record_json,
                EXISTS (
                  SELECT 1 FROM asset_storage_quarantine q
                   WHERE q.user_id=t.user_id AND q.asset_id=t.asset_id
                     AND q.restored_at IS NULL AND q.deleted_at IS NULL
                ) AS quarantined
           FROM asset_transfers t
          WHERE t.user_id=$1 AND t.status='verified'
          ORDER BY t.intent_id`,
        [userId],
      );
      return result.rows.flatMap((row) =>
        validLegacyAsset(row.record_json)
          ? [{ ...row.record_json, quarantined: Boolean(row.quarantined) }]
          : [],
      );
    },

    async listStorageDocuments(userId: string): Promise<StorageDocument[]> {
      const current = await database.query<{
        project_id: string;
        revision_id: string;
        document_json: unknown;
      }>(
        `SELECT project_id, revision_id, document_json FROM project_documents
          WHERE user_id=$1 AND deleted_at IS NULL ORDER BY project_id`,
        [userId],
      );
      const history = await database.query<{
        project_id: string;
        revision_id: string;
        document_json: unknown;
      }>(
        `SELECT r.project_id, r.revision_id, r.document_json
           FROM project_document_revisions r
           JOIN project_documents p
             ON p.user_id=r.user_id AND p.project_id=r.project_id
          WHERE r.user_id=$1 AND p.deleted_at IS NULL
            AND r.revision_id<>p.revision_id
          ORDER BY r.project_id, r.revision_number`,
        [userId],
      );
      const trash = await database.query<{
        project_id: string;
        revision_id: string;
        document_json: unknown;
      }>(
        `SELECT r.project_id, r.revision_id, r.document_json
           FROM project_document_revisions r
           JOIN project_documents p
             ON p.user_id=r.user_id AND p.project_id=r.project_id
          WHERE r.user_id=$1 AND p.deleted_at IS NOT NULL
          ORDER BY r.project_id, r.revision_number`,
        [userId],
      );
      return [
        ...current.rows.map((row) => ({
          ownerId: row.project_id,
          revisionId: row.revision_id,
          kind: 'current' as const,
          document: row.document_json,
        })),
        ...history.rows.map((row) => ({
          ownerId: row.project_id,
          revisionId: row.revision_id,
          kind: 'history' as const,
          document: row.document_json,
        })),
        ...trash.rows.map((row) => ({
          ownerId: row.project_id,
          revisionId: row.revision_id,
          kind: 'trash' as const,
          document: row.document_json,
        })),
      ];
    },

    async replaceInventory(input: {
      userId: string;
      overview: StorageOverview;
      candidates: StorageInventoryCandidate[];
      startedAt: string;
    }) {
      await database.transaction(async (connection) => {
        await connection.query(
          `DELETE FROM asset_storage_inventory_candidates WHERE user_id=$1`,
          [input.userId],
        );
        await insertCandidates(
          connection,
          input.userId,
          input.overview.scanId ?? '',
          input.overview.lastScannedAt ?? input.startedAt,
          input.candidates,
        );
        await connection.query(
          `INSERT INTO asset_storage_inventory_snapshots (
             user_id, scan_id, schema_version, rule_version, status,
             snapshot_json, started_at, completed_at, updated_at
           ) VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7::timestamptz,$8::timestamptz,$8::timestamptz)
           ON CONFLICT (user_id) DO UPDATE SET
             scan_id=EXCLUDED.scan_id,
             schema_version=EXCLUDED.schema_version,
             rule_version=EXCLUDED.rule_version,
             status=EXCLUDED.status,
             snapshot_json=EXCLUDED.snapshot_json,
             started_at=EXCLUDED.started_at,
             completed_at=EXCLUDED.completed_at,
             updated_at=EXCLUDED.updated_at`,
          [
            input.userId,
            input.overview.scanId,
            input.overview.schemaVersion,
            input.overview.ruleVersion,
            input.overview.status,
            input.overview,
            input.startedAt,
            input.overview.lastScannedAt,
          ],
        );
      });
    },

    async createQuarantineJob(input: {
      userId: string;
      scanId: string;
      idempotencyKey: string;
      jobId: string;
      now: string;
      deleteAfter: string;
    }) {
      return database.transaction(async (connection) => {
        const existing = await connection.query<{ job_json: StorageCleanupJob }>(
          `SELECT job_json FROM asset_storage_cleanup_jobs
            WHERE user_id=$1 AND idempotency_key=$2 FOR UPDATE`,
          [input.userId, input.idempotencyKey],
        );
        if (existing.rows[0]) return existing.rows[0].job_json;

        const snapshot = await connection.query<{ scan_id: string; status: string }>(
          `SELECT scan_id, status FROM asset_storage_inventory_snapshots
            WHERE user_id=$1 FOR UPDATE`,
          [input.userId],
        );
        if (snapshot.rows[0]?.scan_id !== input.scanId || snapshot.rows[0]?.status !== 'ready') {
          return undefined;
        }
        const totals = await connection.query<{ count: number | string; bytes: number | string }>(
          `SELECT COUNT(*) AS count, COALESCE(SUM(size_bytes),0) AS bytes
             FROM asset_storage_inventory_candidates
            WHERE user_id=$1 AND scan_id=$2`,
          [input.userId, input.scanId],
        );
        const candidateCount = Number(totals.rows[0]?.count ?? 0);
        const candidateBytes = Number(totals.rows[0]?.bytes ?? 0);
        const job: StorageCleanupJob = {
          schemaVersion: 1,
          jobId: input.jobId,
          scanId: input.scanId,
          status: 'completed',
          backend: 'cloud-object-storage',
          candidateBytes,
          candidateCount,
          processedBytes: candidateBytes,
          processedCount: candidateCount,
          skippedCount: 0,
          quarantineDays: Math.max(
            1,
            Math.round(
              (new Date(input.deleteAfter).getTime() - new Date(input.now).getTime()) /
                (24 * 60 * 60 * 1000),
            ),
          ),
          createdAt: input.now,
          updatedAt: input.now,
          completedAt: input.now,
        };
        await connection.query(
          `INSERT INTO asset_storage_cleanup_jobs (
             user_id, job_id, scan_id, idempotency_key, status, job_json,
             created_at, updated_at, completed_at
           ) VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7::timestamptz,$7::timestamptz,$7::timestamptz)`,
          [
            input.userId,
            input.jobId,
            input.scanId,
            input.idempotencyKey,
            job.status,
            job,
            input.now,
          ],
        );
        await connection.query(
          `INSERT INTO asset_storage_quarantine (
             user_id, asset_id, job_id, scan_id, quarantined_at, delete_after
           ) SELECT user_id, asset_id, $3, scan_id, $4::timestamptz, $5::timestamptz
               FROM asset_storage_inventory_candidates
              WHERE user_id=$1 AND scan_id=$2
           ON CONFLICT (user_id, asset_id) DO NOTHING`,
          [input.userId, input.scanId, input.jobId, input.now, input.deleteAfter],
        );
        return job;
      });
    },

    async getCleanupJob(userId: string, jobId: string) {
      const result = await database.query<{ job_json: StorageCleanupJob }>(
        `SELECT job_json FROM asset_storage_cleanup_jobs WHERE user_id=$1 AND job_id=$2`,
        [userId, jobId],
      );
      return result.rows[0]?.job_json;
    },

    async getCleanupJobByIdempotency(userId: string, idempotencyKey: string) {
      const result = await database.query<{ job_json: StorageCleanupJob }>(
        `SELECT job_json FROM asset_storage_cleanup_jobs
          WHERE user_id=$1 AND idempotency_key=$2`,
        [userId, idempotencyKey],
      );
      return result.rows[0]?.job_json;
    },
  };
}

export type PostgresAssetStorageRepository = ReturnType<
  typeof createPostgresAssetStorageRepository
>;

export const postgresAssetStorageRepository = (() => {
  if (process.env.LICLICK_PROJECT_REPOSITORY !== 'postgres') return undefined;
  const connectionString = process.env.LICLICK_CLOUD_DATABASE_URL?.trim();
  if (!connectionString) {
    throw new Error('Cloud asset storage requires LICLICK_CLOUD_DATABASE_URL.');
  }
  return createPostgresAssetStorageRepository(
    getSharedPgProjectSqlDatabase(connectionString),
  );
})();
