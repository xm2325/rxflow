import type { AuditEvent, IngestResult, RxCase, WorkflowStatus } from "./domain.js";

export interface CaseSummaryView {
  id: string;
  version: number;
  status: WorkflowStatus;
  medicationCode: string;
  payerPlan: string;
  priorAuthRequired: boolean | null;
  paConfidence: number | null;
  evidenceCount: number;
  auditEventCount: number;
  updatedAt: string | null;
  sourceWorkflow: "DIRECT_MEDICATION_REQUEST" | "FHIR_TASK";
  sourceTaskId: string | null;
}

export interface OperationsIngestResultView {
  case: OperationsCaseDetailView;
  duplicate: boolean;
  recovered: boolean;
  inProgress: boolean;
}

export interface ReviewerContextView {
  caseId: string;
  version: number;
  patientReference: string;
  medicationCode: string;
  payerPlan: string;
  reviewClaim: {
    reviewer: string;
    claimedAt: string;
    leaseUntil: string;
  } | null;
  escalation: {
    escalationId: string;
    requestedBy: string;
    requestedAt: string;
    proposedAnswer: string;
    reason: "LOW_CONFIDENCE_EDIT";
  } | null;
  paDraft: {
    answer: string;
    confidence: number;
    requiresHumanReview: boolean;
    reason: string | null;
    evidence: Array<{ source: "fhir" | "payer_policy"; field: string; value: string }>;
  } | null;
}

export interface ReviewGovernanceView {
  caseId: string;
  version: number;
  status: WorkflowStatus;
  reviewClaim: {
    reviewer: string;
    claimedAt: string;
    leaseUntil: string;
  } | null;
  escalation: {
    escalationId: string;
    requestedBy: string;
    requestedAt: string;
    reason: "LOW_CONFIDENCE_EDIT";
    baseVersion: number;
  } | null;
  receipt: {
    decisionId: string;
    reviewer: string;
    secondReviewer: string | null;
    edited: boolean;
    answerHash: string;
    reviewedAt: string;
    committedFromVersion: number;
    committedToVersion: number;
  } | null;
  timeline: Array<{ at: string; type: string; details: Record<string, string | number | boolean> }>;
}

export interface OperationsCaseDetailView extends CaseSummaryView {
  correlationId: string;
  sourceResourceId: string;
  reviewRequired: boolean;
  reviewOwner: string | null;
  reviewLeaseUntil: string | null;
  secondApprovalPending: boolean;
  reviewDecisionId: string | null;
  failure: RxCase["failure"] | null;
  audit: Array<Pick<AuditEvent, "at" | "type">>;
}

/**
 * Operations views intentionally omit patientReference, PA answer text, evidence
 * values, and clinical-note text. Reviewer-only context is exposed separately.
 */
export function toCaseSummaryView(rxCase: RxCase): CaseSummaryView {
  return {
    id: rxCase.id,
    version: rxCase.version,
    status: rxCase.status,
    medicationCode: rxCase.medicationCode,
    payerPlan: rxCase.payerPlan,
    priorAuthRequired: rxCase.priorAuthRequired,
    paConfidence: rxCase.paDraft?.confidence ?? null,
    evidenceCount: rxCase.paDraft?.evidence.length ?? 0,
    auditEventCount: rxCase.audit.length,
    updatedAt: rxCase.audit[rxCase.audit.length - 1]?.at ?? null,
    sourceWorkflow: rxCase.sourceWorkflow ?? "DIRECT_MEDICATION_REQUEST",
    sourceTaskId: rxCase.sourceTaskId ?? null
  };
}

export function toOperationsCaseDetail(rxCase: RxCase): OperationsCaseDetailView {
  return {
    ...toCaseSummaryView(rxCase),
    correlationId: rxCase.correlationId,
    sourceResourceId: rxCase.sourceResourceId,
    reviewRequired: rxCase.status === "HUMAN_REVIEW_REQUIRED",
    reviewOwner: rxCase.reviewClaim?.reviewer ?? null,
    reviewLeaseUntil: rxCase.reviewClaim?.leaseUntil ?? null,
    secondApprovalPending: rxCase.reviewEscalation !== undefined,
    reviewDecisionId: rxCase.reviewDecision?.decisionId ?? null,
    failure: rxCase.failure ? { ...rxCase.failure } : null,
    audit: rxCase.audit.map(({ at, type }) => ({ at, type }))
  };
}

export function toOperationsIngestResult(result: IngestResult): OperationsIngestResultView {
  return {
    case: toOperationsCaseDetail(result.case),
    duplicate: result.duplicate,
    recovered: result.recovered ?? false,
    inProgress: result.inProgress ?? false
  };
}

/** Reviewer-only view. It may include patient/evidence context and proposed override text. */
export function toReviewerContextView(rxCase: RxCase): ReviewerContextView {
  return {
    caseId: rxCase.id,
    version: rxCase.version,
    patientReference: rxCase.patientReference,
    medicationCode: rxCase.medicationCode,
    payerPlan: rxCase.payerPlan,
    reviewClaim: rxCase.reviewClaim ? { ...rxCase.reviewClaim } : null,
    escalation: rxCase.reviewEscalation ? {
      escalationId: rxCase.reviewEscalation.escalationId,
      requestedBy: rxCase.reviewEscalation.requestedBy,
      requestedAt: rxCase.reviewEscalation.requestedAt,
      proposedAnswer: rxCase.reviewEscalation.proposedAnswer,
      reason: rxCase.reviewEscalation.reason
    } : null,
    paDraft: rxCase.paDraft ? {
      answer: rxCase.paDraft.answer,
      confidence: rxCase.paDraft.confidence,
      requiresHumanReview: rxCase.paDraft.requiresHumanReview,
      reason: rxCase.paDraft.reason ?? null,
      evidence: rxCase.paDraft.evidence.map((item) => ({ ...item }))
    } : null
  };
}

export function toReviewGovernanceView(rxCase: RxCase): ReviewGovernanceView {
  const relevant = new Set([
    "human_review_required",
    "human_review_claimed",
    "human_review_claim_expired_reassigned",
    "pa_draft_edited_by_reviewer",
    "review_second_approval_requested",
    "review_second_approval_completed",
    "pa_approved"
  ]);
  return {
    caseId: rxCase.id,
    version: rxCase.version,
    status: rxCase.status,
    reviewClaim: rxCase.reviewClaim ? { ...rxCase.reviewClaim } : null,
    escalation: rxCase.reviewEscalation ? {
      escalationId: rxCase.reviewEscalation.escalationId,
      requestedBy: rxCase.reviewEscalation.requestedBy,
      requestedAt: rxCase.reviewEscalation.requestedAt,
      reason: rxCase.reviewEscalation.reason,
      baseVersion: rxCase.reviewEscalation.baseVersion
    } : null,
    receipt: rxCase.reviewDecision ? {
      decisionId: rxCase.reviewDecision.decisionId,
      reviewer: rxCase.reviewDecision.reviewer,
      secondReviewer: rxCase.reviewDecision.secondReviewer ?? null,
      edited: rxCase.reviewDecision.edited,
      answerHash: rxCase.reviewDecision.answerHash,
      reviewedAt: rxCase.reviewDecision.reviewedAt,
      committedFromVersion: rxCase.reviewDecision.committedFromVersion,
      committedToVersion: rxCase.reviewDecision.committedToVersion
    } : null,
    timeline: rxCase.audit.filter((event) => relevant.has(event.type)).map((event) => ({
      at: event.at,
      type: event.type,
      details: { ...event.details }
    }))
  };
}
