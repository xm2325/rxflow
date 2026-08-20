import { AppError } from "./errors.js";

/**
 * Maps consumer request failures to bounded operational codes. Unexpected
 * Error.message values are deliberately discarded because they can contain
 * remote response text, URLs, infrastructure details, or caller-controlled data.
 */
export function consumerOperationalError(error: unknown): { code: string; status: number } {
  if (error instanceof AppError) return { code: error.code, status: error.httpStatus };
  if (error instanceof Error && error.message === "consumer_request_too_large") return { code: "consumer_request_too_large", status: 413 };
  if (error instanceof Error && (error.message === "consumer_invalid_json" || error.message === "consumer_empty_body")) {
    return { code: error.message, status: 400 };
  }
  return { code: "consumer_internal_error", status: 500 };
}

/** A stable code for an unexpected worker-loop failure. */
export function workerOperationalErrorCode(_error: unknown): string {
  return "outbox_worker_internal_error";
}
