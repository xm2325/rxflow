import { OutboxDispatcher, type DispatchReport, type EventSink } from "./events.js";
import type { CaseStore } from "./store.js";

export interface OutboxDrainReport extends DispatchReport {
  batches: number;
  stoppedBecause: "idle" | "max_batches";
}

export async function drainOutboxUntilIdle(
  store: CaseStore,
  sink: EventSink,
  options: {
    workerId?: string;
    leaseMs?: number;
    batchSize?: number;
    maxAttempts?: number;
    retryBaseMs?: number;
    retryMaxMs?: number;
    maxBatches?: number;
    perTenantClaimLimit?: number;
    maxConcurrentTenants?: number;
    now?: Date;
  } = {}
): Promise<OutboxDrainReport> {
  const maxBatches = options.maxBatches ?? 100;
  if (!Number.isInteger(maxBatches) || maxBatches < 1) throw new Error("invalid_outbox_max_batches");
  const dispatcher = new OutboxDispatcher(
    store,
    sink,
    options.maxAttempts ?? 3,
    options.workerId,
    options.leaseMs ?? 30_000,
    options.batchSize ?? 100,
    options.retryBaseMs ?? 1_000,
    options.retryMaxMs ?? 60_000,
    Math.random,
    () => new Date(),
    options.perTenantClaimLimit ?? options.batchSize ?? 100,
    options.maxConcurrentTenants ?? 1
  );
  const total: OutboxDrainReport = {
    claimed: 0,
    attempted: 0,
    published: 0,
    failed: 0,
    deadLettered: 0,
    staleClaims: 0,
    leaseRenewals: 0,
    leaseRenewalFailures: 0,
    terminalFailures: 0,
    deferred: 0,
    batchShortCircuits: 0,
    tenantShortCircuits: 0,
    globalShortCircuits: 0,
    peakConcurrentDeliveries: 0,
    batches: 0,
    stoppedBecause: "idle"
  };

  for (let batch = 0; batch < maxBatches; batch += 1) {
    const report = await dispatcher.drain(options.now ?? new Date());
    if (report.claimed === 0) return total;
    total.batches += 1;
    total.claimed += report.claimed;
    total.attempted += report.attempted;
    total.published += report.published;
    total.failed += report.failed;
    total.deadLettered += report.deadLettered;
    total.staleClaims += report.staleClaims;
    total.leaseRenewals += report.leaseRenewals;
    total.leaseRenewalFailures += report.leaseRenewalFailures;
    total.terminalFailures += report.terminalFailures;
    total.deferred += report.deferred;
    total.batchShortCircuits += report.batchShortCircuits;
    total.tenantShortCircuits += report.tenantShortCircuits;
    total.globalShortCircuits += report.globalShortCircuits;
    total.peakConcurrentDeliveries = Math.max(total.peakConcurrentDeliveries, report.peakConcurrentDeliveries);
  }
  total.stoppedBecause = "max_batches";
  return total;
}
