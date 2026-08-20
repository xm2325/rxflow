import { DatabaseSync } from "node:sqlite";
import { parseIntegrationEvent, type IntegrationEvent } from "./events.js";

export interface ConsumeResult {
  duplicate: boolean;
  sideEffectApplied: boolean;
  stale?: boolean;
}

export interface PharmacyProjection {
  tenantId: string;
  caseId: string;
  route: string;
  lastEventId: string;
  lastSequence?: number;
  updatedAt: string;
}

interface ProcessedRow { event_id: string; }
interface ProjectionRow {
  tenant_id: string;
  case_id: string;
  route: string;
  last_event_id: string;
  last_sequence: number | null;
  updated_at: string;
}
interface CountRow { count: number; }
interface TableInfoRow { name: string; }

export type ConsumerFailureStage = "after_projection_before_dedup_record";
export type ConsumerFailureInjector = (stage: ConsumerFailureStage, event: IntegrationEvent) => void;

/**
 * Small downstream projection used to demonstrate the consumer half of
 * at-least-once delivery. The business side effect and processed-event marker
 * are committed in one SQLite transaction, so a redelivered event does not
 * apply the side effect twice.
 */
export class SqlitePharmacyProjectionStore {
  private readonly db: DatabaseSync;

  constructor(filePath: string, private readonly failureInjector?: ConsumerFailureInjector) {
    this.db = new DatabaseSync(filePath);
    this.db.exec("PRAGMA busy_timeout = 5000");
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS processed_events (
        event_id TEXT PRIMARY KEY,
        event_type TEXT NOT NULL,
        processed_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS pharmacy_projection (
        case_id TEXT PRIMARY KEY,
        route TEXT NOT NULL,
        last_event_id TEXT NOT NULL,
        last_sequence INTEGER,
        updated_at TEXT NOT NULL
      );
    `);
    this.ensureTenantSchema();
  }

  close(): void {
    this.db.close();
  }

  consume(event: IntegrationEvent): ConsumeResult {
    const validated = parseIntegrationEvent(event);
    event = validated;
    const tenantId = event.tenantId ?? "default";
    let result: ConsumeResult = { duplicate: false, sideEffectApplied: false };
    this.transaction(() => {
      const existing = this.db.prepare("SELECT event_id FROM processed_events WHERE tenant_id = ? AND event_id = ?")
        .get(tenantId, event.eventId) as ProcessedRow | undefined;
      if (existing) {
        result = { duplicate: true, sideEffectApplied: false };
        return;
      }

      let sideEffectApplied = false;
      let stale = false;
      if (event.type === "PrescriptionRouted") {
        const route = event.payload.route;
        if (typeof route !== "string" || route.trim() === "") throw new Error("invalid_route_event");
        const current = this.db.prepare("SELECT last_sequence FROM pharmacy_projection WHERE tenant_id = ? AND case_id = ?")
          .get(tenantId, event.caseId) as { last_sequence: number | null } | undefined;
        if (event.aggregateSequence !== undefined && current?.last_sequence !== null && current?.last_sequence !== undefined && event.aggregateSequence <= current.last_sequence) {
          stale = true;
        }
        const now = new Date().toISOString();
        if (!stale) {
          this.db.prepare(`
            INSERT INTO pharmacy_projection(tenant_id, case_id, route, last_event_id, last_sequence, updated_at)
            VALUES (?, ?, ?, ?, ?, ?)
            ON CONFLICT(tenant_id, case_id) DO UPDATE SET
              route = excluded.route,
              last_event_id = excluded.last_event_id,
              last_sequence = excluded.last_sequence,
              updated_at = excluded.updated_at
          `).run(tenantId, event.caseId, route, event.eventId, event.aggregateSequence ?? null, now);
          sideEffectApplied = true;
          this.failureInjector?.("after_projection_before_dedup_record", event);
        }
      }

      this.db.prepare("INSERT INTO processed_events(tenant_id, event_id, event_type, processed_at) VALUES (?, ?, ?, ?)")
        .run(tenantId, event.eventId, event.type, new Date().toISOString());
      result = { duplicate: false, sideEffectApplied, ...(stale ? { stale: true } : {}) };
    });
    return result;
  }

  getProjection(caseId: string, tenantId = "default"): PharmacyProjection | undefined {
    const row = this.db.prepare(`
      SELECT tenant_id, case_id, route, last_event_id, last_sequence, updated_at
      FROM pharmacy_projection
      WHERE tenant_id = ? AND case_id = ?
    `).get(tenantId, caseId) as ProjectionRow | undefined;
    return row ? {
      tenantId: row.tenant_id,
      caseId: row.case_id,
      route: row.route,
      lastEventId: row.last_event_id,
      ...(row.last_sequence !== null ? { lastSequence: row.last_sequence } : {}),
      updatedAt: row.updated_at
    } : undefined;
  }

  processedCount(tenantId?: string): number {
    if (tenantId === undefined) return (this.db.prepare("SELECT COUNT(*) AS count FROM processed_events").get() as CountRow).count;
    return (this.db.prepare("SELECT COUNT(*) AS count FROM processed_events WHERE tenant_id = ?").get(tenantId) as CountRow).count;
  }

  private ensureTenantSchema(): void {
    const processed = this.db.prepare("PRAGMA table_info(processed_events)").all() as Array<TableInfoRow & { pk?: number }>;
    const processedHasTenant = processed.some((column) => column.name === "tenant_id");
    const processedCompositeKey = processed.some((column) => column.name === "tenant_id" && Number(column.pk) === 1)
      && processed.some((column) => column.name === "event_id" && Number(column.pk) === 2);
    if (!processedHasTenant || !processedCompositeKey) {
      this.transaction(() => {
        this.db.exec("ALTER TABLE processed_events RENAME TO processed_events_legacy");
        this.db.exec(`
          CREATE TABLE processed_events (
            tenant_id TEXT NOT NULL,
            event_id TEXT NOT NULL,
            event_type TEXT NOT NULL,
            processed_at TEXT NOT NULL,
            PRIMARY KEY(tenant_id, event_id)
          )
        `);
        const legacyColumns = this.db.prepare("PRAGMA table_info(processed_events_legacy)").all() as TableInfoRow[];
        const legacyHasTenant = legacyColumns.some((column) => column.name === "tenant_id");
        const tenantExpr = legacyHasTenant ? "tenant_id" : "'default'";
        this.db.exec(`
          INSERT INTO processed_events(tenant_id, event_id, event_type, processed_at)
          SELECT ${tenantExpr}, event_id, event_type, processed_at FROM processed_events_legacy
        `);
        this.db.exec("DROP TABLE processed_events_legacy");
      });
    }
    this.db.exec("CREATE INDEX IF NOT EXISTS idx_processed_events_tenant ON processed_events(tenant_id, event_id)");

    const projection = this.db.prepare("PRAGMA table_info(pharmacy_projection)").all() as Array<TableInfoRow & { pk?: number }>;
    const hasTenant = projection.some((column) => column.name === "tenant_id");
    const hasSequence = projection.some((column) => column.name === "last_sequence");
    const tenantCompositeKey = projection.some((column) => column.name === "tenant_id" && Number(column.pk) === 1)
      && projection.some((column) => column.name === "case_id" && Number(column.pk) === 2);
    if (hasTenant && hasSequence && tenantCompositeKey) return;

    this.transaction(() => {
      this.db.exec("ALTER TABLE pharmacy_projection RENAME TO pharmacy_projection_legacy");
      this.db.exec(`
        CREATE TABLE pharmacy_projection (
          tenant_id TEXT NOT NULL,
          case_id TEXT NOT NULL,
          route TEXT NOT NULL,
          last_event_id TEXT NOT NULL,
          last_sequence INTEGER,
          updated_at TEXT NOT NULL,
          PRIMARY KEY(tenant_id, case_id)
        )
      `);
      const legacyColumns = this.db.prepare("PRAGMA table_info(pharmacy_projection_legacy)").all() as TableInfoRow[];
      const legacyHasTenant = legacyColumns.some((column) => column.name === "tenant_id");
      const legacyHasSequence = legacyColumns.some((column) => column.name === "last_sequence");
      const tenantExpr = legacyHasTenant ? "tenant_id" : "'default'";
      const sequenceExpr = legacyHasSequence ? "last_sequence" : "NULL";
      this.db.exec(`
        INSERT INTO pharmacy_projection(tenant_id, case_id, route, last_event_id, last_sequence, updated_at)
        SELECT ${tenantExpr}, case_id, route, last_event_id, ${sequenceExpr}, updated_at
        FROM pharmacy_projection_legacy
      `);
      this.db.exec("DROP TABLE pharmacy_projection_legacy");
    });
  }

  private transaction(operation: () => void): void {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      operation();
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
}
