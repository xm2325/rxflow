import { AppError } from "./errors.js";

export function caseEtag(caseId: string, version: number): string {
  if (!Number.isInteger(version) || version < 1) throw new Error("invalid_case_version");
  return `\"case-${caseId}-v${version}\"`;
}

export function parseCaseIfMatch(value: string | undefined, caseId: string): number {
  if (!value || value.trim() === "") {
    throw new AppError(
      "review_precondition_required",
      428,
      false,
      "Human review decisions require the case version that was reviewed. Reload the case and retry."
    );
  }
  const escapedCaseId = caseId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = value.trim().match(new RegExp(`^\"case-${escapedCaseId}-v([1-9][0-9]*)\"$`));
  if (!match) {
    throw new AppError("invalid_if_match", 400, false, "If-Match does not contain a valid RxFlow case version.");
  }
  return Number(match[1]);
}

export function outboxRecoveryEtag(eventId: string, generation: number): string {
  if (!Number.isInteger(generation) || generation < 1) throw new Error("invalid_outbox_recovery_generation");
  return `"outbox-${eventId}-g${generation}"`;
}

export function parseOutboxRecoveryIfMatch(value: string | undefined, eventId: string): number {
  if (!value || value.trim() === "") {
    throw new AppError(
      "outbox_recovery_precondition_required",
      428,
      false,
      "Outbox recovery requires the dead-letter generation that was reviewed. Reload the dead-letter queue and retry."
    );
  }
  const escapedEventId = eventId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = value.trim().match(new RegExp(`^"outbox-${escapedEventId}-g([1-9][0-9]*)"$`));
  if (!match) {
    throw new AppError("invalid_outbox_if_match", 400, false, "If-Match does not contain a valid RxFlow outbox recovery generation.");
  }
  return Number(match[1]);
}
