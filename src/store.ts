import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { RxCase, WorkflowStatus } from "./domain.js";
import type { ClaimedOutboxRecord, DeliveryGapReasonCode, IntegrationEvent, OutboxRecord, OutboxStatus } from "./events.js";

export interface IdempotencyLookup {
  case: RxCase;
  requestFingerprint: string;
}

export class IdempotencyKeyAlreadyBoundError extends Error {
  constructor() {
    super("idempotency_key_already_bound");
    this.name = "IdempotencyKeyAlreadyBoundError";
  }
}

export type Awaitable<T> = T | Promise<T>;

export interface OutboxCounts {
  pending: number;
  inFlight: number;
  published: number;
  deadLetter: number;
  retired: number;
}

export interface OutboxPressure {
  pending: number;
  activePendingTenants: number;
  largestTenantPending: number;
  oldestPendingAgeMs: number;
  overduePending: number;
  overduePendingTenants: number;
  orderedBlockedPending: number;
  orderedBlockedAggregates: number;
}


export interface OutboxRetirementRequest {
  eventId: string;
  actorId: string;
  reasonCode: DeliveryGapReasonCode;
  reference: string;
  tenantId?: string;
  now?: Date;
  expectedRecoveryGeneration: number;
}

export interface OutboxRetirementResult {
  retired: OutboxRecord;
  replacement: OutboxRecord;
}

export type OutboxRecoveryRequestStatus = "PENDING" | "APPROVED" | "SUPERSEDED";

export interface OutboxRetirementApprovalRequest {
  requestId: string;
  tenantId: string;
  eventId: string;
  recoveryGeneration: number;
  requestedBy: string;
  reasonCode: DeliveryGapReasonCode;
  reference: string;
  status: OutboxRecoveryRequestStatus;
  requestedAt: string;
  approvedBy?: string;
  approvedAt?: string;
  replacementEventId?: string;
  supersededBy?: string;
  supersededAt?: string;
}

export type OutboxRecoveryAuditAction = "REDRIVEN" | "RETIREMENT_REQUESTED" | "RETIREMENT_APPROVED" | "RETIREMENT_SUPERSEDED";

export interface OutboxRecoveryAuditEntry {
  auditId: string;
  sequence: number;
  tenantId: string;
  eventId: string;
  recoveryGeneration: number;
  action: OutboxRecoveryAuditAction;
  actorId: string;
  createdAt: string;
  requestId?: string;
  reasonCode?: DeliveryGapReasonCode;
  reference?: string;
  replacementEventId?: string;
  supersededBy?: string;
  supersededAt?: string;
}

export interface OutboxRetirementApprovalResult {
  request: OutboxRetirementApprovalRequest;
  retired: OutboxRecord;
  replacement: OutboxRecord;
}

export interface CaseStore {
  get(id: string, tenantId?: string): Awaitable<RxCase | undefined>;
  list(tenantId?: string): Awaitable<RxCase[]>;
  save(rxCase: RxCase): Awaitable<void>;
  createCase(rxCase: RxCase, idempotencyKey: string, requestFingerprint: string, events?: IntegrationEvent[]): Awaitable<void>;
  saveWithOutbox(rxCase: RxCase, events: IntegrationEvent[]): Awaitable<void>;
  saveWithOutboxIfStatus(rxCase: RxCase, expectedStatus: WorkflowStatus, events: IntegrationEvent[]): Awaitable<boolean>;
  saveWithOutboxIfVersion(rxCase: RxCase, expectedVersion: number, events: IntegrationEvent[]): Awaitable<boolean>;
  getByIdempotencyKey(key: string, tenantId?: string): Awaitable<IdempotencyLookup | undefined>;
  bindIdempotencyKey(key: string, caseId: string, requestFingerprint: string, tenantId?: string): Awaitable<void>;
  listOutbox(status?: OutboxStatus, tenantId?: string): Awaitable<OutboxRecord[]>;
  claimOutbox(workerId: string, limit: number, leaseMs: number, now?: Date, perTenantLimit?: number): Awaitable<ClaimedOutboxRecord[]>;
  renewOutboxLease(eventId: string, claimId: string, leaseMs: number, now?: Date): Awaitable<void>;
  deferOutboxClaim(eventId: string, claimId: string, retryDelayMs?: number, now?: Date): Awaitable<void>;
  markOutboxPublished(eventId: string, claimId: string): Awaitable<void>;
  markOutboxFailure(eventId: string, claimId: string, error: string, maxAttempts: number, retryDelayMs?: number, now?: Date): Awaitable<OutboxStatus>;
  redriveDeadLetter(eventId: string, tenantId?: string, expectedRecoveryGeneration?: number, actorId?: string): Awaitable<OutboxRecord>;
  retireDeadLetter(request: OutboxRetirementRequest): Awaitable<OutboxRetirementResult>;
  createRetirementApprovalRequest(request: Omit<OutboxRetirementApprovalRequest, "requestId" | "status" | "requestedAt"> & { now?: Date }): Awaitable<OutboxRetirementApprovalRequest>;
  approveRetirementApprovalRequest(requestId: string, approverId: string, tenantId?: string, now?: Date): Awaitable<OutboxRetirementApprovalResult>;
  listRetirementApprovalRequests(tenantId?: string, eventId?: string): Awaitable<OutboxRetirementApprovalRequest[]>;
  listOutboxRecoveryAudit(eventId: string, tenantId?: string): Awaitable<OutboxRecoveryAuditEntry[]>;
  size(): Awaitable<number>;
  healthCheck(): Awaitable<void>;
  getOutboxCounts(): Awaitable<OutboxCounts>;
  getOutboxPressure(ageTargetMs?: number, now?: Date): Awaitable<OutboxPressure>;
}

function cloneCase(rxCase: RxCase): RxCase {
  return JSON.parse(JSON.stringify(rxCase)) as RxCase;
}

function caseTenant(rxCase: RxCase): string {
  return rxCase.tenantId ?? "default";
}

function eventTenant(event: IntegrationEvent): string {
  return event.tenantId ?? "default";
}

function aggregateKey(event: IntegrationEvent): string | undefined {
  if (!Number.isInteger(event.aggregateSequence) || (event.aggregateSequence ?? 0) < 1) return undefined;
  return `${eventTenant(event)}\u001f${event.caseId}`;
}

const IDEMPOTENCY_SEPARATOR = "\u001f";

function idempotencyStorageKey(tenantId: string, externalKey: string): string {
  return `${tenantId}${IDEMPOTENCY_SEPARATOR}${externalKey}`;
}

function legacyExternalKey(tenantId: string, storedKey: string): string {
  const prefix = `${tenantId}${IDEMPOTENCY_SEPARATOR}`;
  return storedKey.startsWith(prefix) ? storedKey.slice(prefix.length) : storedKey;
}

function normalizeCaseVersion(rxCase: RxCase): RxCase {
  if (!Number.isInteger(rxCase.version) || rxCase.version < 1) rxCase.version = 1;
  if (!Number.isInteger(rxCase.eventSequence) || rxCase.eventSequence < 0) rxCase.eventSequence = 0;
  return rxCase;
}

interface IdempotencyRecord {
  caseId: string;
  requestFingerprint: string;
}

interface StoreSnapshot {
  cases: RxCase[];
  idempotency: Array<[string, IdempotencyRecord]>;
  outbox: OutboxRecord[];
  retirementRequests?: OutboxRetirementApprovalRequest[];
  recoveryAudit?: OutboxRecoveryAuditEntry[];
}

function cloneOutboxRecord(record: OutboxRecord): OutboxRecord {
  return {
    ...record,
    event: { ...record.event, payload: { ...record.event.payload } }
  };
}

function cloneRetirementRequest(request: OutboxRetirementApprovalRequest): OutboxRetirementApprovalRequest { return { ...request }; }
function cloneRecoveryAudit(entry: OutboxRecoveryAuditEntry): OutboxRecoveryAuditEntry { return { ...entry }; }

function clearClaim(record: OutboxRecord): void {
  record.claimId = undefined;
  record.claimedBy = undefined;
  record.leaseUntil = undefined;
}

function buildGapEvent(record: OutboxRecord, reasonCode: DeliveryGapReasonCode, now: Date): IntegrationEvent {
  if (record.event.type === "DeliveryGapDeclared") throw new Error("gap_event_cannot_be_retired");
  const sequence = record.event.aggregateSequence;
  if (!Number.isInteger(sequence) || (sequence ?? 0) < 1) throw new Error("outbox_event_not_ordered");
  return {
    eventId: randomUUID(),
    type: "DeliveryGapDeclared",
    schemaVersion: 2,
    occurredAt: now.toISOString(),
    caseId: record.event.caseId,
    correlationId: record.event.correlationId,
    ...(record.event.tenantId ? { tenantId: record.event.tenantId } : {}),
    aggregateSequence: sequence,
    payload: {
      retiredEventId: record.event.eventId,
      originalType: record.event.type,
      reasonCode
    }
  };
}

function validateRetirementIdentity(actorId: string, reference: string): void {
  if (actorId.trim() === "") throw new Error("retirement_actor_required");
  if (reference.trim().length < 3 || reference.trim().length > 128) throw new Error("invalid_retirement_reference");
}

function appendRecoveryAuditEntry(audit: OutboxRecoveryAuditEntry[], entry: Omit<OutboxRecoveryAuditEntry, "sequence">): OutboxRecoveryAuditEntry {
  const sequence = audit.reduce((max, existing) => existing.tenantId === entry.tenantId && existing.eventId === entry.eventId ? Math.max(max, existing.sequence) : max, 0) + 1;
  const persisted: OutboxRecoveryAuditEntry = { ...entry, sequence };
  audit.push(persisted);
  return persisted;
}

function supersedePendingRetirementRequests(
  requests: Iterable<OutboxRetirementApprovalRequest>,
  tenantId: string,
  eventId: string,
  recoveryGeneration: number,
  actorId: string,
  now: Date,
  audit: OutboxRecoveryAuditEntry[]
): void {
  for (const request of requests) {
    if (request.tenantId !== tenantId || request.eventId !== eventId || request.recoveryGeneration !== recoveryGeneration || request.status !== "PENDING") continue;
    request.status = "SUPERSEDED";
    request.supersededBy = actorId;
    request.supersededAt = now.toISOString();
    appendRecoveryAuditEntry(audit, {
      auditId: randomUUID(), tenantId, eventId, recoveryGeneration, action: "RETIREMENT_SUPERSEDED",
      actorId, createdAt: request.supersededAt, requestId: request.requestId, reasonCode: request.reasonCode, reference: request.reference
    });
  }
}

export class InMemoryCaseStore implements CaseStore {
  protected readonly cases = new Map<string, RxCase>();
  protected readonly idempotency = new Map<string, IdempotencyRecord>();
  protected readonly outbox = new Map<string, OutboxRecord>();
  protected readonly retirementRequests = new Map<string, OutboxRetirementApprovalRequest>();
  protected readonly recoveryAudit: OutboxRecoveryAuditEntry[] = [];

  get(id: string, tenantId?: string): RxCase | undefined {
    const value = this.cases.get(id);
    if (!value || (tenantId !== undefined && caseTenant(value) !== tenantId)) return undefined;
    return cloneCase(value);
  }

  list(tenantId?: string): RxCase[] {
    return [...this.cases.values()]
      .filter((rxCase) => tenantId === undefined || caseTenant(rxCase) === tenantId)
      .map(cloneCase);
  }

  save(rxCase: RxCase): void {
    this.cases.set(rxCase.id, cloneCase(normalizeCaseVersion(rxCase)));
  }

  createCase(rxCase: RxCase, idempotencyKey: string, requestFingerprint: string, events: IntegrationEvent[] = []): void {
    if (this.cases.has(rxCase.id)) throw new Error("case_already_exists");
    const storageKey = idempotencyStorageKey(caseTenant(rxCase), idempotencyKey);
    if (this.idempotency.has(storageKey)) throw new IdempotencyKeyAlreadyBoundError();
    this.cases.set(rxCase.id, cloneCase(normalizeCaseVersion(rxCase)));
    this.idempotency.set(storageKey, { caseId: rxCase.id, requestFingerprint });
    this.enqueue(events);
  }

  saveWithOutbox(rxCase: RxCase, events: IntegrationEvent[]): void {
    this.cases.set(rxCase.id, cloneCase(normalizeCaseVersion(rxCase)));
    this.enqueue(events);
  }

  saveWithOutboxIfStatus(rxCase: RxCase, expectedStatus: WorkflowStatus, events: IntegrationEvent[]): boolean {
    const current = this.cases.get(rxCase.id);
    if (!current || current.status !== expectedStatus) return false;
    this.cases.set(rxCase.id, cloneCase(normalizeCaseVersion(rxCase)));
    this.enqueue(events);
    return true;
  }

  saveWithOutboxIfVersion(rxCase: RxCase, expectedVersion: number, events: IntegrationEvent[]): boolean {
    const current = this.cases.get(rxCase.id);
    if (!current || normalizeCaseVersion(current).version !== expectedVersion) return false;
    if (rxCase.version !== expectedVersion + 1) throw new Error("invalid_case_version_transition");
    this.cases.set(rxCase.id, cloneCase(rxCase));
    this.enqueue(events);
    return true;
  }

  getByIdempotencyKey(key: string, tenantId = "default"): IdempotencyLookup | undefined {
    const record = this.idempotency.get(idempotencyStorageKey(tenantId, key));
    if (!record) return undefined;
    const rxCase = this.cases.get(record.caseId);
    if (!rxCase || (tenantId !== undefined && caseTenant(rxCase) !== tenantId)) return undefined;
    return { case: cloneCase(normalizeCaseVersion(rxCase)), requestFingerprint: record.requestFingerprint };
  }

  bindIdempotencyKey(key: string, caseId: string, requestFingerprint: string, tenantId = "default"): void {
    const storageKey = idempotencyStorageKey(tenantId, key);
    const existing = this.idempotency.get(storageKey);
    if (existing && (existing.caseId !== caseId || existing.requestFingerprint !== requestFingerprint)) {
      throw new IdempotencyKeyAlreadyBoundError();
    }
    const rxCase = this.cases.get(caseId);
    if (tenantId !== undefined && (!rxCase || caseTenant(rxCase) !== tenantId)) throw new Error("case_not_found");
    this.idempotency.set(storageKey, { caseId, requestFingerprint });
  }

  listOutbox(status?: OutboxStatus, tenantId?: string): OutboxRecord[] {
    return [...this.outbox.values()]
      .filter((record) => status === undefined || record.status === status)
      .filter((record) => tenantId === undefined || eventTenant(record.event) === tenantId)
      .map(cloneOutboxRecord);
  }

  claimOutbox(workerId: string, limit: number, leaseMs: number, now = new Date(), perTenantLimit = limit): ClaimedOutboxRecord[] {
    if (limit < 1) return [];
    if (leaseMs < 1) throw new Error("outbox_lease_must_be_positive");
    if (!Number.isInteger(perTenantLimit) || perTenantLimit < 1) throw new Error("outbox_per_tenant_limit_must_be_positive");
    const nowMs = now.getTime();
    const leaseUntil = new Date(nowMs + leaseMs).toISOString();

    // Recover expired leases first. Then rank eligible records within each tenant and
    // interleave those ranks. A single noisy tenant can still use spare capacity, but
    // it cannot occupy the front of every batch while another tenant has ready work.
    for (const record of this.outbox.values()) {
      if (record.status === "IN_FLIGHT" && record.leaseUntil && Date.parse(record.leaseUntil) <= nowMs) {
        record.status = "PENDING";
        clearClaim(record);
      }
    }

    // Ordered aggregates use head-of-line delivery: a later sequence must not
    // overtake an unresolved predecessor that is retrying, in flight, or dead-lettered.
    // Unsequenced legacy events remain independent so old snapshots can still drain.
    const aggregateHeads = new Map<string, number>();
    for (const record of this.outbox.values()) {
      if (record.status === "PUBLISHED" || record.status === "RETIRED") continue;
      const key = aggregateKey(record.event);
      const sequence = record.event.aggregateSequence;
      if (!key || sequence === undefined) continue;
      aggregateHeads.set(key, Math.min(aggregateHeads.get(key) ?? Number.POSITIVE_INFINITY, sequence));
    }

    const tenantRanks = new Map<string, number>();
    const eligible: Array<{ record: OutboxRecord; tenantRank: number; insertionOrder: number }> = [];
    let insertionOrder = 0;
    for (const record of this.outbox.values()) {
      const currentOrder = insertionOrder++;
      if (record.status !== "PENDING") continue;
      if (record.nextAttemptAt && Date.parse(record.nextAttemptAt) > nowMs) continue;
      const key = aggregateKey(record.event);
      const sequence = record.event.aggregateSequence;
      if (key && sequence !== undefined && aggregateHeads.get(key) !== sequence) continue;
      const tenantId = eventTenant(record.event);
      const tenantRank = (tenantRanks.get(tenantId) ?? 0) + 1;
      tenantRanks.set(tenantId, tenantRank);
      eligible.push({ record, tenantRank, insertionOrder: currentOrder });
    }
    eligible.sort((a, b) => a.tenantRank - b.tenantRank || a.insertionOrder - b.insertionOrder);

    const claimed: ClaimedOutboxRecord[] = [];
    for (const { record } of eligible.filter((candidate) => candidate.tenantRank <= perTenantLimit).slice(0, limit)) {
      record.status = "IN_FLIGHT";
      record.claimId = randomUUID();
      record.claimedBy = workerId;
      record.leaseUntil = leaseUntil;
      claimed.push(cloneOutboxRecord(record) as ClaimedOutboxRecord);
    }
    return claimed;
  }

  renewOutboxLease(eventId: string, claimId: string, leaseMs: number, now = new Date()): void {
    if (leaseMs < 1) throw new Error("outbox_lease_must_be_positive");
    const record = this.outbox.get(eventId);
    if (!record) throw new Error("outbox_event_not_found");
    if (record.status !== "IN_FLIGHT" || record.claimId !== claimId) throw new Error("stale_outbox_claim");
    record.leaseUntil = new Date(now.getTime() + leaseMs).toISOString();
  }

  deferOutboxClaim(eventId: string, claimId: string, retryDelayMs = 0, now = new Date()): void {
    if (retryDelayMs < 0) throw new Error("invalid_outbox_retry_delay");
    const record = this.outbox.get(eventId);
    if (!record) throw new Error("outbox_event_not_found");
    if (record.status !== "IN_FLIGHT" || record.claimId !== claimId) throw new Error("stale_outbox_claim");
    record.status = "PENDING";
    record.nextAttemptAt = retryDelayMs > 0 ? new Date(now.getTime() + retryDelayMs).toISOString() : undefined;
    clearClaim(record);
  }

  markOutboxPublished(eventId: string, claimId: string): void {
    const record = this.outbox.get(eventId);
    if (!record) throw new Error("outbox_event_not_found");
    if (record.status !== "IN_FLIGHT" || record.claimId !== claimId) throw new Error("stale_outbox_claim");
    record.attempts += 1;
    record.status = "PUBLISHED";
    record.publishedAt = new Date().toISOString();
    record.lastError = undefined;
    record.nextAttemptAt = undefined;
    clearClaim(record);
  }

  markOutboxFailure(eventId: string, claimId: string, error: string, maxAttempts: number, retryDelayMs = 0, now = new Date()): OutboxStatus {
    const record = this.outbox.get(eventId);
    if (!record) throw new Error("outbox_event_not_found");
    if (record.status !== "IN_FLIGHT" || record.claimId !== claimId) throw new Error("stale_outbox_claim");
    if (retryDelayMs < 0) throw new Error("invalid_outbox_retry_delay");
    record.attempts += 1;
    record.lastError = error;
    record.status = record.attempts >= maxAttempts ? "DEAD_LETTER" : "PENDING";
    if (record.status === "DEAD_LETTER") record.recoveryGeneration = (record.recoveryGeneration ?? 0) + 1;
    record.nextAttemptAt = record.status === "PENDING" && retryDelayMs > 0
      ? new Date(now.getTime() + retryDelayMs).toISOString()
      : undefined;
    clearClaim(record);
    return record.status;
  }

  redriveDeadLetter(eventId: string, tenantId?: string, expectedRecoveryGeneration?: number, actorId?: string): OutboxRecord {
    const record = this.outbox.get(eventId);
    if (!record || (tenantId !== undefined && eventTenant(record.event) !== tenantId)) throw new Error("outbox_event_not_found");
    if (record.status !== "DEAD_LETTER") throw new Error("outbox_event_not_dead_letter");
    if (expectedRecoveryGeneration !== undefined && (record.recoveryGeneration ?? 0) !== expectedRecoveryGeneration) throw new Error("stale_outbox_recovery");
    const generation = record.recoveryGeneration ?? 0;
    const tenant = eventTenant(record.event);
    const redriveActor = actorId?.trim() || "system:redrive";
    const now = new Date();
    supersedePendingRetirementRequests(this.retirementRequests.values(), tenant, eventId, generation, redriveActor, now, this.recoveryAudit);
    record.status = "PENDING";
    record.attempts = 0;
    record.publishedAt = undefined;
    record.nextAttemptAt = undefined;
    clearClaim(record);
    if (actorId?.trim()) appendRecoveryAuditEntry(this.recoveryAudit, {
      auditId: randomUUID(), tenantId: tenant, eventId, recoveryGeneration: generation, action: "REDRIVEN",
      actorId: actorId.trim(), createdAt: now.toISOString()
    });
    return cloneOutboxRecord(record);
  }

  retireDeadLetter(request: OutboxRetirementRequest): OutboxRetirementResult {
    validateRetirementIdentity(request.actorId, request.reference);
    const record = this.outbox.get(request.eventId);
    if (!record || (request.tenantId !== undefined && eventTenant(record.event) !== request.tenantId)) throw new Error("outbox_event_not_found");
    if (record.status !== "DEAD_LETTER") throw new Error("outbox_event_not_dead_letter");
    if ((record.recoveryGeneration ?? 0) !== request.expectedRecoveryGeneration) throw new Error("stale_outbox_recovery");
    const now = request.now ?? new Date();
    const replacementEvent = buildGapEvent(record, request.reasonCode, now);
    if (this.outbox.has(replacementEvent.eventId)) throw new Error("outbox_event_already_exists");
    record.status = "RETIRED";
    record.retiredAt = now.toISOString();
    record.retiredBy = request.actorId.trim();
    record.retirementReasonCode = request.reasonCode;
    record.retirementReference = request.reference.trim();
    record.replacementEventId = replacementEvent.eventId;
    record.nextAttemptAt = undefined;
    clearClaim(record);
    const replacement: OutboxRecord = { event: replacementEvent, status: "PENDING", attempts: 0, enqueuedAt: now.toISOString() };
    this.outbox.set(replacementEvent.eventId, replacement);
    return { retired: cloneOutboxRecord(record), replacement: cloneOutboxRecord(replacement) };
  }

  createRetirementApprovalRequest(request: Omit<OutboxRetirementApprovalRequest, "requestId" | "status" | "requestedAt"> & { now?: Date }): OutboxRetirementApprovalRequest {
    validateRetirementIdentity(request.requestedBy, request.reference);
    const record = this.outbox.get(request.eventId);
    if (!record || eventTenant(record.event) !== request.tenantId) throw new Error("outbox_event_not_found");
    if (record.status !== "DEAD_LETTER") throw new Error("outbox_event_not_dead_letter");
    if ((record.recoveryGeneration ?? 0) !== request.recoveryGeneration) throw new Error("stale_outbox_recovery");
    if (record.event.type === "DeliveryGapDeclared") throw new Error("gap_event_cannot_be_retired");
    if (!aggregateKey(record.event)) throw new Error("outbox_event_not_ordered");
    for (const existing of this.retirementRequests.values()) {
      if (existing.tenantId === request.tenantId && existing.eventId === request.eventId && existing.recoveryGeneration === request.recoveryGeneration) throw new Error("retirement_request_exists");
    }
    const now = request.now ?? new Date();
    const created: OutboxRetirementApprovalRequest = {
      requestId: randomUUID(), tenantId: request.tenantId, eventId: request.eventId, recoveryGeneration: request.recoveryGeneration,
      requestedBy: request.requestedBy.trim(), reasonCode: request.reasonCode, reference: request.reference.trim(), status: "PENDING", requestedAt: now.toISOString()
    };
    this.retirementRequests.set(created.requestId, created);
    appendRecoveryAuditEntry(this.recoveryAudit, { auditId: randomUUID(), tenantId: created.tenantId, eventId: created.eventId, recoveryGeneration: created.recoveryGeneration,
      action: "RETIREMENT_REQUESTED", actorId: created.requestedBy, createdAt: created.requestedAt, requestId: created.requestId, reasonCode: created.reasonCode, reference: created.reference });
    return cloneRetirementRequest(created);
  }

  approveRetirementApprovalRequest(requestId: string, approverId: string, tenantId?: string, now = new Date()): OutboxRetirementApprovalResult {
    const request = this.retirementRequests.get(requestId);
    if (!request || (tenantId !== undefined && request.tenantId !== tenantId)) throw new Error("retirement_request_not_found");
    if (request.status !== "PENDING") throw new Error("retirement_request_not_pending");
    if (!approverId.trim()) throw new Error("retirement_approver_required");
    if (approverId.trim() === request.requestedBy) throw new Error("retirement_separation_of_duties");
    const result = this.retireDeadLetter({ eventId: request.eventId, actorId: approverId.trim(), reasonCode: request.reasonCode, reference: request.reference, tenantId: request.tenantId, expectedRecoveryGeneration: request.recoveryGeneration, now });
    request.status = "APPROVED"; request.approvedBy = approverId.trim(); request.approvedAt = now.toISOString(); request.replacementEventId = result.replacement.event.eventId;
    appendRecoveryAuditEntry(this.recoveryAudit, { auditId: randomUUID(), tenantId: request.tenantId, eventId: request.eventId, recoveryGeneration: request.recoveryGeneration,
      action: "RETIREMENT_APPROVED", actorId: approverId.trim(), createdAt: request.approvedAt, requestId, reasonCode: request.reasonCode, reference: request.reference, replacementEventId: request.replacementEventId });
    return { request: cloneRetirementRequest(request), retired: result.retired, replacement: result.replacement };
  }

  listRetirementApprovalRequests(tenantId?: string, eventId?: string): OutboxRetirementApprovalRequest[] {
    return [...this.retirementRequests.values()].filter((r) => tenantId === undefined || r.tenantId === tenantId).filter((r) => eventId === undefined || r.eventId === eventId).sort((a,b) => a.requestedAt.localeCompare(b.requestedAt)).map(cloneRetirementRequest);
  }

  listOutboxRecoveryAudit(eventId: string, tenantId?: string): OutboxRecoveryAuditEntry[] {
    return this.recoveryAudit.filter((e) => e.eventId === eventId).filter((e) => tenantId === undefined || e.tenantId === tenantId).sort((a,b) => a.sequence - b.sequence).map(cloneRecoveryAudit);
  }

  size(): number {
    return this.cases.size;
  }

  healthCheck(): void {}

  getOutboxCounts(): OutboxCounts {
    const counts: OutboxCounts = { pending: 0, inFlight: 0, published: 0, deadLetter: 0, retired: 0 };
    for (const record of this.outbox.values()) {
      if (record.status === "PENDING") counts.pending += 1;
      else if (record.status === "IN_FLIGHT") counts.inFlight += 1;
      else if (record.status === "PUBLISHED") counts.published += 1;
      else if (record.status === "DEAD_LETTER") counts.deadLetter += 1;
      else if (record.status === "RETIRED") counts.retired += 1;
    }
    return counts;
  }

  getOutboxPressure(ageTargetMs?: number, now = new Date()): OutboxPressure {
    if (ageTargetMs !== undefined && (!Number.isFinite(ageTargetMs) || ageTargetMs < 0)) throw new Error("invalid_outbox_age_target");
    const byTenant = new Map<string, number>();
    const overdueTenants = new Set<string>();
    let pending = 0;
    let overduePending = 0;
    let oldestPendingAgeMs = 0;
    let orderedBlockedPending = 0;
    const orderedBlockedAggregates = new Set<string>();
    const unresolvedHeads = new Map<string, number>();
    for (const record of this.outbox.values()) {
      if (record.status === "PUBLISHED" || record.status === "RETIRED") continue;
      const key = aggregateKey(record.event);
      const sequence = record.event.aggregateSequence;
      if (key && sequence !== undefined) unresolvedHeads.set(key, Math.min(unresolvedHeads.get(key) ?? Number.POSITIVE_INFINITY, sequence));
    }
    for (const record of this.outbox.values()) {
      if (record.status !== "PENDING") continue;
      pending += 1;
      const tenantId = eventTenant(record.event);
      byTenant.set(tenantId, (byTenant.get(tenantId) ?? 0) + 1);
      const enqueuedAt = record.enqueuedAt ?? record.event.occurredAt;
      const ageMs = Math.max(0, now.getTime() - Date.parse(enqueuedAt));
      oldestPendingAgeMs = Math.max(oldestPendingAgeMs, ageMs);
      if (ageTargetMs !== undefined && ageMs > ageTargetMs) {
        overduePending += 1;
        overdueTenants.add(tenantId);
      }
      const key = aggregateKey(record.event);
      const sequence = record.event.aggregateSequence;
      if (key && sequence !== undefined && unresolvedHeads.get(key) !== sequence) {
        orderedBlockedPending += 1;
        orderedBlockedAggregates.add(key);
      }
    }
    return {
      pending,
      activePendingTenants: byTenant.size,
      largestTenantPending: Math.max(0, ...byTenant.values()),
      oldestPendingAgeMs,
      overduePending,
      overduePendingTenants: overdueTenants.size,
      orderedBlockedPending,
      orderedBlockedAggregates: orderedBlockedAggregates.size
    };
  }

  protected enqueue(events: IntegrationEvent[]): void {
    for (const event of events) {
      if (this.outbox.has(event.eventId)) throw new Error("outbox_event_already_exists");
      this.outbox.set(event.eventId, { event, status: "PENDING", attempts: 0, enqueuedAt: event.occurredAt });
    }
  }

  protected snapshot(): StoreSnapshot {
    return {
      cases: [...this.cases.values()].map(cloneCase),
      idempotency: [...this.idempotency.entries()],
      outbox: [...this.outbox.values()].map(cloneOutboxRecord),
      retirementRequests: [...this.retirementRequests.values()].map(cloneRetirementRequest),
      recoveryAudit: this.recoveryAudit.map(cloneRecoveryAudit)
    };
  }

  protected restore(snapshot: StoreSnapshot): void {
    this.cases.clear();
    this.idempotency.clear();
    this.outbox.clear();
    this.retirementRequests.clear();
    this.recoveryAudit.length = 0;
    for (const rxCase of snapshot.cases) this.cases.set(rxCase.id, cloneCase(normalizeCaseVersion(rxCase)));
    for (const [storedKey, record] of snapshot.idempotency) {
      const rxCase = this.cases.get(record.caseId);
      const tenantId = rxCase ? caseTenant(rxCase) : "default";
      const externalKey = legacyExternalKey(tenantId, storedKey);
      this.idempotency.set(idempotencyStorageKey(tenantId, externalKey), record);
    }
    for (const record of snapshot.outbox ?? []) this.outbox.set(record.event.eventId, record);
    for (const request of snapshot.retirementRequests ?? []) this.retirementRequests.set(request.requestId, request);
    for (const legacyEntry of snapshot.recoveryAudit ?? []) {
      const entry = legacyEntry as OutboxRecoveryAuditEntry & { sequence?: number };
      if (Number.isInteger(entry.sequence) && (entry.sequence ?? 0) > 0) this.recoveryAudit.push(entry);
      else appendRecoveryAuditEntry(this.recoveryAudit, { ...entry, sequence: undefined } as unknown as Omit<OutboxRecoveryAuditEntry, "sequence">);
    }
  }
}

export class JsonFileCaseStore extends InMemoryCaseStore {
  constructor(private readonly filePath: string) {
    super();
    this.load();
  }

  override save(rxCase: RxCase): void {
    super.save(rxCase);
    this.flush();
  }

  override createCase(rxCase: RxCase, idempotencyKey: string, requestFingerprint: string, events: IntegrationEvent[] = []): void {
    super.createCase(rxCase, idempotencyKey, requestFingerprint, events);
    this.flush();
  }

  override saveWithOutbox(rxCase: RxCase, events: IntegrationEvent[]): void {
    super.saveWithOutbox(rxCase, events);
    this.flush();
  }

  override saveWithOutboxIfStatus(rxCase: RxCase, expectedStatus: WorkflowStatus, events: IntegrationEvent[]): boolean {
    const saved = super.saveWithOutboxIfStatus(rxCase, expectedStatus, events);
    if (saved) this.flush();
    return saved;
  }

  override saveWithOutboxIfVersion(rxCase: RxCase, expectedVersion: number, events: IntegrationEvent[]): boolean {
    const saved = super.saveWithOutboxIfVersion(rxCase, expectedVersion, events);
    if (saved) this.flush();
    return saved;
  }

  override bindIdempotencyKey(key: string, caseId: string, requestFingerprint: string, tenantId?: string): void {
    super.bindIdempotencyKey(key, caseId, requestFingerprint, tenantId);
    this.flush();
  }

  override claimOutbox(workerId: string, limit: number, leaseMs: number, now = new Date(), perTenantLimit = limit): ClaimedOutboxRecord[] {
    const records = super.claimOutbox(workerId, limit, leaseMs, now, perTenantLimit);
    if (records.length > 0) this.flush();
    return records;
  }

  override renewOutboxLease(eventId: string, claimId: string, leaseMs: number, now = new Date()): void {
    super.renewOutboxLease(eventId, claimId, leaseMs, now);
    this.flush();
  }

  override deferOutboxClaim(eventId: string, claimId: string, retryDelayMs = 0, now = new Date()): void {
    super.deferOutboxClaim(eventId, claimId, retryDelayMs, now);
    this.flush();
  }

  override markOutboxPublished(eventId: string, claimId: string): void {
    super.markOutboxPublished(eventId, claimId);
    this.flush();
  }

  override markOutboxFailure(eventId: string, claimId: string, error: string, maxAttempts: number, retryDelayMs = 0, now = new Date()): OutboxStatus {
    const status = super.markOutboxFailure(eventId, claimId, error, maxAttempts, retryDelayMs, now);
    this.flush();
    return status;
  }

  override redriveDeadLetter(eventId: string, tenantId?: string, expectedRecoveryGeneration?: number, actorId?: string): OutboxRecord {
    const record = super.redriveDeadLetter(eventId, tenantId, expectedRecoveryGeneration, actorId);
    this.flush();
    return record;
  }

  override retireDeadLetter(request: OutboxRetirementRequest): OutboxRetirementResult {
    const result = super.retireDeadLetter(request);
    this.flush();
    return result;
  }

  override createRetirementApprovalRequest(request: Omit<OutboxRetirementApprovalRequest, "requestId" | "status" | "requestedAt"> & { now?: Date }): OutboxRetirementApprovalRequest {
    const result = super.createRetirementApprovalRequest(request); this.flush(); return result;
  }
  override approveRetirementApprovalRequest(requestId: string, approverId: string, tenantId?: string, now = new Date()): OutboxRetirementApprovalResult {
    const result = super.approveRetirementApprovalRequest(requestId, approverId, tenantId, now); this.flush(); return result;
  }

  private load(): void {
    if (!existsSync(this.filePath)) return;
    const parsed = JSON.parse(readFileSync(this.filePath, "utf8")) as Partial<StoreSnapshot>;
    if (!Array.isArray(parsed.cases) || !Array.isArray(parsed.idempotency)) {
      throw new Error("invalid_store_snapshot");
    }
    this.restore({ cases: parsed.cases, idempotency: parsed.idempotency, outbox: Array.isArray(parsed.outbox) ? parsed.outbox : [],
      retirementRequests: Array.isArray(parsed.retirementRequests) ? parsed.retirementRequests : [], recoveryAudit: Array.isArray(parsed.recoveryAudit) ? parsed.recoveryAudit : [] });
  }

  private flush(): void {
    const folder = dirname(this.filePath);
    mkdirSync(folder, { recursive: true });
    const temporary = `${this.filePath}.tmp`;
    writeFileSync(temporary, JSON.stringify(this.snapshot(), null, 2), "utf8");
    renameSync(temporary, this.filePath);
  }
}

interface SqliteCaseRow { case_json: string; }
interface SqliteIdempotencyRow { case_json: string; request_fingerprint: string; }
interface SqliteOutboxRow {
  event_json: string;
  status: OutboxStatus;
  attempts: number;
  last_error: string | null;
  published_at: string | null;
  claim_id: string | null;
  claimed_by: string | null;
  lease_until: string | null;
  next_attempt_at: string | null;
  created_at: string | null;
  retired_at: string | null;
  retired_by: string | null;
  retirement_reason_code: string | null;
  retirement_reference: string | null;
  replacement_event_id: string | null;
  recovery_generation: number;
}
interface SqliteCountRow { count: number; }
interface SqliteStatusCountRow { status: OutboxStatus; count: number; }
interface SqliteSchemaRow { sql: string | null; }
interface SqliteColumnRow { name: string; }
interface SqliteCaseTenantRow { id: string; case_json: string; }
interface SqliteOutboxTenantRow { event_id: string; event_json: string; }
interface SqliteIdempotencyMigrationRow { key: string; tenant_id: string; case_id: string; request_fingerprint: string; }

interface SqliteRetirementRequestRow { request_id: string; tenant_id: string; event_id: string; recovery_generation: number; requested_by: string; reason_code: string; reference: string; status: OutboxRecoveryRequestStatus; requested_at: string; approved_by: string | null; approved_at: string | null; replacement_event_id: string | null; superseded_by: string | null; superseded_at: string | null; }
interface SqliteRecoveryAuditRow { audit_id: string; audit_sequence: number; tenant_id: string; event_id: string; recovery_generation: number; action: OutboxRecoveryAuditAction; actor_id: string; created_at: string; request_id: string | null; reason_code: string | null; reference: string | null; replacement_event_id: string | null; }

export class SqliteCaseStore implements CaseStore {
  private readonly db: DatabaseSync;

  constructor(filePath: string) {
    this.db = new DatabaseSync(filePath);
    this.db.exec("PRAGMA foreign_keys = ON");
    this.db.exec("PRAGMA busy_timeout = 5000");
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS cases (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL DEFAULT 'default',
        case_json TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS idempotency (
        key TEXT NOT NULL,
        tenant_id TEXT NOT NULL DEFAULT 'default',
        case_id TEXT NOT NULL,
        request_fingerprint TEXT NOT NULL,
        PRIMARY KEY(tenant_id, key),
        FOREIGN KEY(case_id) REFERENCES cases(id) ON DELETE CASCADE
      );
    `);
    this.ensureOutboxSchema();
    this.ensureOutboxAgeSchema();
    this.ensureTenantSchema();
    this.ensureOutboxAggregateSchema();
    this.ensureOutboxRetirementSchema();
    this.ensureOutboxRecoveryGenerationSchema();
    this.ensureCompositeIdempotencySchema();
    this.ensureOutboxRecoveryApprovalSchema();
    this.ensureRecoveryAuditSequenceSchema();
  }

  close(): void {
    this.db.close();
  }

  get(id: string, tenantId?: string): RxCase | undefined {
    const row = tenantId === undefined
      ? this.db.prepare("SELECT case_json FROM cases WHERE id = ?").get(id) as SqliteCaseRow | undefined
      : this.db.prepare("SELECT case_json FROM cases WHERE id = ? AND tenant_id = ?").get(id, tenantId) as SqliteCaseRow | undefined;
    return row ? normalizeCaseVersion(JSON.parse(row.case_json) as RxCase) : undefined;
  }

  list(tenantId?: string): RxCase[] {
    const rows = (tenantId === undefined
      ? this.db.prepare("SELECT case_json FROM cases ORDER BY rowid").all()
      : this.db.prepare("SELECT case_json FROM cases WHERE tenant_id = ? ORDER BY rowid").all(tenantId)) as SqliteCaseRow[];
    return rows.map((row) => normalizeCaseVersion(JSON.parse(row.case_json) as RxCase));
  }

  save(rxCase: RxCase): void {
    this.transaction(() => this.upsertCase(rxCase));
  }

  createCase(rxCase: RxCase, idempotencyKey: string, requestFingerprint: string, events: IntegrationEvent[] = []): void {
    this.transaction(() => {
      const tenantId = caseTenant(rxCase);
      const existing = this.db.prepare("SELECT key FROM idempotency WHERE tenant_id = ? AND key = ?").get(tenantId, idempotencyKey) as { key: string } | undefined;
      if (existing) throw new IdempotencyKeyAlreadyBoundError();
      this.db.prepare("INSERT INTO cases(id, tenant_id, case_json) VALUES (?, ?, ?)").run(rxCase.id, caseTenant(rxCase), JSON.stringify(rxCase));
      this.db.prepare("INSERT INTO idempotency(key, tenant_id, case_id, request_fingerprint) VALUES (?, ?, ?, ?)")
        .run(idempotencyKey, tenantId, rxCase.id, requestFingerprint);
      this.insertEvents(events);
    });
  }

  saveWithOutbox(rxCase: RxCase, events: IntegrationEvent[]): void {
    this.transaction(() => {
      this.upsertCase(rxCase);
      this.insertEvents(events);
    });
  }

  saveWithOutboxIfStatus(rxCase: RxCase, expectedStatus: WorkflowStatus, events: IntegrationEvent[]): boolean {
    let saved = false;
    this.transaction(() => {
      const row = this.db.prepare("SELECT case_json FROM cases WHERE id = ?").get(rxCase.id) as SqliteCaseRow | undefined;
      if (!row) return;
      const current = normalizeCaseVersion(JSON.parse(row.case_json) as RxCase);
      if (current.status !== expectedStatus) return;
      this.upsertCase(rxCase);
      this.insertEvents(events);
      saved = true;
    });
    return saved;
  }

  saveWithOutboxIfVersion(rxCase: RxCase, expectedVersion: number, events: IntegrationEvent[]): boolean {
    if (rxCase.version !== expectedVersion + 1) throw new Error("invalid_case_version_transition");
    let saved = false;
    this.transaction(() => {
      const row = this.db.prepare("SELECT case_json FROM cases WHERE id = ?").get(rxCase.id) as SqliteCaseRow | undefined;
      if (!row) return;
      const current = normalizeCaseVersion(JSON.parse(row.case_json) as RxCase);
      if (current.version !== expectedVersion) return;
      this.upsertCase(rxCase);
      this.insertEvents(events);
      saved = true;
    });
    return saved;
  }

  getByIdempotencyKey(key: string, tenantId = "default"): IdempotencyLookup | undefined {
    const row = this.db.prepare(`
      SELECT c.case_json AS case_json, i.request_fingerprint AS request_fingerprint
      FROM idempotency i
      JOIN cases c ON c.id = i.case_id AND c.tenant_id = i.tenant_id
      WHERE i.key = ? AND i.tenant_id = ?
    `).get(key, tenantId) as SqliteIdempotencyRow | undefined;
    if (!row) return undefined;
    const rxCase = normalizeCaseVersion(JSON.parse(row.case_json) as RxCase);
    if (tenantId !== undefined && caseTenant(rxCase) !== tenantId) return undefined;
    return { case: rxCase, requestFingerprint: row.request_fingerprint };
  }

  bindIdempotencyKey(key: string, caseId: string, requestFingerprint: string, tenantId = "default"): void {
    this.transaction(() => {
      const caseRow = this.db.prepare("SELECT case_json FROM cases WHERE id = ? AND tenant_id = ?").get(caseId, tenantId) as SqliteCaseRow | undefined;
      if (!caseRow) throw new Error("case_not_found");
      const existing = this.db.prepare("SELECT case_id, request_fingerprint FROM idempotency WHERE key = ? AND tenant_id = ?").get(key, tenantId) as { case_id: string; request_fingerprint: string } | undefined;
      if (existing && (existing.case_id !== caseId || existing.request_fingerprint !== requestFingerprint)) {
        throw new IdempotencyKeyAlreadyBoundError();
      }
      if (!existing) {
        this.db.prepare("INSERT INTO idempotency(key, tenant_id, case_id, request_fingerprint) VALUES (?, ?, ?, ?)")
          .run(key, tenantId, caseId, requestFingerprint);
      }
    });
  }

  listOutbox(status?: OutboxStatus, tenantId?: string): OutboxRecord[] {
    const columns = "event_json, status, attempts, last_error, published_at, claim_id, claimed_by, lease_until, next_attempt_at, created_at, retired_at, retired_by, retirement_reason_code, retirement_reference, replacement_event_id, recovery_generation";
    let rows: SqliteOutboxRow[];
    if (status !== undefined && tenantId !== undefined) {
      rows = this.db.prepare(`SELECT ${columns} FROM outbox WHERE status = ? AND tenant_id = ? ORDER BY rowid`).all(status, tenantId) as SqliteOutboxRow[];
    } else if (status !== undefined) {
      rows = this.db.prepare(`SELECT ${columns} FROM outbox WHERE status = ? ORDER BY rowid`).all(status) as SqliteOutboxRow[];
    } else if (tenantId !== undefined) {
      rows = this.db.prepare(`SELECT ${columns} FROM outbox WHERE tenant_id = ? ORDER BY rowid`).all(tenantId) as SqliteOutboxRow[];
    } else {
      rows = this.db.prepare(`SELECT ${columns} FROM outbox ORDER BY rowid`).all() as SqliteOutboxRow[];
    }
    return rows.map((row) => this.mapOutboxRow(row));
  }

  claimOutbox(workerId: string, limit: number, leaseMs: number, now = new Date(), perTenantLimit = limit): ClaimedOutboxRecord[] {
    if (limit < 1) return [];
    if (leaseMs < 1) throw new Error("outbox_lease_must_be_positive");
    if (!Number.isInteger(perTenantLimit) || perTenantLimit < 1) throw new Error("outbox_per_tenant_limit_must_be_positive");
    const nowIso = now.toISOString();
    const leaseUntil = new Date(now.getTime() + leaseMs).toISOString();
    const claims: ClaimedOutboxRecord[] = [];

    this.transaction(() => {
      this.db.prepare(`
        UPDATE outbox
        SET status = 'PENDING', claim_id = NULL, claimed_by = NULL, lease_until = NULL, next_attempt_at = NULL
        WHERE status = 'IN_FLIGHT' AND lease_until <= ?
      `).run(nowIso);

      const rows = this.db.prepare(`
        WITH eligible_heads AS (
          SELECT o.rowid AS queue_order, o.event_json, o.status, o.attempts, o.last_error, o.published_at,
                 o.claim_id, o.claimed_by, o.lease_until, o.next_attempt_at, o.created_at, o.retired_at, o.retired_by, o.retirement_reason_code, o.retirement_reference, o.replacement_event_id, o.recovery_generation, o.tenant_id
          FROM outbox AS o
          WHERE o.status = 'PENDING'
            AND (o.next_attempt_at IS NULL OR o.next_attempt_at <= ?)
            AND (
              o.aggregate_sequence IS NULL
              OR NOT EXISTS (
                SELECT 1
                FROM outbox AS predecessor
                WHERE predecessor.tenant_id = o.tenant_id
                  AND predecessor.aggregate_case_id = o.aggregate_case_id
                  AND predecessor.aggregate_sequence < o.aggregate_sequence
                  AND predecessor.status NOT IN ('PUBLISHED','RETIRED')
              )
            )
        ),
        eligible AS (
          SELECT *, ROW_NUMBER() OVER (PARTITION BY tenant_id ORDER BY queue_order) AS tenant_rank
          FROM eligible_heads
        )
        SELECT event_json, status, attempts, last_error, published_at, claim_id, claimed_by, lease_until, next_attempt_at, created_at, retired_at, retired_by, retirement_reason_code, retirement_reference, replacement_event_id, recovery_generation
        FROM eligible
        WHERE tenant_rank <= ?
        ORDER BY tenant_rank, queue_order
        LIMIT ?
      `).all(nowIso, perTenantLimit, limit) as SqliteOutboxRow[];

      const claimStatement = this.db.prepare(`
        UPDATE outbox
        SET status = 'IN_FLIGHT', claim_id = ?, claimed_by = ?, lease_until = ?
        WHERE event_id = ? AND status = 'PENDING'
      `);
      for (const row of rows) {
        const event = JSON.parse(row.event_json) as IntegrationEvent;
        const claimId = randomUUID();
        const result = claimStatement.run(claimId, workerId, leaseUntil, event.eventId);
        if (result.changes !== 1) continue;
        claims.push({
          ...this.mapOutboxRow(row),
          status: "IN_FLIGHT",
          claimId,
          claimedBy: workerId,
          leaseUntil
        } as ClaimedOutboxRecord);
      }
    });
    return claims;
  }

  renewOutboxLease(eventId: string, claimId: string, leaseMs: number, now = new Date()): void {
    if (leaseMs < 1) throw new Error("outbox_lease_must_be_positive");
    const leaseUntil = new Date(now.getTime() + leaseMs).toISOString();
    const result = this.db.prepare(`
      UPDATE outbox
      SET lease_until = ?
      WHERE event_id = ? AND status = 'IN_FLIGHT' AND claim_id = ?
    `).run(leaseUntil, eventId, claimId);
    if (result.changes !== 1) throw new Error("stale_outbox_claim");
  }

  deferOutboxClaim(eventId: string, claimId: string, retryDelayMs = 0, now = new Date()): void {
    if (retryDelayMs < 0) throw new Error("invalid_outbox_retry_delay");
    const nextAttemptAt = retryDelayMs > 0 ? new Date(now.getTime() + retryDelayMs).toISOString() : null;
    const result = this.db.prepare(`
      UPDATE outbox
      SET status = 'PENDING', claim_id = NULL, claimed_by = NULL, lease_until = NULL, next_attempt_at = ?
      WHERE event_id = ? AND status = 'IN_FLIGHT' AND claim_id = ?
    `).run(nextAttemptAt, eventId, claimId);
    if (result.changes !== 1) throw new Error("stale_outbox_claim");
  }

  markOutboxPublished(eventId: string, claimId: string): void {
    const result = this.db.prepare(`
      UPDATE outbox
      SET attempts = attempts + 1,
          status = 'PUBLISHED',
          published_at = ?,
          last_error = NULL,
          claim_id = NULL,
          claimed_by = NULL,
          lease_until = NULL,
          next_attempt_at = NULL
      WHERE event_id = ? AND status = 'IN_FLIGHT' AND claim_id = ?
    `).run(new Date().toISOString(), eventId, claimId);
    if (result.changes !== 1) throw new Error("stale_outbox_claim");
  }

  markOutboxFailure(eventId: string, claimId: string, error: string, maxAttempts: number, retryDelayMs = 0, now = new Date()): OutboxStatus {
    if (retryDelayMs < 0) throw new Error("invalid_outbox_retry_delay");
    let nextStatus: OutboxStatus = "PENDING";
    this.transaction(() => {
      const current = this.db.prepare("SELECT attempts, recovery_generation FROM outbox WHERE event_id = ? AND status = 'IN_FLIGHT' AND claim_id = ?")
        .get(eventId, claimId) as { attempts: number; recovery_generation: number } | undefined;
      if (!current) throw new Error("stale_outbox_claim");
      const nextAttempts = current.attempts + 1;
      nextStatus = nextAttempts >= maxAttempts ? "DEAD_LETTER" : "PENDING";
      const nextAttemptAt = nextStatus === "PENDING" && retryDelayMs > 0
        ? new Date(now.getTime() + retryDelayMs).toISOString()
        : null;
      this.db.prepare(`
        UPDATE outbox
        SET attempts = ?, status = ?, last_error = ?, claim_id = NULL, claimed_by = NULL, lease_until = NULL, next_attempt_at = ?,
            recovery_generation = ?
        WHERE event_id = ? AND claim_id = ?
      `).run(nextAttempts, nextStatus, error, nextAttemptAt, nextStatus === "DEAD_LETTER" ? current.recovery_generation + 1 : current.recovery_generation, eventId, claimId);
    });
    return nextStatus;
  }

  redriveDeadLetter(eventId: string, tenantId?: string, expectedRecoveryGeneration?: number, actorId?: string): OutboxRecord {
    let output: OutboxRecord | undefined;
    this.transaction(() => {
      const row = this.db.prepare(`
        SELECT event_json, status, attempts, last_error, published_at, claim_id, claimed_by, lease_until, next_attempt_at, created_at,
               retired_at, retired_by, retirement_reason_code, retirement_reference, replacement_event_id, recovery_generation
        FROM outbox WHERE event_id = ? AND (? IS NULL OR tenant_id = ?)
      `).get(eventId, tenantId ?? null, tenantId ?? null) as SqliteOutboxRow | undefined;
      if (!row) throw new Error("outbox_event_not_found");
      const before = this.mapOutboxRow(row);
      if (before.status !== "DEAD_LETTER") throw new Error("outbox_event_not_dead_letter");
      if (expectedRecoveryGeneration !== undefined && (before.recoveryGeneration ?? 0) !== expectedRecoveryGeneration) throw new Error("stale_outbox_recovery");
      const generation = before.recoveryGeneration ?? 0;
      const tenant = eventTenant(before.event);
      const redriveActor = actorId?.trim() || "system:redrive";
      const now = new Date();
      const superseded = this.db.prepare(`UPDATE outbox_retirement_requests SET status='SUPERSEDED', superseded_by=?, superseded_at=? WHERE tenant_id=? AND event_id=? AND recovery_generation=? AND status='PENDING' RETURNING request_id,reason_code,reference`).all(redriveActor, now.toISOString(), tenant, eventId, generation) as Array<{request_id:string;reason_code:string;reference:string}>;
      for (const request of superseded) this.insertRecoveryAudit({ auditId: randomUUID(), tenantId: tenant, eventId, recoveryGeneration: generation, action: "RETIREMENT_SUPERSEDED", actorId: redriveActor, createdAt: now.toISOString(), requestId: request.request_id, reasonCode: request.reason_code as DeliveryGapReasonCode, reference: request.reference });
      const updated = this.db.prepare(`
        UPDATE outbox SET status='PENDING', attempts=0, published_at=NULL, claim_id=NULL, claimed_by=NULL, lease_until=NULL, next_attempt_at=NULL
        WHERE event_id=? AND status='DEAD_LETTER'
      `).run(eventId);
      if (updated.changes !== 1) throw new Error("outbox_event_not_dead_letter");
      if (actorId?.trim()) this.insertRecoveryAudit({ auditId: randomUUID(), tenantId: tenant, eventId, recoveryGeneration: generation, action: "REDRIVEN", actorId: actorId.trim(), createdAt: now.toISOString() });
      const current = this.db.prepare("SELECT event_json, status, attempts, last_error, published_at, claim_id, claimed_by, lease_until, next_attempt_at, created_at, retired_at, retired_by, retirement_reason_code, retirement_reference, replacement_event_id, recovery_generation FROM outbox WHERE event_id = ?").get(eventId) as SqliteOutboxRow | undefined;
      if (!current) throw new Error("outbox_event_not_found");
      output = this.mapOutboxRow(current);
    });
    if (!output) throw new Error("outbox_redrive_failed");
    return output;
  }

  retireDeadLetter(request: OutboxRetirementRequest): OutboxRetirementResult {
    validateRetirementIdentity(request.actorId, request.reference);
    const now = request.now ?? new Date();
    let result: OutboxRetirementResult | undefined;
    this.transaction(() => {
      const row = this.db.prepare(`
        SELECT event_json, status, attempts, last_error, published_at, claim_id, claimed_by, lease_until, next_attempt_at, created_at,
               retired_at, retired_by, retirement_reason_code, retirement_reference, replacement_event_id, recovery_generation
        FROM outbox
        WHERE event_id = ? AND (? IS NULL OR tenant_id = ?)
      `).get(request.eventId, request.tenantId ?? null, request.tenantId ?? null) as SqliteOutboxRow | undefined;
      if (!row) throw new Error("outbox_event_not_found");
      const record = this.mapOutboxRow(row);
      if (record.status !== "DEAD_LETTER") throw new Error("outbox_event_not_dead_letter");
      if ((record.recoveryGeneration ?? 0) !== request.expectedRecoveryGeneration) throw new Error("stale_outbox_recovery");
      const replacementEvent = buildGapEvent(record, request.reasonCode, now);
      const updated = this.db.prepare(`
        UPDATE outbox
        SET status = 'RETIRED', claim_id = NULL, claimed_by = NULL, lease_until = NULL, next_attempt_at = NULL,
            retired_at = ?, retired_by = ?, retirement_reason_code = ?, retirement_reference = ?, replacement_event_id = ?
        WHERE event_id = ? AND status = 'DEAD_LETTER'
      `).run(now.toISOString(), request.actorId.trim(), request.reasonCode, request.reference.trim(), replacementEvent.eventId, request.eventId);
      if (updated.changes !== 1) throw new Error("outbox_event_not_dead_letter");
      this.insertEvents([replacementEvent]);
      const retiredRow = this.db.prepare(`
        SELECT event_json, status, attempts, last_error, published_at, claim_id, claimed_by, lease_until, next_attempt_at, created_at,
               retired_at, retired_by, retirement_reason_code, retirement_reference, replacement_event_id, recovery_generation
        FROM outbox WHERE event_id = ?
      `).get(request.eventId) as SqliteOutboxRow;
      const replacementRow = this.db.prepare(`
        SELECT event_json, status, attempts, last_error, published_at, claim_id, claimed_by, lease_until, next_attempt_at, created_at,
               retired_at, retired_by, retirement_reason_code, retirement_reference, replacement_event_id, recovery_generation
        FROM outbox WHERE event_id = ?
      `).get(replacementEvent.eventId) as SqliteOutboxRow;
      result = { retired: this.mapOutboxRow(retiredRow), replacement: this.mapOutboxRow(replacementRow) };
    });
    if (!result) throw new Error("outbox_retirement_failed");
    return result;
  }

  createRetirementApprovalRequest(request: Omit<OutboxRetirementApprovalRequest, "requestId" | "status" | "requestedAt"> & { now?: Date }): OutboxRetirementApprovalRequest {
    validateRetirementIdentity(request.requestedBy, request.reference);
    const now = request.now ?? new Date();
    let created: OutboxRetirementApprovalRequest | undefined;
    this.transaction(() => {
      const row = this.db.prepare(`SELECT event_json, status, attempts, last_error, published_at, claim_id, claimed_by, lease_until, next_attempt_at, created_at, retired_at, retired_by, retirement_reason_code, retirement_reference, replacement_event_id, recovery_generation FROM outbox WHERE event_id=? AND tenant_id=?`).get(request.eventId, request.tenantId) as SqliteOutboxRow | undefined;
      if (!row) throw new Error("outbox_event_not_found");
      const record = this.mapOutboxRow(row);
      if (record.status !== "DEAD_LETTER") throw new Error("outbox_event_not_dead_letter");
      if ((record.recoveryGeneration ?? 0) !== request.recoveryGeneration) throw new Error("stale_outbox_recovery");
      if (record.event.type === "DeliveryGapDeclared") throw new Error("gap_event_cannot_be_retired");
      if (!aggregateKey(record.event)) throw new Error("outbox_event_not_ordered");
      const requestId = randomUUID();
      try {
        this.db.prepare(`INSERT INTO outbox_retirement_requests(request_id,tenant_id,event_id,recovery_generation,requested_by,reason_code,reference,status,requested_at) VALUES (?,?,?,?,?,?,?,'PENDING',?)`).run(requestId, request.tenantId, request.eventId, request.recoveryGeneration, request.requestedBy.trim(), request.reasonCode, request.reference.trim(), now.toISOString());
      } catch (error) {
        if (error instanceof Error && error.message.includes("UNIQUE constraint failed")) throw new Error("retirement_request_exists");
        throw error;
      }
      created = { requestId, tenantId: request.tenantId, eventId: request.eventId, recoveryGeneration: request.recoveryGeneration, requestedBy: request.requestedBy.trim(), reasonCode: request.reasonCode, reference: request.reference.trim(), status: "PENDING", requestedAt: now.toISOString() };
      this.insertRecoveryAudit({ auditId: randomUUID(), tenantId: request.tenantId, eventId: request.eventId, recoveryGeneration: request.recoveryGeneration, action: "RETIREMENT_REQUESTED", actorId: request.requestedBy.trim(), createdAt: now.toISOString(), requestId, reasonCode: request.reasonCode, reference: request.reference.trim() });
    });
    if (!created) throw new Error("retirement_request_create_failed");
    return created;
  }

  approveRetirementApprovalRequest(requestId: string, approverId: string, tenantId?: string, now = new Date()): OutboxRetirementApprovalResult {
    if (!approverId.trim()) throw new Error("retirement_approver_required");
    let output: OutboxRetirementApprovalResult | undefined;
    this.transaction(() => {
      const rr = this.db.prepare(`SELECT request_id,tenant_id,event_id,recovery_generation,requested_by,reason_code,reference,status,requested_at,approved_by,approved_at,replacement_event_id,superseded_by,superseded_at FROM outbox_retirement_requests WHERE request_id=? AND (? IS NULL OR tenant_id=?)`).get(requestId, tenantId ?? null, tenantId ?? null) as SqliteRetirementRequestRow | undefined;
      if (!rr) throw new Error("retirement_request_not_found");
      const request = this.mapRetirementRequestRow(rr);
      if (request.status !== "PENDING") throw new Error("retirement_request_not_pending");
      if (request.requestedBy === approverId.trim()) throw new Error("retirement_separation_of_duties");
      const row = this.db.prepare(`SELECT event_json, status, attempts, last_error, published_at, claim_id, claimed_by, lease_until, next_attempt_at, created_at, retired_at, retired_by, retirement_reason_code, retirement_reference, replacement_event_id, recovery_generation FROM outbox WHERE event_id=? AND tenant_id=?`).get(request.eventId, request.tenantId) as SqliteOutboxRow | undefined;
      if (!row) throw new Error("outbox_event_not_found");
      const record = this.mapOutboxRow(row);
      if (record.status !== "DEAD_LETTER") throw new Error("outbox_event_not_dead_letter");
      if ((record.recoveryGeneration ?? 0) !== request.recoveryGeneration) throw new Error("stale_outbox_recovery");
      const replacementEvent = buildGapEvent(record, request.reasonCode, now);
      const updated = this.db.prepare(`UPDATE outbox SET status='RETIRED',claim_id=NULL,claimed_by=NULL,lease_until=NULL,next_attempt_at=NULL,retired_at=?,retired_by=?,retirement_reason_code=?,retirement_reference=?,replacement_event_id=? WHERE event_id=? AND status='DEAD_LETTER' AND recovery_generation=?`).run(now.toISOString(), approverId.trim(), request.reasonCode, request.reference, replacementEvent.eventId, request.eventId, request.recoveryGeneration);
      if (updated.changes !== 1) throw new Error("stale_outbox_recovery");
      this.insertEvents([replacementEvent]);
      this.db.prepare(`UPDATE outbox_retirement_requests SET status='APPROVED',approved_by=?,approved_at=?,replacement_event_id=? WHERE request_id=? AND status='PENDING'`).run(approverId.trim(), now.toISOString(), replacementEvent.eventId, requestId);
      const approvedRow = this.db.prepare(`SELECT request_id,tenant_id,event_id,recovery_generation,requested_by,reason_code,reference,status,requested_at,approved_by,approved_at,replacement_event_id,superseded_by,superseded_at FROM outbox_retirement_requests WHERE request_id=?`).get(requestId) as SqliteRetirementRequestRow;
      this.insertRecoveryAudit({ auditId: randomUUID(), tenantId: request.tenantId, eventId: request.eventId, recoveryGeneration: request.recoveryGeneration, action: "RETIREMENT_APPROVED", actorId: approverId.trim(), createdAt: now.toISOString(), requestId, reasonCode: request.reasonCode, reference: request.reference, replacementEventId: replacementEvent.eventId });
      const retiredRow = this.db.prepare(`SELECT event_json, status, attempts, last_error, published_at, claim_id, claimed_by, lease_until, next_attempt_at, created_at, retired_at, retired_by, retirement_reason_code, retirement_reference, replacement_event_id, recovery_generation FROM outbox WHERE event_id=?`).get(request.eventId) as SqliteOutboxRow;
      const replacementRow = this.db.prepare(`SELECT event_json, status, attempts, last_error, published_at, claim_id, claimed_by, lease_until, next_attempt_at, created_at, retired_at, retired_by, retirement_reason_code, retirement_reference, replacement_event_id, recovery_generation FROM outbox WHERE event_id=?`).get(replacementEvent.eventId) as SqliteOutboxRow;
      output = { request: this.mapRetirementRequestRow(approvedRow), retired: this.mapOutboxRow(retiredRow), replacement: this.mapOutboxRow(replacementRow) };
    });
    if (!output) throw new Error("retirement_request_approval_failed");
    return output;
  }

  listRetirementApprovalRequests(tenantId?: string, eventId?: string): OutboxRetirementApprovalRequest[] {
    const rows = this.db.prepare(`SELECT request_id,tenant_id,event_id,recovery_generation,requested_by,reason_code,reference,status,requested_at,approved_by,approved_at,replacement_event_id,superseded_by,superseded_at FROM outbox_retirement_requests WHERE (? IS NULL OR tenant_id=?) AND (? IS NULL OR event_id=?) ORDER BY requested_at,request_id`).all(tenantId ?? null, tenantId ?? null, eventId ?? null, eventId ?? null) as SqliteRetirementRequestRow[];
    return rows.map((r) => this.mapRetirementRequestRow(r));
  }

  listOutboxRecoveryAudit(eventId: string, tenantId?: string): OutboxRecoveryAuditEntry[] {
    const rows = this.db.prepare(`SELECT audit_id,audit_sequence,tenant_id,event_id,recovery_generation,action,actor_id,created_at,request_id,reason_code,reference,replacement_event_id FROM outbox_recovery_audit WHERE event_id=? AND (? IS NULL OR tenant_id=?) ORDER BY audit_sequence`).all(eventId, tenantId ?? null, tenantId ?? null) as SqliteRecoveryAuditRow[];
    return rows.map((r) => this.mapRecoveryAuditRow(r));
  }

  size(): number {
    const row = this.db.prepare("SELECT COUNT(*) AS count FROM cases").get() as SqliteCountRow;
    return row.count;
  }

  healthCheck(): void {
    this.db.prepare("SELECT 1 AS ok").get();
  }

  getOutboxCounts(): OutboxCounts {
    const counts: OutboxCounts = { pending: 0, inFlight: 0, published: 0, deadLetter: 0, retired: 0 };
    const rows = this.db.prepare("SELECT status, COUNT(*) AS count FROM outbox GROUP BY status").all() as SqliteStatusCountRow[];
    for (const row of rows) {
      if (row.status === "PENDING") counts.pending = row.count;
      else if (row.status === "IN_FLIGHT") counts.inFlight = row.count;
      else if (row.status === "PUBLISHED") counts.published = row.count;
      else if (row.status === "DEAD_LETTER") counts.deadLetter = row.count;
      else if (row.status === "RETIRED") counts.retired = row.count;
    }
    return counts;
  }

  getOutboxPressure(ageTargetMs?: number, now = new Date()): OutboxPressure {
    if (ageTargetMs !== undefined && (!Number.isFinite(ageTargetMs) || ageTargetMs < 0)) throw new Error("invalid_outbox_age_target");
    const targetIso = ageTargetMs === undefined ? null : new Date(now.getTime() - ageTargetMs).toISOString();
    const row = this.db.prepare(`
      SELECT COALESCE(SUM(tenant_pending), 0) AS pending,
             COUNT(*) AS active_pending_tenants,
             COALESCE(MAX(tenant_pending), 0) AS largest_tenant_pending,
             COALESCE(MAX(oldest_age_ms), 0) AS oldest_pending_age_ms,
             COALESCE(SUM(overdue_pending), 0) AS overdue_pending,
             COALESCE(SUM(CASE WHEN overdue_pending > 0 THEN 1 ELSE 0 END), 0) AS overdue_pending_tenants,
             (SELECT COUNT(*) FROM outbox AS blocked
              WHERE blocked.status = 'PENDING' AND blocked.aggregate_sequence IS NOT NULL
                AND EXISTS (SELECT 1 FROM outbox AS predecessor
                  WHERE predecessor.tenant_id = blocked.tenant_id
                    AND predecessor.aggregate_case_id = blocked.aggregate_case_id
                    AND predecessor.aggregate_sequence < blocked.aggregate_sequence
                    AND predecessor.status NOT IN ('PUBLISHED','RETIRED'))) AS ordered_blocked_pending,
             (SELECT COUNT(DISTINCT blocked.tenant_id || char(31) || blocked.aggregate_case_id) FROM outbox AS blocked
              WHERE blocked.status = 'PENDING' AND blocked.aggregate_sequence IS NOT NULL
                AND EXISTS (SELECT 1 FROM outbox AS predecessor
                  WHERE predecessor.tenant_id = blocked.tenant_id
                    AND predecessor.aggregate_case_id = blocked.aggregate_case_id
                    AND predecessor.aggregate_sequence < blocked.aggregate_sequence
                    AND predecessor.status NOT IN ('PUBLISHED','RETIRED'))) AS ordered_blocked_aggregates
      FROM (
        SELECT tenant_id,
               COUNT(*) AS tenant_pending,
               MAX(MAX(0, (julianday(?) - julianday(created_at)) * 86400000.0)) AS oldest_age_ms,
               SUM(CASE WHEN ? IS NOT NULL AND created_at < ? THEN 1 ELSE 0 END) AS overdue_pending
        FROM outbox
        WHERE status = 'PENDING'
        GROUP BY tenant_id
      )
    `).get(now.toISOString(), targetIso, targetIso) as { pending: number; active_pending_tenants: number; largest_tenant_pending: number; oldest_pending_age_ms: number; overdue_pending: number; overdue_pending_tenants: number; ordered_blocked_pending: number; ordered_blocked_aggregates: number };
    return {
      pending: Number(row.pending),
      activePendingTenants: Number(row.active_pending_tenants),
      largestTenantPending: Number(row.largest_tenant_pending),
      oldestPendingAgeMs: Math.max(0, Math.floor(Number(row.oldest_pending_age_ms))),
      overduePending: Number(row.overdue_pending),
      overduePendingTenants: Number(row.overdue_pending_tenants),
      orderedBlockedPending: Number(row.ordered_blocked_pending),
      orderedBlockedAggregates: Number(row.ordered_blocked_aggregates)
    };
  }

  private insertRecoveryAudit(entry: Omit<OutboxRecoveryAuditEntry, "sequence">): void {
    const seqRow = this.db.prepare(`SELECT COALESCE(MAX(audit_sequence),0)+1 AS next_sequence FROM outbox_recovery_audit WHERE tenant_id=? AND event_id=?`).get(entry.tenantId, entry.eventId) as { next_sequence: number };
    this.db.prepare(`INSERT INTO outbox_recovery_audit(audit_id,audit_sequence,tenant_id,event_id,recovery_generation,action,actor_id,created_at,request_id,reason_code,reference,replacement_event_id) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run(entry.auditId, Number(seqRow.next_sequence), entry.tenantId, entry.eventId, entry.recoveryGeneration, entry.action, entry.actorId, entry.createdAt, entry.requestId ?? null, entry.reasonCode ?? null, entry.reference ?? null, entry.replacementEventId ?? null);
  }
  private mapRetirementRequestRow(row: SqliteRetirementRequestRow): OutboxRetirementApprovalRequest {
    return { requestId: row.request_id, tenantId: row.tenant_id, eventId: row.event_id, recoveryGeneration: Number(row.recovery_generation), requestedBy: row.requested_by, reasonCode: row.reason_code as DeliveryGapReasonCode, reference: row.reference, status: row.status, requestedAt: row.requested_at, ...(row.approved_by ? {approvedBy:row.approved_by}:{}), ...(row.approved_at ? {approvedAt:row.approved_at}:{}), ...(row.replacement_event_id ? {replacementEventId:row.replacement_event_id}:{}), ...(row.superseded_by ? {supersededBy:row.superseded_by}:{}), ...(row.superseded_at ? {supersededAt:row.superseded_at}:{}) };
  }
  private mapRecoveryAuditRow(row: SqliteRecoveryAuditRow): OutboxRecoveryAuditEntry {
    return { auditId: row.audit_id, sequence: Number(row.audit_sequence), tenantId: row.tenant_id, eventId: row.event_id, recoveryGeneration: Number(row.recovery_generation), action: row.action, actorId: row.actor_id, createdAt: row.created_at, ...(row.request_id ? {requestId:row.request_id}:{}), ...(row.reason_code ? {reasonCode:row.reason_code as DeliveryGapReasonCode}:{}), ...(row.reference ? {reference:row.reference}:{}), ...(row.replacement_event_id ? {replacementEventId:row.replacement_event_id}:{}) };
  }

  private mapOutboxRow(row: SqliteOutboxRow): OutboxRecord {
    return {
      event: JSON.parse(row.event_json) as IntegrationEvent,
      status: row.status,
      attempts: row.attempts,
      ...(row.last_error ? { lastError: row.last_error } : {}),
      ...(row.published_at ? { publishedAt: row.published_at } : {}),
      ...(row.claim_id ? { claimId: row.claim_id } : {}),
      ...(row.claimed_by ? { claimedBy: row.claimed_by } : {}),
      ...(row.lease_until ? { leaseUntil: row.lease_until } : {}),
      ...(row.next_attempt_at ? { nextAttemptAt: row.next_attempt_at } : {}),
      ...(row.created_at ? { enqueuedAt: row.created_at } : {}),
      ...(row.retired_at ? { retiredAt: row.retired_at } : {}),
      ...(row.retired_by ? { retiredBy: row.retired_by } : {}),
      ...(row.retirement_reason_code ? { retirementReasonCode: row.retirement_reason_code as DeliveryGapReasonCode } : {}),
      ...(row.retirement_reference ? { retirementReference: row.retirement_reference } : {}),
      ...(row.replacement_event_id ? { replacementEventId: row.replacement_event_id } : {}),
      recoveryGeneration: Number(row.recovery_generation ?? 0)
    };
  }

  private upsertCase(rxCase: RxCase): void {
    this.db.prepare(`
      INSERT INTO cases(id, tenant_id, case_json) VALUES (?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET tenant_id = excluded.tenant_id, case_json = excluded.case_json
    `).run(rxCase.id, caseTenant(rxCase), JSON.stringify(rxCase));
  }

  private insertEvents(events: IntegrationEvent[]): void {
    const statement = this.db.prepare("INSERT INTO outbox(event_id, tenant_id, aggregate_case_id, aggregate_sequence, event_json, status, attempts, created_at) VALUES (?, ?, ?, ?, ?, 'PENDING', 0, ?)");
    for (const event of events) statement.run(
      event.eventId,
      eventTenant(event),
      Number.isInteger(event.aggregateSequence) ? event.caseId : null,
      Number.isInteger(event.aggregateSequence) ? event.aggregateSequence : null,
      JSON.stringify(event),
      event.occurredAt
    );
  }

  private ensureOutboxSchema(): void {
    const existing = this.db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'outbox'").get() as SqliteSchemaRow | undefined;
    if (!existing) {
      this.createOutboxTable("outbox");
      return;
    }
    const sql = existing.sql ?? "";
    const hasClaims = sql.includes("IN_FLIGHT") && sql.includes("claim_id") && sql.includes("lease_until");
    const current = hasClaims && sql.includes("next_attempt_at");
    if (current) {
      this.createOutboxIndexes();
      return;
    }

    this.transaction(() => {
      this.createOutboxTable("outbox_v3");
      if (hasClaims) {
        this.db.exec(`
          INSERT INTO outbox_v3(event_id, event_json, status, attempts, last_error, published_at, claim_id, claimed_by, lease_until)
          SELECT event_id, event_json, status, attempts, last_error, published_at, claim_id, claimed_by, lease_until FROM outbox;
        `);
      } else {
        this.db.exec(`
          INSERT INTO outbox_v3(event_id, event_json, status, attempts, last_error, published_at)
          SELECT event_id, event_json, status, attempts, last_error, published_at FROM outbox;
        `);
      }
      this.db.exec(`
        DROP TABLE outbox;
        ALTER TABLE outbox_v3 RENAME TO outbox;
      `);
      this.createOutboxIndexes();
    });
  }

  private createOutboxTable(name: "outbox" | "outbox_v3" | "outbox_v5"): void {
    this.db.exec(`
      CREATE TABLE ${name} (
        event_id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL DEFAULT 'default',
        aggregate_case_id TEXT,
        aggregate_sequence INTEGER,
        event_json TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('PENDING','IN_FLIGHT','PUBLISHED','DEAD_LETTER','RETIRED')),
        attempts INTEGER NOT NULL DEFAULT 0,
        last_error TEXT,
        published_at TEXT,
        claim_id TEXT,
        claimed_by TEXT,
        lease_until TEXT,
        next_attempt_at TEXT,
        created_at TEXT,
        retired_at TEXT,
        retired_by TEXT,
        retirement_reason_code TEXT,
        retirement_reference TEXT,
        replacement_event_id TEXT,
        recovery_generation INTEGER NOT NULL DEFAULT 0
      );
    `);
    if (name === "outbox") this.createOutboxIndexes();
  }

  private createOutboxIndexes(): void {
    this.db.exec("CREATE INDEX IF NOT EXISTS idx_outbox_status ON outbox(status)");
    this.db.exec("CREATE INDEX IF NOT EXISTS idx_outbox_lease ON outbox(status, lease_until)");
    this.db.exec("CREATE INDEX IF NOT EXISTS idx_outbox_retry ON outbox(status, next_attempt_at)");
  }

  private ensureOutboxAgeSchema(): void {
    const columns = this.db.prepare("PRAGMA table_info(outbox)").all() as SqliteColumnRow[];
    if (!columns.some((column) => column.name === "created_at")) {
      this.db.exec("ALTER TABLE outbox ADD COLUMN created_at TEXT");
    }
    const rows = this.db.prepare("SELECT event_id, event_json, created_at FROM outbox WHERE created_at IS NULL OR created_at = ''").all() as Array<{ event_id: string; event_json: string; created_at: string | null }>;
    const update = this.db.prepare("UPDATE outbox SET created_at = ? WHERE event_id = ?");
    for (const row of rows) {
      let createdAt = new Date().toISOString();
      try {
        const event = JSON.parse(row.event_json) as IntegrationEvent;
        if (Number.isFinite(Date.parse(event.occurredAt))) createdAt = event.occurredAt;
      } catch { /* keep conservative migration timestamp */ }
      update.run(createdAt, row.event_id);
    }
    this.db.exec("CREATE INDEX IF NOT EXISTS idx_outbox_status_created_at ON outbox(status, created_at)");
  }

  private ensureTenantSchema(): void {
    const ensureColumn = (table: "cases" | "idempotency" | "outbox"): boolean => {
      const columns = this.db.prepare(`PRAGMA table_info(${table})`).all() as SqliteColumnRow[];
      if (columns.some((column) => column.name === "tenant_id")) return false;
      this.db.exec(`ALTER TABLE ${table} ADD COLUMN tenant_id TEXT NOT NULL DEFAULT 'default'`);
      return true;
    };
    const casesAdded = ensureColumn("cases");
    const idempotencyAdded = ensureColumn("idempotency");
    const outboxAdded = ensureColumn("outbox");

    // Parse legacy JSON only during the one-time column migration. Normal startup
    // and tenant-qualified reads can then stay inside relational tenant filters.
    if (casesAdded) {
      const caseRows = this.db.prepare("SELECT id, case_json FROM cases").all() as SqliteCaseTenantRow[];
      const updateCase = this.db.prepare("UPDATE cases SET tenant_id = ? WHERE id = ?");
      for (const row of caseRows) updateCase.run(caseTenant(JSON.parse(row.case_json) as RxCase), row.id);
    }

    if (idempotencyAdded) {
      this.db.exec(`
        UPDATE idempotency
        SET tenant_id = COALESCE((SELECT tenant_id FROM cases WHERE cases.id = idempotency.case_id), 'default')
      `);
    }

    if (outboxAdded) {
      const outboxRows = this.db.prepare("SELECT event_id, event_json FROM outbox").all() as SqliteOutboxTenantRow[];
      const updateOutbox = this.db.prepare("UPDATE outbox SET tenant_id = ? WHERE event_id = ?");
      for (const row of outboxRows) updateOutbox.run(eventTenant(JSON.parse(row.event_json) as IntegrationEvent), row.event_id);
    }

    this.db.exec("CREATE INDEX IF NOT EXISTS idx_cases_tenant ON cases(tenant_id, id)");
    this.db.exec("CREATE INDEX IF NOT EXISTS idx_idempotency_tenant ON idempotency(tenant_id, key)");
    this.db.exec("CREATE INDEX IF NOT EXISTS idx_outbox_status_tenant_created_at ON outbox(status, tenant_id, created_at)");
  }

  private ensureOutboxAggregateSchema(): void {
    const columns = this.db.prepare("PRAGMA table_info(outbox)").all() as SqliteColumnRow[];
    if (!columns.some((column) => column.name === "aggregate_case_id")) {
      this.db.exec("ALTER TABLE outbox ADD COLUMN aggregate_case_id TEXT");
    }
    if (!columns.some((column) => column.name === "aggregate_sequence")) {
      this.db.exec("ALTER TABLE outbox ADD COLUMN aggregate_sequence INTEGER");
    }

    const rows = this.db.prepare(`
      SELECT event_id, event_json
      FROM outbox
      WHERE aggregate_case_id IS NULL OR aggregate_sequence IS NULL
    `).all() as SqliteOutboxTenantRow[];
    const update = this.db.prepare("UPDATE outbox SET aggregate_case_id = ?, aggregate_sequence = ? WHERE event_id = ?");
    for (const row of rows) {
      try {
        const event = JSON.parse(row.event_json) as IntegrationEvent;
        if (Number.isInteger(event.aggregateSequence) && (event.aggregateSequence ?? 0) >= 1) {
          update.run(event.caseId, event.aggregateSequence, row.event_id);
        }
      } catch { /* leave unsequenced legacy/invalid rows independent */ }
    }
    this.db.exec("CREATE INDEX IF NOT EXISTS idx_outbox_aggregate_order ON outbox(tenant_id, aggregate_case_id, aggregate_sequence, status)");
  }

  private ensureOutboxRetirementSchema(): void {
    const existing = this.db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'outbox'").get() as SqliteSchemaRow | undefined;
    const columns = this.db.prepare("PRAGMA table_info(outbox)").all() as SqliteColumnRow[];
    const hasRetiredStatus = (existing?.sql ?? "").includes("RETIRED");
    const requiredColumns = ["retired_at", "retired_by", "retirement_reason_code", "retirement_reference", "replacement_event_id"];
    const hasColumns = requiredColumns.every((name) => columns.some((column) => column.name === name));
    if (hasRetiredStatus && hasColumns) return;

    this.transaction(() => {
      this.createOutboxTable("outbox_v5");
      const oldColumns = new Set((this.db.prepare("PRAGMA table_info(outbox)").all() as SqliteColumnRow[]).map((column) => column.name));
      const copy = [
        "event_id", "tenant_id", "aggregate_case_id", "aggregate_sequence", "event_json", "status", "attempts",
        "last_error", "published_at", "claim_id", "claimed_by", "lease_until", "next_attempt_at", "created_at",
        "retired_at", "retired_by", "retirement_reason_code", "retirement_reference", "replacement_event_id"
      ].filter((column) => oldColumns.has(column));
      const destination = copy.join(", ");
      this.db.exec(`INSERT INTO outbox_v5(${destination}) SELECT ${destination} FROM outbox`);
      this.db.exec("DROP TABLE outbox; ALTER TABLE outbox_v5 RENAME TO outbox;");
      this.createOutboxIndexes();
      this.db.exec("CREATE INDEX IF NOT EXISTS idx_outbox_aggregate_order ON outbox(tenant_id, aggregate_case_id, aggregate_sequence, status)");
      this.db.exec("CREATE INDEX IF NOT EXISTS idx_outbox_retired ON outbox(status, retired_at)");
    });
  }

  private ensureOutboxRecoveryGenerationSchema(): void {
    const columns = this.db.prepare("PRAGMA table_info(outbox)").all() as SqliteColumnRow[];
    if (!columns.some((column) => column.name === "recovery_generation")) {
      this.db.exec("ALTER TABLE outbox ADD COLUMN recovery_generation INTEGER NOT NULL DEFAULT 0");
    }
  }

  private ensureOutboxRecoveryApprovalSchema(): void {
    const requestTable = this.db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='outbox_retirement_requests'").get() as SqliteSchemaRow | undefined;
    if (!requestTable) {
      this.db.exec(`
        CREATE TABLE outbox_retirement_requests (
          request_id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, event_id TEXT NOT NULL, recovery_generation INTEGER NOT NULL CHECK(recovery_generation >= 1),
          requested_by TEXT NOT NULL, reason_code TEXT NOT NULL, reference TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('PENDING','APPROVED','SUPERSEDED')),
          requested_at TEXT NOT NULL, approved_by TEXT, approved_at TEXT, replacement_event_id TEXT, superseded_by TEXT, superseded_at TEXT,
          UNIQUE(tenant_id, event_id, recovery_generation)
        );
      `);
    } else if (!(requestTable.sql ?? "").includes("SUPERSEDED")) {
      this.transaction(() => {
        this.db.exec(`
          CREATE TABLE outbox_retirement_requests_v8 (
            request_id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, event_id TEXT NOT NULL, recovery_generation INTEGER NOT NULL CHECK(recovery_generation >= 1),
            requested_by TEXT NOT NULL, reason_code TEXT NOT NULL, reference TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('PENDING','APPROVED','SUPERSEDED')),
            requested_at TEXT NOT NULL, approved_by TEXT, approved_at TEXT, replacement_event_id TEXT, superseded_by TEXT, superseded_at TEXT,
            UNIQUE(tenant_id, event_id, recovery_generation)
          );
          INSERT INTO outbox_retirement_requests_v8(request_id,tenant_id,event_id,recovery_generation,requested_by,reason_code,reference,status,requested_at,approved_by,approved_at,replacement_event_id)
          SELECT request_id,tenant_id,event_id,recovery_generation,requested_by,reason_code,reference,status,requested_at,approved_by,approved_at,replacement_event_id FROM outbox_retirement_requests;
          DROP TABLE outbox_retirement_requests;
          ALTER TABLE outbox_retirement_requests_v8 RENAME TO outbox_retirement_requests;
        `);
      });
    }
    const auditTable = this.db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='outbox_recovery_audit'").get() as SqliteSchemaRow | undefined;
    if (!auditTable) {
      this.db.exec(`
        CREATE TABLE outbox_recovery_audit (
          audit_id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, event_id TEXT NOT NULL, recovery_generation INTEGER NOT NULL,
          action TEXT NOT NULL CHECK(action IN ('REDRIVEN','RETIREMENT_REQUESTED','RETIREMENT_APPROVED','RETIREMENT_SUPERSEDED')), actor_id TEXT NOT NULL, created_at TEXT NOT NULL,
          request_id TEXT, reason_code TEXT, reference TEXT, replacement_event_id TEXT
        );
      `);
    } else if (!(auditTable.sql ?? "").includes("RETIREMENT_SUPERSEDED")) {
      this.transaction(() => {
        this.db.exec(`
          CREATE TABLE outbox_recovery_audit_v8 (
            audit_id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, event_id TEXT NOT NULL, recovery_generation INTEGER NOT NULL,
            action TEXT NOT NULL CHECK(action IN ('REDRIVEN','RETIREMENT_REQUESTED','RETIREMENT_APPROVED','RETIREMENT_SUPERSEDED')), actor_id TEXT NOT NULL, created_at TEXT NOT NULL,
            request_id TEXT, reason_code TEXT, reference TEXT, replacement_event_id TEXT
          );
          INSERT INTO outbox_recovery_audit_v8(audit_id,tenant_id,event_id,recovery_generation,action,actor_id,created_at,request_id,reason_code,reference,replacement_event_id)
          SELECT audit_id,tenant_id,event_id,recovery_generation,action,actor_id,created_at,request_id,reason_code,reference,replacement_event_id FROM outbox_recovery_audit;
          DROP TABLE outbox_recovery_audit;
          ALTER TABLE outbox_recovery_audit_v8 RENAME TO outbox_recovery_audit;
        `);
      });
    }
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_outbox_retirement_requests_tenant_event ON outbox_retirement_requests(tenant_id, event_id, requested_at);
      CREATE INDEX IF NOT EXISTS idx_outbox_recovery_audit_tenant_event ON outbox_recovery_audit(tenant_id, event_id, created_at, audit_id);
    `);
  }

  private ensureRecoveryAuditSequenceSchema(): void {
    const columns = this.db.prepare("PRAGMA table_info(outbox_recovery_audit)").all() as SqliteColumnRow[];
    if (columns.some((column) => column.name === "audit_sequence")) return;
    this.transaction(() => {
      this.db.exec(`
        CREATE TABLE outbox_recovery_audit_v9 (
          audit_id TEXT PRIMARY KEY, audit_sequence INTEGER NOT NULL, tenant_id TEXT NOT NULL, event_id TEXT NOT NULL, recovery_generation INTEGER NOT NULL,
          action TEXT NOT NULL CHECK(action IN ('REDRIVEN','RETIREMENT_REQUESTED','RETIREMENT_APPROVED','RETIREMENT_SUPERSEDED')), actor_id TEXT NOT NULL, created_at TEXT NOT NULL,
          request_id TEXT, reason_code TEXT, reference TEXT, replacement_event_id TEXT, UNIQUE(tenant_id,event_id,audit_sequence)
        );
        INSERT INTO outbox_recovery_audit_v9(audit_id,audit_sequence,tenant_id,event_id,recovery_generation,action,actor_id,created_at,request_id,reason_code,reference,replacement_event_id)
        SELECT audit_id, ROW_NUMBER() OVER (PARTITION BY tenant_id,event_id ORDER BY created_at,rowid), tenant_id,event_id,recovery_generation,action,actor_id,created_at,request_id,reason_code,reference,replacement_event_id
        FROM outbox_recovery_audit;
        DROP TABLE outbox_recovery_audit;
        ALTER TABLE outbox_recovery_audit_v9 RENAME TO outbox_recovery_audit;
        CREATE INDEX idx_outbox_recovery_audit_tenant_event ON outbox_recovery_audit(tenant_id,event_id,audit_sequence);
      `);
    });
  }

  private ensureCompositeIdempotencySchema(): void {
    const columns = this.db.prepare("PRAGMA table_info(idempotency)").all() as Array<SqliteColumnRow & { pk: number }>;
    const tenantPk = columns.find((column) => column.name === "tenant_id")?.pk ?? 0;
    const keyPk = columns.find((column) => column.name === "key")?.pk ?? 0;
    if (tenantPk === 1 && keyPk === 2) return;

    const rows = this.db.prepare("SELECT key, tenant_id, case_id, request_fingerprint FROM idempotency ORDER BY rowid").all() as SqliteIdempotencyMigrationRow[];
    this.transaction(() => {
      this.db.exec(`
        CREATE TABLE idempotency_v2 (
          key TEXT NOT NULL,
          tenant_id TEXT NOT NULL DEFAULT 'default',
          case_id TEXT NOT NULL,
          request_fingerprint TEXT NOT NULL,
          PRIMARY KEY(tenant_id, key),
          FOREIGN KEY(case_id) REFERENCES cases(id) ON DELETE CASCADE
        );
      `);
      const insert = this.db.prepare("INSERT INTO idempotency_v2(key, tenant_id, case_id, request_fingerprint) VALUES (?, ?, ?, ?)");
      for (const row of rows) {
        insert.run(legacyExternalKey(row.tenant_id, row.key), row.tenant_id, row.case_id, row.request_fingerprint);
      }
      this.db.exec("DROP TABLE idempotency; ALTER TABLE idempotency_v2 RENAME TO idempotency;");
      this.db.exec("CREATE INDEX IF NOT EXISTS idx_idempotency_tenant ON idempotency(tenant_id, key)");
    });
  }

  private transaction(operation: () => void): void {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      operation();
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
}
