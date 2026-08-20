import assert from "node:assert/strict";
import test from "node:test";
import { DeterministicPaDraftGenerator } from "../src/ai.js";
import {
  CollectingEventSink,
  DeliveryError,
  OutboxDispatcher,
  externalizeIntegrationEvent,
  parseIntegrationEvent,
  type EventSink,
  type IntegrationEvent
} from "../src/events.js";
import { InMemoryCaseStore } from "../src/store.js";
import { RxWorkflowService } from "../src/workflow.js";

const noPaRequest = {
  resourceType: "MedicationRequest",
  id: "rx-outbox-contract",
  subject: { reference: "Patient/synthetic-outbox-contract" },
  medicationCodeableConcept: { coding: [{ code: "54321" }] },
  insurance: [{ display: "SYNTHETIC_PLAN" }],
  note: [{ text: "Synthetic no-PA fixture." }]
};

test("outbox dispatcher rejects invalid backoff, tenant claim, and tenant concurrency bounds", () => {
  const store = new InMemoryCaseStore();
  const sink = new CollectingEventSink();
  assert.throws(() => new OutboxDispatcher(store, sink, 3, "bad-backoff", 30_000, 10, -1, 10), /invalid_outbox_retry_backoff/);
  assert.throws(() => new OutboxDispatcher(store, sink, 3, "bad-tenant-limit", 30_000, 10, 0, 10, Math.random, () => new Date(), 0, 1), /invalid_outbox_per_tenant_claim_limit/);
  assert.throws(() => new OutboxDispatcher(store, sink, 3, "bad-concurrency", 30_000, 10, 0, 10, Math.random, () => new Date(), 1, 0), /invalid_outbox_tenant_delivery_concurrency/);
});

test("integration-event parsing and canonical egress enforce the public payload contract", () => {
  const parsed = parseIntegrationEvent({
    eventId: "evt-pa-draft",
    type: "PaDraftGenerated",
    schemaVersion: 2,
    occurredAt: "2026-08-20T10:00:00.000Z",
    caseId: "case-pa-draft",
    correlationId: "corr-pa-draft",
    tenantId: "health-a",
    aggregateSequence: 3,
    payload: { confidence: 0.82, evidenceCount: 2, validationErrors: 0 }
  });
  assert.equal(parsed.type, "PaDraftGenerated");
  assert.equal(parsed.payload.confidence, 0.82);

  const external = externalizeIntegrationEvent({
    eventId: "evt-ingress",
    type: "PrescriptionReceived",
    schemaVersion: 2,
    occurredAt: "2026-08-20T10:00:00.000Z",
    caseId: "case-ingress",
    correlationId: "corr-ingress",
    tenantId: "health-a",
    aggregateSequence: 1,
    payload: {
      sourceResourceId: "rx-safe",
      sourceWorkflow: "DIRECT_MEDICATION_REQUEST",
      sourceTaskId: "task-safe",
      clinicalNote: "must-not-cross-egress"
    }
  });
  assert.equal(external.payload.sourceResourceId, "rx-safe");
  assert.equal(external.payload.sourceWorkflow, "DIRECT_MEDICATION_REQUEST");
  assert.equal(external.payload.sourceTaskId, "task-safe");
  assert.equal("clinicalNote" in external.payload, false);

  assert.throws(() => parseIntegrationEvent({
    eventId: "evt-bad-approved",
    type: "PaApproved",
    schemaVersion: 2,
    occurredAt: "2026-08-20T10:00:00.000Z",
    caseId: "case-bad-approved",
    correlationId: "corr-bad-approved",
    payload: { reviewer: "legacy-reviewer" }
  }), /invalid_edited/);
});

test("non-retryable delivery failure dead-letters the aggregate head on its first durable attempt", async () => {
  const store = new InMemoryCaseStore();
  await new RxWorkflowService(store, new DeterministicPaDraftGenerator()).ingest(noPaRequest, "terminal-delivery-key");
  const sink: EventSink = { async deliver() { throw new DeliveryError("synthetic_http_400", { retryable: false }); } };
  const report = await new OutboxDispatcher(store, sink, 5, "terminal-delivery-worker", 30_000, 100, 1_000, 60_000).drain();
  assert.equal(report.attempted, 1);
  assert.equal(report.failed, 1);
  assert.equal(report.terminalFailures, 1);
  assert.equal(report.deadLettered, 1);
  const dead = store.listOutbox("DEAD_LETTER")[0];
  assert.equal(dead?.attempts, 1);
  assert.equal(dead?.lastError, "synthetic_http_400");
  assert.ok(store.getOutboxPressure().orderedBlockedPending >= 1);
});

test("retry-after is a durable floor measured from failure completion", async () => {
  const store = new InMemoryCaseStore();
  await new RxWorkflowService(store, new DeterministicPaDraftGenerator()).ingest(noPaRequest, "retry-after-contract-key");
  const sink: EventSink = {
    async deliver() {
      throw new DeliveryError("synthetic_http_429", { retryable: true, retryAfterMs: 7_000, failureScope: "tenant" });
    }
  };
  const times = [
    new Date("2026-08-20T10:00:00.000Z"),
    new Date("2026-08-20T10:00:02.000Z")
  ];
  let index = 0;
  const report = await new OutboxDispatcher(
    store, sink, 5, "retry-after-contract-worker", 30_000, 1, 1_000, 60_000,
    () => 1, () => times[Math.min(index++, times.length - 1)]!
  ).drain();
  assert.equal(report.failed, 1);
  assert.equal(report.terminalFailures, 0);
  const pending = store.listOutbox("PENDING").find((record) => record.lastError === "synthetic_http_429");
  assert.equal(pending?.nextAttemptAt, "2026-08-20T10:00:09.000Z");
});

test("unsafe durable event contract is treated as poison and never reaches the sink", async () => {
  const store = new InMemoryCaseStore();
  const created = await new RxWorkflowService(store, new DeterministicPaDraftGenerator()).ingest(noPaRequest, "poison-contract-key");
  await new OutboxDispatcher(store, new CollectingEventSink()).drain();
  const poison: IntegrationEvent = {
    eventId: "poison-pa-approved",
    type: "PaApproved",
    schemaVersion: 1,
    occurredAt: "2026-08-20T10:00:00.000Z",
    caseId: created.case.id,
    correlationId: created.case.correlationId,
    tenantId: created.case.tenantId,
    aggregateSequence: 99,
    payload: { reviewer: "legacy-reviewer-without-edited" }
  };
  store.saveWithOutbox(created.case, [poison]);
  const sink = new CollectingEventSink();
  const report = await new OutboxDispatcher(store, sink, 5, "poison-contract-worker").drain();
  assert.equal(report.attempted, 1);
  assert.equal(report.terminalFailures, 1);
  assert.equal(report.deadLettered, 1);
  assert.equal(sink.events.length, 0);
  const dead = store.listOutbox("DEAD_LETTER").find((record) => record.event.eventId === poison.eventId);
  assert.equal(dead?.attempts, 1);
  assert.equal(dead?.lastError, "invalid_integration_event:legacy_pa_approved_missing_edited");
});

test("cross-tenant concurrency remains sequential inside a single tenant lane", async () => {
  const store = new InMemoryCaseStore();
  const makeCase = (id: string) => ({
    id, tenantId: "health-a", version: 1, eventSequence: 1, correlationId: `corr-${id}`,
    sourceResourceId: `rx-${id}`, patientReference: `Patient/${id}`, medicationCode: "12345",
    payerPlan: "SYNTHETIC_PLAN", status: "RECEIVED" as const,
    priorAuthRequired: null, audit: []
  });
  const makeEvent = (id: string): IntegrationEvent => ({
    eventId: `event-${id}`, type: "PrescriptionReceived", schemaVersion: 2,
    occurredAt: new Date().toISOString(), caseId: id, correlationId: `corr-${id}`,
    tenantId: "health-a", aggregateSequence: 1, payload: { sourceResourceId: `rx-${id}` }
  });
  for (const id of ["same-a-1", "same-a-2"]) store.createCase(makeCase(id), `key-${id}`, `fp-${id}`, [makeEvent(id)]);

  let active = 0;
  let peak = 0;
  const sink: EventSink = {
    async deliver() {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 10));
      active -= 1;
    }
  };
  const report = await new OutboxDispatcher(
    store, sink, 3, "same-tenant-worker", 30_000, 2, 0, 0,
    Math.random, () => new Date(), 2, 4
  ).drain();
  assert.equal(report.published, 2);
  assert.equal(report.peakConcurrentDeliveries, 1);
  assert.equal(peak, 1);
});
