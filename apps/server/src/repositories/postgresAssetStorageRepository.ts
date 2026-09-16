import type { StorageBucketId, StorageCleanupJob, StorageOverview } from '@liclick/contracts';
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
  referenceBucket?: StorageBucketId;
};

export type StorageDocument = {
  ownerId: string;
  revisionId?: string;
  kind: 'current' | 'history' | 'trash';
  assetIds: string[];
};

export type StorageDocumentKind = StorageDocument['kind'];

export type StorageDocumentCursor = {
  projectId: string;
  revisionNumber: number;
};

export type StorageDocumentPage = {
  documents: StorageDocument[];
  nextCursor?: StorageDocumentCursor;
};

export type LegacyStorageAssetPage = {
  assets: LegacyStorageAsset[];
  nextCursor?: string;
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

function inventoryQueryTimeoutMs() {
  const configured = Number(process.env.LICLICK_STORAGE_INVENTORY_QUERY_TIMEOUT_MS ?? 45_000);
  if (!Number.isFinite(configured)) return 45_000;
  return Math.max(5_000, Math.min(300_000, Math.trunc(configured)));
}

function runInventoryQuery<T>(
  database: ProjectSqlDatabase,
  operation: (connection: ProjectSqlConnection) => Promise<T>,
) {
  return database.withStatementTimeout
    ? database.withStatementTimeout(inventoryQueryTimeoutMs(), operation)
    : operation(database);
}

function boundedPageSize(value: number, maximum: number) {
  if (!Number.isFinite(value)) return Math.min(128, maximum);
  return Math.max(1, Math.min(maximum, Math.trunc(value)));
}

async function insertCandidates(
  connection: ProjectSqlConnection,
  userId: string,
  scanId: string,
  createdAt: string,
  candidates: StorageInventoryCandidate[],
) {
  if (candidates.length === 0) return;
  const rows = candidates.map((candidate) => ({
    candidate_id: candidate.candidateId,
    asset_id: candidate.assetId,
    project_id: candidate.projectId,
    category: candidate.category,
    size_bytes: candidate.sizeBytes,
    proof_json: candidate.proof,
  }));
  await connection.query(
    `INSERT INTO asset_storage_inventory_candidates (
       user_id, scan_id, candidate_id, asset_id, project_id, category,
       size_bytes, proof_json, created_at
     )
     SELECT $1, $2, candidate_id, asset_id, project_id, category,
            size_bytes, proof_json, $4::timestamptz
       FROM jsonb_to_recordset($3::jsonb) AS candidate(
         candidate_id TEXT,
         asset_id TEXT,
         project_id TEXT,
         category TEXT,
         size_bytes BIGINT,
         proof_json JSONB
       )`,
    [userId, scanId, JSON.stringify(rows), createdAt],
  );
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

    async listLegacyAssetPage(
      userId: string,
      scanId: string,
      cursor: string | undefined,
      requestedLimit: number,
    ): Promise<LegacyStorageAssetPage> {
      const limit = boundedPageSize(requestedLimit, 512);
      return runInventoryQuery(database, async (connection) => {
        const result = await connection.query<{
          intent_id: string;
          record_json: unknown;
          quarantined: boolean;
          bucket_id: StorageBucketId | null;
        }>(
          `SELECT t.intent_id, t.record_json, reference.bucket_id,
                EXISTS (
                  SELECT 1 FROM asset_storage_quarantine q
                   WHERE q.user_id=t.user_id AND q.asset_id=t.asset_id
                     AND q.restored_at IS NULL AND q.deleted_at IS NULL
                ) AS quarantined
           FROM asset_transfers t
           LEFT JOIN asset_storage_inventory_scan_references reference
             ON reference.user_id=t.user_id
            AND reference.scan_id=$2
            AND reference.asset_id=t.asset_id
          WHERE t.user_id=$1 AND t.status='verified' AND t.intent_id>$3
          ORDER BY t.intent_id
          LIMIT $4`,
          [userId, scanId, cursor ?? '', limit],
        );
        const assets = result.rows.flatMap((row) =>
          validLegacyAsset(row.record_json)
            ? [{
                ...row.record_json,
                quarantined: Boolean(row.quarantined),
                ...(row.bucket_id ? { referenceBucket: row.bucket_id } : {}),
              }]
            : [],
        );
        const lastRow = result.rows.at(-1);
        return {
          assets,
          ...(result.rows.length === limit && lastRow
            ? { nextCursor: lastRow.intent_id }
            : {}),
        };
      });
    },

    async listStorageDocumentPage(
      userId: string,
      kind: StorageDocumentKind,
      cursor: StorageDocumentCursor | undefined,
      requestedLimit: number,
    ): Promise<StorageDocumentPage> {
      const limit = boundedPageSize(requestedLimit, 32);
      return runInventoryQuery(database, async (connection) => {
        if (kind === 'current') {
          const current = await connection.query<{
            project_id: string;
            revision_id: string;
            revision_number: number;
            asset_ids: string[];
          }>(
            `WITH page AS (
               SELECT project_id, revision_id, revision_number, document_json
                 FROM project_documents
                WHERE user_id=$1 AND deleted_at IS NULL AND project_id>$2
                ORDER BY project_id
                LIMIT $3
             )
             SELECT page.project_id, page.revision_id, page.revision_number,
                    ARRAY(
                      SELECT DISTINCT asset_match[1]
                        FROM regexp_matches(
                          page.document_json::text,
                          '(?:/assets/|objects/)(asset-[a-zA-Z0-9_-]{8,128})(?:/content)?',
                          'g'
                        ) AS captures(asset_match)
                    ) AS asset_ids
               FROM page
              ORDER BY page.project_id`,
            [userId, cursor?.projectId ?? '', limit],
          );
          const lastRow = current.rows.at(-1);
          return {
            documents: current.rows.map((row) => ({
              ownerId: row.project_id,
              revisionId: row.revision_id,
              kind,
              assetIds: row.asset_ids,
            })),
            ...(current.rows.length === limit && lastRow
              ? {
                  nextCursor: {
                    projectId: lastRow.project_id,
                    revisionNumber: lastRow.revision_number,
                  },
                }
              : {}),
          };
        }
        const revisions = await connection.query<{
          project_id: string;
          revision_id: string;
          revision_number: number;
          asset_ids: string[];
        }>(
          `WITH page AS (
             SELECT r.project_id, r.revision_id, r.revision_number, r.document_json
               FROM project_document_revisions r
               JOIN project_documents p
                 ON p.user_id=r.user_id AND p.project_id=r.project_id
              WHERE r.user_id=$1
                AND p.deleted_at IS ${kind === 'history' ? '' : 'NOT '}NULL
                ${kind === 'history' ? 'AND r.revision_id<>p.revision_id' : ''}
                AND (r.project_id, r.revision_number)>($2,$3)
              ORDER BY r.project_id, r.revision_number
              LIMIT $4
           )
           SELECT page.project_id, page.revision_id, page.revision_number,
                  ARRAY(
                    SELECT DISTINCT asset_match[1]
                      FROM regexp_matches(
                        page.document_json::text,
                        '(?:/assets/|objects/)(asset-[a-zA-Z0-9_-]{8,128})(?:/content)?',
                        'g'
                      ) AS captures(asset_match)
                  ) AS asset_ids
             FROM page
            ORDER BY page.project_id, page.revision_number`,
          [userId, cursor?.projectId ?? '', cursor?.revisionNumber ?? -1, limit],
        );
        const lastRow = revisions.rows.at(-1);
        return {
          documents: revisions.rows.map((row) => ({
            ownerId: row.project_id,
            revisionId: row.revision_id,
            kind,
            assetIds: row.asset_ids,
          })),
          ...(revisions.rows.length === limit && lastRow
            ? {
                nextCursor: {
                  projectId: lastRow.project_id,
                  revisionNumber: lastRow.revision_number,
                },
              }
            : {}),
        };
      });
    },

    async beginInventoryScan(userId: string, scanId: string) {
      await runInventoryQuery(database, async (connection) => {
        await connection.query(
          `DELETE FROM asset_storage_inventory_candidates c
            WHERE c.user_id=$1
              AND (
                c.scan_id=$2 OR NOT EXISTS (
                  SELECT 1 FROM asset_storage_inventory_snapshots s
                   WHERE s.user_id=c.user_id AND s.scan_id=c.scan_id
                )
              )`,
          [userId, scanId],
        );
        await connection.query(
          `DELETE FROM asset_storage_inventory_scan_references WHERE user_id=$1`,
          [userId],
        );
      });
    },

    async appendInventoryReferences(input: {
      userId: string;
      scanId: string;
      references: Array<{ assetId: string; bucketId: Exclude<StorageBucketId, 'temporary'> }>;
    }) {
      if (input.references.length === 0) return;
      const priority: Record<Exclude<StorageBucketId, 'temporary'>, number> = {
        'project-resources': 0,
        history: 1,
        trash: 2,
      };
      const deduplicated = new Map<
        string,
        Exclude<StorageBucketId, 'temporary'>
      >();
      for (const reference of input.references) {
        const retained = deduplicated.get(reference.assetId);
        if (!retained || priority[reference.bucketId] < priority[retained]) {
          deduplicated.set(reference.assetId, reference.bucketId);
        }
      }
      await runInventoryQuery(database, async (connection) => {
        await connection.query(
          `INSERT INTO asset_storage_inventory_scan_references (
             user_id, scan_id, asset_id, bucket_id
           )
           SELECT $1, $2, asset_id, bucket_id
             FROM jsonb_to_recordset($3::jsonb) AS reference(asset_id TEXT, bucket_id TEXT)
           ON CONFLICT (user_id, scan_id, asset_id) DO UPDATE SET
             bucket_id = CASE
               WHEN EXCLUDED.bucket_id='project-resources' THEN EXCLUDED.bucket_id
               WHEN asset_storage_inventory_scan_references.bucket_id='project-resources'
                 THEN asset_storage_inventory_scan_references.bucket_id
               WHEN EXCLUDED.bucket_id='history' THEN EXCLUDED.bucket_id
               ELSE asset_storage_inventory_scan_references.bucket_id
             END`,
          [
            input.userId,
            input.scanId,
            JSON.stringify(
              Array.from(deduplicated, ([assetId, bucketId]) => ({
                asset_id: assetId,
                bucket_id: bucketId,
              })),
            ),
          ],
        );
      });
    },

    async appendInventoryCandidates(input: {
      userId: string;
      scanId: string;
      createdAt: string;
      candidates: StorageInventoryCandidate[];
    }) {
      if (input.candidates.length === 0) return;
      await runInventoryQuery(database, async (connection) => {
        await insertCandidates(
          connection,
          input.userId,
          input.scanId,
          input.createdAt,
          input.candidates,
        );
      });
    },

    async completeInventoryScan(input: {
      userId: string;
      overview: StorageOverview;
      startedAt: string;
    }) {
      await runInventoryQuery(database, async (connection) => {
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
        await connection.query(
          `DELETE FROM asset_storage_inventory_candidates
            WHERE user_id=$1 AND scan_id<>$2`,
          [input.userId, input.overview.scanId],
        );
        await connection.query(
          `DELETE FROM asset_storage_inventory_scan_references WHERE user_id=$1`,
          [input.userId],
        );
      });
    },

    async discardInventoryScan(userId: string, scanId: string) {
      await runInventoryQuery(database, async (connection) => {
        await connection.query(
          `DELETE FROM asset_storage_inventory_candidates WHERE user_id=$1 AND scan_id=$2`,
          [userId, scanId],
        );
        await connection.query(
          `DELETE FROM asset_storage_inventory_scan_references WHERE user_id=$1 AND scan_id=$2`,
          [userId, scanId],
        );
      });
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
