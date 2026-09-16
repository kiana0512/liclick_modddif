-- Asset Storage Schema v2 shadow tables.
-- These tables do not replace Asset Transfer v1 reads or writes yet. They
-- provide inventory, reconciliation and reversible quarantine state only.

CREATE TABLE IF NOT EXISTS asset_storage_blobs (
  user_id TEXT NOT NULL REFERENCES cloud_users(user_id) ON DELETE CASCADE,
  blob_id TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  size_bytes BIGINT NOT NULL CHECK (size_bytes > 0),
  mime_type TEXT NOT NULL,
  object_key TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN (
    'reserved', 'uploading', 'verified', 'quarantined', 'deleting', 'deleted', 'failed'
  )),
  source_protocol INTEGER NOT NULL DEFAULT 1,
  verified_at TIMESTAMPTZ,
  quarantined_at TIMESTAMPTZ,
  delete_after TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (user_id, blob_id),
  UNIQUE (user_id, sha256, size_bytes),
  UNIQUE (object_key)
);

CREATE INDEX IF NOT EXISTS asset_storage_blobs_user_state_idx
  ON asset_storage_blobs (user_id, state, updated_at DESC);

CREATE TABLE IF NOT EXISTS asset_storage_records (
  user_id TEXT NOT NULL,
  asset_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  category TEXT NOT NULL,
  filename TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  blob_id TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('verified', 'quarantined', 'deleted')),
  source_intent_id TEXT,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  deleted_at TIMESTAMPTZ,
  PRIMARY KEY (user_id, asset_id),
  FOREIGN KEY (user_id, blob_id)
    REFERENCES asset_storage_blobs (user_id, blob_id)
    ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS asset_storage_records_user_project_idx
  ON asset_storage_records (user_id, project_id, updated_at DESC);

CREATE INDEX IF NOT EXISTS asset_storage_records_user_blob_idx
  ON asset_storage_records (user_id, blob_id);

CREATE TABLE IF NOT EXISTS asset_storage_references (
  user_id TEXT NOT NULL,
  reference_id TEXT NOT NULL,
  asset_id TEXT NOT NULL,
  owner_type TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  owner_revision_id TEXT,
  field_path_hash TEXT NOT NULL,
  retention_class TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  released_at TIMESTAMPTZ,
  PRIMARY KEY (user_id, reference_id),
  FOREIGN KEY (user_id, asset_id)
    REFERENCES asset_storage_records (user_id, asset_id)
    ON DELETE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS asset_storage_references_identity_idx
  ON asset_storage_references (
    user_id, owner_type, owner_id, COALESCE(owner_revision_id, ''),
    field_path_hash, asset_id
  );

CREATE INDEX IF NOT EXISTS asset_storage_references_live_asset_idx
  ON asset_storage_references (user_id, asset_id)
  WHERE released_at IS NULL;

CREATE TABLE IF NOT EXISTS asset_storage_inventory_snapshots (
  user_id TEXT PRIMARY KEY REFERENCES cloud_users(user_id) ON DELETE CASCADE,
  scan_id TEXT NOT NULL,
  schema_version INTEGER NOT NULL,
  rule_version TEXT NOT NULL,
  status TEXT NOT NULL,
  snapshot_json JSONB NOT NULL,
  started_at TIMESTAMPTZ NOT NULL,
  completed_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS asset_storage_inventory_scan_idx
  ON asset_storage_inventory_snapshots (user_id, scan_id);

CREATE TABLE IF NOT EXISTS asset_storage_inventory_candidates (
  user_id TEXT NOT NULL REFERENCES cloud_users(user_id) ON DELETE CASCADE,
  scan_id TEXT NOT NULL,
  candidate_id TEXT NOT NULL,
  asset_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  category TEXT NOT NULL,
  size_bytes BIGINT NOT NULL CHECK (size_bytes >= 0),
  proof_json JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (user_id, scan_id, candidate_id),
  UNIQUE (user_id, scan_id, asset_id)
);

CREATE INDEX IF NOT EXISTS asset_storage_inventory_candidates_scan_idx
  ON asset_storage_inventory_candidates (user_id, scan_id, candidate_id);

CREATE TABLE IF NOT EXISTS asset_storage_inventory_scan_references (
  user_id TEXT NOT NULL REFERENCES cloud_users(user_id) ON DELETE CASCADE,
  scan_id TEXT NOT NULL,
  asset_id TEXT NOT NULL,
  bucket_id TEXT NOT NULL CHECK (bucket_id IN ('project-resources', 'history', 'trash')),
  PRIMARY KEY (user_id, scan_id, asset_id)
);

CREATE TABLE IF NOT EXISTS asset_storage_cleanup_jobs (
  user_id TEXT NOT NULL REFERENCES cloud_users(user_id) ON DELETE CASCADE,
  job_id TEXT NOT NULL,
  scan_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'completed', 'failed')),
  job_json JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  completed_at TIMESTAMPTZ,
  PRIMARY KEY (user_id, job_id),
  UNIQUE (user_id, idempotency_key)
);

CREATE INDEX IF NOT EXISTS asset_storage_cleanup_jobs_user_created_idx
  ON asset_storage_cleanup_jobs (user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS asset_storage_quarantine (
  user_id TEXT NOT NULL REFERENCES cloud_users(user_id) ON DELETE CASCADE,
  asset_id TEXT NOT NULL,
  job_id TEXT NOT NULL,
  scan_id TEXT NOT NULL,
  quarantined_at TIMESTAMPTZ NOT NULL,
  delete_after TIMESTAMPTZ NOT NULL,
  restored_at TIMESTAMPTZ,
  deleted_at TIMESTAMPTZ,
  PRIMARY KEY (user_id, asset_id),
  FOREIGN KEY (user_id, job_id)
    REFERENCES asset_storage_cleanup_jobs (user_id, job_id)
    ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS asset_storage_purge_jobs (
  user_id TEXT NOT NULL REFERENCES cloud_users(user_id) ON DELETE CASCADE,
  job_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'completed', 'failed')),
  job_json JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  completed_at TIMESTAMPTZ,
  PRIMARY KEY (user_id, job_id),
  UNIQUE (user_id, idempotency_key)
);

CREATE INDEX IF NOT EXISTS asset_storage_purge_jobs_user_created_idx
  ON asset_storage_purge_jobs (user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS asset_storage_purge_items (
  user_id TEXT NOT NULL,
  job_id TEXT NOT NULL,
  asset_id TEXT NOT NULL,
  object_key TEXT NOT NULL,
  size_bytes BIGINT NOT NULL CHECK (size_bytes >= 0),
  status TEXT NOT NULL CHECK (status IN ('pending', 'deleted', 'failed')),
  error TEXT,
  updated_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (user_id, job_id, asset_id),
  FOREIGN KEY (user_id, job_id)
    REFERENCES asset_storage_purge_jobs (user_id, job_id)
    ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS asset_storage_purge_items_pending_idx
  ON asset_storage_purge_items (user_id, job_id, status, asset_id);

CREATE INDEX IF NOT EXISTS asset_storage_quarantine_due_idx
  ON asset_storage_quarantine (delete_after, user_id)
  WHERE restored_at IS NULL AND deleted_at IS NULL;
