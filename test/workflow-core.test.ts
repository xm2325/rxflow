import assert from "node:assert/strict";
import test from "node:test";
import { DeterministicPaDraftGenerator } from "../src/ai.js";
import { AppError } from "../src/errors.js";
import { InMemoryCaseStore } from "../src/store.js";
import { RxWorkflowService } from "../src/workflow.js";

function medicationRequest(id = "rx-core-1", code = "12345", note = "Prior therapy trial of methotrexate.") {
  return {
    resourceType: "MedicationRequest",
    id,
    subject: { reference: "Patient/synthetic-1" },
    medicationCodeableConcept: { coding: [{ code }] },
    insurance: [{ display: "SYNTHETIC_PLAN" }],
    note: [{ text: note }]
  };
}

test("ingest creates a durable synthetic case", async () => {
  const store = new InMemoryCaseStore();
  const service = new RxWorkflowService(store, new DeterministicPaDraftGenerator());
  const result = await service.ingest(medicationRequest(), "core-key-0001", "corr-core-1");
  assert.equal(result.duplicate, false);
  assert.equal(result.case.sourceResourceId, "rx-core-1");
  assert.equal(result.case.patientReference, "Patient/synthetic-1");
  assert.ok(result.case.version >= 1);
  assert.ok((await store.listOutbox()).length > 0);
});

test("same idempotency key and same request replays the winning case", async () => {
  const store = new InMemoryCaseStore();
  const service = new RxWorkflowService(store, new DeterministicPaDraftGenerator());
  const first = await service.ingest(medicationRequest(), "core-key-0002", "corr-core-2");
  const replay = await service.ingest(medicationRequest(), "core-key-0002", "corr-core-3");
  assert.equal(replay.duplicate, true);
  assert.equal(replay.case.id, first.case.id);
});

test("idempotency key reuse with a different payload fails closed", async () => {
  const store = new InMemoryCaseStore();
  const service = new RxWorkflowService(store, new DeterministicPaDraftGenerator());
  await service.ingest(medicationRequest(), "core-key-0003", "corr-core-4");
  let code = "";
  try {
    await service.ingest(medicationRequest("rx-core-1", "different-code"), "core-key-0003", "corr-core-5");
  } catch (error) {
    code = error instanceof AppError ? error.code : "unexpected";
  }
  assert.equal(code, "idempotency_key_conflict");
});

test("case lookup is tenant scoped", async () => {
  const store = new InMemoryCaseStore();
  const service = new RxWorkflowService(store, new DeterministicPaDraftGenerator());
  const created = await service.ingest(medicationRequest("rx-tenant"), "tenant-key-0001", "corr-tenant", undefined, "tenant-a");
  assert.ok(await service.get(created.case.id, "tenant-a"));
  assert.equal(await service.get(created.case.id, "tenant-b"), undefined);
});
