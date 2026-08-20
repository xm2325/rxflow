import assert from "node:assert/strict";
import { Pool } from "pg";
import { DeterministicPaDraftGenerator } from "../dist/src/ai.js";
import { PostgresCaseStore, POSTGRES_SCHEMA_VERSION } from "../dist/src/postgres-store.js";
import { RxWorkflowService } from "../dist/src/workflow.js";

const connectionString = process.env.RXFLOW_POSTGRES_TEST_URL;
if (!connectionString) throw new Error("RXFLOW_POSTGRES_TEST_URL_required");

const pool = new Pool({ connectionString, max: 6, connectionTimeoutMillis: 5_000 });
const store = new PostgresCaseStore(pool);

function request(id = "pg-rx-1") {
  return {
    resourceType: "MedicationRequest",
    id,
    subject: { reference: "Patient/synthetic-postgres" },
    medicationCodeableConcept: { coding: [{ code: "12345" }] },
    insurance: [{ display: "SYNTHETIC_PG_PLAN" }],
    note: [{ text: "Prior therapy trial of methotrexate." }]
  };
}

try {
  await store.migrate();
  await store.verifySchema();

  const versionResult = await pool.query("SELECT MAX(version)::int AS version FROM rxflow_schema_migrations");
  assert.equal(versionResult.rows[0].version, POSTGRES_SCHEMA_VERSION);

  const workflow = new RxWorkflowService(store, new DeterministicPaDraftGenerator());
  const first = await workflow.ingest(request(), "pg-live-key-0001", "pg-live-corr-1", undefined, "tenant-pg-a");
  assert.equal(first.duplicate, false);

  const replay = await workflow.ingest(request(), "pg-live-key-0001", "pg-live-corr-2", undefined, "tenant-pg-a");
  assert.equal(replay.duplicate, true);
  assert.equal(replay.case.id, first.case.id);

  assert.ok(await workflow.get(first.case.id, "tenant-pg-a"));
  assert.equal(await workflow.get(first.case.id, "tenant-pg-b"), undefined);

  const queued = await store.listOutbox(undefined, "tenant-pg-a");
  assert.ok(queued.length > 0);

  const [a, b] = await Promise.all([
    store.claimOutbox("pg-worker-a", 20, 30_000, new Date(), 20),
    store.claimOutbox("pg-worker-b", 20, 30_000, new Date(), 20)
  ]);
  const ids = [...a, ...b].map((record) => record.event.eventId);
  assert.equal(new Set(ids).size, ids.length);

  console.log(JSON.stringify({
    postgres17Live: "passed",
    schemaVersion: POSTGRES_SCHEMA_VERSION,
    tenantIsolation: true,
    idempotentReplay: true,
    concurrentClaimDeduplication: true,
    claimedEvents: ids.length
  }));
} finally {
  await store.close();
}
