import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { Pool } from "pg";
import { DeterministicPaDraftGenerator } from "../dist/src/ai.js";
import { AppError } from "../dist/src/errors.js";
import { PostgresCaseStore } from "../dist/src/postgres-store.js";
import { RxWorkflowService } from "../dist/src/workflow.js";

const connectionString = process.env.RXFLOW_POSTGRES_TEST_URL;
if (!connectionString) throw new Error("RXFLOW_POSTGRES_TEST_URL_required");

function paRequiredCode(plan) {
  for (let i = 0; i < 10_000; i += 1) {
    const code = `pg-review-med-${i}`;
    if (createHash("sha256").update(`${plan}|${code}`).digest()[0] % 2 === 0) return code;
  }
  throw new Error("unable_to_find_pa_code");
}

const pool = new Pool({ connectionString, max: 8, connectionTimeoutMillis: 5_000 });
const store = new PostgresCaseStore(pool);

try {
  await store.migrate();
  const serviceA = new RxWorkflowService(store, new DeterministicPaDraftGenerator());
  const serviceB = new RxWorkflowService(store, new DeterministicPaDraftGenerator());
  const plan = "PG_REVIEW_IDEMPOTENCY_PLAN";
  const id = `pg-review-${randomUUID()}`;
  const ingested = await serviceA.ingest({
    resourceType: "MedicationRequest",
    id,
    subject: { reference: "Patient/synthetic-pg-review" },
    medicationCodeableConcept: { coding: [{ code: paRequiredCode(plan) }] },
    insurance: [{ display: plan }],
    note: [{ text: "Prior therapy trial of methotrexate." }]
  }, `pg-review-ingest-${id}`, `corr-${id}`, undefined, "tenant-review-pg");
  assert.equal(ingested.case.status, "HUMAN_REVIEW_REQUIRED");

  const before = (await store.listOutbox(undefined, "tenant-review-pg")).length;
  const answer = `${ingested.case.paDraft?.answer ?? "Synthetic answer"} Reviewed.`;
  const key = `pg-review-decision-${randomUUID()}`;

  const [a, b] = await Promise.all([
    serviceA.approve(ingested.case.id, "reviewer-a", ingested.case.version, answer, "tenant-review-pg", key),
    serviceB.approve(ingested.case.id, "reviewer-a", ingested.case.version, answer, "tenant-review-pg", key)
  ]);
  assert.equal(a.id, b.id);
  assert.equal(a.version, b.version);

  const after = (await store.listOutbox(undefined, "tenant-review-pg")).length;
  assert.equal(after, before + 2);

  const binding = await pool.query(
    "SELECT case_id, request_fingerprint FROM idempotency WHERE tenant_id=$1 AND key=$2",
    ["tenant-review-pg", `review:${key}`]
  );
  assert.equal(binding.rows.length, 1);
  assert.equal(binding.rows[0].case_id, ingested.case.id);

  let conflictCode = "";
  try {
    await serviceA.approve(ingested.case.id, "reviewer-a", ingested.case.version, `${answer} changed`, "tenant-review-pg", key);
  } catch (error) {
    conflictCode = error instanceof AppError ? error.code : "unexpected";
  }
  assert.equal(conflictCode, "review_idempotency_key_conflict");

  console.log(JSON.stringify({
    postgres17ReviewIdempotency: "passed",
    concurrentSameKeyConverged: true,
    outboxTransitionsAdded: after - before,
    durableDecisionBinding: true,
    conflictingPayloadRejected: true
  }));
} finally {
  await store.close();
}
