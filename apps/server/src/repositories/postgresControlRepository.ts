import type { AuthSource, AuthUser, UserSession } from '../auth/authTypes.js';
import type { WorkspaceFolder } from '../types/folder.js';
import type { AssetJobHistoryRecord } from '../services/assetJobOwnership.js';
import {
  getSharedPgProjectSqlDatabase,
  type ProjectSqlDatabase,
} from './postgresProjectRepository.js';

type UserRow = {
  user_id: string;
  display_name: string;
  email: string | null;
  avatar_url: string | null;
  role: string;
  status: 'active' | 'disabled';
  auth_source: AuthSource;
  atlas_home_dir: string | null;
  created_at: Date | string;
  updated_at: Date | string;
  last_login_at: Date | string | null;
};

type PerformanceLabSessionRow = {
  session_id: string;
  user_id: string;
  project_id: string | null;
  status: 'recording' | 'completed';
  schema_version: number;
  collector_version: string;
  user_display_name: string;
  user_avatar_url: string | null;
  user_email: string | null;
  current_display_name?: string | null;
  current_avatar_url?: string | null;
  current_email?: string | null;
  started_at: Date | string;
  ended_at: Date | string | null;
  client_context_json: Record<string, unknown>;
  summary_json: Record<string, unknown> | null;
  report_json: Record<string, unknown> | null;
  report_sha256: string | null;
  chunk_count: number;
  sample_count: number | string | bigint;
  total_bytes: number | string | bigint;
  created_at: Date | string;
  updated_at: Date | string;
};

type PerformanceLabChunkRow = {
  source: 'browser';
  sequence: number;
  started_at: Date | string;
  ended_at: Date | string;
  sample_count: number;
  byte_count: number;
  payload_sha256: string;
  payload_json: Record<string, unknown>;
};

export class PerformanceLabPersistenceConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PerformanceLabPersistenceConflictError';
  }
}

function iso(value: Date | string) {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function userFromRow(row: UserRow): AuthUser {
  return {
    id: row.user_id,
    displayName: row.display_name,
    ...(row.email ? { email: row.email } : {}),
    ...(row.avatar_url ? { avatarUrl: row.avatar_url } : {}),
    role: row.role,
    status: row.status,
    authSource: row.auth_source,
    ...(row.atlas_home_dir ? { atlasHomeDir: row.atlas_home_dir } : {}),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
    ...(row.last_login_at ? { lastLoginAt: iso(row.last_login_at) } : {}),
  };
}

function performanceLabSessionFromRow(row: PerformanceLabSessionRow) {
  const startedAt = iso(row.started_at);
  const endedAt = row.ended_at ? iso(row.ended_at) : undefined;
  return {
    sessionId: row.session_id,
    userId: row.user_id,
    ...(row.project_id ? { projectId: row.project_id } : {}),
    status: row.status,
    schemaVersion: row.schema_version,
    collectorVersion: row.collector_version,
    user: {
      id: row.user_id,
      displayName: row.current_display_name ?? row.user_display_name,
      ...((row.current_avatar_url ?? row.user_avatar_url)
        ? { avatarUrl: row.current_avatar_url ?? row.user_avatar_url ?? undefined }
        : {}),
      ...((row.current_email ?? row.user_email)
        ? { email: row.current_email ?? row.user_email ?? undefined }
        : {}),
      snapshot: {
        displayName: row.user_display_name,
        ...(row.user_avatar_url ? { avatarUrl: row.user_avatar_url } : {}),
        ...(row.user_email ? { email: row.user_email } : {}),
      },
    },
    startedAt,
    ...(endedAt
      ? { endedAt, durationMs: Math.max(0, Date.parse(endedAt) - Date.parse(startedAt)) }
      : {}),
    clientContext: row.client_context_json,
    ...(row.summary_json ? { summary: row.summary_json } : {}),
    ...(row.report_json ? { report: row.report_json } : {}),
    ...(row.report_sha256 ? { reportSha256: row.report_sha256 } : {}),
    chunkCount: Number(row.chunk_count),
    sampleCount: Number(row.sample_count),
    totalBytes: Number(row.total_bytes),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

const performanceLabSessionColumns = `
  s.session_id, s.user_id, s.project_id, s.status, s.schema_version,
  s.collector_version, s.user_display_name, s.user_avatar_url, s.user_email,
  u.display_name AS current_display_name, u.avatar_url AS current_avatar_url,
  u.email AS current_email, s.started_at, s.ended_at, s.client_context_json,
  s.summary_json, s.report_json, s.report_sha256, s.chunk_count,
  s.sample_count, s.total_bytes, s.created_at, s.updated_at`;

export function createPostgresControlRepository(database: ProjectSqlDatabase) {
  return {
    async upsertUser(input: {
      id: string;
      displayName: string;
      email?: string;
      avatarUrl?: string;
      authSource: AuthSource;
      atlasHomeDir?: string;
      role?: string;
    }) {
      return database.transaction(async (connection) => {
        const existing = await connection.query<UserRow>(
          `SELECT * FROM cloud_users
            WHERE user_id = $1 OR ($2::text IS NOT NULL AND LOWER(email) = LOWER($2))
            ORDER BY CASE WHEN user_id = $1 THEN 0 ELSE 1 END LIMIT 1 FOR UPDATE`,
          [input.id, input.email ?? null],
        );
        const now = new Date().toISOString();
        const id = existing.rows[0]?.user_id ?? input.id;
        if (existing.rows[0]) {
          const result = await connection.query<UserRow>(
            `UPDATE cloud_users SET display_name = $2, email = COALESCE($3, email),
               avatar_url = COALESCE($4, avatar_url), auth_source = $5,
               atlas_home_dir = COALESCE($6, atlas_home_dir),
               role = COALESCE($7, role), updated_at = $8::timestamptz,
               last_login_at = $8::timestamptz WHERE user_id = $1 RETURNING *`,
            [
              id,
              input.displayName,
              input.email ?? null,
              input.avatarUrl ?? null,
              input.authSource,
              input.atlasHomeDir ?? null,
              input.role ?? null,
              now,
            ],
          );
          return userFromRow(result.rows[0]);
        }
        const result = await connection.query<UserRow>(
          `INSERT INTO cloud_users (user_id, display_name, email, avatar_url, role, status,
             auth_source, atlas_home_dir, created_at, updated_at, last_login_at)
           VALUES ($1,$2,$3,$4,COALESCE($7,'user'),'active',$5,$6,$8::timestamptz,$8::timestamptz,$8::timestamptz)
           RETURNING *`,
          [
            id,
            input.displayName,
            input.email ?? null,
            input.avatarUrl ?? null,
            input.authSource,
            input.atlasHomeDir ?? null,
            input.role ?? null,
            now,
          ],
        );
        return userFromRow(result.rows[0]);
      });
    },

    async setUserAtlasHomeDir(userId: string, atlasHomeDir?: string) {
      const result = await database.query<UserRow>(
        `UPDATE cloud_users SET atlas_home_dir = $2, updated_at = NOW()
          WHERE user_id = $1 RETURNING *`,
        [userId, atlasHomeDir ?? null],
      );
      return result.rows[0] ? userFromRow(result.rows[0]) : undefined;
    },

    async createSession(session: UserSession) {
      await database.query('DELETE FROM cloud_user_sessions WHERE expires_at <= NOW()');
      await database.query(
        `INSERT INTO cloud_user_sessions (session_id,user_id,session_token_hash,source,expires_at,created_at,updated_at)
         VALUES ($1,$2,$3,$4,$5::timestamptz,$6::timestamptz,$7::timestamptz)`,
        [
          session.id,
          session.userId,
          session.sessionTokenHash,
          session.source,
          session.expiresAt,
          session.createdAt,
          session.updatedAt,
        ],
      );
    },

    async verifySession(sessionTokenHash: string) {
      const result = await database.query<UserRow>(
        `SELECT u.* FROM cloud_user_sessions s JOIN cloud_users u ON u.user_id = s.user_id
          WHERE s.session_token_hash = $1 AND s.expires_at > NOW() AND u.status = 'active'`,
        [sessionTokenHash],
      );
      return result.rows[0] ? userFromRow(result.rows[0]) : undefined;
    },

    async revokeSession(sessionTokenHash: string) {
      await database.query('DELETE FROM cloud_user_sessions WHERE session_token_hash = $1', [
        sessionTokenHash,
      ]);
    },

    async listFolders(userId: string): Promise<WorkspaceFolder[]> {
      const result = await database.query<{
        folder_id: string;
        name: string;
        sort_order: number;
        created_at: Date | string;
        updated_at: Date | string;
      }>(
        `SELECT folder_id,name,sort_order,created_at,updated_at FROM workspace_folders
           WHERE user_id = $1 AND deleted_at IS NULL ORDER BY sort_order, created_at`,
        [userId],
      );
      return result.rows.map((row) => ({
        id: row.folder_id,
        name: row.name,
        order: row.sort_order,
        createdAt: iso(row.created_at),
        updatedAt: iso(row.updated_at),
      }));
    },

    async createFolder(userId: string, folder: WorkspaceFolder) {
      await database.query(
        `INSERT INTO workspace_folders (user_id,folder_id,name,sort_order,created_at,updated_at)
         VALUES ($1,$2,$3,$4,$5::timestamptz,$6::timestamptz)`,
        [userId, folder.id, folder.name, folder.order, folder.createdAt, folder.updatedAt],
      );
      return folder;
    },

    async renameFolder(userId: string, folderId: string, name: string, updatedAt: string) {
      const result = await database.query<{ folder_id: string }>(
        `UPDATE workspace_folders SET name=$3, updated_at=$4::timestamptz
          WHERE user_id=$1 AND folder_id=$2 AND deleted_at IS NULL RETURNING folder_id`,
        [userId, folderId, name, updatedAt],
      );
      return result.affectedRows === 1;
    },

    async deleteFolder(userId: string, folderId: string, deletedAt: string) {
      const result = await database.query(
        `UPDATE workspace_folders SET deleted_at=$3::timestamptz,updated_at=$3::timestamptz
          WHERE user_id=$1 AND folder_id=$2 AND deleted_at IS NULL`,
        [userId, folderId, deletedAt],
      );
      return result.affectedRows === 1;
    },

    async putAssetJob(jobId: string, record: AssetJobHistoryRecord) {
      await database.query(
        `INSERT INTO asset_job_history (user_id,job_id,record_json,created_at,updated_at)
         VALUES ($1,$2,$3::jsonb,$4::timestamptz,$5::timestamptz)
         ON CONFLICT (user_id,job_id) DO UPDATE SET record_json=EXCLUDED.record_json,updated_at=EXCLUDED.updated_at`,
        [record.userId, jobId, record, record.createdAt, record.updatedAt ?? record.createdAt],
      );
    },

    async getAssetJob(userId: string, jobId: string) {
      const result = await database.query<{ record_json: AssetJobHistoryRecord }>(
        'SELECT record_json FROM asset_job_history WHERE user_id=$1 AND job_id=$2',
        [userId, jobId],
      );
      return result.rows[0]?.record_json;
    },

    async listAssetJobs(userId: string, limit: number) {
      const result = await database.query<{ job_id: string; record_json: AssetJobHistoryRecord }>(
        `SELECT job_id,record_json FROM asset_job_history WHERE user_id=$1 ORDER BY created_at DESC LIMIT $2`,
        [userId, limit],
      );
      return result.rows.map((row) => ({ jobId: row.job_id, record: row.record_json }));
    },

    async putAssetTransfer(record: {
      userId: string;
      intentId: string;
      assetId: string;
      projectId: string;
      status: string;
      createdAt: string;
      verifiedAt?: string;
    }) {
      await database.query(
        `INSERT INTO asset_transfers (user_id,intent_id,asset_id,project_id,status,record_json,created_at,updated_at)
         VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7::timestamptz,$8::timestamptz)
         ON CONFLICT (user_id,intent_id) DO UPDATE SET status=EXCLUDED.status,
           record_json=EXCLUDED.record_json,updated_at=EXCLUDED.updated_at`,
        [
          record.userId,
          record.intentId,
          record.assetId,
          record.projectId,
          record.status,
          record,
          record.createdAt,
          record.verifiedAt ?? record.createdAt,
        ],
      );
    },

    async getAssetTransferByIntent<T>(userId: string, intentId: string) {
      const result = await database.query<{ record_json: T }>(
        'SELECT record_json FROM asset_transfers WHERE user_id=$1 AND intent_id=$2',
        [userId, intentId],
      );
      return result.rows[0]?.record_json;
    },

    async getAssetTransferByAsset<T>(userId: string, assetId: string) {
      const result = await database.query<{ record_json: T }>(
        'SELECT record_json FROM asset_transfers WHERE user_id=$1 AND asset_id=$2',
        [userId, assetId],
      );
      return result.rows[0]?.record_json;
    },

    async getUserSettings<T>(userId: string) {
      const result = await database.query<{ settings_json: T }>(
        'SELECT settings_json FROM user_settings WHERE user_id=$1',
        [userId],
      );
      return result.rows[0]?.settings_json;
    },

    async putUserSettings(userId: string, settings: unknown) {
      await database.query(
        `INSERT INTO user_settings (user_id,settings_json,updated_at) VALUES ($1,$2::jsonb,NOW())
         ON CONFLICT (user_id) DO UPDATE SET settings_json=EXCLUDED.settings_json,updated_at=EXCLUDED.updated_at`,
        [userId, settings],
      );
    },

    async createPerformanceLabSession(input: {
      userId: string;
      sessionId: string;
      projectId?: string;
      schemaVersion: number;
      collectorVersion: string;
      startedAt: string;
      clientContext: Record<string, unknown>;
    }) {
      return database.transaction(async (connection) => {
        const existing = await connection.query<PerformanceLabSessionRow>(
          `SELECT ${performanceLabSessionColumns}
             FROM performance_lab_sessions s
             JOIN cloud_users u ON u.user_id = s.user_id
            WHERE s.session_id = $1 FOR UPDATE`,
          [input.sessionId],
        );
        if (existing.rows[0]) {
          const row = existing.rows[0];
          if (
            row.user_id !== input.userId ||
            row.schema_version !== input.schemaVersion ||
            row.collector_version !== input.collectorVersion ||
            (row.project_id ?? undefined) !== input.projectId
          ) {
            throw new PerformanceLabPersistenceConflictError(
              'This performance session id is already bound to different immutable input.',
            );
          }
          return performanceLabSessionFromRow(row);
        }
        const inserted = await connection.query<{ session_id: string }>(
          `INSERT INTO performance_lab_sessions (
             session_id, user_id, project_id, status, schema_version, collector_version,
             user_display_name, user_avatar_url, user_email, started_at,
             client_context_json, created_at, updated_at
           )
           SELECT $1, u.user_id, $3, 'recording', $4, $5,
                  u.display_name, u.avatar_url, u.email, $6::timestamptz,
                  $7::jsonb, NOW(), NOW()
             FROM cloud_users u WHERE u.user_id = $2
           RETURNING session_id`,
          [
            input.sessionId,
            input.userId,
            input.projectId ?? null,
            input.schemaVersion,
            input.collectorVersion,
            input.startedAt,
            input.clientContext,
          ],
        );
        if (!inserted.rows[0]) throw new Error('Authenticated Cloud user was not found.');
        const result = await connection.query<PerformanceLabSessionRow>(
          `SELECT ${performanceLabSessionColumns}
             FROM performance_lab_sessions s
             JOIN cloud_users u ON u.user_id = s.user_id
            WHERE s.session_id = $1`,
          [input.sessionId],
        );
        return performanceLabSessionFromRow(result.rows[0]);
      });
    },

    async appendPerformanceLabChunk(input: {
      userId: string;
      sessionId: string;
      sequence: number;
      startedAt: string;
      endedAt: string;
      sampleCount: number;
      byteCount: number;
      payloadSha256: string;
      payload: Record<string, unknown>;
    }) {
      return database.transaction(async (connection) => {
        const session = await connection.query<{
          user_id: string;
          status: 'recording' | 'completed';
        }>(
          'SELECT user_id, status FROM performance_lab_sessions WHERE session_id = $1 FOR UPDATE',
          [input.sessionId],
        );
        const row = session.rows[0];
        if (!row || row.user_id !== input.userId) return undefined;
        const existing = await connection.query<{ payload_sha256: string }>(
          `SELECT payload_sha256 FROM performance_lab_chunks
            WHERE session_id = $1 AND source = 'browser' AND sequence = $2`,
          [input.sessionId, input.sequence],
        );
        if (existing.rows[0]) {
          if (existing.rows[0].payload_sha256 !== input.payloadSha256) {
            throw new PerformanceLabPersistenceConflictError(
              'A different performance chunk already used this sequence.',
            );
          }
          return { accepted: true as const, idempotent: true as const };
        }
        if (row.status !== 'recording') {
          throw new PerformanceLabPersistenceConflictError(
            'Completed performance sessions cannot accept new chunks.',
          );
        }
        await connection.query(
          `INSERT INTO performance_lab_chunks (
             session_id, source, sequence, started_at, ended_at, sample_count,
             byte_count, payload_sha256, payload_json, created_at
           ) VALUES ($1, 'browser', $2, $3::timestamptz, $4::timestamptz,
                     $5, $6, $7, $8::jsonb, NOW())`,
          [
            input.sessionId,
            input.sequence,
            input.startedAt,
            input.endedAt,
            input.sampleCount,
            input.byteCount,
            input.payloadSha256,
            input.payload,
          ],
        );
        await connection.query(
          `UPDATE performance_lab_sessions
              SET chunk_count = chunk_count + 1,
                  sample_count = sample_count + $2,
                  total_bytes = total_bytes + $3,
                  updated_at = NOW()
            WHERE session_id = $1`,
          [input.sessionId, input.sampleCount, input.byteCount],
        );
        return { accepted: true as const, idempotent: false as const };
      });
    },

    async completePerformanceLabSession(input: {
      userId: string;
      sessionId: string;
      endedAt: string;
      summary: Record<string, unknown>;
      report: Record<string, unknown>;
      reportSha256: string;
    }) {
      return database.transaction(async (connection) => {
        const selected = await connection.query<PerformanceLabSessionRow>(
          `SELECT ${performanceLabSessionColumns}
             FROM performance_lab_sessions s
             JOIN cloud_users u ON u.user_id = s.user_id
            WHERE s.session_id = $1 FOR UPDATE`,
          [input.sessionId],
        );
        const row = selected.rows[0];
        if (!row || row.user_id !== input.userId) return undefined;
        if (row.status === 'completed') {
          if (row.report_sha256 !== input.reportSha256) {
            throw new PerformanceLabPersistenceConflictError(
              'This performance session was already completed with a different report.',
            );
          }
          return performanceLabSessionFromRow(row);
        }
        await connection.query(
          `UPDATE performance_lab_sessions
              SET status = 'completed', ended_at = $2::timestamptz,
                  summary_json = $3::jsonb, report_json = $4::jsonb,
                  report_sha256 = $5, updated_at = NOW()
            WHERE session_id = $1`,
          [input.sessionId, input.endedAt, input.summary, input.report, input.reportSha256],
        );
        const result = await connection.query<PerformanceLabSessionRow>(
          `SELECT ${performanceLabSessionColumns}
             FROM performance_lab_sessions s
             JOIN cloud_users u ON u.user_id = s.user_id
            WHERE s.session_id = $1`,
          [input.sessionId],
        );
        return performanceLabSessionFromRow(result.rows[0]);
      });
    },

    async listPerformanceLabSessions(input: {
      requesterUserId: string;
      includeAllUsers: boolean;
      limit: number;
      beforeSessionId?: string;
    }) {
      const result = await database.query<PerformanceLabSessionRow>(
        `SELECT ${performanceLabSessionColumns}
           FROM performance_lab_sessions s
           JOIN cloud_users u ON u.user_id = s.user_id
          WHERE ($1::boolean = TRUE OR s.user_id = $2)
            AND ($4::text IS NULL OR (s.started_at, s.session_id) < (
              SELECT cursor.started_at, cursor.session_id FROM performance_lab_sessions cursor
              WHERE cursor.session_id = $4 AND ($1::boolean = TRUE OR cursor.user_id = $2)
            ))
          ORDER BY s.started_at DESC, s.session_id DESC
          LIMIT $3`,
        [input.includeAllUsers, input.requesterUserId, input.limit, input.beforeSessionId ?? null],
      );
      return result.rows.map(performanceLabSessionFromRow);
    },

    async getPerformanceLabSession(input: {
      requesterUserId: string;
      includeAllUsers: boolean;
      sessionId: string;
    }) {
      const selected = await database.query<PerformanceLabSessionRow>(
        `SELECT ${performanceLabSessionColumns}
           FROM performance_lab_sessions s
           JOIN cloud_users u ON u.user_id = s.user_id
          WHERE s.session_id = $1 AND ($2::boolean = TRUE OR s.user_id = $3)`,
        [input.sessionId, input.includeAllUsers, input.requesterUserId],
      );
      const row = selected.rows[0];
      if (!row) return undefined;
      const chunks = await database.query<PerformanceLabChunkRow>(
        `SELECT source, sequence, started_at, ended_at, sample_count, byte_count,
                payload_sha256, payload_json
           FROM performance_lab_chunks
          WHERE session_id = $1
          ORDER BY source, sequence`,
        [input.sessionId],
      );
      return {
        ...performanceLabSessionFromRow(row),
        chunks: chunks.rows.map((chunk) => ({
          source: chunk.source,
          sequence: chunk.sequence,
          startedAt: iso(chunk.started_at),
          endedAt: iso(chunk.ended_at),
          sampleCount: chunk.sample_count,
          byteCount: chunk.byte_count,
          payloadSha256: chunk.payload_sha256,
          payload: chunk.payload_json,
        })),
      };
    },

    async putOAuthLogin(loginId: string, state: string, payload: unknown, expiresAt: string) {
      await database.query('DELETE FROM oauth_login_transactions WHERE expires_at <= NOW()');
      await database.query(
        `INSERT INTO oauth_login_transactions (login_id,oauth_state,payload_json,state_consumed,expires_at,updated_at)
         VALUES ($1,$2,$3::jsonb,FALSE,$4::timestamptz,NOW())
         ON CONFLICT (login_id) DO UPDATE SET payload_json=EXCLUDED.payload_json,
           expires_at=EXCLUDED.expires_at,updated_at=EXCLUDED.updated_at`,
        [loginId, state, payload, expiresAt],
      );
    },

    async getOAuthLogin<T>(loginId: string) {
      const result = await database.query<{ payload_json: T }>(
        'SELECT payload_json FROM oauth_login_transactions WHERE login_id=$1 AND expires_at>NOW()',
        [loginId],
      );
      return result.rows[0]?.payload_json;
    },

    async consumeOAuthState<T>(state: string) {
      const result = await database.query<{ payload_json: T }>(
        `UPDATE oauth_login_transactions SET state_consumed=TRUE,updated_at=NOW()
          WHERE oauth_state=$1 AND state_consumed=FALSE AND expires_at>NOW() RETURNING payload_json`,
        [state],
      );
      return result.rows[0]?.payload_json;
    },

    async deleteOAuthLogin(loginId: string) {
      await database.query('DELETE FROM oauth_login_transactions WHERE login_id=$1', [loginId]);
    },
  };
}

export type PostgresControlRepository = ReturnType<typeof createPostgresControlRepository>;

export const postgresControlRepository = (() => {
  if (process.env.LICLICK_PROJECT_REPOSITORY !== 'postgres') return undefined;
  const connectionString = process.env.LICLICK_CLOUD_DATABASE_URL?.trim();
  if (!connectionString)
    throw new Error('Cloud control plane requires LICLICK_CLOUD_DATABASE_URL.');
  return createPostgresControlRepository(getSharedPgProjectSqlDatabase(connectionString));
})();
