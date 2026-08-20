import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { DeterministicPaDraftGenerator } from "../src/ai.js";
import { AppError } from "../src/errors.js";
import { InMemoryCaseStore } from "../src/store.js";
import { RxWorkflowService } from "../src/workflow.js";

function paRequiredCode(plan: string): string {
  for (let i = 0; i < 10_000; i += 1) {
    const code = `review-idem-med-${i}`;
    if (createHash("sha256").update(`${plan}|${code}`).digest()[0] % 2 === 0) return code;
  }
  throw new Error("unable_to_find_pa_code");
}

function request(id: string) {
  const plan = "REVIEW_IDEMPOTENCY_PLAN";
  return {
    resourceType: "MedicationRequest",
    id,
    subject: { reference: "Patient/synthetic-review-idempotency" },
    medicationCodeableConcept: { coding: [{ code: paRequiredCode(plan) }] },
    insurance: [{ display: plan }],
    note: [{ text: "Prior therapy trial of methotrexate." }]
  };
}

test("same review decision key replays the committed winner without new outbox events", async () => {
  const store = new InMemoryCaseStore();
  const service = new RxWorkflowService(store, new DeterministicPaDraftGenerator());
  const ingested = await service.ingest(request("review-idem-1"), "ingest-review-idem-1", "corr-review-idem-1");
  assert.equal(ingested.case.status, "HUMAN_REVIEW_REQUIRED");
  const before = (await store.listOutbox()).length;
  const answer = `${ingested.case.paDraft?.answer ?? "Synthetic answer"} Reviewed.`;
  const first = await service.approve(ingested.case.id, "synthetic-reviewer", ingested.case.version, answer, "default", "review-decision-0001");
  const afterFirst = (await store.listOutbox()).length;
  const replay = await service.approve(ingested.case.id, "synthetic-reviewer", ingested.case.version, answer, "default", "review-decision-0001");
  const afterReplay = (await store.listOutbox()).length;
  assert.equal(replay.id, first.id);
  assert.equal(replay.version, first.version);
  assert.equal(afterFirst, before + 2);
  assert.equal(afterReplay, afterFirst);
});

test("same review decision key with a different payload conflicts", async () => {
  const store = new InMemoryCaseStore();
  const service = new RxWorkflowService(store, new DeterministicPaDraftGenerator());
  const ingested = await service.ingest(request("review-idem-2"), "ingest-review-idem-2", "corr-review-idem-2");
  const answer = `${ingested.case.paDraft?.answer ?? "Synthetic answer"} Reviewed.`;
  await service.approve(ingested.case.id, "synthetic-reviewer", ingested.case.version, answer, "default", "review-decision-0002");
  await assert.rejects(
    () => service.approve(ingested.case.id, "synthetic-reviewer", ingested.case.version, `${answer} changed`, "default", "review-decision-0002"),
    (error: unknown) => error instanceof AppError && error.code === "review_idempotency_key_conflict"
  );
});
