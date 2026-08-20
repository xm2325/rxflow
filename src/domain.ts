export type WorkflowStatus =
  | "RECEIVED"
  | "BENEFITS_PENDING"
  | "PA_NOT_REQUIRED"
  | "PA_DRAFT_PENDING"
  | "HUMAN_REVIEW_REQUIRED"
  | "SECOND_APPROVAL_REQUIRED"
  | "PA_APPROVED"
  | "ROUTED"
  | "FAILED_RETRYABLE"
  | "FAILED";

export interface EvidenceItem {
  source: "fhir" | "payer_policy";
  field: string;
  value: string;
}

export interface PriorAuthDraft {
  answer: string;
  evidence: EvidenceItem[];
  confidence: number;
  requiresHumanReview: boolean;
  reason?: string;
}

export interface AuditEvent {
  at: string;
  type: string;
  details: Record<string, string | number | boolean>;
}


export interface HumanReviewDecision {
  reviewer: string;
  edited: boolean;
  finalAnswer: string;
  reviewedAt: string;
  secondReviewer?: string;
  secondReviewedAt?: string;
}

export interface ReviewClaim {
  claimId: string;
  reviewer: string;
  claimedAt: string;
  leaseUntil: string;
}

export type ReviewReceiptOutcome = "ROUTED" | "SECOND_APPROVAL_REQUIRED" | "ROUTED_AFTER_SECOND_APPROVAL";

export interface ReviewDecisionReceipt {
  receiptId: string;
  outcome: ReviewReceiptOutcome;
  reviewer: string;
  caseVersion: number;
  edited: boolean;
  createdAt: string;
  secondReviewer?: string;
  decisionKeyHash?: string;
}

export interface ReviewEscalation {
  requestedBy: string;
  requestedAt: string;
  reasonCode: "LOW_CONFIDENCE_EDIT";
  proposedAnswer: string;
}

export interface WorkflowFailure {
  stage: "PA_DRAFT";
  code: string;
  retryable: boolean;
  attempts: number;
  lastFailedAt: string;
}

export interface RxCase {
  id: string;
  /** Application tenant boundary. Legacy snapshots without this field are treated as the default tenant. */
  tenantId?: string;
  version: number;
  eventSequence: number;
  correlationId: string;
  sourceResourceId: string;
  sourceWorkflow?: "DIRECT_MEDICATION_REQUEST" | "FHIR_TASK";
  sourceTaskId?: string;
  patientReference: string;
  medicationCode: string;
  payerPlan: string;
  status: WorkflowStatus;
  priorAuthRequired: boolean | null;
  paDraft?: PriorAuthDraft;
  reviewDecision?: HumanReviewDecision;
  reviewClaim?: ReviewClaim;
  reviewReceipts?: ReviewDecisionReceipt[];
  reviewEscalation?: ReviewEscalation;
  failure?: WorkflowFailure;
  audit: AuditEvent[];
}

export interface IngestResult {
  case: RxCase;
  duplicate: boolean;
  recovered?: boolean;
  inProgress?: boolean;
}
