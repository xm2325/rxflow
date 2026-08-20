CREATE TABLE IF NOT EXISTS rxflow_schema_migrations (
  version INTEGER PRIMARY KEY,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS cases (
  id TEXT PRIMARY KEY,
  version INTEGER NOT NULL CHECK (version >= 1),
  status TEXT NOT NULL,
  case_json JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS idempotency (
  key TEXT PRIMARY KEY,
  case_id TEXT NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
  request_fingerprint TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS outbox (
  event_id TEXT PRIMARY KEY,
  event_json JSONB NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('PENDING','IN_FLIGHT','PUBLISHED','DEAD_LETTER')),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  last_error TEXT,
  published_at TIMESTAMPTZ,
  claim_id TEXT,
  claimed_by TEXT,
  lease_until TIMESTAMPTZ,
  next_attempt_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_cases_status ON cases(status);
CREATE INDEX IF NOT EXISTS idx_outbox_status_created ON outbox(status, created_at, event_id);
CREATE INDEX IF NOT EXISTS idx_outbox_lease ON outbox(status, lease_until);
CREATE INDEX IF NOT EXISTS idx_outbox_retry ON outbox(status, next_attempt_at);

INSERT INTO rxflow_schema_migrations(version) VALUES (1)
ON CONFLICT (version) DO NOTHING;
