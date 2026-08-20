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
      // Another instance may have bound the key after our initial lookup. Resolve the
      // durable winner instead of converting a legitimate same-request race into a 500.
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

  async approve(caseId: string, reviewer: string, expectedVersion: number, finalAnswer?: string, tenantIdInput?: string): Promise<RxCase> {
    const tenantId = normalizedTenantId(tenantIdInput);
    const current = await this.store.get(caseId, tenantId);
    if (!current || caseTenantId(current) !== tenantId) throw new AppError("case_not_found", 404, false, "Case not found.");
    if (current.status !== "HUMAN_REVIEW_REQUIRED") throw new AppError("case_not_reviewable", 409, false, "The case is not waiting for human review.");
    if (!current.paDraft) throw new AppError("missing_pa_draft", 409, false, "No PA draft is available for review.");
    if (!Number.isInteger(expectedVersion) || expectedVersion < 1) {
      throw new AppError("invalid_review_version", 400, false, "A valid reviewed case version is required.");
    }
    if (current.version !== expectedVersion) {
      this.metrics.increment("stale_review_decisions_total");
      throw new AppError("stale_review", 412, false, "The case changed after it was reviewed. Reload the case before deciding again.");
    }

    // Work on a detached copy. In-memory storage otherwise aliases the object held by the store,
    // which would mutate the persisted status before the compare-and-swap check.
    const rxCase = JSON.parse(JSON.stringify(current)) as RxCase;
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
    const edited = reviewedAnswer !== current.paDraft.answer;
    const reviewedAt = new Date().toISOString();
    rxCase.reviewDecision = { reviewer, edited, finalAnswer: reviewedAnswer, reviewedAt };
    if (edited) audit(rxCase, "pa_draft_edited_by_reviewer", { reviewer, answerChars: reviewedAnswer.length });
    rxCase.status = "PA_APPROVED";
    audit(rxCase, "pa_approved", { reviewer, edited });
    rxCase.status = "ROUTED";
    audit(rxCase, "prescription_routed", { route: "synthetic_internal_pharmacy" });
    const events = [
      integrationEvent("PaApproved", rxCase, { edited }),
      integrationEvent("PrescriptionRouted", rxCase, { route: "synthetic_internal_pharmacy" })
    ];
    rxCase.version = expectedVersion + 1;
    const saved = await this.store.saveWithOutboxIfVersion(rxCase, expectedVersion, events);
    if (!saved) {
      this.metrics.increment("review_conflicts_total");
      throw new AppError("review_conflict", 409, false, "The case changed before this review could be committed. Reload the case before retrying.");
    }
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
