import assert from "node:assert/strict";
import { Pool } from "pg";
import { DeterministicPaDraftGenerator } from "../dist/src/ai.js";
import { PostgresCaseStore, POSTGRES_SCHEMA_VERSION } from "../dist/src/postgres-store.js";
import { RxWorkflowService } from "../dist/src/workflow.js";

const connectionString = process.env.RXFLOW_POSTGRES_TEST_URL;
if (!connectionString) throw new Error("RXFLOW_POSTGRES_TEST_URL_required");

const pool = new Pool({ connectionString, max: 6, connectionTimeoutMillis: 5_000 });
const store = new PostgresCaseStore(pool);

function request(
  id = "pg-rx-1",
  note = "Prior therapy trial of methotrexate.",
  medicationCode = "12345",
  payerPlan = "SYNTHETIC_PG_PLAN"
) {
  return {
    resourceType: "MedicationRequest",
    id,
    subject: { reference: "Patient/synthetic-postgres" },
    medicationCodeableConcept: { coding: [{ code: medicationCode }] },
    insurance: [{ display: payerPlan }],
    note: [{ text: note }]
  };
}

function hasCode(code) {
  return (error) => error?.code === code;
}

function addMs(date, ms) {
  return new Date(date.getTime() + ms);
}

async function publishAllClaimable(workerId, now = new Date()) {
  for (;;) {
    const claimed = await store.claimOutbox(workerId, 20, 30_000, now, 20);
    if (claimed.length === 0) return;
    for (const record of claimed) {
      await store.markOutboxPublished(record.event.eventId, record.claimId);
    }
  }
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
  const concurrentlyClaimed = [...a, ...b];
  const ids = concurrentlyClaimed.map((record) => record.event.eventId);
  assert.equal(new Set(ids).size, ids.length);
  for (const record of concurrentlyClaimed) {
    await store.markOutboxPublished(record.event.eventId, record.claimId);
  }
  await publishAllClaimable("pg-cleanup-worker");
  assert.equal((await store.listOutbox("PENDING")).length, 0);

  const outboxTenant = "tenant-pg-outbox";
  const outboxCase = await workflow.ingest(
    request(
      "pg-rx-outbox-order",
      "Synthetic no-PA path for PostgreSQL outbox ordering.",
      "54321",
      "SYNTHETIC_PLAN"
    ),
    "pg-outbox-order-0001",
    "pg-outbox-corr-1",
    undefined,
    outboxTenant
  );
  assert.equal(outboxCase.case.status, "ROUTED");
  const initialOutbox = await store.listOutbox(undefined, outboxTenant);
  const expectedSequences = initialOutbox
    .map((record) => record.event.aggregateSequence)
    .filter((value) => Number.isInteger(value))
    .sort((left, right) => left - right);
  assert.ok(expectedSequences.length >= 3);
  assert.equal(new Set(expectedSequences).size, expectedSequences.length);

  const outboxStart = new Date();
  const firstHead = await store.claimOutbox("pg-order-worker-1", 20, 30_000, outboxStart, 20);
  assert.equal(firstHead.length, 1);
  assert.equal(firstHead[0].event.tenantId, outboxTenant);
  assert.equal(firstHead[0].event.aggregateSequence, expectedSequences[0]);
  assert.equal(
    await store.markOutboxFailure(
      firstHead[0].event.eventId,
      firstHead[0].claimId,
      "synthetic_terminal_head",
      1,
      0,
      outboxStart
    ),
    "DEAD_LETTER"
  );

  const firstDead = (await store.listOutbox("DEAD_LETTER", outboxTenant))[0];
  if (!firstDead) throw new Error("missing_pg_dead_letter_generation_1");
  assert.equal(firstDead.recoveryGeneration, 1);
  assert.equal(
    (await store.claimOutbox("pg-order-blocked", 20, 30_000, addMs(outboxStart, 1), 20)).length,
    0
  );

  const firstRedrive = await store.redriveDeadLetter(
    firstDead.event.eventId,
    outboxTenant,
    1,
    "pg-operator-redrive-1"
  );
  assert.equal(firstRedrive.status, "PENDING");
  const firstAudit = await store.listOutboxRecoveryAudit(firstDead.event.eventId, outboxTenant);
  assert.equal(firstAudit.at(-1)?.action, "REDRIVEN");
  assert.equal(firstAudit.at(-1)?.recoveryGeneration, 1);

  const secondHead = await store.claimOutbox("pg-order-worker-2", 20, 30_000, addMs(outboxStart, 2), 20);
  assert.equal(secondHead.length, 1);
  assert.equal(secondHead[0].event.eventId, firstDead.event.eventId);
  assert.equal(
    await store.markOutboxFailure(
      secondHead[0].event.eventId,
      secondHead[0].claimId,
      "synthetic_terminal_head_again",
      1,
      0,
      addMs(outboxStart, 2)
    ),
    "DEAD_LETTER"
  );
  const secondDead = (await store.listOutbox("DEAD_LETTER", outboxTenant))[0];
  if (!secondDead) throw new Error("missing_pg_dead_letter_generation_2");
  assert.equal(secondDead.recoveryGeneration, 2);
  await assert.rejects(
    () => store.redriveDeadLetter(secondDead.event.eventId, outboxTenant, 1, "pg-stale-operator"),
    /stale_outbox_recovery/
  );
  await store.redriveDeadLetter(secondDead.event.eventId, outboxTenant, 2, "pg-operator-redrive-2");

  const publishedSequences = [];
  for (let index = 0; index < expectedSequences.length; index += 1) {
    const claimed = await store.claimOutbox(
      `pg-order-publish-${index}`,
      20,
      30_000,
      addMs(outboxStart, 10 + index),
      20
    );
    assert.equal(claimed.length, 1);
    publishedSequences.push(claimed[0].event.aggregateSequence);
    await store.markOutboxPublished(claimed[0].event.eventId, claimed[0].claimId);
  }
  assert.deepEqual(publishedSequences, expectedSequences);
  assert.equal((await store.listOutbox("PENDING", outboxTenant)).length, 0);
  assert.equal((await store.listOutbox("DEAD_LETTER", outboxTenant)).length, 0);

  const retryTenant = "tenant-pg-retry";
  const retryCase = await workflow.ingest(
    request(
      "pg-rx-outbox-retry",
      "Synthetic no-PA path for PostgreSQL retry scheduling.",
      "54321",
      "SYNTHETIC_PLAN"
    ),
    "pg-outbox-retry-0001",
    "pg-outbox-retry-corr-1",
    undefined,
    retryTenant
  );
  assert.equal(retryCase.case.status, "ROUTED");
  const retryBase = new Date();
  const retryHead = await store.claimOutbox("pg-retry-worker-1", 20, 30_000, retryBase, 20);
  assert.equal(retryHead.length, 1);
  assert.equal(retryHead[0].event.tenantId, retryTenant);
  assert.equal(
    await store.markOutboxFailure(
      retryHead[0].event.eventId,
      retryHead[0].claimId,
      "synthetic_retryable_failure",
      3,
      5_000,
      retryBase
    ),
    "PENDING"
  );
  assert.equal(
    (await store.claimOutbox("pg-retry-too-early", 20, 30_000, addMs(retryBase, 4_999), 20)).length,
    0
  );
  const dueRetry = await store.claimOutbox("pg-retry-due", 20, 30_000, addMs(retryBase, 5_000), 20);
  assert.equal(dueRetry.length, 1);
  assert.equal(dueRetry[0].event.eventId, retryHead[0].event.eventId);
  await store.markOutboxPublished(dueRetry[0].event.eventId, dueRetry[0].claimId);
  await publishAllClaimable("pg-retry-cleanup", addMs(retryBase, 5_001));
  assert.equal((await store.listOutbox("PENDING", retryTenant)).length, 0);

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
    outboxAggregateOrdering: true,
    outboxRecoveryGeneration: true,
    staleOutboxRecoveryRejected: true,
    outboxRetryFloor: true,
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
