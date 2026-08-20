import type { RxCase } from "./domain.js";

export type WorkQueueAction = "SECOND_REVIEW_APPROVAL" | "PHARMACIST_REVIEW" | "RETRYABLE_WORKFLOW_FAILURE" | "OPERATOR_REVIEW";

export interface WorkQueueItem {
  caseId: string;
  version: number;
  action: WorkQueueAction;
  priority: number;
  status: RxCase["status"];
  medicationCode: string;
  payerPlan: string;
  sourceWorkflow: "DIRECT_MEDICATION_REQUEST" | "FHIR_TASK";
  sourceTaskId: string | null;
  correlationId: string;
  updatedAt: string | null;
  reviewOwner: string | null;
  reviewLeaseUntil: string | null;
  secondApprovalRequestedBy: string | null;
}

function actionFor(rxCase: RxCase): { action: WorkQueueAction; priority: number } | undefined {
  if (rxCase.status === "HUMAN_REVIEW_REQUIRED" && rxCase.reviewEscalation) return { action: "SECOND_REVIEW_APPROVAL", priority: 120 };
  if (rxCase.status === "HUMAN_REVIEW_REQUIRED") return { action: "PHARMACIST_REVIEW", priority: 100 };
  if (rxCase.status === "FAILED_RETRYABLE") return { action: "RETRYABLE_WORKFLOW_FAILURE", priority: 80 };
  if (rxCase.status === "FAILED") return { action: "OPERATOR_REVIEW", priority: 70 };
  return undefined;
}

/**
 * Produces a data-minimised operational queue. Patient references, clinical
 * notes, PA answers, evidence values, and proposed override text are excluded.
 */
export function buildWorkQueue(cases: RxCase[]): WorkQueueItem[] {
  return cases.flatMap((rxCase) => {
    const actionable = actionFor(rxCase);
    if (!actionable) return [];
    return [{
      caseId: rxCase.id,
      version: rxCase.version,
      action: actionable.action,
      priority: actionable.priority,
      status: rxCase.status,
      medicationCode: rxCase.medicationCode,
      payerPlan: rxCase.payerPlan,
      sourceWorkflow: rxCase.sourceWorkflow ?? "DIRECT_MEDICATION_REQUEST",
      sourceTaskId: rxCase.sourceTaskId ?? null,
      correlationId: rxCase.correlationId,
      updatedAt: rxCase.audit[rxCase.audit.length - 1]?.at ?? null,
      reviewOwner: rxCase.reviewClaim?.reviewer ?? null,
      reviewLeaseUntil: rxCase.reviewClaim?.leaseUntil ?? null,
      secondApprovalRequestedBy: rxCase.reviewEscalation?.requestedBy ?? null
    }];
  }).sort((a, b) => {
    if (a.priority !== b.priority) return b.priority - a.priority;
    const left = a.updatedAt ? Date.parse(a.updatedAt) : 0;
    const right = b.updatedAt ? Date.parse(b.updatedAt) : 0;
    if (left !== right) return left - right;
    return a.caseId.localeCompare(b.caseId);
  });
}
