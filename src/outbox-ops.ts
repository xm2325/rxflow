import { isDeliveryGapReasonCode, type DeliveryGapReasonCode, type OutboxRecord } from "./events.js";
import { AppError } from "./errors.js";
import type { CaseStore, OutboxRecoveryAuditEntry, OutboxRetirementApprovalRequest } from "./store.js";
import { outboxRecoveryEtag } from "./http-preconditions.js";

export interface OutboxOperationsView {
  eventId: string;
  type: string;
  caseId: string;
  aggregateSequence: number | null;
  status: OutboxRecord["status"];
  attempts: number;
  failure: "delivery_failed" | null;
  publishedAt: string | null;
  nextAttemptAt: string | null;
  recoveryGeneration: number;
  recoveryEtag: string | null;
}

export function toOutboxOperationsView(record: OutboxRecord): OutboxOperationsView {
  return {
    eventId: record.event.eventId,
    type: record.event.type,
    caseId: record.event.caseId,
    aggregateSequence: record.event.aggregateSequence ?? null,
    status: record.status,
    attempts: record.attempts,
    failure: record.lastError ? "delivery_failed" : null,
    publishedAt: record.publishedAt ?? null,
    nextAttemptAt: record.nextAttemptAt ?? null,
    recoveryGeneration: record.recoveryGeneration ?? 0,
    recoveryEtag: record.status === "DEAD_LETTER" && (record.recoveryGeneration ?? 0) > 0
      ? outboxRecoveryEtag(record.event.eventId, record.recoveryGeneration ?? 0)
      : null
  };
}

export async function listDeadLetterViews(store: CaseStore, tenantId?: string): Promise<OutboxOperationsView[]> {
  return (await store.listOutbox("DEAD_LETTER", tenantId))
    .map(toOutboxOperationsView);
}

export async function redriveDeadLetter(store: CaseStore, eventId: string, tenantId?: string, expectedRecoveryGeneration?: number, actorId?: string): Promise<OutboxOperationsView> {
  try {
    if (tenantId !== undefined) {
      const record = (await store.listOutbox(undefined, tenantId)).find((candidate) => candidate.event.eventId === eventId);
      if (!record) {
        throw new AppError("outbox_event_not_found", 404, false, "Outbox event not found.");
      }
    }
    return toOutboxOperationsView(await store.redriveDeadLetter(eventId, tenantId, expectedRecoveryGeneration, actorId));
  } catch (error) {
    if (error instanceof Error && error.message === "outbox_event_not_found") {
      throw new AppError("outbox_event_not_found", 404, false, "Outbox event not found.");
    }
    if (error instanceof Error && error.message === "outbox_event_not_dead_letter") {
      throw new AppError("outbox_event_not_dead_letter", 409, false, "Only dead-letter events can be redriven.");
    }
    if (error instanceof Error && error.message === "stale_outbox_recovery") {
      throw new AppError("stale_outbox_recovery", 412, false, "The dead-letter event changed after it was reviewed. Reload the dead-letter queue and retry.");
    }
    throw error;
  }
}

export interface OutboxRetirementOperationsView {
  retired: OutboxOperationsView & {
    status: "RETIRED";
    retiredAt: string;
    retiredBy: string;
    reasonCode: DeliveryGapReasonCode;
    reference: string;
    replacementEventId: string;
  };
  replacement: OutboxOperationsView;
}

export async function retireDeadLetter(
  store: CaseStore,
  eventId: string,
  actorId: string,
  reasonCode: unknown,
  reference: unknown,
  tenantId: string | undefined,
  expectedRecoveryGeneration: number
): Promise<OutboxRetirementOperationsView> {
  if (!isDeliveryGapReasonCode(reasonCode)) {
    throw new AppError("invalid_retirement_reason", 400, false, "A supported retirement reason code is required.");
  }
  if (typeof reference !== "string" || reference.trim().length < 3 || reference.trim().length > 128) {
    throw new AppError("invalid_retirement_reference", 400, false, "A 3-128 character recovery reference is required.");
  }
  try {
    const result = await store.retireDeadLetter({
      eventId, actorId, reasonCode, reference: reference.trim(), tenantId, expectedRecoveryGeneration
    });
    const retired = result.retired;
    if (retired.status !== "RETIRED" || !retired.retiredAt || !retired.retiredBy || !retired.retirementReasonCode || !retired.retirementReference || !retired.replacementEventId) {
      throw new Error("invalid_outbox_retirement_result");
    }
    return {
      retired: {
        ...toOutboxOperationsView(retired),
        status: "RETIRED",
        retiredAt: retired.retiredAt,
        retiredBy: retired.retiredBy,
        reasonCode: retired.retirementReasonCode,
        reference: retired.retirementReference,
        replacementEventId: retired.replacementEventId
      },
      replacement: toOutboxOperationsView(result.replacement)
    };
  } catch (error) {
    if (error instanceof Error && error.message === "outbox_event_not_found") {
      throw new AppError("outbox_event_not_found", 404, false, "Outbox event not found.");
    }
    if (error instanceof Error && error.message === "outbox_event_not_dead_letter") {
      throw new AppError("outbox_event_not_dead_letter", 409, false, "Only dead-letter events can be retired.");
    }
    if (error instanceof Error && error.message === "outbox_event_not_ordered") {
      throw new AppError("outbox_event_not_ordered", 409, false, "Only ordered aggregate events can use gap-declaration recovery.");
    }
    if (error instanceof Error && error.message === "gap_event_cannot_be_retired") {
      throw new AppError("gap_event_cannot_be_retired", 409, false, "A delivery-gap marker cannot be retired again. Repair or redrive the marker instead.");
    }
    if (error instanceof Error && error.message === "stale_outbox_recovery") {
      throw new AppError("stale_outbox_recovery", 412, false, "The dead-letter event changed after it was reviewed. Reload the dead-letter queue and retry.");
    }
    throw error;
  }
}

export interface RetirementApprovalRequestView {
  requestId: string;
  eventId: string;
  recoveryGeneration: number;
  requestedBy: string;
  reasonCode: DeliveryGapReasonCode;
  reference: string;
  status: OutboxRetirementApprovalRequest["status"];
  requestedAt: string;
  approvedBy: string | null;
  approvedAt: string | null;
  replacementEventId: string | null;
  supersededBy: string | null;
  supersededAt: string | null;
  recoveryEtag: string;
}

function toRetirementApprovalRequestView(request: OutboxRetirementApprovalRequest): RetirementApprovalRequestView {
  return {
    requestId: request.requestId, eventId: request.eventId, recoveryGeneration: request.recoveryGeneration, requestedBy: request.requestedBy,
    reasonCode: request.reasonCode, reference: request.reference, status: request.status, requestedAt: request.requestedAt,
    approvedBy: request.approvedBy ?? null, approvedAt: request.approvedAt ?? null, replacementEventId: request.replacementEventId ?? null,
    supersededBy: request.supersededBy ?? null, supersededAt: request.supersededAt ?? null,
    recoveryEtag: outboxRecoveryEtag(request.eventId, request.recoveryGeneration)
  };
}

export async function requestDeadLetterRetirement(
  store: CaseStore, eventId: string, actorId: string, reasonCode: unknown, reference: unknown, tenantId: string, expectedRecoveryGeneration: number
): Promise<RetirementApprovalRequestView> {
  if (!isDeliveryGapReasonCode(reasonCode)) throw new AppError("invalid_retirement_reason", 400, false, "A supported retirement reason code is required.");
  if (typeof reference !== "string" || reference.trim().length < 3 || reference.trim().length > 128) throw new AppError("invalid_retirement_reference", 400, false, "A 3-128 character recovery reference is required.");
  try {
    const request = await store.createRetirementApprovalRequest({
      tenantId, eventId, recoveryGeneration: expectedRecoveryGeneration, requestedBy: actorId, reasonCode, reference: reference.trim()
    });
    return toRetirementApprovalRequestView(request);
  } catch (error) {
    if (error instanceof Error && error.message === "outbox_event_not_found") throw new AppError("outbox_event_not_found", 404, false, "Outbox event not found.");
    if (error instanceof Error && error.message === "outbox_event_not_dead_letter") throw new AppError("outbox_event_not_dead_letter", 409, false, "Only dead-letter events can enter retirement approval.");
    if (error instanceof Error && error.message === "outbox_event_not_ordered") throw new AppError("outbox_event_not_ordered", 409, false, "Only ordered aggregate events can use gap-declaration recovery.");
    if (error instanceof Error && error.message === "gap_event_cannot_be_retired") throw new AppError("gap_event_cannot_be_retired", 409, false, "A delivery-gap marker cannot be retired again.");
    if (error instanceof Error && error.message === "stale_outbox_recovery") throw new AppError("stale_outbox_recovery", 412, false, "The dead-letter event changed after it was reviewed. Reload and retry.");
    if (error instanceof Error && error.message === "retirement_request_exists") throw new AppError("retirement_request_exists", 409, false, "A retirement request already exists for this failure generation.");
    throw error;
  }
}

export async function approveDeadLetterRetirement(
  store: CaseStore, requestId: string, approverId: string, tenantId: string
): Promise<{ request: RetirementApprovalRequestView; retired: OutboxOperationsView; replacement: OutboxOperationsView }> {
  try {
    const result = await store.approveRetirementApprovalRequest(requestId, approverId, tenantId);
    return { request: toRetirementApprovalRequestView(result.request), retired: toOutboxOperationsView(result.retired), replacement: toOutboxOperationsView(result.replacement) };
  } catch (error) {
    if (error instanceof Error && error.message === "retirement_request_not_found") throw new AppError("retirement_request_not_found", 404, false, "Retirement request not found.");
    if (error instanceof Error && error.message === "retirement_request_not_pending") throw new AppError("retirement_request_not_pending", 409, false, "Retirement request is no longer pending.");
    if (error instanceof Error && error.message === "retirement_separation_of_duties") throw new AppError("retirement_separation_of_duties", 409, false, "The requester cannot approve their own destructive recovery action.");
    if (error instanceof Error && error.message === "stale_outbox_recovery") throw new AppError("stale_outbox_recovery", 412, false, "The dead-letter event changed after the retirement request was created.");
    if (error instanceof Error && error.message === "outbox_event_not_dead_letter") throw new AppError("outbox_event_not_dead_letter", 409, false, "The target event is no longer dead-lettered.");
    throw error;
  }
}

export interface RecoveryAuditView {
  sequence: number;
  action: OutboxRecoveryAuditEntry["action"];
  actorId: string;
  recoveryGeneration: number;
  createdAt: string;
  requestId: string | null;
  reasonCode: DeliveryGapReasonCode | null;
  reference: string | null;
  replacementEventId: string | null;
}

export async function listRecoveryHistory(store: CaseStore, eventId: string, tenantId: string): Promise<RecoveryAuditView[]> {
  return (await store.listOutboxRecoveryAudit(eventId, tenantId)).map((entry) => ({
    sequence: entry.sequence, action: entry.action, actorId: entry.actorId, recoveryGeneration: entry.recoveryGeneration, createdAt: entry.createdAt,
    requestId: entry.requestId ?? null, reasonCode: entry.reasonCode ?? null, reference: entry.reference ?? null, replacementEventId: entry.replacementEventId ?? null
  }));
}

export interface BlockedAggregateRecoveryView {
  caseId: string;
  headEventId: string;
  headType: string;
  recoveryGeneration: number;
  recoveryEtag: string;
  blockedFollowers: number;
  pendingRetirementRequestId: string | null;
}

export async function listBlockedAggregateRecoveryViews(store: CaseStore, tenantId: string): Promise<BlockedAggregateRecoveryView[]> {
  const records = await store.listOutbox(undefined, tenantId);
  const requests = await store.listRetirementApprovalRequests(tenantId);
  const pendingByEventGeneration = new Map(requests.filter((request) => request.status === "PENDING").map((request) => [`${request.eventId}\u001f${request.recoveryGeneration}`, request.requestId]));
  const byCase = new Map<string, typeof records>();
  for (const record of records) {
    if (!Number.isInteger(record.event.aggregateSequence)) continue;
    const group = byCase.get(record.event.caseId) ?? []; group.push(record); byCase.set(record.event.caseId, group);
  }
  const views: BlockedAggregateRecoveryView[] = [];
  for (const [caseId, group] of byCase) {
    group.sort((a,b) => (a.event.aggregateSequence ?? 0) - (b.event.aggregateSequence ?? 0));
    const head = group.find((record) => record.status !== "PUBLISHED" && record.status !== "RETIRED");
    if (!head || head.status !== "DEAD_LETTER" || (head.recoveryGeneration ?? 0) < 1) continue;
    const seq = head.event.aggregateSequence ?? 0;
    const blockedFollowers = group.filter((record) => (record.event.aggregateSequence ?? 0) > seq && record.status === "PENDING").length;
    views.push({ caseId, headEventId: head.event.eventId, headType: head.event.type, recoveryGeneration: head.recoveryGeneration ?? 0,
      recoveryEtag: outboxRecoveryEtag(head.event.eventId, head.recoveryGeneration ?? 0), blockedFollowers, pendingRetirementRequestId: pendingByEventGeneration.get(`${head.event.eventId}\u001f${head.recoveryGeneration ?? 0}`) ?? null });
  }
  return views;
}
