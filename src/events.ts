import { randomUUID } from "node:crypto";
import type { RxCase } from "./domain.js";
import type { CaseStore } from "./store.js";

export type IntegrationEventType =
  | "PrescriptionReceived"
  | "BenefitsVerified"
  | "PaDraftGenerated"
  | "HumanReviewRequired"
  | "PaApproved"
  | "PrescriptionRouted"
  | "WorkflowFailed"
  | "DeliveryGapDeclared";

export interface IntegrationEvent {
  eventId: string;
  type: IntegrationEventType;
  schemaVersion: 1 | 2;
  occurredAt: string;
  caseId: string;
  correlationId: string;
  tenantId?: string;
  aggregateSequence?: number;
  payload: Record<string, string | number | boolean | null>;
}


const EVENT_TYPES: IntegrationEventType[] = [
  "PrescriptionReceived", "BenefitsVerified", "PaDraftGenerated", "HumanReviewRequired",
  "PaApproved", "PrescriptionRouted", "WorkflowFailed", "DeliveryGapDeclared"
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function eventContractError(reason: string): never {
  throw new Error(`invalid_integration_event:${reason}`);
}

function requireEventString(payload: Record<string, unknown>, field: string): string {
  const value = payload[field];
  if (typeof value !== "string" || value.trim() === "") eventContractError(`missing_${field}`);
  return value;
}

function requireEventBoolean(payload: Record<string, unknown>, field: string): boolean {
  const value = payload[field];
  if (typeof value !== "boolean") eventContractError(`invalid_${field}`);
  return value;
}

function requireEventNumber(payload: Record<string, unknown>, field: string, minimum = 0): number {
  const value = payload[field];
  if (typeof value !== "number" || !Number.isFinite(value) || value < minimum) eventContractError(`invalid_${field}`);
  return value;
}

export function parseIntegrationEvent(input: unknown): IntegrationEvent {
  if (!isRecord(input)) eventContractError("body_not_object");
  const eventId = requireEventString(input, "eventId");
  const typeValue = requireEventString(input, "type");
  if (!EVENT_TYPES.includes(typeValue as IntegrationEventType)) eventContractError("unsupported_type");
  if (input.schemaVersion !== 1 && input.schemaVersion !== 2) eventContractError("unsupported_schema_version");
  const occurredAt = requireEventString(input, "occurredAt");
  if (!Number.isFinite(Date.parse(occurredAt))) eventContractError("invalid_occurredAt");
  const caseId = requireEventString(input, "caseId");
  const correlationId = requireEventString(input, "correlationId");
  const tenantId = input.tenantId === undefined ? undefined : requireEventString(input, "tenantId");
  if (input.aggregateSequence !== undefined && (!Number.isInteger(input.aggregateSequence) || (input.aggregateSequence as number) < 1)) {
    eventContractError("invalid_aggregate_sequence");
  }
  if (!isRecord(input.payload)) eventContractError("payload_not_object");
  for (const value of Object.values(input.payload)) {
    if (!(value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean")) {
      eventContractError("payload_value_not_scalar");
    }
  }
  const payload = input.payload;
  const type = typeValue as IntegrationEventType;
  switch (type) {
    case "PrescriptionReceived":
      requireEventString(payload, "sourceResourceId");
      break;
    case "BenefitsVerified":
      requireEventBoolean(payload, "priorAuthRequired");
      break;
    case "PaDraftGenerated": {
      const confidence = requireEventNumber(payload, "confidence");
      if (confidence > 1) eventContractError("invalid_confidence");
      requireEventNumber(payload, "evidenceCount");
      requireEventNumber(payload, "validationErrors");
      break;
    }
    case "HumanReviewRequired":
      requireEventString(payload, "reason");
      break;
    case "PaApproved":
      if (input.schemaVersion === 1) requireEventString(payload, "reviewer");
      else requireEventBoolean(payload, "edited");
      break;
    case "PrescriptionRouted":
      requireEventString(payload, "route");
      break;
    case "WorkflowFailed":
      requireEventString(payload, "stage");
      requireEventString(payload, "code");
      requireEventBoolean(payload, "retryable");
      requireEventNumber(payload, "attempts", 1);
      break;
    case "DeliveryGapDeclared":
      if (input.schemaVersion !== 2) eventContractError("gap_requires_schema_v2");
      requireEventString(payload, "retiredEventId");
      requireEventString(payload, "originalType");
      requireEventString(payload, "reasonCode");
      break;
  }
  return {
    eventId,
    type,
    schemaVersion: input.schemaVersion as 1 | 2,
    occurredAt,
    caseId,
    correlationId,
    ...(tenantId ? { tenantId } : {}),
    ...(typeof input.aggregateSequence === "number" ? { aggregateSequence: input.aggregateSequence } : {}),
    payload: payload as IntegrationEvent["payload"]
  };
}


/**
 * Build the event that is allowed to cross an external integration boundary.
 *
 * Runtime parsing proves the durable event is structurally valid, but it may still
 * contain legacy or accidental extra scalar fields. Reconstructing each payload from
 * an allow-list keeps the external contract data-minimised. Legacy PaApproved v1
 * records are upgraded only when the non-identifying `edited` flag is present; a
 * record that cannot be upgraded safely fails closed instead of publishing reviewer
 * identity from an old backlog.
 */
export function externalizeIntegrationEvent(input: IntegrationEvent): IntegrationEvent {
  const event = parseIntegrationEvent(input);
  const common = {
    eventId: event.eventId,
    type: event.type,
    schemaVersion: 2 as const,
    occurredAt: event.occurredAt,
    caseId: event.caseId,
    correlationId: event.correlationId,
    ...(event.tenantId ? { tenantId: event.tenantId } : {}),
    ...(typeof event.aggregateSequence === "number" ? { aggregateSequence: event.aggregateSequence } : {})
  };

  switch (event.type) {
    case "PrescriptionReceived":
      return {
        ...common,
        payload: {
          sourceResourceId: requireEventString(event.payload, "sourceResourceId"),
          ...(typeof event.payload.sourceWorkflow === "string" && event.payload.sourceWorkflow.trim() !== ""
            ? { sourceWorkflow: event.payload.sourceWorkflow }
            : {}),
          ...(typeof event.payload.sourceTaskId === "string" && event.payload.sourceTaskId.trim() !== ""
            ? { sourceTaskId: event.payload.sourceTaskId }
            : {})
        }
      };
    case "BenefitsVerified":
      return { ...common, payload: { priorAuthRequired: requireEventBoolean(event.payload, "priorAuthRequired") } };
    case "PaDraftGenerated":
      return {
        ...common,
        payload: {
          confidence: requireEventNumber(event.payload, "confidence"),
          evidenceCount: requireEventNumber(event.payload, "evidenceCount"),
          validationErrors: requireEventNumber(event.payload, "validationErrors"),
          ...(typeof event.payload.recoveredAfterFailures === "number" && Number.isFinite(event.payload.recoveredAfterFailures)
            ? { recoveredAfterFailures: event.payload.recoveredAfterFailures }
            : {})
        }
      };
    case "HumanReviewRequired":
      return { ...common, payload: { reason: requireEventString(event.payload, "reason") } };
    case "PaApproved": {
      const edited = event.payload.edited;
      if (typeof edited !== "boolean") eventContractError("legacy_pa_approved_missing_edited");
      return { ...common, payload: { edited } };
    }
    case "PrescriptionRouted":
      return { ...common, payload: { route: requireEventString(event.payload, "route") } };
    case "WorkflowFailed":
      return {
        ...common,
        payload: {
          stage: requireEventString(event.payload, "stage"),
          code: requireEventString(event.payload, "code"),
          retryable: requireEventBoolean(event.payload, "retryable"),
          attempts: requireEventNumber(event.payload, "attempts", 1)
        }
      };
    case "DeliveryGapDeclared":
      return {
        ...common,
        payload: {
          retiredEventId: requireEventString(event.payload, "retiredEventId"),
          originalType: requireEventString(event.payload, "originalType"),
          reasonCode: requireEventString(event.payload, "reasonCode")
        }
      };
  }
}

export const DELIVERY_GAP_REASON_CODES = [
  "downstream_reconciled",
  "obsolete_contract",
  "duplicate_transition",
  "source_corrected_out_of_band"
] as const;

export type DeliveryGapReasonCode = typeof DELIVERY_GAP_REASON_CODES[number];

export function isDeliveryGapReasonCode(value: unknown): value is DeliveryGapReasonCode {
  return typeof value === "string" && (DELIVERY_GAP_REASON_CODES as readonly string[]).includes(value);
}

export type OutboxStatus = "PENDING" | "IN_FLIGHT" | "PUBLISHED" | "DEAD_LETTER" | "RETIRED";

export interface OutboxRecord {
  event: IntegrationEvent;
  status: OutboxStatus;
  attempts: number;
  lastError?: string;
  publishedAt?: string;
  claimId?: string;
  claimedBy?: string;
  leaseUntil?: string;
  nextAttemptAt?: string;
  enqueuedAt?: string;
  retiredAt?: string;
  retiredBy?: string;
  retirementReasonCode?: DeliveryGapReasonCode;
  retirementReference?: string;
  replacementEventId?: string;
  recoveryGeneration?: number;
}

export interface ClaimedOutboxRecord extends OutboxRecord {
  status: "IN_FLIGHT";
  claimId: string;
  claimedBy: string;
  leaseUntil: string;
}

export function integrationEvent(
  type: IntegrationEventType,
  rxCase: RxCase,
  payload: IntegrationEvent["payload"] = {}
): IntegrationEvent {
  rxCase.eventSequence = (Number.isInteger(rxCase.eventSequence) && rxCase.eventSequence >= 0 ? rxCase.eventSequence : 0) + 1;
  return {
    eventId: randomUUID(),
    type,
    schemaVersion: 2,
    occurredAt: new Date().toISOString(),
    caseId: rxCase.id,
    correlationId: rxCase.correlationId,
    ...(rxCase.tenantId ? { tenantId: rxCase.tenantId } : {}),
    aggregateSequence: rxCase.eventSequence,
    payload
  };
}

export interface EventSink {
  deliver(event: IntegrationEvent): Promise<void>;
}

/**
 * A delivery failure may be retryable (network outage, 429, 5xx) or terminal
 * (invalid payload, non-retryable 4xx). Retryable failures may also carry a
 * downstream Retry-After floor that is applied on top of local jittered backoff.
 */
export type DeliveryFailureScope = "record" | "tenant" | "global";

export class DeliveryError extends Error {
  readonly retryable: boolean;
  readonly retryAfterMs?: number;
  readonly stopBatch: boolean;
  readonly failureScope: DeliveryFailureScope;

  constructor(message: string, options: { retryable?: boolean; retryAfterMs?: number; stopBatch?: boolean; failureScope?: DeliveryFailureScope } = {}) {
    super(message);
    this.name = "DeliveryError";
    this.retryable = options.retryable ?? true;
    this.failureScope = options.failureScope ?? (options.stopBatch ? "global" : "record");
    this.stopBatch = this.failureScope !== "record";
    if (options.retryAfterMs !== undefined) {
      if (!Number.isFinite(options.retryAfterMs) || options.retryAfterMs < 0) throw new Error("invalid_delivery_retry_after");
      this.retryAfterMs = Math.floor(options.retryAfterMs);
    }
  }
}

function classifyDeliveryFailure(error: unknown): { message: string; retryable: boolean; retryAfterMs?: number; stopBatch: boolean; failureScope: DeliveryFailureScope } {
  if (error instanceof DeliveryError) {
    return {
      message: error.message,
      retryable: error.retryable,
      stopBatch: error.stopBatch,
      failureScope: error.failureScope,
      ...(error.retryAfterMs !== undefined ? { retryAfterMs: error.retryAfterMs } : {})
    };
  }
  const message = error instanceof Error ? error.message : "delivery_internal_error";
  // Contract/data failures are generated by RxFlow's own parser and use bounded
  // machine codes. They cannot heal by waiting, so they leave the active queue
  // immediately rather than burning the retry budget.
  if (message.startsWith("invalid_integration_event:")) return { message, retryable: false, stopBatch: false, failureScope: "record" };
  // Arbitrary sink/provider Error.message values are not an operational contract.
  // They may contain URLs, infrastructure details, or caller-controlled text, so
  // never persist them into the outbox or surface them through worker metrics.
  return { message: "delivery_internal_error", retryable: true, stopBatch: false, failureScope: "record" };
}

export interface DispatchReport {
  claimed: number;
  attempted: number;
  published: number;
  failed: number;
  deadLettered: number;
  staleClaims: number;
  leaseRenewals: number;
  leaseRenewalFailures: number;
  terminalFailures: number;
  deferred: number;
  batchShortCircuits: number;
  tenantShortCircuits: number;
  globalShortCircuits: number;
  peakConcurrentDeliveries: number;
}

export class CollectingEventSink implements EventSink {
  readonly events: IntegrationEvent[] = [];

  async deliver(event: IntegrationEvent): Promise<void> {
    this.events.push(event);
  }
}

export function computeRetryDelayMs(
  attemptsBeforeFailure: number,
  retryBaseMs: number,
  retryMaxMs: number,
  random: () => number = Math.random
): number {
  if (retryBaseMs === 0) return 0;
  if (!Number.isInteger(attemptsBeforeFailure) || attemptsBeforeFailure < 0) throw new Error("invalid_outbox_attempt_count");
  const sample = random();
  if (!Number.isFinite(sample) || sample < 0 || sample > 1) throw new Error("invalid_retry_random_sample");
  const cap = Math.min(retryMaxMs, retryBaseMs * (2 ** attemptsBeforeFailure));
  // Equal jitter keeps a non-zero floor while preventing many workers from retrying at one instant.
  return Math.floor(cap / 2 + (cap / 2) * sample);
}

export class OutboxDispatcher {
  constructor(
    private readonly store: CaseStore,
    private readonly sink: EventSink,
    private readonly maxAttempts = 3,
    private readonly workerId = randomUUID(),
    private readonly leaseMs = 30_000,
    private readonly batchSize = 100,
    private readonly retryBaseMs = 0,
    private readonly retryMaxMs = 60_000,
    private readonly random: () => number = Math.random,
    private readonly clock: () => Date = () => new Date(),
    private readonly perTenantClaimLimit = batchSize,
    private readonly maxConcurrentTenants = 1
  ) {
    if (retryBaseMs < 0 || retryMaxMs < 0 || retryBaseMs > retryMaxMs) throw new Error("invalid_outbox_retry_backoff");
    if (!Number.isInteger(perTenantClaimLimit) || perTenantClaimLimit < 1) throw new Error("invalid_outbox_per_tenant_claim_limit");
    if (!Number.isInteger(maxConcurrentTenants) || maxConcurrentTenants < 1) throw new Error("invalid_outbox_tenant_delivery_concurrency");
  }

  async drain(now?: Date): Promise<DispatchReport> {
    const total: DispatchReport = {
      claimed: 0, attempted: 0, published: 0, failed: 0, deadLettered: 0,
      staleClaims: 0, leaseRenewals: 0, leaseRenewalFailures: 0, terminalFailures: 0,
      deferred: 0, batchShortCircuits: 0, tenantShortCircuits: 0, globalShortCircuits: 0,
      peakConcurrentDeliveries: 0
    };
    // Claim one unresolved event per aggregate at the store boundary, then advance
    // successful aggregates in additional waves. This preserves aggregate ordering
    // across workers without reducing a healthy single-case flow to one event per timer tick.
    while (total.claimed < this.batchSize) {
      // Runtime waves must receive a fresh ownership timestamp. Reusing the first
      // wave's claim time can create already-expired leases after a slow delivery.
      const claimTime = now ?? this.clock();
      const wave = await this.drainWave(claimTime, this.batchSize - total.claimed);
      for (const key of Object.keys(total) as Array<keyof DispatchReport>) {
        if (key === "peakConcurrentDeliveries") total[key] = Math.max(total[key], wave[key]);
        else total[key] += wave[key];
      }
      if (wave.claimed === 0) break;
      // Never re-attempt a failed head within the same drain. Retry scheduling and
      // dead-letter handling must remain durable across distinct worker iterations.
      if (wave.failed > 0 || wave.globalShortCircuits > 0) break;
    }
    return total;
  }

  private async drainWave(claimTime: Date, claimLimit: number): Promise<DispatchReport> {
    const claimed = await this.store.claimOutbox(this.workerId, claimLimit, this.leaseMs, claimTime, Math.min(this.perTenantClaimLimit, claimLimit));
    const report: DispatchReport = {
      claimed: claimed.length,
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
      peakConcurrentDeliveries: 0
    };
    if (claimed.length === 0) return report;

    // Claims are made as a batch, but delivery may be slower than the lease. Without
    // renewal, later records in the batch can expire before this worker reaches them,
    // allowing another worker to redeliver them unnecessarily. Keep every outstanding
    // claim alive until its delivery attempt finishes.
    const activeClaims = new Map(claimed.map((record) => [record.event.eventId, record.claimId]));
    const claimTenants = new Map(claimed.map((record) => [record.event.eventId, record.event.tenantId ?? "default"]));
    const lostClaims = new Set<string>();
    const heartbeatIntervalMs = Math.max(10, Math.floor(this.leaseMs / 3));
    let heartbeatRunning = false;
    let heartbeatPromise: Promise<void> | undefined;

    const pulse = async (): Promise<void> => {
      if (heartbeatRunning || activeClaims.size === 0) return;
      heartbeatRunning = true;
      try {
        for (const [eventId, claimId] of [...activeClaims.entries()]) {
          if (!activeClaims.has(eventId)) continue;
          try {
            await this.store.renewOutboxLease(eventId, claimId, this.leaseMs, this.clock());
            report.leaseRenewals += 1;
          } catch {
            // If a lease cannot be renewed, do not start a later delivery under a claim
            // we can no longer prove we own. A delivery already in progress can still
            // complete, and downstream event-ID deduplication remains the final safety net.
            if (activeClaims.has(eventId)) {
              lostClaims.add(eventId);
              report.leaseRenewalFailures += 1;
            }
          }
        }
      } finally {
        heartbeatRunning = false;
      }
    };

    const heartbeat = setInterval(() => {
      heartbeatPromise = pulse();
    }, heartbeatIntervalMs);

    let activeDeliveries = 0;
    let globalStop = false;
    const inProgress = new Set<string>();

    const handleRecord = async (record: ClaimedOutboxRecord): Promise<"continue" | "stop_tenant" | "stop_global"> => {
      const eventId = record.event.eventId;
      if (!activeClaims.has(eventId)) return "continue";
      if (lostClaims.has(eventId)) {
        activeClaims.delete(eventId);
        report.failed += 1;
        report.staleClaims += 1;
        return "continue";
      }
      if (globalStop) return "stop_global";

      inProgress.add(eventId);
      activeDeliveries += 1;
      report.peakConcurrentDeliveries = Math.max(report.peakConcurrentDeliveries, activeDeliveries);
      try {
        report.attempted += 1;
        await this.sink.deliver(externalizeIntegrationEvent(record.event));
        activeClaims.delete(eventId);
        await this.store.markOutboxPublished(eventId, record.claimId);
        report.published += 1;
        return "continue";
      } catch (error) {
        activeClaims.delete(eventId);
        const failure = classifyDeliveryFailure(error);
        try {
          const localRetryDelayMs = failure.retryable
            ? computeRetryDelayMs(record.attempts, this.retryBaseMs, this.retryMaxMs, this.random)
            : 0;
          const retryDelayMs = Math.max(localRetryDelayMs, failure.retryAfterMs ?? 0);
          const effectiveMaxAttempts = failure.retryable ? this.maxAttempts : record.attempts + 1;
          const failureCompletedAt = this.clock();
          const status = await this.store.markOutboxFailure(
            eventId,
            record.claimId,
            failure.message,
            effectiveMaxAttempts,
            retryDelayMs,
            failureCompletedAt
          );
          report.failed += 1;
          if (!failure.retryable) report.terminalFailures += 1;
          if (status === "DEAD_LETTER") report.deadLettered += 1;

          if (failure.retryable && failure.failureScope !== "record" && activeClaims.size > 0) {
            const failedTenant = record.event.tenantId ?? "default";
            // Do not defer a claim whose external delivery has already started in a
            // concurrent tenant lane. A global failure can therefore have at most
            // `maxConcurrentTenants` external calls already in flight; untouched
            // claims are returned to PENDING without consuming attempt budget.
            const candidates = [...activeClaims.entries()].filter(([remainingEventId]) =>
              !inProgress.has(remainingEventId) &&
              (failure.failureScope === "global" || claimTenants.get(remainingEventId) === failedTenant)
            );
            if (candidates.length > 0) {
              report.batchShortCircuits += 1;
              if (failure.failureScope === "tenant") report.tenantShortCircuits += 1;
              else report.globalShortCircuits += 1;
              for (const [remainingEventId, remainingClaimId] of candidates) {
                try {
                  await this.store.deferOutboxClaim(remainingEventId, remainingClaimId, retryDelayMs, failureCompletedAt);
                  report.deferred += 1;
                } catch (deferError) {
                  if (!(deferError instanceof Error) || deferError.message !== "stale_outbox_claim") throw deferError;
                  report.staleClaims += 1;
                } finally {
                  activeClaims.delete(remainingEventId);
                }
              }
            }
            if (failure.failureScope === "global") {
              globalStop = true;
              return "stop_global";
            }
            if (failure.failureScope === "tenant") return "stop_tenant";
          }
          return "continue";
        } catch (claimError) {
          if (!(claimError instanceof Error) || claimError.message !== "stale_outbox_claim") throw claimError;
          report.failed += 1;
          report.staleClaims += 1;
          return "continue";
        }
      } finally {
        inProgress.delete(eventId);
        activeDeliveries -= 1;
      }
    };

    // Deliver records sequentially within a tenant lane so tenant-scoped 429/backoff
    // can stop later work for that tenant, while independent tenant lanes may run in
    // parallel. This removes execution-level head-of-line blocking without allowing
    // same-tenant work to race past a tenant-scoped throttle.
    const lanes = new Map<string, ClaimedOutboxRecord[]>();
    for (const record of claimed) {
      const tenantId = record.event.tenantId ?? "default";
      const lane = lanes.get(tenantId) ?? [];
      lane.push(record);
      lanes.set(tenantId, lane);
    }
    interface TenantLane { records: ClaimedOutboxRecord[]; index: number; }
    const readyLanes: TenantLane[] = [...lanes.values()].map((records) => ({ records, index: 0 }));

    // A concurrency slot is held for one external call, not for the tenant's entire
    // claimed lane. After a successful/record-scoped attempt the tenant goes to the
    // back of the ready queue. This keeps one slow tenant from occupying a delivery
    // slot for its whole claim quantum while still guaranteeing at most one active
    // external request per tenant in this dispatcher.
    const runScheduler = async (): Promise<void> => {
      await new Promise<void>((resolve, reject) => {
        let running = 0;
        let settled = false;

        const finishIfDone = (): void => {
          if (settled) return;
          if (running === 0 && (globalStop || readyLanes.length === 0)) {
            settled = true;
            resolve();
          }
        };

        const schedule = (): void => {
          if (settled) return;
          while (!globalStop && running < this.maxConcurrentTenants && readyLanes.length > 0) {
            const lane = readyLanes.shift()!;
            while (lane.index < lane.records.length && !activeClaims.has(lane.records[lane.index].event.eventId)) lane.index += 1;
            if (lane.index >= lane.records.length) continue;
            const record = lane.records[lane.index];
            lane.index += 1;
            running += 1;
            void handleRecord(record).then((result) => {
              running -= 1;
              if (result === "continue") {
                while (lane.index < lane.records.length && !activeClaims.has(lane.records[lane.index].event.eventId)) lane.index += 1;
                if (lane.index < lane.records.length && !globalStop) readyLanes.push(lane);
              }
              schedule();
              finishIfDone();
            }, (error) => {
              if (settled) return;
              settled = true;
              reject(error);
            });
          }
          finishIfDone();
        };

        schedule();
      });
    };

    try {
      await runScheduler();
    } finally {
      clearInterval(heartbeat);
      if (heartbeatPromise) await heartbeatPromise;
    }

    return report;
  }
}

export class MetadataLogEventSink implements EventSink {
  constructor(private readonly log: (line: string) => void = console.log) {}

  async deliver(event: IntegrationEvent): Promise<void> {
    this.log(JSON.stringify({
      event: "integration_event_published",
      eventId: event.eventId,
      type: event.type,
      schemaVersion: event.schemaVersion,
      correlationId: event.correlationId
    }));
  }
}

export class BackgroundOutboxPublisher {
  private active?: Promise<DispatchReport>;

  constructor(private readonly dispatcher: OutboxDispatcher) {}

  isActive(): boolean {
    return this.active !== undefined;
  }

  async tick(): Promise<DispatchReport | undefined> {
    if (this.active) return undefined;
    const active = this.dispatcher.drain();
    this.active = active;
    try {
      return await active;
    } finally {
      if (this.active === active) this.active = undefined;
    }
  }

  async waitForIdle(timeoutMs = 10_000): Promise<boolean> {
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1) throw new Error("invalid_publisher_idle_timeout");
    const active = this.active;
    if (!active) return true;
    return await new Promise<boolean>((resolve) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        resolve(false);
      }, timeoutMs);
      active.then(
        () => { if (!settled) { settled = true; clearTimeout(timer); resolve(true); } },
        () => { if (!settled) { settled = true; clearTimeout(timer); resolve(true); } }
      );
    });
  }
}
