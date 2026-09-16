import {
  STORAGE_INVENTORY_RULE_VERSION,
  type StorageBucketId,
  type StorageCleanupJob,
  type StorageOverview,
  type StoragePurgeJob,
} from '@liclick/contracts';
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

export type StorageDocumentReferencePage = {
  scannedDocumentCount: number;
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

export type CloudStoragePurgeItem = {
  assetId: string;
  objectKey: string;
  sizeBytes: number;
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

    async appendStorageDocumentReferencePage(
      userId: string,
      scanId: string,
      kind: StorageDocumentKind,
      cursor: StorageDocumentCursor | undefined,
      requestedLimit: number,
    ): Promise<StorageDocumentReferencePage> {
      const limit = boundedPageSize(requestedLimit, 32);
      const bucketId = kind === 'current' ? 'project-resources' : kind;
      return runInventoryQuery(database, async (connection) => {
        const rows = kind === 'current'
          ? await connection.query<{
              project_id: string;
              revision_number: number;
            }>(
              `WITH page AS MATERIALIZED (
                 SELECT project_id, revision_number, document_json
                   FROM project_documents
                  WHERE user_id=$1 AND deleted_at IS NULL AND project_id>$2
                  ORDER BY project_id
                  LIMIT $3
               ), matches AS MATERIALIZED (
                 SELECT DISTINCT asset_match[1] AS asset_id
                   FROM page
                   CROSS JOIN LATERAL regexp_matches(
                     page.document_json::text,
                     '(?:/assets/|objects/)(asset-[a-zA-Z0-9_-]{8,128})(?:/content)?',
                     'g'
                   ) AS captures(asset_match)
               ), inserted AS (
                 INSERT INTO asset_storage_inventory_scan_references (
                   user_id, scan_id, asset_id, bucket_id
                 )
                 SELECT $1, $4, asset_id, $5 FROM matches
                 ON CONFLICT (user_id, scan_id, asset_id) DO UPDATE SET
                   bucket_id = CASE
                     WHEN EXCLUDED.bucket_id='project-resources' THEN EXCLUDED.bucket_id
                     WHEN asset_storage_inventory_scan_references.bucket_id='project-resources'
                       THEN asset_storage_inventory_scan_references.bucket_id
                     WHEN EXCLUDED.bucket_id='history' THEN EXCLUDED.bucket_id
                     ELSE asset_storage_inventory_scan_references.bucket_id
                   END
                 RETURNING asset_id
               )
               SELECT page.project_id, page.revision_number
                 FROM page
                ORDER BY page.project_id`,
              [userId, cursor?.projectId ?? '', limit, scanId, bucketId],
            )
          : await connection.query<{
              project_id: string;
              revision_number: number;
            }>(
              `WITH page AS MATERIALIZED (
                 SELECT r.project_id, r.revision_number, r.document_json
                   FROM project_document_revisions r
                   JOIN project_documents p
                     ON p.user_id=r.user_id AND p.project_id=r.project_id
                  WHERE r.user_id=$1
                    AND p.deleted_at IS ${kind === 'history' ? '' : 'NOT '}NULL
                    ${kind === 'history' ? 'AND r.revision_id<>p.revision_id' : ''}
                    AND (r.project_id, r.revision_number)>($2,$3)
                  ORDER BY r.project_id, r.revision_number
                  LIMIT $4
               ), matches AS MATERIALIZED (
                 SELECT DISTINCT asset_match[1] AS asset_id
                   FROM page
                   CROSS JOIN LATERAL regexp_matches(
                     page.document_json::text,
                     '(?:/assets/|objects/)(asset-[a-zA-Z0-9_-]{8,128})(?:/content)?',
                     'g'
                   ) AS captures(asset_match)
               ), inserted AS (
                 INSERT INTO asset_storage_inventory_scan_references (
                   user_id, scan_id, asset_id, bucket_id
                 )
                 SELECT $1, $5, asset_id, $6 FROM matches
                 ON CONFLICT (user_id, scan_id, asset_id) DO UPDATE SET
                   bucket_id = CASE
                     WHEN EXCLUDED.bucket_id='project-resources' THEN EXCLUDED.bucket_id
                     WHEN asset_storage_inventory_scan_references.bucket_id='project-resources'
                       THEN asset_storage_inventory_scan_references.bucket_id
                     WHEN EXCLUDED.bucket_id='history' THEN EXCLUDED.bucket_id
                     ELSE asset_storage_inventory_scan_references.bucket_id
                   END
                 RETURNING asset_id
               )
               SELECT page.project_id, page.revision_number
                 FROM page
                ORDER BY page.project_id, page.revision_number`,
              [
                userId,
                cursor?.projectId ?? '',
                cursor?.revisionNumber ?? -1,
                limit,
                scanId,
                bucketId,
              ],
            );
        const lastRow = rows.rows.at(-1);
        return {
          scannedDocumentCount: rows.rows.length,
          ...(rows.rows.length === limit && lastRow
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
          `DELETE FROM asset_storage_inventory_scan_references reference
            WHERE reference.user_id=$1
              AND (
                reference.scan_id=$2 OR NOT EXISTS (
                  SELECT 1 FROM asset_storage_inventory_snapshots snapshot
                   WHERE snapshot.user_id=reference.user_id
                     AND snapshot.scan_id=reference.scan_id
                )
              )`,
          [userId, scanId],
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
          `DELETE FROM asset_storage_inventory_scan_references
            WHERE user_id=$1 AND scan_id<>$2`,
          [input.userId, input.overview.scanId],
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

    async getCloudQuarantineSummary(userId: string) {
      const result = await database.query<{
        item_count: number | string;
        bytes: number | string;
      }>(
        `SELECT COUNT(*) AS item_count,
                COALESCE(SUM((t.record_json->>'sizeBytes')::bigint),0) AS bytes
           FROM asset_storage_quarantine q
           JOIN asset_transfers t
             ON t.user_id=q.user_id AND t.asset_id=q.asset_id AND t.status='verified'
           LEFT JOIN asset_storage_inventory_snapshots snapshot
             ON snapshot.user_id=q.user_id AND snapshot.status='ready'
            AND snapshot.rule_version=$2
           LEFT JOIN asset_storage_inventory_scan_references reference
             ON reference.user_id=q.user_id
            AND reference.scan_id=snapshot.scan_id
            AND reference.asset_id=q.asset_id
          WHERE q.user_id=$1 AND q.restored_at IS NULL AND q.deleted_at IS NULL
            AND reference.asset_id IS NULL`,
        [userId, STORAGE_INVENTORY_RULE_VERSION],
      );
      return {
        itemCount: Number(result.rows[0]?.item_count ?? 0),
        bytes: Number(result.rows[0]?.bytes ?? 0),
      };
    },

    async getActivePurgeJob(userId: string) {
      const result = await database.query<{ job_json: StoragePurgeJob }>(
        `SELECT job_json FROM asset_storage_purge_jobs
          WHERE user_id=$1 AND status IN ('queued','running')
          ORDER BY created_at
          LIMIT 1`,
        [userId],
      );
      return result.rows[0]?.job_json;
    },

    async getPurgeJob(userId: string, jobId: string) {
      const result = await database.query<{ job_json: StoragePurgeJob }>(
        `SELECT job_json FROM asset_storage_purge_jobs WHERE user_id=$1 AND job_id=$2`,
        [userId, jobId],
      );
      return result.rows[0]?.job_json;
    },

    async createPurgeJob(input: {
      userId: string;
      idempotencyKey: string;
      jobId: string;
      now: string;
    }) {
      return database.transaction(async (connection) => {
        await connection.query(
          `SELECT user_id FROM cloud_users WHERE user_id=$1 FOR UPDATE`,
          [input.userId],
        );
        const existing = await connection.query<{ job_json: StoragePurgeJob }>(
          `SELECT job_json FROM asset_storage_purge_jobs
            WHERE user_id=$1 AND idempotency_key=$2`,
          [input.userId, input.idempotencyKey],
        );
        if (existing.rows[0]) return existing.rows[0].job_json;
        const active = await connection.query<{ job_json: StoragePurgeJob }>(
          `SELECT job_json FROM asset_storage_purge_jobs
            WHERE user_id=$1 AND status IN ('queued','running')
            ORDER BY created_at
            LIMIT 1`,
          [input.userId],
        );
        if (active.rows[0]) return active.rows[0].job_json;
        const snapshot = await connection.query<{ scan_id: string }>(
          `SELECT scan_id FROM asset_storage_inventory_snapshots
            WHERE user_id=$1 AND status='ready' AND rule_version=$2`,
          [input.userId, STORAGE_INVENTORY_RULE_VERSION],
        );
        const scanId = snapshot.rows[0]?.scan_id;
        if (!scanId) return undefined;
        const totals = await connection.query<{
          item_count: number | string;
          bytes: number | string;
          cleanup_job_ids: string[];
        }>(
          `SELECT COUNT(*) AS item_count,
                  COALESCE(SUM((t.record_json->>'sizeBytes')::bigint),0) AS bytes,
                  COALESCE(ARRAY_AGG(DISTINCT q.job_id), ARRAY[]::text[]) AS cleanup_job_ids
             FROM asset_storage_quarantine q
             JOIN asset_transfers t
               ON t.user_id=q.user_id AND t.asset_id=q.asset_id AND t.status='verified'
             LEFT JOIN asset_storage_inventory_scan_references reference
               ON reference.user_id=q.user_id
              AND reference.scan_id=$2
              AND reference.asset_id=q.asset_id
            WHERE q.user_id=$1
              AND q.restored_at IS NULL AND q.deleted_at IS NULL
              AND reference.asset_id IS NULL`,
          [input.userId, scanId],
        );
        const targetCount = Number(totals.rows[0]?.item_count ?? 0);
        const targetBytes = Number(totals.rows[0]?.bytes ?? 0);
        if (targetCount === 0) return undefined;
        const job: StoragePurgeJob = {
          schemaVersion: 1,
          jobId: input.jobId,
          status: 'queued',
          backend: 'cloud-object-storage',
          cleanupJobIds: totals.rows[0]?.cleanup_job_ids ?? [],
          targetBytes,
          targetCount,
          createdAt: input.now,
          updatedAt: input.now,
        };
        await connection.query(
          `INSERT INTO asset_storage_purge_jobs (
             user_id, job_id, idempotency_key, status, job_json, created_at, updated_at
           ) VALUES ($1,$2,$3,'queued',$4::jsonb,$5::timestamptz,$5::timestamptz)`,
          [input.userId, input.jobId, input.idempotencyKey, job, input.now],
        );
        await connection.query(
          `INSERT INTO asset_storage_purge_items (
             user_id, job_id, asset_id, object_key, size_bytes, status, updated_at
           )
           SELECT q.user_id, $3, q.asset_id, t.record_json->>'objectKey',
                  (t.record_json->>'sizeBytes')::bigint, 'pending', $4::timestamptz
             FROM asset_storage_quarantine q
             JOIN asset_transfers t
               ON t.user_id=q.user_id AND t.asset_id=q.asset_id AND t.status='verified'
             LEFT JOIN asset_storage_inventory_scan_references reference
               ON reference.user_id=q.user_id
              AND reference.scan_id=$2
              AND reference.asset_id=q.asset_id
            WHERE q.user_id=$1
              AND q.restored_at IS NULL AND q.deleted_at IS NULL
              AND reference.asset_id IS NULL`,
          [input.userId, scanId, input.jobId, input.now],
        );
        return job;
      });
    },

    async markPurgeJobRunning(userId: string, job: StoragePurgeJob) {
      const updated: StoragePurgeJob = {
        ...job,
        status: 'running',
        phase: 'deleting',
        detachedAt: job.detachedAt ?? new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        error: undefined,
      };
      await database.query(
        `UPDATE asset_storage_purge_jobs
            SET status='running', job_json=$3::jsonb, updated_at=$4::timestamptz
          WHERE user_id=$1 AND job_id=$2`,
        [userId, job.jobId, updated, updated.updatedAt],
      );
      return updated;
    },

    async listPurgeItemPage(
      userId: string,
      jobId: string,
      cursor: string | undefined,
      requestedLimit: number,
    ) {
      const limit = boundedPageSize(requestedLimit, 128);
      const result = await database.query<{
        asset_id: string;
        object_key: string;
        size_bytes: number | string;
      }>(
        `SELECT asset_id, object_key, size_bytes
           FROM asset_storage_purge_items
          WHERE user_id=$1 AND job_id=$2 AND status='pending' AND asset_id>$3
          ORDER BY asset_id
          LIMIT $4`,
        [userId, jobId, cursor ?? '', limit],
      );
      const items: CloudStoragePurgeItem[] = result.rows.map((row) => ({
        assetId: row.asset_id,
        objectKey: row.object_key,
        sizeBytes: Number(row.size_bytes),
      }));
      return {
        items,
        ...(items.length === limit ? { nextCursor: items.at(-1)?.assetId } : {}),
      };
    },

    async markPurgeItemDeleted(input: {
      userId: string;
      jobId: string;
      assetId: string;
      now: string;
    }) {
      await database.transaction(async (connection) => {
        await connection.query(
          `DELETE FROM asset_transfers WHERE user_id=$1 AND asset_id=$2`,
          [input.userId, input.assetId],
        );
        await connection.query(
          `UPDATE asset_storage_quarantine
              SET deleted_at=$3::timestamptz
            WHERE user_id=$1 AND asset_id=$2 AND restored_at IS NULL`,
          [input.userId, input.assetId, input.now],
        );
        await connection.query(
          `UPDATE asset_storage_purge_items
              SET status='deleted', error=NULL, updated_at=$4::timestamptz
            WHERE user_id=$1 AND job_id=$2 AND asset_id=$3`,
          [input.userId, input.jobId, input.assetId, input.now],
        );
      });
    },

    async finishPurgeJob(input: {
      userId: string;
      job: StoragePurgeJob;
      error?: string;
    }) {
      const now = new Date().toISOString();
      const completed: StoragePurgeJob = input.error
        ? {
            ...input.job,
            status: 'failed',
            phase: undefined,
            updatedAt: now,
            error: input.error,
          }
        : {
            ...input.job,
            status: 'completed',
            phase: undefined,
            updatedAt: now,
            completedAt: now,
            error: undefined,
          };
      await database.query(
        `UPDATE asset_storage_purge_jobs
            SET status=$3, job_json=$4::jsonb, updated_at=$5::timestamptz,
                completed_at=$6::timestamptz
          WHERE user_id=$1 AND job_id=$2`,
        [
          input.userId,
          input.job.jobId,
          completed.status,
          completed,
          now,
          completed.completedAt ?? null,
        ],
      );
      return completed;
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
