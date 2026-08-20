import assert from "node:assert/strict";
import test from "node:test";
import { DeterministicPaDraftGenerator, StructuredJsonPaDraftGenerator } from "../src/ai.js";
import { IdempotencyKeyAlreadyBoundError, InMemoryCaseStore, type CaseStore } from "../src/store.js";
import { RxWorkflowService } from "../src/workflow.js";
import { toOperationsCaseDetail } from "../src/case-view.js";

const paRequest = {
  resourceType: "MedicationRequest",
  id: "rx-risk-pa",
  subject: { reference: "Patient/synthetic-risk" },
  medicationCodeableConcept: { coding: [{ code: "12345" }] },
  insurance: [{ display: "SYNTHETIC_PLAN" }],
  note: [{ text: "Prior therapy trial of methotrexate with inadequate response." }]
};

const noPaRequest = {
  ...paRequest,
  id: "rx-risk-no-pa",
  medicationCodeableConcept: { coding: [{ code: "54321" }] }
};

test("PA-required path produces an evidence-bound human-review case", async () => {
  const store = new InMemoryCaseStore();
  const service = new RxWorkflowService(store, new DeterministicPaDraftGenerator());
  const result = await service.ingest(paRequest, "risk-pa-key");
  assert.equal(result.case.priorAuthRequired, true);
  assert.equal(result.case.status, "HUMAN_REVIEW_REQUIRED");
  assert.equal(result.case.paDraft?.requiresHumanReview, true);
  assert.ok((result.case.paDraft?.evidence.length ?? 0) > 0);
});

test("no-PA path routes directly without a PA draft", async () => {
  const store = new InMemoryCaseStore();
  const service = new RxWorkflowService(store, new DeterministicPaDraftGenerator());
  const result = await service.ingest(noPaRequest, "risk-no-pa-key");
  assert.equal(result.case.priorAuthRequired, false);
  assert.equal(result.case.status, "ROUTED");
  assert.equal(result.case.paDraft, undefined);
});

test("retryable PA dependency failure recovers on same-key replay without duplicating ingress events", async () => {
  const store = new InMemoryCaseStore();
  let attempts = 0;
  const generator = {
    async generate(input: Parameters<DeterministicPaDraftGenerator["generate"]>[0]) {
      attempts += 1;
      if (attempts === 1) throw new Error("synthetic_dependency_outage");
      return new DeterministicPaDraftGenerator().generate(input);
    }
  };
  const service = new RxWorkflowService(store, generator, 3);
  await assert.rejects(() => service.ingest(paRequest, "risk-recovery-key"), /pa_draft_dependency_unavailable/);
  assert.equal(store.getByIdempotencyKey("risk-recovery-key")?.case.status, "FAILED_RETRYABLE");
  const replay = await service.ingest(paRequest, "risk-recovery-key");
  assert.equal(replay.duplicate, true);
  assert.equal(replay.recovered, true);
  assert.equal(replay.case.status, "HUMAN_REVIEW_REQUIRED");
  assert.equal(store.listOutbox().filter((r) => r.event.type === "PrescriptionReceived").length, 1);
});

test("PA dependency failure becomes terminal after the configured retry budget", async () => {
  const store = new InMemoryCaseStore();
  const service = new RxWorkflowService(store, { async generate() { throw new Error("synthetic_outage"); } }, 3);
  await assert.rejects(() => service.ingest(paRequest, "risk-terminal-key"), /pa_draft_dependency_unavailable/);
  await assert.rejects(() => service.ingest(paRequest, "risk-terminal-key"), /pa_draft_dependency_unavailable/);
  await assert.rejects(() => service.ingest(paRequest, "risk-terminal-key"), /pa_draft_dependency_unavailable/);
  const terminal = store.getByIdempotencyKey("risk-terminal-key")?.case;
  assert.equal(terminal?.status, "FAILED");
  assert.equal(terminal?.failure?.retryable, false);
  assert.equal(terminal?.failure?.attempts, 3);
});

test("unsafe model request to skip review is contained by the workflow gate", async () => {
  const generator = new StructuredJsonPaDraftGenerator({
    async complete(input) {
      return JSON.stringify({
        answer: "Synthetic answer grounded in supplied evidence.",
        evidence: [{ source: "fhir", field: "MedicationRequest.note", value: input.clinicalNote }],
        confidence: 0.99,
        requiresHumanReview: false,
        reason: "Unsafe synthetic output."
      });
    }
  });
  const store = new InMemoryCaseStore();
  const result = await new RxWorkflowService(store, generator).ingest(paRequest, "risk-unsafe-model");
  assert.equal(result.case.status, "HUMAN_REVIEW_REQUIRED");
  assert.equal(store.listOutbox().find((r) => r.event.type === "HumanReviewRequired")?.event.payload.reason, "human_review_gate_missing");
});

test("stale human-review decision is rejected using the version the reviewer saw", async () => {
  const store = new InMemoryCaseStore();
  const service = new RxWorkflowService(store, new DeterministicPaDraftGenerator());
  const created = await service.ingest(paRequest, "risk-stale-review");
  const reviewedVersion = created.case.version;
  const concurrent = store.get(created.case.id);
  if (!concurrent) throw new Error("missing_case");
  concurrent.version += 1;
  concurrent.audit.push({ at: new Date().toISOString(), type: "synthetic_concurrent_update", details: {} });
  store.save(concurrent);
  await assert.rejects(() => service.approve(created.case.id, "reviewer-stale", reviewedVersion), /stale_review/);
  assert.equal(store.get(created.case.id)?.status, "HUMAN_REVIEW_REQUIRED");
});

test("a second human approval cannot emit duplicate approval or routing events", async () => {
  const store = new InMemoryCaseStore();
  const service = new RxWorkflowService(store, new DeterministicPaDraftGenerator());
  const created = await service.ingest(paRequest, "risk-double-review");
  await service.approve(created.case.id, "reviewer-a", created.case.version);
  const count = store.listOutbox().length;
  await assert.rejects(() => service.approve(created.case.id, "reviewer-b", created.case.version), /case_not_reviewable/);
  assert.equal(store.listOutbox().length, count);
});

test("review corrections are bounded and do not leak into operations views", async () => {
  const store = new InMemoryCaseStore();
  const service = new RxWorkflowService(store, new DeterministicPaDraftGenerator());
  const created = await service.ingest(paRequest, "risk-review-edit");
  await assert.rejects(() => service.approve(created.case.id, "reviewer", created.case.version, "   "), /invalid_review_answer/);
  await assert.rejects(() => service.approve(created.case.id, "reviewer", created.case.version, "x".repeat(4001)), /review_answer_too_large/);
  const finalAnswer = "Reviewer-confirmed synthetic answer.";
  const approved = await service.approve(created.case.id, "reviewer", created.case.version, finalAnswer);
  assert.equal(approved.reviewDecision?.edited, true);
  assert.equal(approved.reviewDecision?.finalAnswer, finalAnswer);
  assert.equal(JSON.stringify(toOperationsCaseDetail(approved)).includes(finalAnswer), false);
});

test("cross-instance create race resolves to the durable idempotency winner", async () => {
  const winnerStore = new InMemoryCaseStore();
  const winner = await new RxWorkflowService(winnerStore, new DeterministicPaDraftGenerator()).ingest(paRequest, "risk-race-key");
  const lookup = winnerStore.getByIdempotencyKey("risk-race-key");
  if (!lookup) throw new Error("missing_winner");
  let lookups = 0;
  const racingStore = {
    async getByIdempotencyKey() { lookups += 1; return lookups === 1 ? undefined : lookup; },
    async createCase() { throw new IdempotencyKeyAlreadyBoundError(); }
  } as unknown as CaseStore;
  const resolved = await new RxWorkflowService(racingStore, new DeterministicPaDraftGenerator()).ingest(paRequest, "risk-race-key");
  assert.equal(resolved.duplicate, true);
  assert.equal(resolved.case.id, winner.case.id);
});

test("cross-instance create race still rejects a changed payload fingerprint", async () => {
  const winnerStore = new InMemoryCaseStore();
  await new RxWorkflowService(winnerStore, new DeterministicPaDraftGenerator()).ingest(noPaRequest, "risk-race-conflict");
  const lookup = winnerStore.getByIdempotencyKey("risk-race-conflict");
  if (!lookup) throw new Error("missing_winner");
  let lookups = 0;
  const racingStore = {
    async getByIdempotencyKey() { lookups += 1; return lookups === 1 ? undefined : lookup; },
    async createCase() { throw new IdempotencyKeyAlreadyBoundError(); }
  } as unknown as CaseStore;
  await assert.rejects(
    () => new RxWorkflowService(racingStore, new DeterministicPaDraftGenerator()).ingest(paRequest, "risk-race-conflict"),
    /idempotency_key_conflict/
  );
});
