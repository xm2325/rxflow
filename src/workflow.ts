import { createHash, randomUUID } from "node:crypto";
import type { IngestResult, RxCase } from "./domain.js";
import type { PaDraftGenerator } from "./ai.js";
import { validatePaDraft } from "./ai.js";
import { integrationEvent } from "./events.js";
import { AppError } from "./errors.js";
import { NoopMetrics, type Metrics } from "./metrics.js";
import { normalizePrescriptionInput, type NormalizedPrescription } from "./fhir.js";
import { IdempotencyKeyAlreadyBoundError, type CaseStore } from "./store.js";

function audit(rxCase: RxCase, type: string, details: Record<string, string | number | boolean> = {}): void {
  rxCase.audit.push({ at: new Date().toISOString(), type, details });
}

function requestFingerprint(input: { resourceId: string; patientReference: string; medicationCode: string; payerPlan: string; clinicalNote: string; sourceWorkflow?: string; sourceTaskId?: string }): string {
  return createHash("sha256")
    .update(JSON.stringify({
      resourceId: input.resourceId,
      patientReference: input.patientReference,
      medicationCode: input.medicationCode,
      payerPlan: input.payerPlan,
      clinicalNote: input.clinicalNote,
      sourceWorkflow: input.sourceWorkflow ?? "DIRECT_MEDICATION_REQUEST",
      sourceTaskId: input.sourceTaskId ?? null
    }))
    .digest("hex");
}

const DEFAULT_TENANT = "default";

function normalizedTenantId(value?: string): string {
  const tenantId = value?.trim() || DEFAULT_TENANT;
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(tenantId)) {
    throw new AppError("invalid_tenant", 400, false, "Tenant identifier is invalid.");
  }
  return tenantId;
}

function caseTenantId(rxCase: RxCase): string {
  return rxCase.tenantId ?? DEFAULT_TENANT;
}

const DEFAULT_REVIEW_LEASE_MS = 5 * 60_000;
const MIN_REVIEW_LEASE_MS = 30_000;
const MAX_REVIEW_LEASE_MS = 30 * 60_000;

function normalizeReviewDecisionKey(value?: string): string | undefined {
  if (value === undefined) return undefined;
  const key = value.trim();
  if (key.length < 8 || key.length > 128 || !/^[A-Za-z0-9][A-Za-z0-9._~:+/=\-]*$/.test(key)) {
    throw new AppError("invalid_review_idempotency_key", 400, false, "Review idempotency keys must be opaque 8-128 character tokens.");
  }
  return key;
}

function reviewFingerprint(input: Record<string, unknown>): string {
  return createHash("sha256").update(JSON.stringify(input)).digest("hex");
}

function decisionKeyHash(key: string): string {
  return createHash("sha256").update(key).digest("hex");
}

function activeReviewClaim(rxCase: RxCase, now = new Date()): RxCase["reviewClaim"] | undefined {
  const claim = rxCase.reviewClaim;
  if (!claim) return undefined;
  return Date.parse(claim.leaseUntil) > now.getTime() ? claim : undefined;
}

function detachedCase(rxCase: RxCase): RxCase {
  return JSON.parse(JSON.stringify(rxCase)) as RxCase;
}

function deterministicPaRule(payerPlan: string, medicationCode: string): boolean {
  const digest = createHash("sha256").update(`${payerPlan}|${medicationCode}`).digest();
  return digest[0] % 2 === 0;
}

export class RxWorkflowService {
  constructor(
    private readonly store: CaseStore,
    private readonly generator: PaDraftGenerator,
    private readonly maxPaDraftAttempts = 3,
    private readonly metrics: Metrics = new NoopMetrics()
  ) {
    if (maxPaDraftAttempts < 1) throw new Error("max_pa_draft_attempts_must_be_positive");
  }

  async ingest(input: unknown, idempotencyKey?: string, correlationId?: string, signal?: AbortSignal, tenantIdInput?: string): Promise<IngestResult> {
    const normalized = normalizePrescriptionInput(input);
    const tenantId = normalizedTenantId(tenantIdInput);
    const key = idempotencyKey ?? `fhir:${normalized.resourceId}`;
    const fingerprint = requestFingerprint(normalized);
    const existing = await this.store.getByIdempotencyKey(key, tenantId);
    if (existing) {
      if (existing.requestFingerprint !== fingerprint) throw new AppError("idempotency_key_conflict", 409, false, "The idempotency key was already used for a different request.");
      this.metrics.increment("idempotent_replays_total");
      if (existing.case.status === "FAILED_RETRYABLE" && existing.case.failure?.stage === "PA_DRAFT") {
        const recovered = await this.generatePaDraft(existing.case, normalized, existing.case.version, signal);
        this.metrics.increment("workflow_recoveries_total");
        return { case: recovered, duplicate: true, recovered: true, inProgress: false };
      }
      const inProgress = existing.case.status === "RECEIVED" || existing.case.status === "BENEFITS_PENDING" || existing.case.status === "PA_DRAFT_PENDING";
      if (inProgress) this.metrics.increment("in_progress_replays_total");
      return { case: existing.case, duplicate: true, recovered: false, inProgress };
    }

    this.metrics.increment("ingestions_total");
    const rxCase: RxCase = {
      id: randomUUID(),
      tenantId,
      version: 1,
      eventSequence: 0,
      correlationId: correlationId ?? randomUUID(),
      sourceResourceId: normalized.resourceId,
      sourceWorkflow: normalized.sourceWorkflow ?? "DIRECT_MEDICATION_REQUEST",
      ...(normalized.sourceTaskId ? { sourceTaskId: normalized.sourceTaskId } : {}),
      patientReference: normalized.patientReference,
      medicationCode: normalized.medicationCode,
      payerPlan: normalized.payerPlan,
      status: "RECEIVED",
      priorAuthRequired: null,
      audit: []
    };
    audit(rxCase, "prescription_received");
    try {
      await this.store.createCase(rxCase, key, fingerprint, [
        integrationEvent("PrescriptionReceived", rxCase, {
          sourceResourceId: normalized.resourceId,
          sourceWorkflow: normalized.sourceWorkflow ?? "DIRECT_MEDICATION_REQUEST",
          ...(normalized.sourceTaskId ? { sourceTaskId: normalized.sourceTaskId } : {})
        })
      ]);
    } catch (error) {
      if (!(error instanceof IdempotencyKeyAlreadyBoundError)) throw error;
      const winner = await this.store.getByIdempotencyKey(key, tenantId);
      if (!winner) throw new AppError("idempotency_race_unresolved", 503, true, "The request raced with another ingestion and the winning case is not visible yet; retry with the same idempotency key.");
      if (winner.requestFingerprint !== fingerprint) {
        throw new AppError("idempotency_key_conflict", 409, false, "The idempotency key was already used for a different request.");
      }
      this.metrics.increment("idempotent_create_races_total");
      const inProgress = winner.case.status === "RECEIVED" || winner.case.status === "BENEFITS_PENDING" || winner.case.status === "PA_DRAFT_PENDING";
      return { case: winner.case, duplicate: true, recovered: false, inProgress };
    }

    rxCase.status = "BENEFITS_PENDING";
    audit(rxCase, "benefits_check_requested");

    rxCase.priorAuthRequired = deterministicPaRule(normalized.payerPlan, normalized.medicationCode);
    audit(rxCase, "benefits_verified", { priorAuthRequired: rxCase.priorAuthRequired });

    if (!rxCase.priorAuthRequired) {
      this.metrics.increment("pa_not_required_total");
      rxCase.status = "PA_NOT_REQUIRED";
      audit(rxCase, "prior_auth_not_required");
      rxCase.status = "ROUTED";
      audit(rxCase, "prescription_routed", { route: "synthetic_internal_pharmacy" });
      const expectedVersion = rxCase.version;
      rxCase.version += 1;
      const saved = await this.store.saveWithOutboxIfVersion(rxCase, expectedVersion, [
        integrationEvent("BenefitsVerified", rxCase, { priorAuthRequired: false }),
        integrationEvent("PrescriptionRouted", rxCase, { route: "synthetic_internal_pharmacy" })
      ]);
      if (!saved) throw new AppError("workflow_state_conflict", 409, true, "The case changed while benefits processing was being committed; retry with the same idempotency key.");
      this.metrics.increment("routed_total");
      return { case: rxCase, duplicate: false, recovered: false, inProgress: false };
    }

    this.metrics.increment("pa_required_total");
    rxCase.status = "PA_DRAFT_PENDING";
    audit(rxCase, "pa_draft_requested");
    const expectedBenefitsVersion = rxCase.version;
    rxCase.version += 1;
    const benefitsSaved = await this.store.saveWithOutboxIfVersion(rxCase, expectedBenefitsVersion, [
      integrationEvent("BenefitsVerified", rxCase, { priorAuthRequired: true })
    ]);
    if (!benefitsSaved) throw new AppError("workflow_state_conflict", 409, true, "The case changed while benefits processing was being committed; retry with the same idempotency key.");

    const completed = await this.generatePaDraft(rxCase, normalized, rxCase.version, signal);
    return { case: completed, duplicate: false, recovered: false, inProgress: false };
  }

  private async generatePaDraft(rxCase: RxCase, normalized: NormalizedPrescription, expectedVersion = rxCase.version, signal?: AbortSignal): Promise<RxCase> {
    rxCase.status = "PA_DRAFT_PENDING";
    if (rxCase.failure) {
      audit(rxCase, "pa_draft_retry_started", { attempt: rxCase.failure.attempts + 1 });
    }

    try {
      const draft = await this.generator.generate(normalized, signal);
      rxCase.paDraft = draft;
      const validationErrors = validatePaDraft(draft, normalized);
      audit(rxCase, "pa_draft_generated", {
        confidence: draft.confidence,
        evidenceCount: draft.evidence.length,
        validationErrors: validationErrors.length
      });

      rxCase.status = "HUMAN_REVIEW_REQUIRED";
      const previousFailureAttempts = rxCase.failure?.attempts ?? 0;
      rxCase.failure = undefined;
      audit(rxCase, "human_review_required", {
        reason: validationErrors.length ? validationErrors.join(",") : "safety_policy"
      });
      this.metrics.increment("pa_drafts_generated_total");
      rxCase.version = expectedVersion + 1;
      const saved = await this.store.saveWithOutboxIfVersion(rxCase, expectedVersion, [
        integrationEvent("PaDraftGenerated", rxCase, {
          confidence: draft.confidence,
          evidenceCount: draft.evidence.length,
          validationErrors: validationErrors.length,
          recoveredAfterFailures: previousFailureAttempts
        }),
        integrationEvent("HumanReviewRequired", rxCase, {
          reason: validationErrors.length ? validationErrors.join(",") : "safety_policy"
        })
      ]);
      if (!saved) {
        this.metrics.increment("workflow_conflicts_total");
        const winner = await this.store.get(rxCase.id, caseTenantId(rxCase));
        if (!winner) throw new AppError("workflow_state_conflict", 409, true, "The case changed while the PA draft was being committed; retry the request.");
        return winner;
      }
      return rxCase;
    } catch (error) {
      if (error instanceof AppError && error.code === "workflow_state_conflict") throw error;
      const cancelled = error instanceof Error && error.message === "pa_generator_aborted";
      const attempts = (rxCase.failure?.attempts ?? 0) + 1;
      const retryable = cancelled || attempts < this.maxPaDraftAttempts;
      const code = cancelled ? "pa_draft_cancelled" : "pa_draft_dependency_unavailable";
      rxCase.status = retryable ? "FAILED_RETRYABLE" : "FAILED";
      rxCase.failure = {
        stage: "PA_DRAFT",
        code,
        retryable,
        attempts,
        lastFailedAt: new Date().toISOString()
      };
      audit(rxCase, "workflow_failed", { stage: "PA_DRAFT", code, retryable, attempts });
      rxCase.version = expectedVersion + 1;
      const saved = await this.store.saveWithOutboxIfVersion(rxCase, expectedVersion, [
        integrationEvent("WorkflowFailed", rxCase, { stage: "PA_DRAFT", code, retryable, attempts })
      ]);
      if (!saved) {
        this.metrics.increment("workflow_conflicts_total");
        const winner = await this.store.get(rxCase.id, caseTenantId(rxCase));
        if (winner) return winner;
        throw new AppError("workflow_state_conflict", 409, true, "The case changed while a PA failure was being committed; retry the request.");
      }
      if (cancelled) this.metrics.increment("workflow_cancellations_total");
      else this.metrics.increment("workflow_failures_total");
      throw new AppError(code, cancelled ? 499 : 503, retryable, cancelled
        ? "The request was cancelled before PA assistance completed; retry with the same idempotency key."
        : retryable
          ? "The PA draft dependency is temporarily unavailable; retry the same request with the same idempotency key."
          : "The PA draft retry budget is exhausted; operator review is required.");
    }
  }

  private async lookupReviewDecisionReservation(
    bindingKey: string,
    fingerprint: string,
    caseId: string,
    tenantId: string,
    keyHash: string
  ): Promise<"reserved" | RxCase | undefined> {
    const existing = await this.store.getByIdempotencyKey(bindingKey, tenantId);
    if (!existing) return undefined;
    if (existing.case.id !== caseId || existing.requestFingerprint !== fingerprint) {
      this.metrics.increment("review_idempotency_conflicts_total");
      throw new AppError("review_idempotency_key_conflict", 409, false, "The review decision key was already used for a different decision.");
    }
    if (existing.case.reviewReceipts?.some((receipt) => receipt.decisionKeyHash === keyHash)) {
      this.metrics.increment("review_idempotent_replays_total");
      return existing.case;
    }
    return "reserved";
  }

  private async bindReviewDecisionReservation(
    bindingKey: string,
    fingerprint: string,
    caseId: string,
    tenantId: string,
    keyHash: string
  ): Promise<RxCase | undefined> {
    try {
      await this.store.bindIdempotencyKey(bindingKey, caseId, fingerprint, tenantId);
      return undefined;
    } catch (error) {
      if (!(error instanceof IdempotencyKeyAlreadyBoundError)) throw error;
      const winner = await this.store.getByIdempotencyKey(bindingKey, tenantId);
      if (!winner || winner.case.id !== caseId || winner.requestFingerprint !== fingerprint) {
        this.metrics.increment("review_idempotency_conflicts_total");
        throw new AppError("review_idempotency_key_conflict", 409, false, "The review decision key was already used for a different decision.");
      }
      if (winner.case.reviewReceipts?.some((receipt) => receipt.decisionKeyHash === keyHash)) {
        this.metrics.increment("review_idempotent_replays_total");
        return winner.case;
      }
      return undefined;
    }
  }

  async claimReview(
    caseId: string,
    reviewer: string,
    expectedVersion: number,
    tenantIdInput?: string,
    leaseMs = DEFAULT_REVIEW_LEASE_MS,
    now = new Date()
  ): Promise<RxCase> {
    const tenantId = normalizedTenantId(tenantIdInput);
    if (!Number.isInteger(expectedVersion) || expectedVersion < 1) {
      throw new AppError("invalid_review_version", 400, false, "A valid reviewed case version is required.");
    }
    if (!Number.isInteger(leaseMs) || leaseMs < MIN_REVIEW_LEASE_MS || leaseMs > MAX_REVIEW_LEASE_MS) {
      throw new AppError("invalid_review_lease", 400, false, "Review leases must be between 30 seconds and 30 minutes.");
    }
    const current = await this.store.get(caseId, tenantId);
    if (!current || caseTenantId(current) !== tenantId) throw new AppError("case_not_found", 404, false, "Case not found.");
    if (current.status !== "HUMAN_REVIEW_REQUIRED" && current.status !== "SECOND_APPROVAL_REQUIRED") {
      throw new AppError("case_not_reviewable", 409, false, "The case is not waiting for human review.");
    }
    if (current.version !== expectedVersion) {
      throw new AppError("stale_review", 412, false, "The case changed before it could be claimed. Reload the case and retry.");
    }
    const active = activeReviewClaim(current, now);
    if (active?.reviewer === reviewer) return current;
    if (active) {
      throw new AppError("review_already_claimed", 409, false, "Another reviewer currently holds the review lease.");
    }
    const rxCase = detachedCase(current);
    rxCase.reviewClaim = {
      claimId: randomUUID(),
      reviewer,
      claimedAt: now.toISOString(),
      leaseUntil: new Date(now.getTime() + leaseMs).toISOString()
    };
    audit(rxCase, "review_claimed", { reviewer, leaseMs, stage: rxCase.status });
    rxCase.version = expectedVersion + 1;
    const saved = await this.store.saveWithOutboxIfVersion(rxCase, expectedVersion, []);
    if (!saved) throw new AppError("review_claim_conflict", 409, false, "The case changed before the review lease could be committed.");
    this.metrics.increment("review_claims_total");
    return rxCase;
  }

  async approve(
    caseId: string,
    reviewer: string,
    expectedVersion: number,
    finalAnswer?: string,
    tenantIdInput?: string,
    reviewIdempotencyKey?: string,
    requireActiveClaim = false,
    now = new Date()
  ): Promise<RxCase> {
    const tenantId = normalizedTenantId(tenantIdInput);
    const current = await this.store.get(caseId, tenantId);
    if (!current || caseTenantId(current) !== tenantId) throw new AppError("case_not_found", 404, false, "Case not found.");
    if (!current.paDraft) throw new AppError("missing_pa_draft", 409, false, "No PA draft is available for review.");
    if (!Number.isInteger(expectedVersion) || expectedVersion < 1) {
      throw new AppError("invalid_review_version", 400, false, "A valid reviewed case version is required.");
    }

    let reviewedAnswer = current.paDraft.answer;
    if (finalAnswer !== undefined) {
      if (typeof finalAnswer !== "string" || finalAnswer.trim() === "") {
        throw new AppError("invalid_review_answer", 400, false, "A reviewer answer, when supplied, must be a non-empty string.");
      }
      if (finalAnswer.length > 4000) {
        throw new AppError("review_answer_too_large", 413, false, "Reviewer answer exceeds the 4,000 character limit.");
      }
      reviewedAnswer = finalAnswer.trim();
    }

    const idempotencyKey = normalizeReviewDecisionKey(reviewIdempotencyKey);
    const bindingKey = idempotencyKey ? `review:${idempotencyKey}` : undefined;
    const fingerprint = idempotencyKey ? reviewFingerprint({
      action: "approve", caseId, reviewer, expectedVersion, finalAnswer: reviewedAnswer
    }) : undefined;
    const keyHash = bindingKey ? decisionKeyHash(bindingKey) : undefined;
    const existingReservation = bindingKey && fingerprint && keyHash
      ? await this.lookupReviewDecisionReservation(bindingKey, fingerprint, caseId, tenantId, keyHash)
      : undefined;
    if (existingReservation && existingReservation !== "reserved") return existingReservation;

    if (current.status !== "HUMAN_REVIEW_REQUIRED") throw new AppError("case_not_reviewable", 409, false, "The case is not waiting for first human review.");
    if (current.version !== expectedVersion) {
      this.metrics.increment("stale_review_decisions_total");
      throw new AppError("stale_review", 412, false, "The case changed after it was reviewed. Reload the case before deciding again.");
    }
    const active = activeReviewClaim(current, now);
    if (requireActiveClaim && (!active || active.reviewer !== reviewer)) {
      throw new AppError("review_claim_required", 409, false, "An active review lease owned by the reviewer is required before deciding.");
    }
    if (active && active.reviewer !== reviewer) {
      throw new AppError("review_claim_mismatch", 409, false, "The review lease is owned by another reviewer.");
    }
    if (bindingKey && fingerprint && keyHash && existingReservation !== "reserved") {
      const replay = await this.bindReviewDecisionReservation(bindingKey, fingerprint, caseId, tenantId, keyHash);
      if (replay) return replay;
    }

    const rxCase = detachedCase(current);
    const edited = reviewedAnswer !== current.paDraft.answer;
    const reviewedAt = now.toISOString();
    rxCase.reviewDecision = { reviewer, edited, finalAnswer: reviewedAnswer, reviewedAt };
    rxCase.reviewClaim = undefined;
    if (edited) audit(rxCase, "pa_draft_edited_by_reviewer", { reviewer, answerChars: reviewedAnswer.length });

    const needsSecondApproval = edited && current.paDraft.confidence < 0.8;
    rxCase.reviewReceipts ??= [];
    const receiptId = randomUUID();
    if (needsSecondApproval) {
      rxCase.status = "SECOND_APPROVAL_REQUIRED";
      rxCase.reviewEscalation = {
        requestedBy: reviewer,
        requestedAt: reviewedAt,
        reasonCode: "LOW_CONFIDENCE_EDIT",
        proposedAnswer: reviewedAnswer
      };
      rxCase.reviewReceipts.push({
        receiptId, outcome: "SECOND_APPROVAL_REQUIRED", reviewer,
        caseVersion: expectedVersion + 1, edited: true, createdAt: reviewedAt, ...(keyHash ? { decisionKeyHash: keyHash } : {})
      });
      audit(rxCase, "second_approval_required", { reviewer, reasonCode: "LOW_CONFIDENCE_EDIT", receiptId });
      rxCase.version = expectedVersion + 1;
      const saved = await this.store.saveWithOutboxIfVersion(rxCase, expectedVersion, []);
      if (!saved) {
        const winner = await this.store.get(caseId, tenantId);
        if (keyHash && winner?.reviewReceipts?.some((receipt) => receipt.decisionKeyHash === keyHash)) return winner;
        throw new AppError("review_conflict", 409, false, "The case changed before this review could be committed. Reload the case before retrying.");
      }
      this.metrics.increment("second_approval_requests_total");
      return rxCase;
    }

    rxCase.reviewEscalation = undefined;
    rxCase.status = "PA_APPROVED";
    audit(rxCase, "pa_approved", { reviewer, edited, receiptId });
    rxCase.status = "ROUTED";
    audit(rxCase, "prescription_routed", { route: "synthetic_internal_pharmacy" });
    rxCase.reviewReceipts.push({
      receiptId, outcome: "ROUTED", reviewer,
      caseVersion: expectedVersion + 1, edited, createdAt: reviewedAt, ...(keyHash ? { decisionKeyHash: keyHash } : {})
    });
    const events = [
      integrationEvent("PaApproved", rxCase, { edited }),
      integrationEvent("PrescriptionRouted", rxCase, { route: "synthetic_internal_pharmacy" })
    ];
    rxCase.version = expectedVersion + 1;
    const saved = await this.store.saveWithOutboxIfVersion(rxCase, expectedVersion, events);
    if (!saved) {
      const winner = await this.store.get(caseId, tenantId);
      if (keyHash && winner?.reviewReceipts?.some((receipt) => receipt.decisionKeyHash === keyHash)) return winner;
      this.metrics.increment("review_conflicts_total");
      throw new AppError("review_conflict", 409, false, "The case changed before this review could be committed. Reload the case before retrying.");
    }
    this.metrics.increment("human_approvals_total");
    this.metrics.increment("routed_total");
    return rxCase;
  }

  async secondApprove(
    caseId: string,
    reviewer: string,
    expectedVersion: number,
    tenantIdInput?: string,
    reviewIdempotencyKey?: string,
    requireActiveClaim = false,
    now = new Date()
  ): Promise<RxCase> {
    const tenantId = normalizedTenantId(tenantIdInput);
    const current = await this.store.get(caseId, tenantId);
    if (!current || caseTenantId(current) !== tenantId) throw new AppError("case_not_found", 404, false, "Case not found.");
    const firstDecision = current.reviewDecision;
    if (!firstDecision) throw new AppError("second_approval_not_required", 409, false, "The case has no first review decision.");
    const firstReviewer = firstDecision.reviewer;
    if (!Number.isInteger(expectedVersion) || expectedVersion < 1) {
      throw new AppError("invalid_review_version", 400, false, "A valid reviewed case version is required.");
    }
    const idempotencyKey = normalizeReviewDecisionKey(reviewIdempotencyKey);
    const bindingKey = idempotencyKey ? `second-review:${idempotencyKey}` : undefined;
    const fingerprint = idempotencyKey ? reviewFingerprint({
      action: "secondApprove", caseId, reviewer, expectedVersion, firstReviewer
    }) : undefined;
    const keyHash = bindingKey ? decisionKeyHash(bindingKey) : undefined;
    const existingReservation = bindingKey && fingerprint && keyHash
      ? await this.lookupReviewDecisionReservation(bindingKey, fingerprint, caseId, tenantId, keyHash)
      : undefined;
    if (existingReservation && existingReservation !== "reserved") return existingReservation;
    if (current.status !== "SECOND_APPROVAL_REQUIRED" || !current.reviewEscalation) {
      throw new AppError("second_approval_not_required", 409, false, "The case is not waiting for second approval.");
    }
    if (reviewer === firstReviewer) {
      throw new AppError("second_approver_must_differ", 409, false, "The second approver must be different from the first reviewer.");
    }
    if (current.version !== expectedVersion) throw new AppError("stale_review", 412, false, "The case changed before second approval. Reload it before deciding.");
    const active = activeReviewClaim(current, now);
    if (requireActiveClaim && (!active || active.reviewer !== reviewer)) {
      throw new AppError("review_claim_required", 409, false, "An active review lease owned by the second reviewer is required before deciding.");
    }
    if (active && active.reviewer !== reviewer) throw new AppError("review_claim_mismatch", 409, false, "The review lease is owned by another reviewer.");
    if (bindingKey && fingerprint && keyHash && existingReservation !== "reserved") {
      const replay = await this.bindReviewDecisionReservation(bindingKey, fingerprint, caseId, tenantId, keyHash);
      if (replay) return replay;
    }

    const rxCase = detachedCase(current);
    const secondReviewedAt = now.toISOString();
    rxCase.reviewDecision = { ...firstDecision, secondReviewer: reviewer, secondReviewedAt };
    rxCase.reviewClaim = undefined;
    rxCase.status = "PA_APPROVED";
    const receiptId = randomUUID();
    audit(rxCase, "second_approval_granted", { firstReviewer, secondReviewer: reviewer, receiptId });
    audit(rxCase, "pa_approved", { reviewer: firstReviewer, secondReviewer: reviewer, edited: firstDecision.edited, receiptId });
    rxCase.status = "ROUTED";
    audit(rxCase, "prescription_routed", { route: "synthetic_internal_pharmacy" });
    rxCase.reviewReceipts ??= [];
    rxCase.reviewReceipts.push({
      receiptId, outcome: "ROUTED_AFTER_SECOND_APPROVAL", reviewer: firstReviewer,
      secondReviewer: reviewer, caseVersion: expectedVersion + 1, edited: firstDecision.edited, createdAt: secondReviewedAt, ...(keyHash ? { decisionKeyHash: keyHash } : {})
    });
    rxCase.reviewEscalation = undefined;
    const events = [
      integrationEvent("PaApproved", rxCase, { edited: firstDecision.edited }),
      integrationEvent("PrescriptionRouted", rxCase, { route: "synthetic_internal_pharmacy" })
    ];
    rxCase.version = expectedVersion + 1;
    const saved = await this.store.saveWithOutboxIfVersion(rxCase, expectedVersion, events);
    if (!saved) {
      const winner = await this.store.get(caseId, tenantId);
      if (keyHash && winner?.reviewReceipts?.some((receipt) => receipt.decisionKeyHash === keyHash)) return winner;
      throw new AppError("review_conflict", 409, false, "The case changed before second approval could be committed. Reload it before retrying.");
    }
    this.metrics.increment("second_approvals_total");
    this.metrics.increment("human_approvals_total");
    this.metrics.increment("routed_total");
    return rxCase;
  }

  async get(caseId: string, tenantIdInput?: string): Promise<RxCase | undefined> {
    const tenantId = normalizedTenantId(tenantIdInput);
    return await this.store.get(caseId, tenantId);
  }

  async list(tenantIdInput?: string): Promise<RxCase[]> {
    const tenantId = normalizedTenantId(tenantIdInput);
    return await this.store.list(tenantId);
  }
}
