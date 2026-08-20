import { randomUUID } from "node:crypto";
import type { EvidenceItem, PriorAuthDraft } from "./domain.js";
import type { NormalizedPrescription } from "./fhir.js";

export interface PaDraftGenerator {
  generate(input: NormalizedPrescription, signal?: AbortSignal): Promise<PriorAuthDraft>;
}

export class DeterministicPaDraftGenerator implements PaDraftGenerator {
  async generate(input: NormalizedPrescription, _signal?: AbortSignal): Promise<PriorAuthDraft> {
    const hasPriorTherapy = /prior therapy|failed|trial of|methotrexate|adalimumab/i.test(input.clinicalNote);
    const evidence: EvidenceItem[] = [];
    if (input.clinicalNote) {
      evidence.push({ source: "fhir", field: "MedicationRequest.note", value: input.clinicalNote });
    }

    if (!hasPriorTherapy) {
      return {
        answer: "Insufficient evidence for step-therapy requirement.",
        evidence,
        confidence: 0.55,
        requiresHumanReview: true,
        reason: "No prior-therapy evidence found in the synthetic clinical note."
      };
    }

    return {
      answer: "Prior therapy is documented in the supplied clinical evidence.",
      evidence,
      confidence: 0.94,
      requiresHumanReview: true,
      reason: "Safety policy requires pharmacist review before submission."
    };
  }
}

export function validatePaDraft(draft: PriorAuthDraft, input?: NormalizedPrescription): string[] {
  const errors: string[] = [];
  if (draft.answer.trim().length < 5) errors.push("answer_too_short");
  if (draft.evidence.length === 0) errors.push("missing_evidence");
  if (draft.confidence < 0 || draft.confidence > 1) errors.push("invalid_confidence");
  if (draft.confidence < 0.8) errors.push("low_confidence");
  if (!draft.requiresHumanReview) errors.push("human_review_gate_missing");

  if (input) {
    for (const item of draft.evidence) {
      if (item.source === "fhir") {
        if (item.field !== "MedicationRequest.note" || item.value !== input.clinicalNote) {
          errors.push("ungrounded_fhir_evidence");
        }
      } else if (item.source === "payer_policy") {
        errors.push("unsupported_payer_policy_evidence");
      }
    }
  }

  return [...new Set(errors)];
}

export interface AiTrace {
  traceId: string;
  provider: string;
  startedAt: string;
  durationMs: number;
  success: boolean;
  confidence?: number;
  evidenceCount?: number;
  requiresHumanReview?: boolean;
  errorCode?: string;
}

export interface AiTraceSink {
  record(trace: AiTrace): void;
}

export class InMemoryAiTraceSink implements AiTraceSink {
  readonly traces: AiTrace[] = [];
  record(trace: AiTrace): void {
    this.traces.push(trace);
  }
}

export class MetadataLogAiTraceSink implements AiTraceSink {
  record(trace: AiTrace): void {
    // AiTrace deliberately contains no prescription text, patient reference, answer, or evidence value.
    console.log(JSON.stringify({ event: "ai_trace", ...trace }));
  }
}

export class TracingPaDraftGenerator implements PaDraftGenerator {
  constructor(
    private readonly inner: PaDraftGenerator,
    private readonly sink: AiTraceSink,
    private readonly provider = "deterministic-local"
  ) {}

  async generate(input: NormalizedPrescription, signal?: AbortSignal): Promise<PriorAuthDraft> {
    const started = Date.now();
    const startedAt = new Date().toISOString();
    const traceId = randomUUID();
    try {
      const draft = await this.inner.generate(input, signal);
      this.sink.record({
        traceId,
        provider: this.provider,
        startedAt,
        durationMs: Date.now() - started,
        success: true,
        confidence: draft.confidence,
        evidenceCount: draft.evidence.length,
        requiresHumanReview: draft.requiresHumanReview
      });
      return draft;
    } catch (error) {
      const errorCode = safePaGeneratorErrorCode(error);
      this.sink.record({
        traceId,
        provider: this.provider,
        startedAt,
        durationMs: Date.now() - started,
        success: false,
        errorCode
      });
      throw new Error(errorCode);
    }
  }
}


function safePaGeneratorErrorCode(error: unknown): string {
  if (!(error instanceof Error)) return "pa_generator_error";
  const safe = new Set([
    "pa_generator_timeout",
    "pa_generator_aborted",
    "pa_generator_circuit_open",
    "invalid_pa_model_output"
  ]);
  return safe.has(error.message) ? error.message : "pa_generator_error";
}

export interface RawPaModelClient {
  complete(input: NormalizedPrescription, signal?: AbortSignal): Promise<string>;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function invalidModelOutput(): never {
  throw new Error("invalid_pa_model_output");
}

/**
 * Parses an untrusted model response into the exact PA draft contract used by
 * the workflow. Invalid JSON, wrong scalar types, unsupported evidence sources,
 * and out-of-range confidence values all fail closed.
 */
export function parsePriorAuthDraftJson(raw: string): PriorAuthDraft {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    invalidModelOutput();
  }
  if (!isPlainObject(parsed)) invalidModelOutput();
  if (typeof parsed.answer !== "string" || parsed.answer.trim().length < 5) invalidModelOutput();
  if (typeof parsed.confidence !== "number" || !Number.isFinite(parsed.confidence) || parsed.confidence < 0 || parsed.confidence > 1) invalidModelOutput();
  if (typeof parsed.requiresHumanReview !== "boolean") invalidModelOutput();
  if (parsed.reason !== undefined && typeof parsed.reason !== "string") invalidModelOutput();
  if (!Array.isArray(parsed.evidence)) invalidModelOutput();

  const evidence: EvidenceItem[] = parsed.evidence.map((item) => {
    if (!isPlainObject(item)) invalidModelOutput();
    if (item.source !== "fhir" && item.source !== "payer_policy") invalidModelOutput();
    if (typeof item.field !== "string" || item.field.trim() === "") invalidModelOutput();
    if (typeof item.value !== "string" || item.value.trim() === "") invalidModelOutput();
    return { source: item.source, field: item.field, value: item.value };
  });

  return {
    answer: parsed.answer,
    evidence,
    confidence: parsed.confidence,
    requiresHumanReview: parsed.requiresHumanReview,
    ...(typeof parsed.reason === "string" ? { reason: parsed.reason } : {})
  };
}

export class StructuredJsonPaDraftGenerator implements PaDraftGenerator {
  constructor(private readonly client: RawPaModelClient) {}

  async generate(input: NormalizedPrescription, signal?: AbortSignal): Promise<PriorAuthDraft> {
    const raw = await this.client.complete(input, signal);
    return parsePriorAuthDraftJson(raw);
  }
}

export class TimeoutPaDraftGenerator implements PaDraftGenerator {
  constructor(
    private readonly inner: PaDraftGenerator,
    private readonly timeoutMs: number
  ) {
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1) throw new Error("invalid_pa_timeout");
  }

  async generate(input: NormalizedPrescription, parentSignal?: AbortSignal): Promise<PriorAuthDraft> {
    const controller = new AbortController();
    let timeoutTriggered = false;
    let parentAborted = false;
    let rejectDeadline: ((error: Error) => void) | undefined;

    const onParentAbort = () => {
      parentAborted = true;
      controller.abort(parentSignal?.reason ?? new Error("pa_generator_aborted"));
      rejectDeadline?.(new Error("pa_generator_aborted"));
    };
    if (parentSignal?.aborted) onParentAbort();
    else parentSignal?.addEventListener("abort", onParentAbort, { once: true });

    const deadline = new Promise<PriorAuthDraft>((_resolve, reject) => {
      rejectDeadline = reject;
    });
    const timer = setTimeout(() => {
      timeoutTriggered = true;
      controller.abort(new Error("pa_generator_timeout"));
      rejectDeadline?.(new Error("pa_generator_timeout"));
    }, this.timeoutMs);

    try {
      const operation = this.inner.generate(input, controller.signal);
      return await Promise.race([operation, deadline]);
    } catch (error) {
      if (timeoutTriggered) throw new Error("pa_generator_timeout");
      if (parentAborted || parentSignal?.aborted) throw new Error("pa_generator_aborted");
      throw error;
    } finally {
      clearTimeout(timer);
      parentSignal?.removeEventListener("abort", onParentAbort);
    }
  }
}

export type CircuitState = "CLOSED" | "OPEN" | "HALF_OPEN";

export interface CircuitBreakerSnapshot {
  state: CircuitState;
  consecutiveFailures: number;
  openedAtMs?: number;
  probeInFlight: boolean;
}

export class CircuitBreakerPaDraftGenerator implements PaDraftGenerator {
  private state: CircuitState = "CLOSED";
  private consecutiveFailures = 0;
  private openedAtMs: number | undefined;
  private probeInFlight = false;

  constructor(
    private readonly inner: PaDraftGenerator,
    private readonly failureThreshold = 3,
    private readonly resetAfterMs = 30_000,
    private readonly clock: () => number = () => Date.now()
  ) {
    if (!Number.isInteger(failureThreshold) || failureThreshold < 1) throw new Error("invalid_circuit_failure_threshold");
    if (!Number.isInteger(resetAfterMs) || resetAfterMs < 1) throw new Error("invalid_circuit_reset_window");
  }

  snapshot(): CircuitBreakerSnapshot {
    return {
      state: this.state,
      consecutiveFailures: this.consecutiveFailures,
      ...(this.openedAtMs !== undefined ? { openedAtMs: this.openedAtMs } : {}),
      probeInFlight: this.probeInFlight
    };
  }

  async generate(input: NormalizedPrescription, signal?: AbortSignal): Promise<PriorAuthDraft> {
    const now = this.clock();
    if (this.state === "OPEN") {
      if (this.openedAtMs === undefined || now - this.openedAtMs < this.resetAfterMs) throw new Error("pa_generator_circuit_open");
      this.state = "HALF_OPEN";
    }
    if (this.state === "HALF_OPEN") {
      if (this.probeInFlight) throw new Error("pa_generator_circuit_open");
      this.probeInFlight = true;
    }

    try {
      const result = await this.inner.generate(input, signal);
      this.state = "CLOSED";
      this.consecutiveFailures = 0;
      this.openedAtMs = undefined;
      return result;
    } catch (error) {
      const callerCancelled = error instanceof Error && error.message === "pa_generator_aborted";
      if (!callerCancelled) {
        this.consecutiveFailures += 1;
        if (this.state === "HALF_OPEN" || this.consecutiveFailures >= this.failureThreshold) {
          this.state = "OPEN";
          this.openedAtMs = this.clock();
        }
      } else if (this.state === "HALF_OPEN") {
        // A caller going away is not evidence that the dependency is unhealthy.
        // Return the breaker to OPEN with the original reset clock so another real probe can happen later.
        this.state = "OPEN";
      }
      throw error;
    } finally {
      this.probeInFlight = false;
    }
  }
}
