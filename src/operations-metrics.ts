import type { MetricsRegistry } from "./metrics.js";
import type { CaseStore } from "./store.js";

export interface OperationsMetricsView {
  counters: Record<string, number>;
  outbox: {
    pending: number;
    inFlight: number;
    published: number;
    deadLetter: number;
    retired: number;
  };
  queuePressure: {
    pending: number;
    activePendingTenants: number;
    largestTenantPending: number;
    largestTenantShare: number;
    pendingAgeTargetMs: number;
    oldestPendingAgeMs: number;
    overduePending: number;
    overduePendingTenants: number;
    orderedBlockedPending: number;
    orderedBlockedAggregates: number;
    targetBreached: boolean;
  };
}

/**
 * Operations metrics use aggregate queue counts rather than materialising
 * outbox records. This keeps the monitoring path independent of event payloads
 * and avoids an O(queue-size) read for a simple status request.
 */
export async function buildOperationsMetrics(store: CaseStore, metrics: MetricsRegistry, pendingAgeTargetMs = 60_000, now = new Date()): Promise<OperationsMetricsView> {
  const [counts, pressure] = await Promise.all([store.getOutboxCounts(), store.getOutboxPressure(pendingAgeTargetMs, now)]);
  const largestTenantShare = pressure.pending > 0 ? pressure.largestTenantPending / pressure.pending : 0;
  return {
    counters: metrics.snapshot(),
    outbox: counts,
    queuePressure: {
      pending: pressure.pending,
      activePendingTenants: pressure.activePendingTenants,
      largestTenantPending: pressure.largestTenantPending,
      largestTenantShare,
      pendingAgeTargetMs,
      oldestPendingAgeMs: pressure.oldestPendingAgeMs,
      overduePending: pressure.overduePending,
      overduePendingTenants: pressure.overduePendingTenants,
      orderedBlockedPending: pressure.orderedBlockedPending,
      orderedBlockedAggregates: pressure.orderedBlockedAggregates,
      targetBreached: pressure.overduePending > 0
    }
  };
}
