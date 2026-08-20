import assert from "node:assert/strict";
import { unlinkSync } from "node:fs";
import test from "node:test";
import { DeterministicPaDraftGenerator } from "../src/ai.js";
import {
  CollectingEventSink,
  DeliveryError,
  OutboxDispatcher,
  type EventSink,
  type IntegrationEvent
} from "../src/events.js";
import { outboxRecoveryEtag, parseOutboxRecoveryIfMatch } from "../src/http-preconditions.js";
import { toOutboxOperationsView } from "../src/outbox-ops.js";
import { InMemoryCaseStore, SqliteCaseStore } from "../src/store.js";
import { RxWorkflowService } from "../src/workflow.js";

const paRequest = {
  resourceType: "MedicationRequest",
  id: "rx-outbox-pa",
  subject: { reference: "Patient/synthetic-outbox" },
  medicationCodeableConcept: { coding: [{ code: "12345" }] },
  insurance: [{ display: "SYNTHETIC_PLAN" }],
  note: [{ text: "Prior therapy trial of methotrexate with inadequate response." }]
};

const noPaRequest = {
  ...paRequest,
  id: "rx-outbox-no-pa",
  medicationCodeableConcept: { coding: [{ code: "54321" }] }
};

test("outbox lease heartbeat prevents a slow batch from being reclaimed by another worker", async () => {
  const filePath = `/tmp/rxflow-lease-heartbeat-${Date.now()}-${Math.random().toString(16).slice(2)}.sqlite`;
  const storeA = new SqliteCaseStore(filePath);
  const storeB = new SqliteCaseStore(filePath);
  try {
    await new RxWorkflowService(storeA, new DeterministicPaDraftGenerator()).ingest(paRequest, "lease-heartbeat-key");
    const delivered: Array<{ worker: string; eventId: string }> = [];
    const slowSink: EventSink = {
      async deliver(event) {
        delivered.push({ worker: "a", eventId: event.eventId });
        await new Promise((resolve) => setTimeout(resolve, 80));
      }
    };
    const fastSink: EventSink = {
      async deliver(event) { delivered.push({ worker: "b", eventId: event.eventId }); }
    };

    let resolveFirstRenewal: (() => void) | undefined;
    const firstRenewal = new Promise<void>((resolve) => { resolveFirstRenewal = resolve; });
    const originalRenew = storeA.renewOutboxLease.bind(storeA);
    storeA.renewOutboxLease = (eventId, claimId, leaseMs, now) => {
      originalRenew(eventId, claimId, leaseMs, now);
      resolveFirstRenewal?.();
    };
    const workerA = new OutboxDispatcher(storeA, slowSink, 3, "lease-worker-a", 50, 10, 0, 0);
    const workerB = new OutboxDispatcher(storeB, fastSink, 3, "lease-worker-b", 50, 10, 0, 0);
    const first = workerA.drain();
    await firstRenewal;
    const second = await workerB.drain();
    const firstReport = await first;

    assert.equal(second.attempted, 0);
    assert.equal(firstReport.published, 4);
    assert.ok(firstReport.leaseRenewals > 0);
    assert.equal(firstReport.leaseRenewalFailures, 0);
    assert.equal(new Set(delivered.map((item) => item.eventId)).size, 4);
    assert.equal(delivered.length, 4);
    assert.equal(storeA.listOutbox("PUBLISHED").length, 4);
  } finally {
    storeA.close();
    storeB.close();
    for (const path of [filePath, `${filePath}-wal`, `${filePath}-shm`]) {
      try { unlinkSync(path); } catch {}
    }
  }
});

test("outbox retry delay starts from failure completion time rather than claim time", async () => {
  const store = new InMemoryCaseStore();
  await new RxWorkflowService(store, new DeterministicPaDraftGenerator()).ingest(noPaRequest, "slow-failure-retry-clock");
  const sink: EventSink = { async deliver() { throw new Error("synthetic_downstream_failure"); } };
  const times = [
    new Date("2026-08-18T01:00:00.000Z"),
    new Date("2026-08-18T01:00:05.000Z"),
    new Date("2026-08-18T01:00:06.000Z"),
    new Date("2026-08-18T01:00:07.000Z")
  ];
  let index = 0;
  const report = await new OutboxDispatcher(
    store, sink, 3, "completion-clock-worker", 30_000, 100, 1_000, 10_000,
    () => 1, () => times[Math.min(index++, times.length - 1)]!
  ).drain();
  assert.equal(report.failed, 1);
  assert.equal(store.listOutbox("PENDING").filter((record) => record.nextAttemptAt === "2026-08-18T01:00:06.000Z").length, 1);
  assert.equal(store.getOutboxPressure().orderedBlockedPending, 2);
});

test("outbox claim interleaves ready tenants so one backlog cannot monopolise the batch", async () => {
  const store = new InMemoryCaseStore();
  const service = new RxWorkflowService(store, new DeterministicPaDraftGenerator());
  for (let i = 0; i < 10; i += 1) {
    await service.ingest({ ...paRequest, id: `fair-a-${i}` }, `fair-a-key-${i}`, undefined, undefined, "health-a");
  }
  for (let i = 0; i < 4; i += 1) {
    await service.ingest({ ...paRequest, id: `fair-b-${i}` }, `fair-b-key-${i}`, undefined, undefined, "health-b");
  }
  const claimed = store.claimOutbox("fair-worker", 8, 30_000, new Date("2026-08-18T05:00:00.000Z"));
  assert.deepEqual(claimed.map((record) => record.event.tenantId), [
    "health-a", "health-b", "health-a", "health-b",
    "health-a", "health-b", "health-a", "health-b"
  ]);
  assert.ok(claimed.every((record) => record.event.aggregateSequence === 1));
});

test("tenant-scoped throttling defers only that tenant while other tenants continue", async () => {
  const store = new InMemoryCaseStore();
  const service = new RxWorkflowService(store, new DeterministicPaDraftGenerator());
  for (let i = 0; i < 4; i += 1) {
    await service.ingest({ ...paRequest, id: `tenant-throttle-a-${i}` }, `tenant-throttle-a-key-${i}`, undefined, undefined, "health-a");
    await service.ingest({ ...paRequest, id: `tenant-throttle-b-${i}` }, `tenant-throttle-b-key-${i}`, undefined, undefined, "health-b");
  }
  const delivered: IntegrationEvent[] = [];
  let throttled = false;
  const sink: EventSink = {
    async deliver(event) {
      if (event.tenantId === "health-a" && !throttled) {
        throttled = true;
        throw new DeliveryError("webhook_http_429", { retryable: true, retryAfterMs: 5_000, failureScope: "tenant" });
      }
      delivered.push(event);
    }
  };
  const report = await new OutboxDispatcher(
    store, sink, 3, "tenant-throttle-worker", 30_000, 8, 1_000, 60_000,
    () => 0, () => new Date()
  ).drain();
  assert.equal(report.claimed, 8);
  assert.equal(report.attempted, 5);
  assert.equal(report.published, 4);
  assert.equal(report.failed, 1);
  assert.equal(report.deferred, 3);
  assert.equal(report.tenantShortCircuits, 1);
  assert.equal(report.globalShortCircuits, 0);
  assert.ok(delivered.every((event) => event.tenantId === "health-b"));
  assert.equal(store.listOutbox("PUBLISHED", "health-b").length, 4);
  assert.equal(store.listOutbox("PENDING", "health-a").filter((record) => record.attempts === 1).length, 1);
});

test("global dependency failure defers every untouched tenant in the claimed batch", async () => {
  const store = new InMemoryCaseStore();
  const service = new RxWorkflowService(store, new DeterministicPaDraftGenerator());
  for (const [id, tenant] of [["a1", "health-a"], ["a2", "health-a"], ["b1", "health-b"], ["b2", "health-b"]] as const) {
    await service.ingest({ ...paRequest, id: `global-stop-${id}` }, `global-stop-${id}-key`, undefined, undefined, tenant);
  }
  const sink: EventSink = {
    async deliver() {
      throw new DeliveryError("webhook_http_503", { retryable: true, retryAfterMs: 1_000, failureScope: "global" });
    }
  };
  const report = await new OutboxDispatcher(
    store, sink, 3, "global-stop-worker", 30_000, 8, 1_000, 60_000,
    () => 0, () => new Date()
  ).drain();
  assert.equal(report.attempted, 1);
  assert.equal(report.deferred, 3);
  assert.equal(report.tenantShortCircuits, 0);
  assert.equal(report.globalShortCircuits, 1);
  assert.equal(store.listOutbox("PENDING").length, 16);
});

test("ordered outbox claiming exposes only one unresolved head per aggregate", async () => {
  const store = new InMemoryCaseStore();
  const service = new RxWorkflowService(store, new DeterministicPaDraftGenerator());
  await service.ingest(noPaRequest, "ordered-head-a");
  await service.ingest({ ...noPaRequest, id: "rx-ordered-b" }, "ordered-head-b");
  const first = store.claimOutbox("ordered-head-worker", 100, 30_000, new Date("2026-08-18T08:00:00.000Z"));
  assert.equal(first.length, 2);
  assert.ok(first.every((record) => record.event.aggregateSequence === 1));
  assert.equal(new Set(first.map((record) => record.event.caseId)).size, 2);
  assert.equal(store.getOutboxPressure().orderedBlockedPending, 4);
});

test("terminal aggregate head blocks successors until redrive then delivery resumes in sequence", async () => {
  const store = new InMemoryCaseStore();
  await new RxWorkflowService(store, new DeterministicPaDraftGenerator()).ingest(noPaRequest, "ordered-terminal");
  let failedOnce = false;
  const sink: EventSink = {
    async deliver() {
      if (!failedOnce) {
        failedOnce = true;
        throw new DeliveryError("synthetic_terminal_head", { retryable: false });
      }
    }
  };
  const first = await new OutboxDispatcher(store, sink, 5, "ordered-terminal-worker").drain();
  assert.equal(first.attempted, 1);
  assert.equal(first.deadLettered, 1);
  assert.equal(store.getOutboxPressure().orderedBlockedPending, 2);
  const dead = store.listOutbox("DEAD_LETTER")[0];
  if (!dead) throw new Error("expected_ordered_dead_letter");
  store.redriveDeadLetter(dead.event.eventId);
  const collecting = new CollectingEventSink();
  const recovered = await new OutboxDispatcher(store, collecting, 5, "ordered-recovery-worker").drain();
  assert.equal(recovered.published, 3);
  assert.deepEqual(collecting.events.map((event) => event.aggregateSequence), [1, 2, 3]);
  assert.equal(store.getOutboxPressure().orderedBlockedPending, 0);
});

test("dead-letter recovery generations reject stale operator intent", async () => {
  const store = new InMemoryCaseStore();
  await new RxWorkflowService(store, new DeterministicPaDraftGenerator())
    .ingest(noPaRequest, "recovery-generation", undefined, undefined, "health-a");
  const firstClaim = store.claimOutbox("recovery-worker-1", 1, 30_000)[0];
  if (!firstClaim) throw new Error("missing_first_claim");
  store.markOutboxFailure(firstClaim.event.eventId, firstClaim.claimId, "terminal-1", 1);
  const firstDead = store.listOutbox("DEAD_LETTER", "health-a")[0];
  if (!firstDead) throw new Error("missing_first_dead_letter");
  assert.equal(firstDead.recoveryGeneration, 1);
  const firstView = toOutboxOperationsView(firstDead);
  assert.equal(firstView.recoveryEtag, outboxRecoveryEtag(firstDead.event.eventId, 1));
  assert.equal(parseOutboxRecoveryIfMatch(firstView.recoveryEtag ?? undefined, firstDead.event.eventId), 1);

  store.redriveDeadLetter(firstDead.event.eventId, "health-a", 1);
  const secondClaim = store.claimOutbox("recovery-worker-2", 1, 30_000)[0];
  if (!secondClaim) throw new Error("missing_second_claim");
  store.markOutboxFailure(secondClaim.event.eventId, secondClaim.claimId, "terminal-2", 1);
  const secondDead = store.listOutbox("DEAD_LETTER", "health-a")[0];
  if (!secondDead) throw new Error("missing_second_dead_letter");
  assert.equal(secondDead.recoveryGeneration, 2);
  assert.throws(() => store.retireDeadLetter({
    eventId: secondDead.event.eventId,
    actorId: "platform-stale",
    reasonCode: "downstream_reconciled",
    reference: "INC-STALE-1",
    tenantId: "health-a",
    expectedRecoveryGeneration: 1
  }), /stale_outbox_recovery/);
});

test("cross-tenant delivery concurrency lets a fast tenant complete while another tenant is slow", async () => {
  const store = new InMemoryCaseStore();
  const makeCase = (id: string, tenantId: string) => ({
    id, tenantId, version: 1, eventSequence: 1, correlationId: `corr-${id}`,
    sourceResourceId: `rx-${id}`, patientReference: `Patient/${id}`, medicationCode: "12345",
    payerPlan: "SYNTHETIC_PLAN", status: "RECEIVED" as const,
    priorAuthRequired: null, audit: []
  });
  const makeEvent = (id: string, tenantId: string): IntegrationEvent => ({
    eventId: `event-${id}`, type: "PrescriptionReceived", schemaVersion: 2,
    occurredAt: new Date().toISOString(), caseId: id, correlationId: `corr-${id}`,
    tenantId, aggregateSequence: 1, payload: { sourceResourceId: `rx-${id}` }
  });
  store.createCase(makeCase("slow-a", "health-a"), "key-a", "fp-a", [makeEvent("slow-a", "health-a")]);
  store.createCase(makeCase("fast-b", "health-b"), "key-b", "fp-b", [makeEvent("fast-b", "health-b")]);
  const completions: string[] = [];
  let active = 0;
  let peak = 0;
  const sink: EventSink = {
    async deliver(event) {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, event.tenantId === "health-a" ? 80 : 5));
      completions.push(event.tenantId ?? "default");
      active -= 1;
    }
  };
  const report = await new OutboxDispatcher(
    store, sink, 3, "tenant-concurrency-worker", 30_000, 2, 0, 0,
    Math.random, () => new Date(), 1, 2
  ).drain();
  assert.equal(report.published, 2);
  assert.equal(report.peakConcurrentDeliveries, 2);
  assert.equal(peak, 2);
  assert.deepEqual(completions, ["health-b", "health-a"]);
});

test("global outage defers untouched work without cancelling deliveries already in flight", async () => {
  const store = new InMemoryCaseStore();
  const makeCase = (tenantId: string) => ({
    id: `case-${tenantId}`, tenantId, version: 1, eventSequence: 1, correlationId: `corr-${tenantId}`,
    sourceResourceId: `rx-${tenantId}`, patientReference: `Patient/${tenantId}`, medicationCode: "12345",
    payerPlan: "SYNTHETIC_PLAN", status: "RECEIVED" as const,
    priorAuthRequired: null, audit: []
  });
  const makeEvent = (tenantId: string): IntegrationEvent => ({
    eventId: `event-${tenantId}`, type: "PrescriptionReceived", schemaVersion: 2,
    occurredAt: new Date().toISOString(), caseId: `case-${tenantId}`, correlationId: `corr-${tenantId}`,
    tenantId, aggregateSequence: 1, payload: { sourceResourceId: `rx-${tenantId}` }
  });
  for (const tenantId of ["health-a", "health-b", "health-c"]) {
    store.createCase(makeCase(tenantId), `key-${tenantId}`, `fp-${tenantId}`, [makeEvent(tenantId)]);
  }
  const started: string[] = [];
  const sink: EventSink = {
    async deliver(event) {
      const tenant = event.tenantId ?? "default";
      started.push(tenant);
      if (tenant === "health-a") {
        await new Promise((resolve) => setTimeout(resolve, 10));
        throw new DeliveryError("shared_dependency_unavailable", { retryable: true, retryAfterMs: 100, failureScope: "global" });
      }
      await new Promise((resolve) => setTimeout(resolve, 40));
    }
  };
  const report = await new OutboxDispatcher(
    store, sink, 3, "global-concurrent-worker", 30_000, 3, 100, 100,
    () => 0, () => new Date(), 1, 2
  ).drain();
  assert.equal(report.peakConcurrentDeliveries, 2);
  assert.equal(report.attempted, 2);
  assert.equal(report.failed, 1);
  assert.equal(report.published, 1);
  assert.equal(report.globalShortCircuits, 1);
  assert.equal(report.deferred, 1);
  assert.equal(started.includes("health-c"), false);
  const untouched = store.listOutbox().find((record) => record.event.tenantId === "health-c");
  assert.equal(untouched?.status, "PENDING");
  assert.equal(untouched?.attempts, 0);
});
