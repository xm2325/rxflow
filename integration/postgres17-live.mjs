import assert from "node:assert/strict";
import { Pool } from "pg";
import { DeterministicPaDraftGenerator } from "../dist/src/ai.js";
import { PostgresCaseStore, POSTGRES_SCHEMA_VERSION } from "../dist/src/postgres-store.js";
import { RxWorkflowService } from "../dist/src/workflow.js";

const connectionString = process.env.RXFLOW_POSTGRES_TEST_URL;
if (!connectionString) throw new Error("RXFLOW_POSTGRES_TEST_URL_required");

const pool = new Pool({ connectionString, max: 6, connectionTimeoutMillis: 5_000 });
const store = new PostgresCaseStore(pool);

function request(id = "pg-rx-1", note = "Prior therapy trial of methotrexate.") {
  return {
    resourceType: "MedicationRequest",
    id,
    subject: { reference: "Patient/synthetic-postgres" },
    medicationCodeableConcept: { coding: [{ code: "12345" }] },
    insurance: [{ display: "SYNTHETIC_PG_PLAN" }],
    note: [{ text: note }]
  };
}

function hasCode(code) {
  return (error) => error?.code === code;
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

  const reviewTenant = "tenant-pg-review";
  const firstReviewer = "pg-reviewer-a";
  const secondReviewer = "pg-reviewer-b";
  const editedAnswer = "Reviewer-edited synthetic answer for the live PostgreSQL governance contract.";
  const reviewCase = await workflow.ingest(
    request("pg-rx-review-governance", "Medication history is incomplete in the synthetic record."),
    "pg-live-review-ingest-0001",
    "pg-live-review-corr-1",
    undefined,
    reviewTenant
  );
  assert.equal(reviewCase.case.priorAuthRequired, true);
  assert.equal(reviewCase.case.status, "HUMAN_REVIEW_REQUIRED");
  assert.ok((reviewCase.case.paDraft?.confidence ?? 1) < 0.8);

  const claimedFirst = await workflow.claimReview(
    reviewCase.case.id,
    firstReviewer,
    reviewCase.case.version,
    reviewTenant,
    60_000
  );
  assert.equal(claimedFirst.reviewClaim?.reviewer, firstReviewer);

  const firstDecision = await workflow.approve(
    reviewCase.case.id,
    firstReviewer,
    claimedFirst.version,
    editedAnswer,
    reviewTenant,
    "pg-review-decision-0001",
    true
  );
  assert.equal(firstDecision.status, "SECOND_APPROVAL_REQUIRED");
  assert.equal(firstDecision.reviewDecision?.reviewer, firstReviewer);
  assert.equal(firstDecision.reviewDecision?.edited, true);
  assert.equal(firstDecision.reviewEscalation?.requestedBy, firstReviewer);

  const firstDecisionReplay = await workflow.approve(
    reviewCase.case.id,
    firstReviewer,
    claimedFirst.version,
    editedAnswer,
    reviewTenant,
    "pg-review-decision-0001",
    true
  );
  assert.equal(firstDecisionReplay.version, firstDecision.version);
  assert.equal(firstDecisionReplay.status, "SECOND_APPROVAL_REQUIRED");

  await assert.rejects(
    () => workflow.approve(
      reviewCase.case.id,
      firstReviewer,
      claimedFirst.version,
      `${editedAnswer} conflict`,
      reviewTenant,
      "pg-review-decision-0001",
      true
    ),
    hasCode("review_idempotency_key_conflict")
  );

  await assert.rejects(
    () => workflow.secondApprove(
      reviewCase.case.id,
      firstReviewer,
      firstDecision.version,
      reviewTenant,
      "pg-second-self-0001"
    ),
    hasCode("second_approver_must_differ")
  );

  const claimedSecond = await workflow.claimReview(
    reviewCase.case.id,
    secondReviewer,
    firstDecision.version,
    reviewTenant,
    60_000
  );
  assert.equal(claimedSecond.reviewClaim?.reviewer, secondReviewer);

  const routed = await workflow.secondApprove(
    reviewCase.case.id,
    secondReviewer,
    claimedSecond.version,
    reviewTenant,
    "pg-second-decision-0001",
    true
  );
  assert.equal(routed.status, "ROUTED");
  assert.equal(routed.reviewDecision?.reviewer, firstReviewer);
  assert.equal(routed.reviewDecision?.secondReviewer, secondReviewer);
  assert.equal(routed.reviewDecision?.finalAnswer, editedAnswer);
  assert.equal(routed.reviewEscalation, undefined);
  assert.equal(routed.reviewClaim, undefined);

  const secondDecisionReplay = await workflow.secondApprove(
    reviewCase.case.id,
    secondReviewer,
    claimedSecond.version,
    reviewTenant,
    "pg-second-decision-0001",
    true
  );
  assert.equal(secondDecisionReplay.version, routed.version);
  assert.equal(secondDecisionReplay.status, "ROUTED");

  await assert.rejects(
    () => workflow.secondApprove(
      reviewCase.case.id,
      "pg-reviewer-c",
      claimedSecond.version,
      reviewTenant,
      "pg-second-decision-0001",
      true
    ),
    hasCode("review_idempotency_key_conflict")
  );

  const persisted = await workflow.get(reviewCase.case.id, reviewTenant);
  assert.equal(persisted?.status, "ROUTED");
  assert.equal(persisted?.reviewDecision?.reviewer, firstReviewer);
  assert.equal(persisted?.reviewDecision?.secondReviewer, secondReviewer);
  assert.equal(persisted?.reviewDecision?.finalAnswer, editedAnswer);
  assert.ok(persisted?.reviewReceipts?.some((receipt) => receipt.outcome === "SECOND_APPROVAL_REQUIRED"));
  assert.ok(persisted?.reviewReceipts?.some((receipt) => receipt.outcome === "ROUTED_AFTER_SECOND_APPROVAL"));
  assert.equal(await workflow.get(reviewCase.case.id, "tenant-pg-other"), undefined);

  console.log(JSON.stringify({
    postgres17Live: "passed",
    schemaVersion: POSTGRES_SCHEMA_VERSION,
    tenantIsolation: true,
    idempotentReplay: true,
    concurrentClaimDeduplication: true,
    claimedEvents: ids.length,
    reviewGovernanceRoute: true,
    reviewDecisionReplay: true,
    reviewDecisionConflict: true,
    separationOfDuties: true,
    secondApprovalReplay: true,
    persistedReviewMetadata: true
  }));
} finally {
  await store.close();
}
