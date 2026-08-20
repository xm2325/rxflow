import { unlinkSync } from "node:fs";
import { performance } from "node:perf_hooks";
import { DeterministicPaDraftGenerator } from "./ai.js";
import { OutboxDispatcher, type EventSink, type IntegrationEvent } from "./events.js";
import { SqliteCaseStore } from "./store.js";
import { RxWorkflowService } from "./workflow.js";

const caseCount = Number(process.env.RXFLOW_OUTBOX_BENCH_CASES ?? 300);
const workerCount = Number(process.env.RXFLOW_OUTBOX_BENCH_WORKERS ?? 4);
const batchSize = Number(process.env.RXFLOW_OUTBOX_BENCH_BATCH ?? 100);
if (!Number.isInteger(caseCount) || caseCount < 1) throw new Error("invalid_case_count");
if (!Number.isInteger(workerCount) || workerCount < 1) throw new Error("invalid_worker_count");
if (!Number.isInteger(batchSize) || batchSize < 1) throw new Error("invalid_batch_size");

function request(i: number) {
  return {
    resourceType: "MedicationRequest",
    id: `outbox-bench-rx-${i}`,
    subject: { reference: `Patient/synthetic-outbox-${i}` },
    medicationCodeableConcept: { coding: [{ code: i % 2 === 0 ? "12345" : "1049502" }] },
    insurance: [{ display: `SYNTHETIC_PLAN_${i % 5}` }],
    note: [{ text: i % 2 === 0 ? "Prior therapy trial of methotrexate." : "Routine medication request." }]
  };
}

const filePath = `/tmp/rxflow-outbox-benchmark-${Date.now()}-${Math.random().toString(16).slice(2)}.db`;
const writer = new SqliteCaseStore(filePath);
const service = new RxWorkflowService(writer, new DeterministicPaDraftGenerator());
for (let i = 0; i < caseCount; i += 1) {
  await service.ingest(request(i), `outbox-bench-key-${i}`, `outbox-bench-corr-${i}`);
}
const expectedEvents = writer.listOutbox().length;
writer.close();

const delivered = new Set<string>();
let duplicateDeliveries = 0;
const sink: EventSink = {
  async deliver(event: IntegrationEvent): Promise<void> {
    if (delivered.has(event.eventId)) duplicateDeliveries += 1;
    delivered.add(event.eventId);
  }
};

const stores = Array.from({ length: workerCount }, () => new SqliteCaseStore(filePath));
const dispatchers = stores.map((store, i) => new OutboxDispatcher(store, sink, 3, `bench-worker-${i}`, 30_000, batchSize));
const started = performance.now();
let rounds = 0;
let published = 0;
while (true) {
  rounds += 1;
  const reports = await Promise.all(dispatchers.map((dispatcher) => dispatcher.drain()));
  published += reports.reduce((sum, report) => sum + report.published, 0);
  if (reports.every((report) => report.claimed === 0)) break;
  if (rounds > 10_000) throw new Error("outbox_benchmark_did_not_converge");
}
const durationMs = performance.now() - started;
const finalStore = stores[0];
const report = {
  scope: "local SQLite multi-worker outbox benchmark; not cloud throughput",
  caseCount,
  expectedEvents,
  workerCount,
  batchSize,
  rounds,
  published,
  uniqueDelivered: delivered.size,
  duplicateDeliveries,
  pending: finalStore.listOutbox("PENDING").length,
  inFlight: finalStore.listOutbox("IN_FLIGHT").length,
  deadLetter: finalStore.listOutbox("DEAD_LETTER").length,
  durationMs: Number(durationMs.toFixed(2)),
  eventsPerSecond: Number((expectedEvents / (durationMs / 1000)).toFixed(1))
};
console.log(JSON.stringify(report, null, 2));

for (const store of stores) store.close();
unlinkSync(filePath);
if (published !== expectedEvents || delivered.size !== expectedEvents || duplicateDeliveries !== 0) {
  throw new Error("outbox_benchmark_invariant_failed");
}
