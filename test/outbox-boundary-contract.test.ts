import assert from "node:assert/strict";
import test from "node:test";
import { DeterministicPaDraftGenerator } from "../src/ai.js";
import {
  BackgroundOutboxPublisher,
  DeliveryError,
  MetadataLogEventSink,
  OutboxDispatcher,
  computeRetryDelayMs,
  externalizeIntegrationEvent,
  parseIntegrationEvent,
  type EventSink,
  type IntegrationEvent
} from "../src/events.js";
import { InMemoryCaseStore } from "../src/store.js";
import { RxWorkflowService } from "../src/workflow.js";

const noPaRequest = {
  resourceType: "MedicationRequest",
  id: "rx-outbox-boundary",
  subject: { reference: "Patient/synthetic-outbox-boundary" },
  medicationCodeableConcept: { coding: [{ code: "54321" }] },
  insurance: [{ display: "SYNTHETIC_PLAN" }],
  note: [{ text: "Synthetic no-PA boundary fixture." }]
};

function eventBase(type: IntegrationEvent["type"], payload: IntegrationEvent["payload"], schemaVersion: 1 | 2 = 2): IntegrationEvent {
  return {
    eventId: `evt-${type}`,
    type,
    schemaVersion,
    occurredAt: "2026-08-20T10:00:00.000Z",
    caseId: "case-boundary",
    correlationId: "corr-boundary",
    tenantId: "health-a",
    aggregateSequence: 1,
    payload
  };
}

test("integration-event parser rejects malformed boundary inputs with stable codes", () => {
  const base = eventBase("PrescriptionReceived", { sourceResourceId: "rx-safe" });
  const malformed: Array<[unknown, RegExp]> = [
    [null, /invalid_integration_event:body_not_object/],
    [{ ...base, eventId: "" }, /invalid_integration_event:missing_eventId/],
    [{ ...base, type: "UnknownEvent" }, /invalid_integration_event:unsupported_type/],
    [{ ...base, schemaVersion: 3 }, /invalid_integration_event:unsupported_schema_version/],
    [{ ...base, occurredAt: "not-a-date" }, /invalid_integration_event:invalid_occurredAt/],
    [{ ...base, tenantId: 7 }, /invalid_integration_event:missing_tenantId/],
    [{ ...base, aggregateSequence: 0 }, /invalid_integration_event:invalid_aggregate_sequence/],
    [{ ...base, payload: [] }, /invalid_integration_event:payload_not_object/],
    [{ ...base, payload: { sourceResourceId: "rx-safe", nested: { unsafe: true } } }, /invalid_integration_event:payload_value_not_scalar/],
    [eventBase("DeliveryGapDeclared", {
      retiredEventId: "evt-retired",
      originalType: "PrescriptionReceived",
      reasonCode: "downstream_reconciled"
    }, 1), /invalid_integration_event:gap_requires_schema_v2/]
  ];
  for (const [value, expected] of malformed) assert.throws(() => parseIntegrationEvent(value), expected);
});

test("canonical egress reconstructs every integration-event payload from an allow-list", () => {
  const cases: IntegrationEvent[] = [
    eventBase("PrescriptionReceived", { sourceResourceId: "rx-safe", extra: "drop-me" }),
    eventBase("BenefitsVerified", { priorAuthRequired: true, extra: "drop-me" }),
    eventBase("PaDraftGenerated", { confidence: 0.8, evidenceCount: 2, validationErrors: 0, recoveredAfterFailures: 1, extra: "drop-me" }),
    eventBase("HumanReviewRequired", { reason: "policy_gate", extra: "drop-me" }),
    eventBase("PaApproved", { edited: true, extra: "drop-me" }),
    eventBase("PrescriptionRouted", { route: "synthetic-route", extra: "drop-me" }),
    eventBase("WorkflowFailed", { stage: "PA_DRAFT", code: "dependency_unavailable", retryable: true, attempts: 2, extra: "drop-me" }),
    eventBase("DeliveryGapDeclared", { retiredEventId: "evt-retired", originalType: "PrescriptionReceived", reasonCode: "downstream_reconciled", extra: "drop-me" })
  ];

  const external = cases.map((event) => externalizeIntegrationEvent(event));
  assert.deepEqual(external.map((event) => event.type), cases.map((event) => event.type));
  for (const event of external) {
    assert.equal(event.schemaVersion, 2);
    assert.equal("extra" in event.payload, false);
  }
  assert.equal(external[2]?.payload.recoveredAfterFailures, 1);
  assert.deepEqual(external[7]?.payload, {
    retiredEventId: "evt-retired",
    originalType: "PrescriptionReceived",
    reasonCode: "downstream_reconciled"
  });
});

test("delivery retry parameters fail closed and equal-jitter backoff stays bounded", () => {
  assert.throws(() => new DeliveryError("bad", { retryAfterMs: -1 }), /invalid_delivery_retry_after/);
  assert.throws(() => new DeliveryError("bad", { retryAfterMs: Number.POSITIVE_INFINITY }), /invalid_delivery_retry_after/);
  assert.equal(computeRetryDelayMs(999, 0, 1_000), 0);
  assert.throws(() => computeRetryDelayMs(-1, 100, 1_000), /invalid_outbox_attempt_count/);
  assert.throws(() => computeRetryDelayMs(0, 100, 1_000, () => 1.1), /invalid_retry_random_sample/);
  assert.equal(computeRetryDelayMs(4, 100, 500, () => 1), 500);
  assert.equal(computeRetryDelayMs(0, 100, 500, () => 0), 50);
});

test("metadata log sink emits bounded delivery metadata without the event payload", async () => {
  const lines: string[] = [];
  const sink = new MetadataLogEventSink((line) => lines.push(line));
  await sink.deliver(eventBase("PrescriptionReceived", { sourceResourceId: "rx-safe", clinicalNote: "must-not-be-logged" }));
  assert.equal(lines.length, 1);
  const logged = JSON.parse(lines[0]!) as Record<string, unknown>;
  assert.deepEqual(logged, {
    event: "integration_event_published",
    eventId: "evt-PrescriptionReceived",
    type: "PrescriptionReceived",
    schemaVersion: 2,
    correlationId: "corr-boundary"
  });
  assert.equal(lines[0]!.includes("clinicalNote"), false);
});

test("background publisher is single-flight and exposes bounded graceful-idle semantics", async () => {
  const store = new InMemoryCaseStore();
  await new RxWorkflowService(store, new DeterministicPaDraftGenerator()).ingest(noPaRequest, "publisher-boundary-key");

  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const sink: EventSink = { async deliver() { await gate; } };
  const dispatcher = new OutboxDispatcher(store, sink, 3, "publisher-boundary-worker", 30_000, 1);
  const publisher = new BackgroundOutboxPublisher(dispatcher);

  const first = publisher.tick();
  assert.equal(publisher.isActive(), true);
  assert.equal(await publisher.tick(), undefined);
  assert.equal(await publisher.waitForIdle(5), false);

  release();
  const report = await first;
  assert.equal(report?.published, 1);
  assert.equal(publisher.isActive(), false);
  assert.equal(await publisher.waitForIdle(), true);
  await assert.rejects(() => publisher.waitForIdle(0), /invalid_publisher_idle_timeout/);
});
