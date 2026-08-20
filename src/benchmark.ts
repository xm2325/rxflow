import { performance } from "node:perf_hooks";
import { DeterministicPaDraftGenerator } from "./ai.js";
import { MetricsRegistry } from "./metrics.js";
import { InMemoryCaseStore } from "./store.js";
import { RxWorkflowService } from "./workflow.js";

interface TimedResult {
  ms: number;
  status: string;
  priorAuthRequired: boolean | null;
}

function percentile(sorted: number[], q: number): number {
  if (sorted.length === 0) return 0;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1));
  return sorted[index];
}

function request(i: number, paRequired: boolean) {
  return {
    resourceType: "MedicationRequest",
    id: `bench-rx-${i}`,
    subject: { reference: `Patient/synthetic-bench-${i}` },
    medicationCodeableConcept: { coding: [{ code: paRequired ? "12345" : "1049502" }] },
    insurance: [{ display: `SYNTHETIC_PLAN_${i % 7}` }],
    note: [{ text: paRequired ? "Prior therapy trial of methotrexate with inadequate response." : "Routine medication request." }]
  };
}

const caseCount = Number(process.env.RXFLOW_BENCH_CASES ?? 2000);
const concurrency = Number(process.env.RXFLOW_BENCH_CONCURRENCY ?? 50);
const replayCount = Math.min(Number(process.env.RXFLOW_BENCH_REPLAYS ?? 200), caseCount);
const store = new InMemoryCaseStore();
const metrics = new MetricsRegistry();
const service = new RxWorkflowService(store, new DeterministicPaDraftGenerator(), 3, metrics);
const results: TimedResult[] = [];
const start = performance.now();

for (let offset = 0; offset < caseCount; offset += concurrency) {
  const batch = Array.from({ length: Math.min(concurrency, caseCount - offset) }, (_, j) => offset + j);
  const batchResults = await Promise.all(batch.map(async (i) => {
    const input = request(i, i % 2 === 0);
    const t0 = performance.now();
    const result = await service.ingest(input, `bench-key-${i}`, `bench-corr-${i}`);
    return { ms: performance.now() - t0, status: result.case.status, priorAuthRequired: result.case.priorAuthRequired };
  }));
  results.push(...batchResults);
}

let duplicateReplayCount = 0;
for (let i = 0; i < replayCount; i += 1) {
  const replay = await service.ingest(request(i, i % 2 === 0), `bench-key-${i}`, `bench-corr-${i}`);
  if (replay.duplicate) duplicateReplayCount += 1;
}

const totalDurationMs = performance.now() - start;
const latencies = results.map((r) => r.ms).sort((a, b) => a - b);
const report = {
  scope: "local synthetic in-process benchmark; not production latency",
  caseCount,
  concurrency,
  replayCount,
  duplicateReplayCount,
  totalDurationMs: Number(totalDurationMs.toFixed(2)),
  throughputCasesPerSecond: Number((caseCount / (totalDurationMs / 1000)).toFixed(1)),
  latencyMs: {
    p50: Number(percentile(latencies, 0.50).toFixed(3)),
    p95: Number(percentile(latencies, 0.95).toFixed(3)),
    p99: Number(percentile(latencies, 0.99).toFixed(3))
  },
  workflow: {
    humanReviewRequired: results.filter((r) => r.status === "HUMAN_REVIEW_REQUIRED").length,
    routed: results.filter((r) => r.status === "ROUTED").length,
    paRequired: results.filter((r) => r.priorAuthRequired === true).length,
    paNotRequired: results.filter((r) => r.priorAuthRequired === false).length
  },
  caseStoreSize: store.size(),
  outboxRecordCount: store.listOutbox().length,
  counters: metrics.snapshot()
};

console.log(JSON.stringify(report, null, 2));
if (store.size() !== caseCount || duplicateReplayCount !== replayCount) {
  throw new Error("benchmark_invariant_failed");
}
