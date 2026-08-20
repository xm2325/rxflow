import test from "node:test";
import assert from "node:assert/strict";
import { DeterministicPaDraftGenerator } from "../src/ai.js";
import { AppError } from "../src/errors.js";
import { InMemoryCaseStore, SqliteCaseStore } from "../src/store.js";
import { RxWorkflowService } from "../src/workflow.js";
import { buildWorkQueue } from "../src/work-queue.js";
import { toOperationsCaseDetail, toReviewerContextView } from "../src/case-view.js";

function request(id: string, note: string) {
  return {
    resourceType: "MedicationRequest",
    id,
    subject: { reference: "Patient/synthetic-governance" },
    medicationCodeableConcept: { coding: [{ code: "12345" }] },
    insurance: [{ display: "SYNTHETIC_COMMERCIAL_PLAN" }],
    note: [{ text: note }]
  };
}

async function expectCode(action: () => Promise<unknown>, code: string): Promise<void> {
  try {
    await action();
  } catch (error) {
    assert.equal(error instanceof AppError ? error.code : "unexpected", code);
    return;
  }
  throw new Error(`expected_${code}`);
}

test("review claim is lease-bound, owner-scoped, and visible only as operational metadata", async () => {
  const store = new InMemoryCaseStore();
  const service = new RxWorkflowService(store, new DeterministicPaDraftGenerator());
  const created = await service.ingest(
    request("gov-claim", "Prior therapy trial of methotrexate with inadequate response."),
    "gov-claim-ingest"
  );
  assert.equal(created.case.status, "HUMAN_REVIEW_REQUIRED");

  const t0 = new Date("2026-08-20T09:00:00.000Z");
  const claimed = await service.claimReview(created.case.id, "reviewer-a", created.case.version, undefined, 60_000, t0);
  assert.equal(claimed.reviewClaim?.reviewer, "reviewer-a");
  assert.equal(claimed.reviewClaim?.leaseUntil, "2026-08-20T09:01:00.000Z");

  const replay = await service.claimReview(claimed.id, "reviewer-a", claimed.version, undefined, 60_000, new Date("2026-08-20T09:00:30.000Z"));
  assert.equal(replay.version, claimed.version);
  assert.equal(replay.reviewClaim?.claimId, claimed.reviewClaim?.claimId);

  await expectCode(
    () => service.claimReview(claimed.id, "reviewer-b", claimed.version, undefined, 60_000, new Date("2026-08-20T09:00:30.000Z")),
    "review_already_claimed"
  );

  const reclaimed = await service.claimReview(claimed.id, "reviewer-b", claimed.version, undefined, 60_000, new Date("2026-08-20T09:01:01.000Z"));
  assert.equal(reclaimed.reviewClaim?.reviewer, "reviewer-b");
  assert.ok(reclaimed.reviewClaim?.claimId !== claimed.reviewClaim?.claimId);

  const operations = toOperationsCaseDetail(reclaimed);
  assert.equal(operations.reviewOwner, "reviewer-b");
  assert.equal(JSON.stringify(operations).includes("Patient/synthetic-governance"), false);
  const reviewer = toReviewerContextView(reclaimed);
  assert.equal(reviewer.patientReference, "Patient/synthetic-governance");
  assert.equal(reviewer.reviewOwner, "reviewer-b");
});

test("review decision retry is durable and same-key different-payload reuse fails closed", async () => {
  const store = new InMemoryCaseStore();
  const service = new RxWorkflowService(store, new DeterministicPaDraftGenerator());
  const created = await service.ingest(
    request("gov-idem", "Prior therapy trial of methotrexate with inadequate response."),
    "gov-idem-ingest"
  );
  const claimed = await service.claimReview(created.case.id, "reviewer-a", created.case.version);
  const approved = await service.approve(
    claimed.id, "reviewer-a", claimed.version, undefined, undefined, "decision-key-0001", true
  );
  assert.equal(approved.status, "ROUTED");
  assert.equal(approved.reviewReceipts?.length, 1);
  assert.equal(approved.reviewReceipts?.[0]?.outcome, "ROUTED");
  const outboxCount = (await store.listOutbox()).length;

  const replay = await service.approve(
    claimed.id, "reviewer-a", claimed.version, undefined, undefined, "decision-key-0001", true
  );
  assert.equal(replay.id, approved.id);
  assert.equal(replay.version, approved.version);
  assert.equal((await store.listOutbox()).length, outboxCount);

  await expectCode(
    () => service.approve(
      claimed.id, "reviewer-a", claimed.version, "A conflicting retry payload.", undefined, "decision-key-0001", true
    ),
    "review_idempotency_key_conflict"
  );
});

test("low-confidence edited review requires a distinct second approver before routing", async () => {
  const store = new InMemoryCaseStore();
  const service = new RxWorkflowService(store, new DeterministicPaDraftGenerator());
  const created = await service.ingest(request("gov-two-person", "Initial treatment request."), "gov-two-person-ingest");
  assert.equal(created.case.paDraft?.confidence, 0.55);

  const firstClaim = await service.claimReview(created.case.id, "reviewer-a", created.case.version);
  const firstDecision = await service.approve(
    firstClaim.id,
    "reviewer-a",
    firstClaim.version,
    "Reviewer-proposed answer from the synthetic chart.",
    undefined,
    "decision-key-0002",
    true
  );
  assert.equal(firstDecision.status, "SECOND_APPROVAL_REQUIRED");
  assert.equal(firstDecision.reviewEscalation?.reasonCode, "LOW_CONFIDENCE_EDIT");
  assert.equal(firstDecision.reviewReceipts?.[0]?.outcome, "SECOND_APPROVAL_REQUIRED");
  assert.equal((await store.listOutbox()).some((row) => row.event.type === "PaApproved"), false);

  const queue = buildWorkQueue([firstDecision]);
  assert.equal(queue[0]?.action, "SECOND_PHARMACIST_APPROVAL");
  assert.equal(queue[0]?.priority, 110);

  const secondClaim = await service.claimReview(firstDecision.id, "reviewer-b", firstDecision.version);
  await expectCode(
    () => service.secondApprove(secondClaim.id, "reviewer-a", secondClaim.version, undefined, "decision-key-0003", true),
    "second_approver_must_differ"
  );

  const routed = await service.secondApprove(
    secondClaim.id, "reviewer-b", secondClaim.version, undefined, "decision-key-0003", true
  );
  assert.equal(routed.status, "ROUTED");
  assert.equal(routed.reviewDecision?.reviewer, "reviewer-a");
  assert.equal(routed.reviewDecision?.secondReviewer, "reviewer-b");
  assert.equal(routed.reviewEscalation, undefined);
  assert.equal(routed.reviewReceipts?.length, 2);
  assert.equal(routed.reviewReceipts?.[1]?.outcome, "ROUTED_AFTER_SECOND_APPROVAL");

  const events = await store.listOutbox();
  assert.equal(events.filter((row) => row.event.type === "PaApproved").length, 1);
  assert.equal(events.filter((row) => row.event.type === "PrescriptionRouted").length, 1);

  const replay = await service.secondApprove(
    secondClaim.id, "reviewer-b", secondClaim.version, undefined, "decision-key-0003", true
  );
  assert.equal(replay.version, routed.version);
  assert.equal((await store.listOutbox()).filter((row) => row.event.type === "PaApproved").length, 1);
});

test("SQLite persists review decision binding in the same durable transaction as the routed case", async () => {
  const store = new SqliteCaseStore(":memory:");
  try {
    const service = new RxWorkflowService(store, new DeterministicPaDraftGenerator());
    const created = await service.ingest(
      request("gov-sqlite", "Prior therapy trial of methotrexate with inadequate response."),
      "gov-sqlite-ingest"
    );
    const claimed = await service.claimReview(created.case.id, "sqlite-reviewer", created.case.version);
    const approved = await service.approve(
      claimed.id, "sqlite-reviewer", claimed.version, undefined, undefined, "decision-key-sqlite", true
    );
    assert.equal(approved.status, "ROUTED");
    const binding = await store.getByIdempotencyKey("review:decision-key-sqlite", "default");
    assert.equal(binding?.case.id, approved.id);
    assert.equal(binding?.case.status, "ROUTED");
    assert.equal(binding?.case.reviewReceipts?.length, 1);
  } finally {
    store.close();
  }
});
