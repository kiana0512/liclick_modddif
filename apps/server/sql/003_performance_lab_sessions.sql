CREATE TABLE IF NOT EXISTS performance_lab_sessions (
  session_id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES cloud_users(user_id) ON DELETE CASCADE,
  project_id TEXT,
  status TEXT NOT NULL CHECK (status IN ('recording', 'completed')),
  schema_version INTEGER NOT NULL,
  collector_version TEXT NOT NULL,
  user_display_name TEXT NOT NULL,
  user_avatar_url TEXT,
  user_email TEXT,
  started_at TIMESTAMPTZ NOT NULL,
  ended_at TIMESTAMPTZ,
  client_context_json JSONB NOT NULL,
  summary_json JSONB,
  report_json JSONB,
  report_sha256 TEXT,
  chunk_count INTEGER NOT NULL DEFAULT 0,
  sample_count BIGINT NOT NULL DEFAULT 0,
  total_bytes BIGINT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS performance_lab_sessions_user_started_idx
  ON performance_lab_sessions (user_id, started_at DESC);

CREATE INDEX IF NOT EXISTS performance_lab_sessions_status_started_idx
  ON performance_lab_sessions (status, started_at DESC);

CREATE INDEX IF NOT EXISTS performance_lab_sessions_project_started_idx
  ON performance_lab_sessions (project_id, started_at DESC)
  WHERE project_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS performance_lab_chunks (
  session_id TEXT NOT NULL REFERENCES performance_lab_sessions(session_id) ON DELETE CASCADE,
  source TEXT NOT NULL CHECK (source = 'browser'),
  sequence INTEGER NOT NULL CHECK (sequence >= 0),
  started_at TIMESTAMPTZ NOT NULL,
  ended_at TIMESTAMPTZ NOT NULL,
  sample_count INTEGER NOT NULL CHECK (sample_count >= 0),
  byte_count INTEGER NOT NULL CHECK (byte_count >= 0),
  payload_sha256 TEXT NOT NULL,
  payload_json JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (session_id, source, sequence)
);

CREATE INDEX IF NOT EXISTS performance_lab_chunks_session_time_idx
  ON performance_lab_chunks (session_id, started_at, sequence);

COMMENT ON TABLE performance_lab_sessions IS
  'PERF-LAB-REPORT schema v2 browser recordings. Cloud stores reports; server GPU is not measured.';

COMMENT ON COLUMN performance_lab_sessions.user_display_name IS
  'Trusted Feishu/auth-session display-name snapshot at recording time.';

COMMENT ON COLUMN performance_lab_sessions.user_avatar_url IS
  'Trusted Feishu/auth-session avatar snapshot at recording time.';
