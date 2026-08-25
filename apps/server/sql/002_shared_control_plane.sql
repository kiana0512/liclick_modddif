CREATE TABLE IF NOT EXISTS cloud_users (
  user_id TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  email TEXT,
  avatar_url TEXT,
  role TEXT NOT NULL DEFAULT 'user',
  status TEXT NOT NULL DEFAULT 'active',
  auth_source TEXT NOT NULL,
  atlas_home_dir TEXT,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  last_login_at TIMESTAMPTZ
);

CREATE UNIQUE INDEX IF NOT EXISTS cloud_users_email_unique_idx
  ON cloud_users (LOWER(email)) WHERE email IS NOT NULL;

CREATE TABLE IF NOT EXISTS cloud_user_sessions (
  session_id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES cloud_users(user_id) ON DELETE CASCADE,
  session_token_hash TEXT NOT NULL UNIQUE,
  source TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS cloud_user_sessions_user_expiry_idx
  ON cloud_user_sessions (user_id, expires_at DESC);

CREATE TABLE IF NOT EXISTS workspace_folders (
  user_id TEXT NOT NULL,
  folder_id TEXT NOT NULL,
  name TEXT NOT NULL,
  sort_order INTEGER NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  deleted_at TIMESTAMPTZ,
  PRIMARY KEY (user_id, folder_id)
);

CREATE INDEX IF NOT EXISTS workspace_folders_user_order_idx
  ON workspace_folders (user_id, sort_order) WHERE deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS asset_job_history (
  user_id TEXT NOT NULL,
  job_id TEXT NOT NULL,
  record_json JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (user_id, job_id)
);

CREATE INDEX IF NOT EXISTS asset_job_history_user_created_idx
  ON asset_job_history (user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS asset_transfers (
  user_id TEXT NOT NULL,
  intent_id TEXT NOT NULL,
  asset_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  status TEXT NOT NULL,
  record_json JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (user_id, intent_id),
  UNIQUE (user_id, asset_id)
);

CREATE INDEX IF NOT EXISTS asset_transfers_user_project_idx
  ON asset_transfers (user_id, project_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS user_settings (
  user_id TEXT PRIMARY KEY,
  settings_json JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS oauth_login_transactions (
  login_id TEXT PRIMARY KEY,
  oauth_state TEXT NOT NULL UNIQUE,
  payload_json JSONB NOT NULL,
  state_consumed BOOLEAN NOT NULL DEFAULT FALSE,
  expires_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS oauth_login_transactions_expiry_idx
  ON oauth_login_transactions (expires_at);
