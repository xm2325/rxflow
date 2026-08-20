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
  paDraft: {
    answer: string;
    confidence: number;
    requiresHumanReview: boolean;
    reason: string | null;
    evidence: RxCase["paDraft"] extends infer _T ? Array<{ source: "fhir" | "payer_policy"; field: string; value: string }> : never;
  } | null;
}

export interface OperationsCaseDetailView extends CaseSummaryView {
  correlationId: string;
  sourceResourceId: string;
  reviewRequired: boolean;
  failure: RxCase["failure"] | null;
  audit: Array<Pick<AuditEvent, "at" | "type">>;
}

/**
 * Operations views intentionally omit patientReference, PA answer text, evidence
 * values, and clinical-note text. A future reviewer UI should obtain clinical
 * context through a separately authenticated, least-privilege endpoint.
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


/**
 * Reviewer context is intentionally separate from the operations view. It may
 * contain a patient reference and evidence values required for human review and
 * must therefore be served only through the reviewer-authenticated route.
 */
export function toReviewerContextView(rxCase: RxCase): ReviewerContextView {
  return {
    caseId: rxCase.id,
    version: rxCase.version,
    patientReference: rxCase.patientReference,
    medicationCode: rxCase.medicationCode,
    payerPlan: rxCase.payerPlan,
    paDraft: rxCase.paDraft ? {
      answer: rxCase.paDraft.answer,
      confidence: rxCase.paDraft.confidence,
      requiresHumanReview: rxCase.paDraft.requiresHumanReview,
      reason: rxCase.paDraft.reason ?? null,
      evidence: rxCase.paDraft.evidence.map((item) => ({ ...item }))
    } : null
  };
}
