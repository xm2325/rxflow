import { randomUUID } from "node:crypto";
import type { RxCase, WorkflowStatus } from "./domain.js";
import type { ClaimedOutboxRecord, DeliveryGapReasonCode, IntegrationEvent, OutboxRecord, OutboxStatus } from "./events.js";
import { IdempotencyKeyAlreadyBoundError, type CaseStore, type IdempotencyLookup, type OutboxCounts, type OutboxPressure, type OutboxRecoveryAuditAction, type OutboxRecoveryAuditEntry, type OutboxRetirementApprovalRequest, type OutboxRetirementApprovalResult, type OutboxRetirementRequest, type OutboxRetirementResult } from "./store.js";

export interface PgQueryResult<Row = Record<string, unknown>> {
  rows: Row[];
  rowCount?: number | null;
}

export interface PgClientLike {
  query<Row = Record<string, unknown>>(text: string, params?: readonly unknown[]): Promise<PgQueryResult<Row>>;
  release(): void;
}

export interface PgPoolLike {
  query<Row = Record<string, unknown>>(text: string, params?: readonly unknown[]): Promise<PgQueryResult<Row>>;
  connect(): Promise<PgClientLike>;
  end?(): Promise<void>;
}

export const POSTGRES_SCHEMA_VERSION = 9;

export const POSTGRES_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS rxflow_schema_migrations (
  version INTEGER PRIMARY KEY,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS cases (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  version INTEGER NOT NULL CHECK (version >= 1),
  status TEXT NOT NULL,
  case_json JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS idempotency (
  key TEXT NOT NULL,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  case_id TEXT NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
  request_fingerprint TEXT NOT NULL,
  PRIMARY KEY (tenant_id, key)
);

CREATE TABLE IF NOT EXISTS outbox (
  event_id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  aggregate_case_id TEXT,
  aggregate_sequence INTEGER,
  event_json JSONB NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('PENDING','IN_FLIGHT','PUBLISHED','DEAD_LETTER','RETIRED')),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  last_error TEXT,
  published_at TIMESTAMPTZ,
  claim_id TEXT,
  claimed_by TEXT,
  lease_until TIMESTAMPTZ,
  next_attempt_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  retired_at TIMESTAMPTZ,
  retired_by TEXT,
  retirement_reason_code TEXT,
  retirement_reference TEXT,
  replacement_event_id TEXT,
  recovery_generation INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS outbox_retirement_requests (
  request_id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  recovery_generation INTEGER NOT NULL CHECK (recovery_generation >= 1),
  requested_by TEXT NOT NULL,
  reason_code TEXT NOT NULL,
  reference TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('PENDING','APPROVED','SUPERSEDED')),
  requested_at TIMESTAMPTZ NOT NULL,
  approved_by TEXT,
  approved_at TIMESTAMPTZ,
  replacement_event_id TEXT,
  superseded_by TEXT,
  superseded_at TIMESTAMPTZ,
  UNIQUE(tenant_id, event_id, recovery_generation)
);

CREATE TABLE IF NOT EXISTS outbox_recovery_audit (
  audit_id TEXT PRIMARY KEY,
  audit_sequence INTEGER NOT NULL,
  tenant_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  recovery_generation INTEGER NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('REDRIVEN','RETIREMENT_REQUESTED','RETIREMENT_APPROVED','RETIREMENT_SUPERSEDED')),
  actor_id TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  request_id TEXT,
  reason_code TEXT,
  reference TEXT,
  replacement_event_id TEXT,
  UNIQUE(tenant_id, event_id, audit_sequence)
);

-- v2 adds relational tenant columns to existing v1 installations. Values are
-- backfilled from the durable JSON records so legacy/default and tenant-aware
-- cases can be migrated without rewriting application-level identifiers.
ALTER TABLE cases ADD COLUMN IF NOT EXISTS tenant_id TEXT;
UPDATE cases
SET tenant_id = COALESCE(NULLIF(case_json->>'tenantId', ''), 'default')
WHERE tenant_id IS NULL;
ALTER TABLE cases ALTER COLUMN tenant_id SET DEFAULT 'default';
ALTER TABLE cases ALTER COLUMN tenant_id SET NOT NULL;

ALTER TABLE idempotency ADD COLUMN IF NOT EXISTS tenant_id TEXT;
UPDATE idempotency AS i
SET tenant_id = COALESCE(c.tenant_id, 'default')
FROM cases AS c
WHERE i.case_id = c.id AND i.tenant_id IS NULL;
UPDATE idempotency SET tenant_id = 'default' WHERE tenant_id IS NULL;
ALTER TABLE idempotency ALTER COLUMN tenant_id SET DEFAULT 'default';
ALTER TABLE idempotency ALTER COLUMN tenant_id SET NOT NULL;

ALTER TABLE outbox ADD COLUMN IF NOT EXISTS tenant_id TEXT;
UPDATE outbox
SET tenant_id = COALESCE(NULLIF(event_json->>'tenantId', ''), 'default')
WHERE tenant_id IS NULL;
ALTER TABLE outbox ALTER COLUMN tenant_id SET DEFAULT 'default';
ALTER TABLE outbox ALTER COLUMN tenant_id SET NOT NULL;

-- v3 makes the external idempotency key tenant-local in storage. v0.0.65-v0.0.69
-- encoded non-default tenant identity into the key string; strip that legacy
-- prefix once, then enforce the relational (tenant_id, key) primary key.
DO $$
DECLARE
  pk_columns TEXT;
BEGIN
  SELECT string_agg(a.attname, ',' ORDER BY u.ordinality)
  INTO pk_columns
  FROM pg_constraint AS c
  CROSS JOIN LATERAL unnest(c.conkey) WITH ORDINALITY AS u(attnum, ordinality)
  JOIN pg_attribute AS a ON a.attrelid = c.conrelid AND a.attnum = u.attnum
  WHERE c.conrelid = 'public.idempotency'::regclass AND c.contype = 'p';

  IF pk_columns IS DISTINCT FROM 'tenant_id,key' THEN
    ALTER TABLE idempotency DROP CONSTRAINT IF EXISTS idempotency_pkey;
    UPDATE idempotency
    SET key = substring(key FROM length(tenant_id) + 2)
    WHERE key LIKE tenant_id || chr(31) || '%';
    ALTER TABLE idempotency ADD CONSTRAINT idempotency_pkey PRIMARY KEY (tenant_id, key);
  END IF;
END $$;

-- v4 makes aggregate ordering relational so the dispatcher can enforce
-- head-of-line delivery without parsing JSON inside queue ownership logic.
ALTER TABLE outbox ADD COLUMN IF NOT EXISTS aggregate_case_id TEXT;
ALTER TABLE outbox ADD COLUMN IF NOT EXISTS aggregate_sequence INTEGER;
UPDATE outbox
SET aggregate_case_id = event_json->>'caseId',
    aggregate_sequence = CASE
      WHEN (event_json->>'aggregateSequence') ~ '^[0-9]+$' THEN (event_json->>'aggregateSequence')::integer
      ELSE NULL
    END
WHERE aggregate_case_id IS NULL OR aggregate_sequence IS NULL;

-- v5 adds explicit retirement metadata for operator-declared delivery gaps.
ALTER TABLE outbox ADD COLUMN IF NOT EXISTS retired_at TIMESTAMPTZ;
ALTER TABLE outbox ADD COLUMN IF NOT EXISTS retired_by TEXT;
ALTER TABLE outbox ADD COLUMN IF NOT EXISTS retirement_reason_code TEXT;
ALTER TABLE outbox ADD COLUMN IF NOT EXISTS retirement_reference TEXT;
ALTER TABLE outbox ADD COLUMN IF NOT EXISTS replacement_event_id TEXT;
ALTER TABLE outbox DROP CONSTRAINT IF EXISTS outbox_status_check;
ALTER TABLE outbox ADD CONSTRAINT outbox_status_check CHECK (status IN ('PENDING','IN_FLIGHT','PUBLISHED','DEAD_LETTER','RETIRED')) NOT VALID;
ALTER TABLE outbox VALIDATE CONSTRAINT outbox_status_check;

-- v6 versions dead-letter recovery cycles so stale operator actions cannot target a newer failure.
ALTER TABLE outbox ADD COLUMN IF NOT EXISTS recovery_generation INTEGER NOT NULL DEFAULT 0;

-- v7 adds durable two-person retirement requests and recovery audit history.
CREATE TABLE IF NOT EXISTS outbox_retirement_requests (
  request_id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, event_id TEXT NOT NULL, recovery_generation INTEGER NOT NULL CHECK (recovery_generation >= 1),
  requested_by TEXT NOT NULL, reason_code TEXT NOT NULL, reference TEXT NOT NULL, status TEXT NOT NULL CHECK (status IN ('PENDING','APPROVED')),
  requested_at TIMESTAMPTZ NOT NULL, approved_by TEXT, approved_at TIMESTAMPTZ, replacement_event_id TEXT,
  UNIQUE(tenant_id, event_id, recovery_generation)
);
CREATE TABLE IF NOT EXISTS outbox_recovery_audit (
  audit_id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, event_id TEXT NOT NULL, recovery_generation INTEGER NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('REDRIVEN','RETIREMENT_REQUESTED','RETIREMENT_APPROVED','RETIREMENT_SUPERSEDED')), actor_id TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL,
  request_id TEXT, reason_code TEXT, reference TEXT, replacement_event_id TEXT
);

-- v8 gives stale two-person recovery proposals an explicit lifecycle state.
ALTER TABLE outbox_retirement_requests ADD COLUMN IF NOT EXISTS superseded_by TEXT;
ALTER TABLE outbox_retirement_requests ADD COLUMN IF NOT EXISTS superseded_at TIMESTAMPTZ;
ALTER TABLE outbox_retirement_requests DROP CONSTRAINT IF EXISTS outbox_retirement_requests_status_check;
ALTER TABLE outbox_retirement_requests ADD CONSTRAINT outbox_retirement_requests_status_check CHECK (status IN ('PENDING','APPROVED','SUPERSEDED')) NOT VALID;
ALTER TABLE outbox_retirement_requests VALIDATE CONSTRAINT outbox_retirement_requests_status_check;
ALTER TABLE outbox_recovery_audit DROP CONSTRAINT IF EXISTS outbox_recovery_audit_action_check;
ALTER TABLE outbox_recovery_audit ADD CONSTRAINT outbox_recovery_audit_action_check CHECK (action IN ('REDRIVEN','RETIREMENT_REQUESTED','RETIREMENT_APPROVED','RETIREMENT_SUPERSEDED')) NOT VALID;
ALTER TABLE outbox_recovery_audit VALIDATE CONSTRAINT outbox_recovery_audit_action_check;

-- v9 adds a durable causal sequence because timestamps can collide inside one transaction.
ALTER TABLE outbox_recovery_audit ADD COLUMN IF NOT EXISTS audit_sequence INTEGER;
WITH ranked AS (
  SELECT audit_id, ROW_NUMBER() OVER (PARTITION BY tenant_id,event_id ORDER BY created_at,audit_id) AS seq
  FROM outbox_recovery_audit
)
UPDATE outbox_recovery_audit AS a SET audit_sequence = ranked.seq
FROM ranked WHERE a.audit_id = ranked.audit_id AND a.audit_sequence IS NULL;
ALTER TABLE outbox_recovery_audit ALTER COLUMN audit_sequence SET NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_outbox_recovery_audit_sequence ON outbox_recovery_audit(tenant_id,event_id,audit_sequence);

CREATE INDEX IF NOT EXISTS idx_cases_tenant_status ON cases(tenant_id, status);
CREATE INDEX IF NOT EXISTS idx_cases_tenant_updated ON cases(tenant_id, updated_at, id);
CREATE INDEX IF NOT EXISTS idx_idempotency_tenant_key ON idempotency(tenant_id, key);
CREATE INDEX IF NOT EXISTS idx_outbox_tenant_status_created ON outbox(tenant_id, status, created_at, event_id);
CREATE INDEX IF NOT EXISTS idx_outbox_status_created ON outbox(status, created_at, event_id);
CREATE INDEX IF NOT EXISTS idx_outbox_lease ON outbox(status, lease_until);
CREATE INDEX IF NOT EXISTS idx_outbox_retry ON outbox(status, next_attempt_at);
CREATE INDEX IF NOT EXISTS idx_outbox_aggregate_order ON outbox(tenant_id, aggregate_case_id, aggregate_sequence, status);
CREATE INDEX IF NOT EXISTS idx_outbox_retirement_requests_tenant_event ON outbox_retirement_requests(tenant_id, event_id, requested_at);
CREATE INDEX IF NOT EXISTS idx_outbox_recovery_audit_tenant_event ON outbox_recovery_audit(tenant_id, event_id, created_at, audit_id);

INSERT INTO rxflow_schema_migrations(version) VALUES (1)
ON CONFLICT (version) DO NOTHING;
INSERT INTO rxflow_schema_migrations(version) VALUES (2)
ON CONFLICT (version) DO NOTHING;
INSERT INTO rxflow_schema_migrations(version) VALUES (3)
ON CONFLICT (version) DO NOTHING;
INSERT INTO rxflow_schema_migrations(version) VALUES (4)
ON CONFLICT (version) DO NOTHING;
INSERT INTO rxflow_schema_migrations(version) VALUES (5)
ON CONFLICT (version) DO NOTHING;
INSERT INTO rxflow_schema_migrations(version) VALUES (6)
ON CONFLICT (version) DO NOTHING;
INSERT INTO rxflow_schema_migrations(version) VALUES (7)
ON CONFLICT (version) DO NOTHING;
INSERT INTO rxflow_schema_migrations(version) VALUES (8)
ON CONFLICT (version) DO NOTHING;
INSERT INTO rxflow_schema_migrations(version) VALUES (9)
ON CONFLICT (version) DO NOTHING;
`;

export const POSTGRES_VERIFY_SCHEMA_SQL = `
SELECT
  COALESCE((SELECT MAX(version) FROM rxflow_schema_migrations), 0) AS version,
  to_regclass('public.cases') IS NOT NULL AS has_cases,
  to_regclass('public.idempotency') IS NOT NULL AS has_idempotency,
  to_regclass('public.outbox') IS NOT NULL AS has_outbox,
  EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'cases' AND column_name = 'tenant_id'
  ) AS has_case_tenant,
  EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'idempotency' AND column_name = 'tenant_id'
  ) AS has_idempotency_tenant,
  EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'outbox' AND column_name = 'tenant_id'
  ) AS has_outbox_tenant,
  EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'outbox' AND column_name = 'aggregate_case_id'
  ) AS has_outbox_aggregate_case,
  EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'outbox' AND column_name = 'aggregate_sequence'
  ) AS has_outbox_aggregate_sequence,
  EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'outbox' AND column_name = 'retired_at'
  ) AS has_outbox_retired_at,
  EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'outbox' AND column_name = 'replacement_event_id'
  ) AS has_outbox_replacement_event,
  EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'outbox' AND column_name = 'recovery_generation'
  ) AS has_outbox_recovery_generation,
  to_regclass('public.outbox_retirement_requests') IS NOT NULL AS has_outbox_retirement_requests,
  to_regclass('public.outbox_recovery_audit') IS NOT NULL AS has_outbox_recovery_audit,
  EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'outbox_retirement_requests' AND column_name = 'superseded_at'
  ) AS has_retirement_request_superseded_at,
  EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'outbox_recovery_audit' AND column_name = 'audit_sequence'
  ) AS has_recovery_audit_sequence,
  COALESCE((
    SELECT string_agg(a.attname, ',' ORDER BY u.ordinality) = 'tenant_id,key'
    FROM pg_constraint AS c
    CROSS JOIN LATERAL unnest(c.conkey) WITH ORDINALITY AS u(attnum, ordinality)
    JOIN pg_attribute AS a ON a.attrelid = c.conrelid AND a.attnum = u.attnum
    WHERE c.conrelid = 'public.idempotency'::regclass AND c.contype = 'p'
  ), false) AS has_idempotency_composite_pk;
`;

export const POSTGRES_CLAIM_OUTBOX_SQL = `
WITH eligible_heads AS (
  SELECT o.event_id, o.tenant_id, o.created_at
  FROM outbox AS o
  WHERE (
      (o.status = 'PENDING' AND (o.next_attempt_at IS NULL OR o.next_attempt_at <= $1::timestamptz))
      OR (o.status = 'IN_FLIGHT' AND o.lease_until <= $1::timestamptz)
    )
    AND (
      o.aggregate_sequence IS NULL
      OR NOT EXISTS (
        SELECT 1
        FROM outbox AS predecessor
        WHERE predecessor.tenant_id = o.tenant_id
          AND predecessor.aggregate_case_id = o.aggregate_case_id
          AND predecessor.aggregate_sequence < o.aggregate_sequence
          AND predecessor.status NOT IN ('PUBLISHED','RETIRED')
      )
    )
),
ranked AS (
  SELECT event_id, created_at,
         ROW_NUMBER() OVER (PARTITION BY tenant_id ORDER BY created_at, event_id) AS tenant_rank
  FROM eligible_heads
),
candidates AS (
  SELECT o.event_id
  FROM outbox AS o
  JOIN ranked AS r ON r.event_id = o.event_id
  WHERE r.tenant_rank <= $6
  ORDER BY r.tenant_rank, r.created_at, o.event_id
  LIMIT $2
  FOR UPDATE OF o SKIP LOCKED
)
UPDATE outbox AS o
SET status = 'IN_FLIGHT',
    claim_id = $3,
    claimed_by = $4,
    lease_until = $5::timestamptz,
    next_attempt_at = NULL
FROM candidates AS c
WHERE o.event_id = c.event_id
RETURNING o.event_json, o.status, o.attempts, o.last_error, o.published_at,
          o.claim_id, o.claimed_by, o.lease_until, o.next_attempt_at, o.created_at,
          o.retired_at, o.retired_by, o.retirement_reason_code, o.retirement_reference, o.replacement_event_id, o.recovery_generation;
`;

interface CaseJsonRow { case_json: RxCase | string; }
interface IdempotencyRow { case_json: RxCase | string; request_fingerprint: string; }
interface OutboxRow {
  event_json: IntegrationEvent | string;
  status: OutboxStatus;
  attempts: number;
  last_error: string | null;
  published_at: string | Date | null;
  claim_id: string | null;
  claimed_by: string | null;
  lease_until: string | Date | null;
  next_attempt_at: string | Date | null;
  created_at: string | Date | null;
  retired_at: string | Date | null;
  retired_by: string | null;
  retirement_reason_code: string | null;
  retirement_reference: string | null;
  replacement_event_id: string | null;
  recovery_generation: number;
}
interface CountRow { count: string | number; }
interface StatusCountRow { status: OutboxStatus; count: string | number; }
interface StatusRow { status: OutboxStatus; }
interface RetirementRequestRow { request_id: string; tenant_id: string; event_id: string; recovery_generation: number; requested_by: string; reason_code: string; reference: string; status: OutboxRetirementApprovalRequest["status"]; requested_at: string | Date; approved_by: string | null; approved_at: string | Date | null; replacement_event_id: string | null; superseded_by: string | null; superseded_at: string | Date | null; }
interface RecoveryAuditRow { audit_id: string; audit_sequence: number; tenant_id: string; event_id: string; recovery_generation: number; action: OutboxRecoveryAuditAction; actor_id: string; created_at: string | Date; request_id: string | null; reason_code: string | null; reference: string | null; replacement_event_id: string | null; }
interface SchemaVerificationRow { version: string | number; has_cases: boolean; has_idempotency: boolean; has_outbox: boolean; has_case_tenant: boolean; has_idempotency_tenant: boolean; has_outbox_tenant: boolean; has_outbox_aggregate_case: boolean; has_outbox_aggregate_sequence: boolean; has_outbox_retired_at: boolean; has_outbox_replacement_event: boolean; has_outbox_recovery_generation: boolean; has_outbox_retirement_requests: boolean; has_outbox_recovery_audit: boolean; has_retirement_request_superseded_at: boolean; has_recovery_audit_sequence: boolean; has_idempotency_composite_pk: boolean; }
export type PostgresSchemaMode = "migrate" | "verify";

function parseJson<T>(value: T | string): T {
  return typeof value === "string" ? JSON.parse(value) as T : value;
}

function iso(value: string | Date | null): string | undefined {
  if (value === null) return undefined;
  return value instanceof Date ? value.toISOString() : value;
}

function cloneCase(rxCase: RxCase): RxCase {
  return JSON.parse(JSON.stringify(rxCase)) as RxCase;
}

function validateCaseVersion(rxCase: RxCase): void {
  if (!Number.isInteger(rxCase.version) || rxCase.version < 1) throw new Error("invalid_case_version");
}

function caseTenantId(rxCase: RxCase): string {
  return rxCase.tenantId ?? "default";
}

function eventTenantId(event: IntegrationEvent): string {
  return event.tenantId ?? "default";
}

/**
 * PostgreSQL implementation of the CaseStore contract.
 *
 * The class accepts a small pool interface so transaction behaviour and SQL
 * contracts can be tested without tying domain code to one driver. A runtime
 * node-postgres adapter is provided separately.
 */
function validateRetirementIdentity(actorId: string, reference: string): void {
  if (actorId.trim() === "") throw new Error("retirement_actor_required");
  if (reference.trim().length < 3 || reference.trim().length > 128) throw new Error("invalid_retirement_reference");
}

function buildGapEvent(record: OutboxRecord, reasonCode: DeliveryGapReasonCode, now: Date): IntegrationEvent {
  if (record.event.type === "DeliveryGapDeclared") throw new Error("gap_event_cannot_be_retired");
  const sequence = record.event.aggregateSequence;
  if (!Number.isInteger(sequence) || (sequence ?? 0) < 1) throw new Error("outbox_event_not_ordered");
  return {
    eventId: randomUUID(),
    type: "DeliveryGapDeclared",
    schemaVersion: 2,
    occurredAt: now.toISOString(),
    caseId: record.event.caseId,
    correlationId: record.event.correlationId,
    ...(record.event.tenantId ? { tenantId: record.event.tenantId } : {}),
    aggregateSequence: sequence,
    payload: { retiredEventId: record.event.eventId, originalType: record.event.type, reasonCode }
  };
}

export class PostgresCaseStore implements CaseStore {
  constructor(private readonly pool: PgPoolLike) {}

  async initialize(mode: PostgresSchemaMode = "migrate"): Promise<void> {
    if (mode === "migrate") {
      await this.migrate();
      return;
    }
    await this.verifySchema();
  }

  async migrate(): Promise<void> {
    await this.pool.query(POSTGRES_SCHEMA_SQL);
    await this.verifySchema();
  }

  async verifySchema(): Promise<void> {
    let result: PgQueryResult<SchemaVerificationRow>;
    try {
      result = await this.pool.query<SchemaVerificationRow>(POSTGRES_VERIFY_SCHEMA_SQL);
    } catch {
      throw new Error("postgres_schema_not_initialized");
    }
    const row = result.rows[0];
    const version = Number(row?.version ?? Number.NaN);
    if (!row || version !== POSTGRES_SCHEMA_VERSION || !row.has_cases || !row.has_idempotency || !row.has_outbox || !row.has_case_tenant || !row.has_idempotency_tenant || !row.has_outbox_tenant || !row.has_outbox_aggregate_case || !row.has_outbox_aggregate_sequence || !row.has_outbox_retired_at || !row.has_outbox_replacement_event || !row.has_outbox_recovery_generation || !row.has_outbox_retirement_requests || !row.has_outbox_recovery_audit || !row.has_retirement_request_superseded_at || !row.has_recovery_audit_sequence || !row.has_idempotency_composite_pk) {
      throw new Error("postgres_schema_version_mismatch");
    }
  }

  async close(): Promise<void> {
    await this.pool.end?.();
  }

  async get(id: string, tenantId?: string): Promise<RxCase | undefined> {
    const result = tenantId === undefined
      ? await this.pool.query<CaseJsonRow>("SELECT case_json FROM cases WHERE id = $1", [id])
      : await this.pool.query<CaseJsonRow>("SELECT case_json FROM cases WHERE id = $1 AND tenant_id = $2", [id, tenantId]);
    return result.rows[0] ? cloneCase(parseJson(result.rows[0].case_json)) : undefined;
  }

  async list(tenantId?: string): Promise<RxCase[]> {
    const result = tenantId === undefined
      ? await this.pool.query<CaseJsonRow>("SELECT case_json FROM cases ORDER BY created_at, id")
      : await this.pool.query<CaseJsonRow>("SELECT case_json FROM cases WHERE tenant_id = $1 ORDER BY created_at, id", [tenantId]);
    return result.rows.map((row) => cloneCase(parseJson(row.case_json)));
  }

  async save(rxCase: RxCase): Promise<void> {
    validateCaseVersion(rxCase);
    await this.pool.query(`
      INSERT INTO cases(id, tenant_id, version, status, case_json)
      VALUES ($1, $2, $3, $4, $5::jsonb)
      ON CONFLICT (id) DO UPDATE
      SET tenant_id = EXCLUDED.tenant_id,
          version = EXCLUDED.version,
          status = EXCLUDED.status,
          case_json = EXCLUDED.case_json,
          updated_at = NOW()
    `, [rxCase.id, caseTenantId(rxCase), rxCase.version, rxCase.status, JSON.stringify(rxCase)]);
  }

  async createCase(rxCase: RxCase, idempotencyKey: string, requestFingerprint: string, events: IntegrationEvent[] = []): Promise<void> {
    validateCaseVersion(rxCase);
    try {
      await this.withTransaction(async (client) => {
        await client.query(
          "INSERT INTO cases(id, tenant_id, version, status, case_json) VALUES ($1, $2, $3, $4, $5::jsonb)",
          [rxCase.id, caseTenantId(rxCase), rxCase.version, rxCase.status, JSON.stringify(rxCase)]
        );
        await client.query(
          "INSERT INTO idempotency(key, tenant_id, case_id, request_fingerprint) VALUES ($1, $2, $3, $4)",
          [idempotencyKey, caseTenantId(rxCase), rxCase.id, requestFingerprint]
        );
        await this.insertEvents(client, events);
      });
    } catch (error) {
      if (isPostgresIdempotencyUniqueViolation(error)) throw new IdempotencyKeyAlreadyBoundError();
      throw error;
    }
  }

  async saveWithOutbox(rxCase: RxCase, events: IntegrationEvent[]): Promise<void> {
    validateCaseVersion(rxCase);
    await this.withTransaction(async (client) => {
      await client.query(`
        INSERT INTO cases(id, tenant_id, version, status, case_json)
        VALUES ($1, $2, $3, $4, $5::jsonb)
        ON CONFLICT (id) DO UPDATE
        SET tenant_id = EXCLUDED.tenant_id,
            version = EXCLUDED.version,
            status = EXCLUDED.status,
            case_json = EXCLUDED.case_json,
            updated_at = NOW()
      `, [rxCase.id, caseTenantId(rxCase), rxCase.version, rxCase.status, JSON.stringify(rxCase)]);
      await this.insertEvents(client, events);
    });
  }

  async saveWithOutboxIfStatus(rxCase: RxCase, expectedStatus: WorkflowStatus, events: IntegrationEvent[]): Promise<boolean> {
    validateCaseVersion(rxCase);
    return await this.withConditionalTransaction(async (client) => {
      const updated = await client.query<{ id: string }>(`
        UPDATE cases
        SET version = $3, status = $4, case_json = $5::jsonb, updated_at = NOW()
        WHERE id = $1 AND tenant_id = $2 AND status = $6
        RETURNING id
      `, [rxCase.id, caseTenantId(rxCase), rxCase.version, rxCase.status, JSON.stringify(rxCase), expectedStatus]);
      if (updated.rows.length !== 1) return false;
      await this.insertEvents(client, events);
      return true;
    });
  }

  async saveWithOutboxIfVersion(rxCase: RxCase, expectedVersion: number, events: IntegrationEvent[]): Promise<boolean> {
    if (rxCase.version !== expectedVersion + 1) throw new Error("invalid_case_version_transition");
    return await this.withConditionalTransaction(async (client) => {
      const updated = await client.query<{ id: string }>(`
        UPDATE cases
        SET version = $4, status = $5, case_json = $6::jsonb, updated_at = NOW()
        WHERE id = $1 AND tenant_id = $2 AND version = $3
        RETURNING id
      `, [rxCase.id, caseTenantId(rxCase), expectedVersion, rxCase.version, rxCase.status, JSON.stringify(rxCase)]);
      if (updated.rows.length !== 1) return false;
      await this.insertEvents(client, events);
      return true;
    });
  }

  async getByIdempotencyKey(key: string, tenantId = "default"): Promise<IdempotencyLookup | undefined> {
    const result = await this.pool.query<IdempotencyRow>(`
      SELECT c.case_json, i.request_fingerprint
      FROM idempotency AS i
      JOIN cases AS c ON c.id = i.case_id AND c.tenant_id = i.tenant_id
      WHERE i.key = $1 AND i.tenant_id = $2
    `, [key, tenantId]);
    const row = result.rows[0];
    return row ? { case: cloneCase(parseJson(row.case_json)), requestFingerprint: row.request_fingerprint } : undefined;
  }

  async bindIdempotencyKey(key: string, caseId: string, requestFingerprint: string, tenantId = "default"): Promise<void> {
    await this.withTransaction(async (client) => {
      await client.query(`
        INSERT INTO idempotency(key, tenant_id, case_id, request_fingerprint)
        VALUES ($1, $2, $3, $4)
        ON CONFLICT (tenant_id, key) DO NOTHING
      `, [key, tenantId, caseId, requestFingerprint]);
      const result = await client.query<{ case_id: string; request_fingerprint: string }>(
        "SELECT case_id, request_fingerprint FROM idempotency WHERE key = $1 AND tenant_id = $2",
        [key, tenantId]
      );
      const existing = result.rows[0];
      if (!existing || existing.case_id !== caseId || existing.request_fingerprint !== requestFingerprint) {
        throw new Error("idempotency_key_already_bound");
      }
    });
  }

  async listOutbox(status?: OutboxStatus, tenantId?: string): Promise<OutboxRecord[]> {
    let result: PgQueryResult<OutboxRow>;
    if (status !== undefined && tenantId !== undefined) {
      result = await this.pool.query<OutboxRow>(`
        SELECT event_json, status, attempts, last_error, published_at, claim_id, claimed_by, lease_until, next_attempt_at, created_at, retired_at, retired_by, retirement_reason_code, retirement_reference, replacement_event_id, recovery_generation
        FROM outbox WHERE status = $1 AND tenant_id = $2 ORDER BY created_at, event_id
      `, [status, tenantId]);
    } else if (status !== undefined) {
      result = await this.pool.query<OutboxRow>(`
        SELECT event_json, status, attempts, last_error, published_at, claim_id, claimed_by, lease_until, next_attempt_at, created_at, retired_at, retired_by, retirement_reason_code, retirement_reference, replacement_event_id, recovery_generation
        FROM outbox WHERE status = $1 ORDER BY created_at, event_id
      `, [status]);
    } else if (tenantId !== undefined) {
      result = await this.pool.query<OutboxRow>(`
        SELECT event_json, status, attempts, last_error, published_at, claim_id, claimed_by, lease_until, next_attempt_at, created_at, retired_at, retired_by, retirement_reason_code, retirement_reference, replacement_event_id, recovery_generation
        FROM outbox WHERE tenant_id = $1 ORDER BY created_at, event_id
      `, [tenantId]);
    } else {
      result = await this.pool.query<OutboxRow>(`
        SELECT event_json, status, attempts, last_error, published_at, claim_id, claimed_by, lease_until, next_attempt_at, created_at, retired_at, retired_by, retirement_reason_code, retirement_reference, replacement_event_id, recovery_generation
        FROM outbox ORDER BY created_at, event_id
      `);
    }
    return result.rows.map((row) => this.mapOutboxRow(row));
  }

  async claimOutbox(workerId: string, limit: number, leaseMs: number, now = new Date(), perTenantLimit = limit): Promise<ClaimedOutboxRecord[]> {
    if (limit < 1) return [];
    if (leaseMs < 1) throw new Error("outbox_lease_must_be_positive");
    if (!Number.isInteger(perTenantLimit) || perTenantLimit < 1) throw new Error("outbox_per_tenant_limit_must_be_positive");
    const claimId = randomUUID();
    const leaseUntil = new Date(now.getTime() + leaseMs);
    const result = await this.pool.query<OutboxRow>(POSTGRES_CLAIM_OUTBOX_SQL, [
      now.toISOString(), limit, claimId, workerId, leaseUntil.toISOString(), perTenantLimit
    ]);
    return result.rows.map((row) => {
      const record = this.mapOutboxRow(row);
      if (record.status !== "IN_FLIGHT" || !record.claimId || !record.claimedBy || !record.leaseUntil) {
        throw new Error("invalid_claimed_outbox_record");
      }
      return record as ClaimedOutboxRecord;
    });
  }

  async renewOutboxLease(eventId: string, claimId: string, leaseMs: number, now = new Date()): Promise<void> {
    if (leaseMs < 1) throw new Error("outbox_lease_must_be_positive");
    const leaseUntil = new Date(now.getTime() + leaseMs).toISOString();
    const result = await this.pool.query<{ event_id: string }>(`
      UPDATE outbox
      SET lease_until = $3::timestamptz
      WHERE event_id = $1 AND status = 'IN_FLIGHT' AND claim_id = $2
      RETURNING event_id
    `, [eventId, claimId, leaseUntil]);
    if (result.rows.length !== 1) throw new Error("stale_outbox_claim");
  }

  async deferOutboxClaim(eventId: string, claimId: string, retryDelayMs = 0, now = new Date()): Promise<void> {
    if (retryDelayMs < 0) throw new Error("invalid_outbox_retry_delay");
    const nextAttemptAt = retryDelayMs > 0 ? new Date(now.getTime() + retryDelayMs).toISOString() : null;
    const result = await this.pool.query<{ event_id: string }>(`
      UPDATE outbox
      SET status = 'PENDING', claim_id = NULL, claimed_by = NULL, lease_until = NULL, next_attempt_at = $3::timestamptz
      WHERE event_id = $1 AND status = 'IN_FLIGHT' AND claim_id = $2
      RETURNING event_id
    `, [eventId, claimId, nextAttemptAt]);
    if (result.rows.length !== 1) throw new Error("stale_outbox_claim");
  }

  async markOutboxPublished(eventId: string, claimId: string): Promise<void> {
    const result = await this.pool.query<{ event_id: string }>(`
      UPDATE outbox
      SET attempts = attempts + 1,
          status = 'PUBLISHED',
          published_at = NOW(),
          last_error = NULL,
          claim_id = NULL,
          claimed_by = NULL,
          lease_until = NULL,
          next_attempt_at = NULL
      WHERE event_id = $1 AND status = 'IN_FLIGHT' AND claim_id = $2
      RETURNING event_id
    `, [eventId, claimId]);
    if (result.rows.length !== 1) throw new Error("stale_outbox_claim");
  }

  async markOutboxFailure(eventId: string, claimId: string, error: string, maxAttempts: number, retryDelayMs = 0, now = new Date()): Promise<OutboxStatus> {
    if (retryDelayMs < 0) throw new Error("invalid_outbox_retry_delay");
    const nextAttemptAt = retryDelayMs > 0 ? new Date(now.getTime() + retryDelayMs).toISOString() : null;
    const result = await this.pool.query<StatusRow>(`
      UPDATE outbox
      SET attempts = attempts + 1,
          status = CASE WHEN attempts + 1 >= $4 THEN 'DEAD_LETTER' ELSE 'PENDING' END,
          last_error = $3,
          claim_id = NULL,
          claimed_by = NULL,
          lease_until = NULL,
          next_attempt_at = CASE
            WHEN attempts + 1 >= $4 OR $5::timestamptz IS NULL THEN NULL
            ELSE $5::timestamptz
          END,
          recovery_generation = CASE WHEN attempts + 1 >= $4 THEN recovery_generation + 1 ELSE recovery_generation END
      WHERE event_id = $1 AND status = 'IN_FLIGHT' AND claim_id = $2
      RETURNING status
    `, [eventId, claimId, error, maxAttempts, nextAttemptAt]);
    const row = result.rows[0];
    if (!row) throw new Error("stale_outbox_claim");
    return row.status;
  }

  async redriveDeadLetter(eventId: string, tenantId?: string, expectedRecoveryGeneration?: number, actorId?: string): Promise<OutboxRecord> {
    return await this.withTransaction(async (client) => {
      const selected = await client.query<OutboxRow>(`
        SELECT event_json, status, attempts, last_error, published_at, claim_id, claimed_by, lease_until, next_attempt_at, created_at,
               retired_at, retired_by, retirement_reason_code, retirement_reference, replacement_event_id, recovery_generation
        FROM outbox WHERE event_id = $1 AND ($2::text IS NULL OR tenant_id = $2) FOR UPDATE
      `, [eventId, tenantId ?? null]);
      const row = selected.rows[0];
      if (!row) throw new Error("outbox_event_not_found");
      const before = this.mapOutboxRow(row);
      if (before.status !== "DEAD_LETTER") throw new Error("outbox_event_not_dead_letter");
      if (expectedRecoveryGeneration !== undefined && (before.recoveryGeneration ?? 0) !== expectedRecoveryGeneration) throw new Error("stale_outbox_recovery");
      const generation = before.recoveryGeneration ?? 0;
      const tenant = before.event.tenantId ?? "default";
      const redriveActor = actorId?.trim() || "system:redrive";
      const now = new Date().toISOString();
      const superseded = await client.query<RetirementRequestRow>(`
        UPDATE outbox_retirement_requests
        SET status='SUPERSEDED', superseded_by=$4, superseded_at=$5::timestamptz
        WHERE tenant_id=$1 AND event_id=$2 AND recovery_generation=$3 AND status='PENDING'
        RETURNING request_id, tenant_id, event_id, recovery_generation, requested_by, reason_code, reference, status, requested_at, approved_by, approved_at, replacement_event_id, superseded_by, superseded_at
      `, [tenant, eventId, generation, redriveActor, now]);
      for (const request of superseded.rows) await this.insertRecoveryAudit(client, {
        auditId: randomUUID(), tenantId: tenant, eventId, recoveryGeneration: generation, action: "RETIREMENT_SUPERSEDED",
        actorId: redriveActor, createdAt: now, requestId: request.request_id, reasonCode: request.reason_code as DeliveryGapReasonCode, reference: request.reference
      });
      const updated = await client.query<OutboxRow>(`
        UPDATE outbox SET status = 'PENDING', attempts = 0, published_at = NULL, claim_id = NULL, claimed_by = NULL, lease_until = NULL, next_attempt_at = NULL
        WHERE event_id = $1 AND status = 'DEAD_LETTER'
        RETURNING event_json, status, attempts, last_error, published_at, claim_id, claimed_by, lease_until, next_attempt_at, created_at,
                  retired_at, retired_by, retirement_reason_code, retirement_reference, replacement_event_id, recovery_generation
      `, [eventId]);
      if (!updated.rows[0]) throw new Error("outbox_event_not_dead_letter");
      if (actorId?.trim()) await this.insertRecoveryAudit(client, { auditId: randomUUID(), tenantId: tenant, eventId, recoveryGeneration: generation, action: "REDRIVEN", actorId: actorId.trim(), createdAt: now });
      return this.mapOutboxRow(updated.rows[0]);
    });
  }

  async retireDeadLetter(request: OutboxRetirementRequest): Promise<OutboxRetirementResult> {
    validateRetirementIdentity(request.actorId, request.reference);
    const now = request.now ?? new Date();
    return await this.withTransaction(async (client) => {
      const selected = await client.query<OutboxRow>(`
        SELECT event_json, status, attempts, last_error, published_at, claim_id, claimed_by, lease_until, next_attempt_at, created_at,
               retired_at, retired_by, retirement_reason_code, retirement_reference, replacement_event_id, recovery_generation
        FROM outbox
        WHERE event_id = $1 AND ($2::text IS NULL OR tenant_id = $2)
        FOR UPDATE
      `, [request.eventId, request.tenantId ?? null]);
      const row = selected.rows[0];
      if (!row) throw new Error("outbox_event_not_found");
      const record = this.mapOutboxRow(row);
      if (record.status !== "DEAD_LETTER") throw new Error("outbox_event_not_dead_letter");
      if ((record.recoveryGeneration ?? 0) !== request.expectedRecoveryGeneration) throw new Error("stale_outbox_recovery");
      const replacementEvent = buildGapEvent(record, request.reasonCode, now);
      const updated = await client.query<OutboxRow>(`
        UPDATE outbox
        SET status = 'RETIRED', claim_id = NULL, claimed_by = NULL, lease_until = NULL, next_attempt_at = NULL,
            retired_at = $3::timestamptz, retired_by = $4, retirement_reason_code = $5, retirement_reference = $6, replacement_event_id = $7
        WHERE event_id = $1 AND status = 'DEAD_LETTER' AND ($2::text IS NULL OR tenant_id = $2)
        RETURNING event_json, status, attempts, last_error, published_at, claim_id, claimed_by, lease_until, next_attempt_at, created_at,
                  retired_at, retired_by, retirement_reason_code, retirement_reference, replacement_event_id, recovery_generation
      `, [request.eventId, request.tenantId ?? null, now.toISOString(), request.actorId.trim(), request.reasonCode, request.reference.trim(), replacementEvent.eventId]);
      const retiredRow = updated.rows[0];
      if (!retiredRow) throw new Error("outbox_event_not_dead_letter");
      await this.insertEvents(client, [replacementEvent]);
      const replacement = await client.query<OutboxRow>(`
        SELECT event_json, status, attempts, last_error, published_at, claim_id, claimed_by, lease_until, next_attempt_at, created_at,
               retired_at, retired_by, retirement_reason_code, retirement_reference, replacement_event_id, recovery_generation
        FROM outbox WHERE event_id = $1
      `, [replacementEvent.eventId]);
      if (!replacement.rows[0]) throw new Error("outbox_retirement_failed");
      return { retired: this.mapOutboxRow(retiredRow), replacement: this.mapOutboxRow(replacement.rows[0]) };
    });
  }

  async createRetirementApprovalRequest(request: Omit<OutboxRetirementApprovalRequest, "requestId" | "status" | "requestedAt"> & { now?: Date }): Promise<OutboxRetirementApprovalRequest> {
    validateRetirementIdentity(request.requestedBy, request.reference);
    const now = request.now ?? new Date();
    return await this.withTransaction(async (client) => {
      const selected = await client.query<OutboxRow>(`
        SELECT event_json, status, attempts, last_error, published_at, claim_id, claimed_by, lease_until, next_attempt_at, created_at,
               retired_at, retired_by, retirement_reason_code, retirement_reference, replacement_event_id, recovery_generation
        FROM outbox WHERE event_id = $1 AND tenant_id = $2 FOR UPDATE
      `, [request.eventId, request.tenantId]);
      const row = selected.rows[0];
      if (!row) throw new Error("outbox_event_not_found");
      const record = this.mapOutboxRow(row);
      if (record.status !== "DEAD_LETTER") throw new Error("outbox_event_not_dead_letter");
      if ((record.recoveryGeneration ?? 0) !== request.recoveryGeneration) throw new Error("stale_outbox_recovery");
      if (record.event.type === "DeliveryGapDeclared") throw new Error("gap_event_cannot_be_retired");
      if (!Number.isInteger(record.event.aggregateSequence) || (record.event.aggregateSequence ?? 0) < 1) throw new Error("outbox_event_not_ordered");
      const requestId = randomUUID();
      try {
        await client.query(`
          INSERT INTO outbox_retirement_requests(
            request_id, tenant_id, event_id, recovery_generation, requested_by, reason_code, reference, status, requested_at
          ) VALUES ($1,$2,$3,$4,$5,$6,$7,'PENDING',$8::timestamptz)
        `, [requestId, request.tenantId, request.eventId, request.recoveryGeneration, request.requestedBy.trim(), request.reasonCode, request.reference.trim(), now.toISOString()]);
      } catch (error) {
        if (typeof error === "object" && error !== null && (error as { code?: unknown }).code === "23505") throw new Error("retirement_request_exists");
        throw error;
      }
      const created: OutboxRetirementApprovalRequest = {
        requestId, tenantId: request.tenantId, eventId: request.eventId, recoveryGeneration: request.recoveryGeneration,
        requestedBy: request.requestedBy.trim(), reasonCode: request.reasonCode, reference: request.reference.trim(),
        status: "PENDING", requestedAt: now.toISOString()
      };
      await this.insertRecoveryAudit(client, {
        auditId: randomUUID(), tenantId: created.tenantId, eventId: created.eventId, recoveryGeneration: created.recoveryGeneration,
        action: "RETIREMENT_REQUESTED", actorId: created.requestedBy, createdAt: created.requestedAt, requestId,
        reasonCode: created.reasonCode, reference: created.reference
      });
      return created;
    });
  }

  async approveRetirementApprovalRequest(requestId: string, approverId: string, tenantId?: string, now = new Date()): Promise<OutboxRetirementApprovalResult> {
    if (!approverId.trim()) throw new Error("retirement_approver_required");
    return await this.withTransaction(async (client) => {
      // Read the request identity without a row lock, then acquire durable locks
      // in the same order used by redrive: outbox row first, request row second.
      // This avoids an approve(request→outbox) / redrive(outbox→request) deadlock.
      const requestIdentity = await client.query<RetirementRequestRow>(`
        SELECT request_id, tenant_id, event_id, recovery_generation, requested_by, reason_code, reference, status, requested_at,
               approved_by, approved_at, replacement_event_id, superseded_by, superseded_at
        FROM outbox_retirement_requests
        WHERE request_id = $1 AND ($2::text IS NULL OR tenant_id = $2)
      `, [requestId, tenantId ?? null]);
      const identityRow = requestIdentity.rows[0];
      if (!identityRow) throw new Error("retirement_request_not_found");
      const identity = this.mapRetirementRequestRow(identityRow);

      const selectedEvent = await client.query<OutboxRow>(`
        SELECT event_json, status, attempts, last_error, published_at, claim_id, claimed_by, lease_until, next_attempt_at, created_at,
               retired_at, retired_by, retirement_reason_code, retirement_reference, replacement_event_id, recovery_generation
        FROM outbox WHERE event_id = $1 AND tenant_id = $2 FOR UPDATE
      `, [identity.eventId, identity.tenantId]);

      const selectedRequest = await client.query<RetirementRequestRow>(`
        SELECT request_id, tenant_id, event_id, recovery_generation, requested_by, reason_code, reference, status, requested_at,
               approved_by, approved_at, replacement_event_id, superseded_by, superseded_at
        FROM outbox_retirement_requests
        WHERE request_id = $1 AND tenant_id = $2 FOR UPDATE
      `, [requestId, identity.tenantId]);
      const requestRow = selectedRequest.rows[0];
      if (!requestRow) throw new Error("retirement_request_not_found");
      const request = this.mapRetirementRequestRow(requestRow);
      if (request.eventId !== identity.eventId || request.recoveryGeneration !== identity.recoveryGeneration) throw new Error("stale_outbox_recovery");
      if (request.status !== "PENDING") throw new Error("retirement_request_not_pending");
      if (request.requestedBy === approverId.trim()) throw new Error("retirement_separation_of_duties");
      const eventRow = selectedEvent.rows[0];
      if (!eventRow) throw new Error("outbox_event_not_found");
      const record = this.mapOutboxRow(eventRow);
      if (record.status !== "DEAD_LETTER") throw new Error("outbox_event_not_dead_letter");
      if ((record.recoveryGeneration ?? 0) !== request.recoveryGeneration) throw new Error("stale_outbox_recovery");
      const replacementEvent = buildGapEvent(record, request.reasonCode, now);
      const updated = await client.query<OutboxRow>(`
        UPDATE outbox
        SET status = 'RETIRED', claim_id = NULL, claimed_by = NULL, lease_until = NULL, next_attempt_at = NULL,
            retired_at = $2::timestamptz, retired_by = $3, retirement_reason_code = $4, retirement_reference = $5, replacement_event_id = $6
        WHERE event_id = $1 AND status = 'DEAD_LETTER' AND recovery_generation = $7
        RETURNING event_json, status, attempts, last_error, published_at, claim_id, claimed_by, lease_until, next_attempt_at, created_at,
                  retired_at, retired_by, retirement_reason_code, retirement_reference, replacement_event_id, recovery_generation
      `, [request.eventId, now.toISOString(), approverId.trim(), request.reasonCode, request.reference, replacementEvent.eventId, request.recoveryGeneration]);
      if (!updated.rows[0]) throw new Error("stale_outbox_recovery");
      await this.insertEvents(client, [replacementEvent]);
      const approved = await client.query<RetirementRequestRow>(`
        UPDATE outbox_retirement_requests
        SET status='APPROVED', approved_by=$2, approved_at=$3::timestamptz, replacement_event_id=$4
        WHERE request_id=$1 AND status='PENDING'
        RETURNING request_id, tenant_id, event_id, recovery_generation, requested_by, reason_code, reference, status, requested_at, approved_by, approved_at, replacement_event_id, superseded_by, superseded_at
      `, [requestId, approverId.trim(), now.toISOString(), replacementEvent.eventId]);
      if (!approved.rows[0]) throw new Error("retirement_request_not_pending");
      await this.insertRecoveryAudit(client, {
        auditId: randomUUID(), tenantId: request.tenantId, eventId: request.eventId, recoveryGeneration: request.recoveryGeneration,
        action: "RETIREMENT_APPROVED", actorId: approverId.trim(), createdAt: now.toISOString(), requestId, reasonCode: request.reasonCode,
        reference: request.reference, replacementEventId: replacementEvent.eventId
      });
      const replacement = await client.query<OutboxRow>(`
        SELECT event_json, status, attempts, last_error, published_at, claim_id, claimed_by, lease_until, next_attempt_at, created_at,
               retired_at, retired_by, retirement_reason_code, retirement_reference, replacement_event_id, recovery_generation
        FROM outbox WHERE event_id = $1
      `, [replacementEvent.eventId]);
      if (!replacement.rows[0]) throw new Error("outbox_retirement_failed");
      return { request: this.mapRetirementRequestRow(approved.rows[0]), retired: this.mapOutboxRow(updated.rows[0]), replacement: this.mapOutboxRow(replacement.rows[0]) };
    });
  }

  async listRetirementApprovalRequests(tenantId?: string, eventId?: string): Promise<OutboxRetirementApprovalRequest[]> {
    const result = await this.pool.query<RetirementRequestRow>(`
      SELECT request_id, tenant_id, event_id, recovery_generation, requested_by, reason_code, reference, status, requested_at, approved_by, approved_at, replacement_event_id, superseded_by, superseded_at
      FROM outbox_retirement_requests
      WHERE ($1::text IS NULL OR tenant_id = $1) AND ($2::text IS NULL OR event_id = $2)
      ORDER BY requested_at, request_id
    `, [tenantId ?? null, eventId ?? null]);
    return result.rows.map((row) => this.mapRetirementRequestRow(row));
  }

  async listOutboxRecoveryAudit(eventId: string, tenantId?: string): Promise<OutboxRecoveryAuditEntry[]> {
    const result = await this.pool.query<RecoveryAuditRow>(`
      SELECT audit_id, audit_sequence, tenant_id, event_id, recovery_generation, action, actor_id, created_at, request_id, reason_code, reference, replacement_event_id
      FROM outbox_recovery_audit WHERE event_id = $1 AND ($2::text IS NULL OR tenant_id = $2) ORDER BY audit_sequence
    `, [eventId, tenantId ?? null]);
    return result.rows.map((row) => this.mapRecoveryAuditRow(row));
  }

  async size(): Promise<number> {
    const result = await this.pool.query<CountRow>("SELECT COUNT(*) AS count FROM cases");
    const count = Number(result.rows[0]?.count ?? Number.NaN);
    if (!Number.isSafeInteger(count) || count < 0) throw new Error("invalid_postgres_count");
    return count;
  }

  async healthCheck(): Promise<void> {
    await this.pool.query("SELECT 1 AS ok");
  }

  async getOutboxCounts(): Promise<OutboxCounts> {
    const counts: OutboxCounts = { pending: 0, inFlight: 0, published: 0, deadLetter: 0, retired: 0 };
    const result = await this.pool.query<StatusCountRow>("SELECT status, COUNT(*) AS count FROM outbox GROUP BY status");
    for (const row of result.rows) {
      const count = Number(row.count);
      if (!Number.isSafeInteger(count) || count < 0) throw new Error("invalid_postgres_count");
      if (row.status === "PENDING") counts.pending = count;
      else if (row.status === "IN_FLIGHT") counts.inFlight = count;
      else if (row.status === "PUBLISHED") counts.published = count;
      else if (row.status === "DEAD_LETTER") counts.deadLetter = count;
      else if (row.status === "RETIRED") counts.retired = count;
    }
    return counts;
  }

  async getOutboxPressure(ageTargetMs?: number, now = new Date()): Promise<OutboxPressure> {
    if (ageTargetMs !== undefined && (!Number.isFinite(ageTargetMs) || ageTargetMs < 0)) throw new Error("invalid_outbox_age_target");
    const result = await this.pool.query<{ pending: number; active_pending_tenants: number; largest_tenant_pending: number; oldest_pending_age_ms: number; overdue_pending: number; overdue_pending_tenants: number; ordered_blocked_pending: number; ordered_blocked_aggregates: number }>(`
      SELECT COALESCE(SUM(tenant_pending), 0)::int AS pending,
             COUNT(*)::int AS active_pending_tenants,
             COALESCE(MAX(tenant_pending), 0)::int AS largest_tenant_pending,
             COALESCE(MAX(oldest_age_ms), 0)::bigint AS oldest_pending_age_ms,
             COALESCE(SUM(overdue_pending), 0)::int AS overdue_pending,
             COALESCE(SUM(CASE WHEN overdue_pending > 0 THEN 1 ELSE 0 END), 0)::int AS overdue_pending_tenants,
             (SELECT COUNT(*)::int FROM outbox AS blocked
              WHERE blocked.status = 'PENDING' AND blocked.aggregate_sequence IS NOT NULL
                AND EXISTS (SELECT 1 FROM outbox AS predecessor
                  WHERE predecessor.tenant_id = blocked.tenant_id
                    AND predecessor.aggregate_case_id = blocked.aggregate_case_id
                    AND predecessor.aggregate_sequence < blocked.aggregate_sequence
                    AND predecessor.status NOT IN ('PUBLISHED','RETIRED'))) AS ordered_blocked_pending,
             (SELECT COUNT(DISTINCT (blocked.tenant_id, blocked.aggregate_case_id))::int FROM outbox AS blocked
              WHERE blocked.status = 'PENDING' AND blocked.aggregate_sequence IS NOT NULL
                AND EXISTS (SELECT 1 FROM outbox AS predecessor
                  WHERE predecessor.tenant_id = blocked.tenant_id
                    AND predecessor.aggregate_case_id = blocked.aggregate_case_id
                    AND predecessor.aggregate_sequence < blocked.aggregate_sequence
                    AND predecessor.status NOT IN ('PUBLISHED','RETIRED'))) AS ordered_blocked_aggregates
      FROM (
        SELECT tenant_id,
               COUNT(*)::int AS tenant_pending,
               GREATEST(0, EXTRACT(EPOCH FROM ($1::timestamptz - MIN(created_at))) * 1000)::bigint AS oldest_age_ms,
               COUNT(*) FILTER (WHERE $2::bigint IS NOT NULL AND created_at < $1::timestamptz - ($2::bigint * INTERVAL '1 millisecond'))::int AS overdue_pending
        FROM outbox
        WHERE status = 'PENDING'
        GROUP BY tenant_id
      ) AS tenant_backlog
    `, [now.toISOString(), ageTargetMs ?? null]);
    const row = result.rows[0] ?? { pending: 0, active_pending_tenants: 0, largest_tenant_pending: 0, oldest_pending_age_ms: 0, overdue_pending: 0, overdue_pending_tenants: 0, ordered_blocked_pending: 0, ordered_blocked_aggregates: 0 };
    return {
      pending: Number(row.pending),
      activePendingTenants: Number(row.active_pending_tenants),
      largestTenantPending: Number(row.largest_tenant_pending),
      oldestPendingAgeMs: Math.max(0, Number(row.oldest_pending_age_ms)),
      overduePending: Number(row.overdue_pending),
      overduePendingTenants: Number(row.overdue_pending_tenants),
      orderedBlockedPending: Number(row.ordered_blocked_pending),
      orderedBlockedAggregates: Number(row.ordered_blocked_aggregates)
    };
  }

  private async insertRecoveryAudit(client: PgClientLike, entry: Omit<OutboxRecoveryAuditEntry, "sequence">): Promise<void> {
    const next = await client.query<{ next_sequence: number | string }>(`
      SELECT COALESCE(MAX(audit_sequence),0)+1 AS next_sequence
      FROM outbox_recovery_audit WHERE tenant_id=$1 AND event_id=$2
    `, [entry.tenantId, entry.eventId]);
    const sequence = Number(next.rows[0]?.next_sequence ?? 1);
    await client.query(`
      INSERT INTO outbox_recovery_audit(
        audit_id, audit_sequence, tenant_id, event_id, recovery_generation, action, actor_id, created_at, request_id, reason_code, reference, replacement_event_id
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8::timestamptz,$9,$10,$11,$12)
    `, [entry.auditId, sequence, entry.tenantId, entry.eventId, entry.recoveryGeneration, entry.action, entry.actorId, entry.createdAt,
      entry.requestId ?? null, entry.reasonCode ?? null, entry.reference ?? null, entry.replacementEventId ?? null]);
  }

  private mapRetirementRequestRow(row: RetirementRequestRow): OutboxRetirementApprovalRequest {
    return {
      requestId: row.request_id, tenantId: row.tenant_id, eventId: row.event_id, recoveryGeneration: Number(row.recovery_generation),
      requestedBy: row.requested_by, reasonCode: row.reason_code as DeliveryGapReasonCode, reference: row.reference, status: row.status,
      requestedAt: iso(row.requested_at)!, ...(row.approved_by ? { approvedBy: row.approved_by } : {}),
      ...(iso(row.approved_at) ? { approvedAt: iso(row.approved_at)! } : {}),
      ...(row.replacement_event_id ? { replacementEventId: row.replacement_event_id } : {}),
      ...(row.superseded_by ? { supersededBy: row.superseded_by } : {}),
      ...(iso(row.superseded_at) ? { supersededAt: iso(row.superseded_at)! } : {})
    };
  }

  private mapRecoveryAuditRow(row: RecoveryAuditRow): OutboxRecoveryAuditEntry {
    return {
      auditId: row.audit_id, sequence: Number(row.audit_sequence), tenantId: row.tenant_id, eventId: row.event_id, recoveryGeneration: Number(row.recovery_generation),
      action: row.action, actorId: row.actor_id, createdAt: iso(row.created_at)!,
      ...(row.request_id ? { requestId: row.request_id } : {}), ...(row.reason_code ? { reasonCode: row.reason_code as DeliveryGapReasonCode } : {}),
      ...(row.reference ? { reference: row.reference } : {}), ...(row.replacement_event_id ? { replacementEventId: row.replacement_event_id } : {})
    };
  }

  private mapOutboxRow(row: OutboxRow): OutboxRecord {
    return {
      event: parseJson(row.event_json),
      status: row.status,
      attempts: row.attempts,
      ...(row.last_error ? { lastError: row.last_error } : {}),
      ...(iso(row.published_at) ? { publishedAt: iso(row.published_at)! } : {}),
      ...(row.claim_id ? { claimId: row.claim_id } : {}),
      ...(row.claimed_by ? { claimedBy: row.claimed_by } : {}),
      ...(iso(row.lease_until) ? { leaseUntil: iso(row.lease_until)! } : {}),
      ...(iso(row.next_attempt_at) ? { nextAttemptAt: iso(row.next_attempt_at)! } : {}),
      ...(iso(row.created_at) ? { enqueuedAt: iso(row.created_at)! } : {}),
      ...(iso(row.retired_at) ? { retiredAt: iso(row.retired_at)! } : {}),
      ...(row.retired_by ? { retiredBy: row.retired_by } : {}),
      ...(row.retirement_reason_code ? { retirementReasonCode: row.retirement_reason_code as DeliveryGapReasonCode } : {}),
      ...(row.retirement_reference ? { retirementReference: row.retirement_reference } : {}),
      ...(row.replacement_event_id ? { replacementEventId: row.replacement_event_id } : {}),
      recoveryGeneration: Number(row.recovery_generation ?? 0)
    };
  }

  private async insertEvents(client: PgClientLike, events: IntegrationEvent[]): Promise<void> {
    for (const event of events) {
      await client.query(
        "INSERT INTO outbox(event_id, tenant_id, aggregate_case_id, aggregate_sequence, event_json, status, attempts, created_at) VALUES ($1, $2, $3, $4, $5::jsonb, 'PENDING', 0, $6::timestamptz)",
        [event.eventId, eventTenantId(event), Number.isInteger(event.aggregateSequence) ? event.caseId : null, Number.isInteger(event.aggregateSequence) ? event.aggregateSequence : null, JSON.stringify(event), event.occurredAt]
      );
    }
  }

  private async withTransaction<T>(operation: (client: PgClientLike) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const value = await operation(client);
      await client.query("COMMIT");
      return value;
    } catch (error) {
      try { await client.query("ROLLBACK"); } catch { /* preserve original error */ }
      throw error;
    } finally {
      client.release();
    }
  }

  private async withConditionalTransaction(operation: (client: PgClientLike) => Promise<boolean>): Promise<boolean> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const saved = await operation(client);
      if (!saved) {
        await client.query("ROLLBACK");
        return false;
      }
      await client.query("COMMIT");
      return true;
    } catch (error) {
      try { await client.query("ROLLBACK"); } catch { /* preserve original error */ }
      throw error;
    } finally {
      client.release();
    }
  }
}

function isPostgresIdempotencyUniqueViolation(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const candidate = error as { code?: unknown; constraint?: unknown };
  return candidate.code === "23505" && candidate.constraint === "idempotency_pkey";
}
