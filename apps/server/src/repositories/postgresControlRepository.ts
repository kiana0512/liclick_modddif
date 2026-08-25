import type { AuthSource, AuthUser, UserSession } from '../auth/authTypes.js';
import type { WorkspaceFolder } from '../types/folder.js';
import type { AssetJobHistoryRecord } from '../services/assetJobOwnership.js';
import { getSharedPgProjectSqlDatabase, type ProjectSqlDatabase } from './postgresProjectRepository.js';

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

export function createPostgresControlRepository(database: ProjectSqlDatabase) {
  return {
    async upsertUser(input: {
      id: string;
      displayName: string;
      email?: string;
      avatarUrl?: string;
      authSource: AuthSource;
      atlasHomeDir?: string;
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
               atlas_home_dir = COALESCE($6, atlas_home_dir), updated_at = $7::timestamptz,
               last_login_at = $7::timestamptz WHERE user_id = $1 RETURNING *`,
            [id, input.displayName, input.email ?? null, input.avatarUrl ?? null, input.authSource, input.atlasHomeDir ?? null, now],
          );
          return userFromRow(result.rows[0]);
        }
        const result = await connection.query<UserRow>(
          `INSERT INTO cloud_users (user_id, display_name, email, avatar_url, role, status,
             auth_source, atlas_home_dir, created_at, updated_at, last_login_at)
           VALUES ($1,$2,$3,$4,'user','active',$5,$6,$7::timestamptz,$7::timestamptz,$7::timestamptz)
           RETURNING *`,
          [id, input.displayName, input.email ?? null, input.avatarUrl ?? null, input.authSource, input.atlasHomeDir ?? null, now],
        );
        return userFromRow(result.rows[0]);
      });
    },

    async createSession(session: UserSession) {
      await database.query('DELETE FROM cloud_user_sessions WHERE expires_at <= NOW()');
      await database.query(
        `INSERT INTO cloud_user_sessions (session_id,user_id,session_token_hash,source,expires_at,created_at,updated_at)
         VALUES ($1,$2,$3,$4,$5::timestamptz,$6::timestamptz,$7::timestamptz)`,
        [session.id, session.userId, session.sessionTokenHash, session.source, session.expiresAt, session.createdAt, session.updatedAt],
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
      await database.query('DELETE FROM cloud_user_sessions WHERE session_token_hash = $1', [sessionTokenHash]);
    },

    async listFolders(userId: string): Promise<WorkspaceFolder[]> {
      const result = await database.query<{
        folder_id: string; name: string; sort_order: number; created_at: Date | string; updated_at: Date | string;
      }>(`SELECT folder_id,name,sort_order,created_at,updated_at FROM workspace_folders
           WHERE user_id = $1 AND deleted_at IS NULL ORDER BY sort_order, created_at`, [userId]);
      return result.rows.map((row) => ({ id: row.folder_id, name: row.name, order: row.sort_order, createdAt: iso(row.created_at), updatedAt: iso(row.updated_at) }));
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
          WHERE user_id=$1 AND folder_id=$2 AND deleted_at IS NULL`, [userId, folderId, deletedAt],
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
        'SELECT record_json FROM asset_job_history WHERE user_id=$1 AND job_id=$2', [userId, jobId],
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
      userId: string; intentId: string; assetId: string; projectId: string;
      status: string; createdAt: string; verifiedAt?: string;
    }) {
      await database.query(
        `INSERT INTO asset_transfers (user_id,intent_id,asset_id,project_id,status,record_json,created_at,updated_at)
         VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7::timestamptz,$8::timestamptz)
         ON CONFLICT (user_id,intent_id) DO UPDATE SET status=EXCLUDED.status,
           record_json=EXCLUDED.record_json,updated_at=EXCLUDED.updated_at`,
        [record.userId, record.intentId, record.assetId, record.projectId, record.status, record,
          record.createdAt, record.verifiedAt ?? record.createdAt],
      );
    },

    async getAssetTransferByIntent<T>(userId: string, intentId: string) {
      const result = await database.query<{ record_json: T }>(
        'SELECT record_json FROM asset_transfers WHERE user_id=$1 AND intent_id=$2', [userId, intentId],
      );
      return result.rows[0]?.record_json;
    },

    async getAssetTransferByAsset<T>(userId: string, assetId: string) {
      const result = await database.query<{ record_json: T }>(
        'SELECT record_json FROM asset_transfers WHERE user_id=$1 AND asset_id=$2', [userId, assetId],
      );
      return result.rows[0]?.record_json;
    },

    async getUserSettings<T>(userId: string) {
      const result = await database.query<{ settings_json: T }>(
        'SELECT settings_json FROM user_settings WHERE user_id=$1', [userId],
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
        'SELECT payload_json FROM oauth_login_transactions WHERE login_id=$1 AND expires_at>NOW()', [loginId],
      );
      return result.rows[0]?.payload_json;
    },

    async consumeOAuthState<T>(state: string) {
      const result = await database.query<{ payload_json: T }>(
        `UPDATE oauth_login_transactions SET state_consumed=TRUE,updated_at=NOW()
          WHERE oauth_state=$1 AND state_consumed=FALSE AND expires_at>NOW() RETURNING payload_json`, [state],
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
  if (!connectionString) throw new Error('Cloud control plane requires LICLICK_CLOUD_DATABASE_URL.');
  return createPostgresControlRepository(getSharedPgProjectSqlDatabase(connectionString));
})();
