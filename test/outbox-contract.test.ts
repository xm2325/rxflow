import assert from "node:assert/strict";
import test from "node:test";
import { CollectingEventSink, OutboxDispatcher, integrationEvent } from "../src/events.js";
import type { RxCase } from "../src/domain.js";
import { InMemoryCaseStore } from "../src/store.js";

function baseCase(): RxCase {
  return {
    id: "case-outbox-1",
    tenantId: "tenant-a",
    version: 1,
    eventSequence: 0,
    correlationId: "corr-outbox-1",
    sourceResourceId: "rx-outbox-1",
    patientReference: "Patient/synthetic-outbox",
    medicationCode: "med-outbox",
    payerPlan: "PLAN-OUTBOX",
    status: "RECEIVED",
    priorAuthRequired: null,
    audit: []
  };
}

test("dispatcher publishes claimed events exactly once in a clean drain", async () => {
  const store = new InMemoryCaseStore();
  const rxCase = baseCase();
  const first = integrationEvent("PrescriptionReceived", rxCase, { sourceResourceId: rxCase.sourceResourceId });
  await store.createCase(rxCase, "outbox-key-0001", "fingerprint-1", [first]);
  const sink = new CollectingEventSink();
  const report = await new OutboxDispatcher(store, sink).drain();
  assert.equal(report.published, 1);
  assert.equal(report.failed, 0);
  assert.equal(sink.events.length, 1);
  assert.equal((await store.listOutbox("PUBLISHED")).length, 1);
});

test("ordered aggregate claims do not overtake an unresolved predecessor", async () => {
  const store = new InMemoryCaseStore();
  const rxCase = baseCase();
  const first = integrationEvent("PrescriptionReceived", rxCase, { sourceResourceId: rxCase.sourceResourceId });
  const second = integrationEvent("BenefitsVerified", rxCase, { priorAuthRequired: false });
  await store.createCase(rxCase, "outbox-key-0002", "fingerprint-2", [first, second]);
  const claimed = await store.claimOutbox("worker-a", 10, 30_000, new Date(), 10);
  assert.equal(claimed.length, 1);
  assert.equal(claimed[0].event.eventId, first.eventId);
});

test("dead-letter redrive requires the reviewed recovery generation", async () => {
  const store = new InMemoryCaseStore();
  const rxCase = baseCase();
  const event = integrationEvent("PrescriptionReceived", rxCase, { sourceResourceId: rxCase.sourceResourceId });
  await store.createCase(rxCase, "outbox-key-0003", "fingerprint-3", [event]);
  const [claim] = await store.claimOutbox("worker-a", 1, 30_000);
  await store.markOutboxFailure(event.eventId, claim.claimId, "bounded_failure", 1);
  const dead = (await store.listOutbox("DEAD_LETTER"))[0];
  assert.equal(dead.recoveryGeneration, 1);
  assert.throws(() => store.redriveDeadLetter(event.eventId, "tenant-a", 2, "operator-a"), /stale_outbox_recovery/);
  const redriven = await store.redriveDeadLetter(event.eventId, "tenant-a", 1, "operator-a");
  assert.equal(redriven.status, "PENDING");
});
