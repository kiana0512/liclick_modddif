CREATE TABLE IF NOT EXISTS project_documents (
  user_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  slug TEXT NOT NULL,
  name TEXT NOT NULL,
  folder_id TEXT,
  document_json JSONB NOT NULL,
  revision_id TEXT NOT NULL,
  revision_number INTEGER NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  deleted_at TIMESTAMPTZ,
  PRIMARY KEY (user_id, project_id),
  UNIQUE (user_id, slug)
);

CREATE INDEX IF NOT EXISTS project_documents_user_updated_idx
  ON project_documents (user_id, updated_at DESC)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS project_documents_user_folder_idx
  ON project_documents (user_id, folder_id)
  WHERE deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS project_document_revisions (
  user_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  revision_id TEXT NOT NULL,
  revision_number INTEGER NOT NULL,
  parent_revision_id TEXT,
  document_json JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (user_id, project_id, revision_id),
  UNIQUE (user_id, project_id, revision_number),
  FOREIGN KEY (user_id, project_id)
    REFERENCES project_documents (user_id, project_id)
    ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS project_document_revisions_history_idx
  ON project_document_revisions (user_id, project_id, revision_number DESC);

CREATE TABLE IF NOT EXISTS project_command_receipts (
  user_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  command_id TEXT NOT NULL,
  command_sha256 TEXT NOT NULL,
  result_revision_id TEXT NOT NULL,
  applied_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (user_id, project_id, command_id),
  FOREIGN KEY (user_id, project_id)
    REFERENCES project_documents (user_id, project_id)
    ON DELETE CASCADE
);
