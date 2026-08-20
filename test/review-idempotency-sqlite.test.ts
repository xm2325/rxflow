import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { DeterministicPaDraftGenerator } from "../src/ai.js";
import { AppError } from "../src/errors.js";
import { SqliteCaseStore } from "../src/store.js";
import { RxWorkflowService } from "../src/workflow.js";

function paRequiredCode(plan: string): string {
  for (let i = 0; i < 10_000; i += 1) {
    const code = `sqlite-review-med-${i}`;
    if (createHash("sha256").update(`${plan}|${code}`).digest()[0] % 2 === 0) return code;
  }
  throw new Error("unable_to_find_pa_code");
}

test("SQLite commits the review transition, outbox, and decision binding together", async () => {
  const store = new SqliteCaseStore(":memory:");
  try {
    const service = new RxWorkflowService(store, new DeterministicPaDraftGenerator());
    const plan = "SQLITE_REVIEW_PLAN";
    const ingested = await service.ingest({
      resourceType: "MedicationRequest",
      id: "sqlite-review-1",
      subject: { reference: "Patient/synthetic-sqlite-review" },
      medicationCodeableConcept: { coding: [{ code: paRequiredCode(plan) }] },
      insurance: [{ display: plan }],
      note: [{ text: "Prior therapy trial of methotrexate." }]
    }, "sqlite-ingest-key", "sqlite-corr");
    assert.equal(ingested.case.status, "HUMAN_REVIEW_REQUIRED");

    const before = (await store.listOutbox()).length;
    const answer = `${ingested.case.paDraft?.answer ?? "Synthetic answer"} Reviewed.`;
    const first = await service.approve(ingested.case.id, "synthetic-reviewer", ingested.case.version, answer, "default", "sqlite-review-decision-1");
    const afterFirst = (await store.listOutbox()).length;
    const replay = await service.approve(ingested.case.id, "synthetic-reviewer", ingested.case.version, answer, "default", "sqlite-review-decision-1");
    assert.equal(replay.version, first.version);
    assert.equal((await store.listOutbox()).length, afterFirst);
    assert.equal(afterFirst, before + 2);

    await assert.rejects(
      () => service.approve(ingested.case.id, "synthetic-reviewer", ingested.case.version, `${answer} changed`, "default", "sqlite-review-decision-1"),
      (error: unknown) => error instanceof AppError && error.code === "review_idempotency_key_conflict"
    );
  } finally {
    store.close();
  }
});
