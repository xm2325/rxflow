import { AppError } from "./errors.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const TRACE_ID_RE = /^(?!0{32}$)[0-9a-f]{32}$/i;
const IDEMPOTENCY_KEY_RE = /^[A-Za-z0-9][A-Za-z0-9._~:+/=\-]*$/;

export function acceptedExternalCorrelationId(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  if (value.length > 64 || value !== value.trim()) return undefined;
  return UUID_RE.test(value) || TRACE_ID_RE.test(value) ? value : undefined;
}

export function parseIdempotencyKey(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.length < 8 || value.length > 128 || value !== value.trim() || !IDEMPOTENCY_KEY_RE.test(value)) {
    throw new AppError(
      "invalid_idempotency_key",
      400,
      false,
      "Idempotency keys must be opaque 8-128 character tokens containing only letters, digits, and ._~:+/=-."
    );
  }
  return value;
}

export function requireJsonContentType(value: unknown, allowFhirJson = false): void {
  if (typeof value !== "string" || value.trim() === "") {
    throw new AppError("unsupported_media_type", 415, false, "A JSON Content-Type is required.");
  }
  const segments = value.split(";").map((part) => part.trim());
  const mediaType = segments.shift()?.toLowerCase();
  const allowed = mediaType === "application/json" || (allowFhirJson && mediaType === "application/fhir+json");
  if (!allowed) {
    throw new AppError("unsupported_media_type", 415, false, allowFhirJson
      ? "Content-Type must be application/json or application/fhir+json."
      : "Content-Type must be application/json.");
  }
  for (const parameter of segments) {
    if (!parameter) continue;
    const [rawName, ...rawValue] = parameter.split("=");
    if (rawName?.trim().toLowerCase() !== "charset") continue;
    const charset = rawValue.join("=").trim().replace(/^"|"$/g, "").toLowerCase();
    if (charset && charset !== "utf-8" && charset !== "utf8") {
      throw new AppError("unsupported_charset", 415, false, "JSON requests must use UTF-8.");
    }
  }
}

export function rejectOversizeContentLength(value: unknown, maxBytes: number): void {
  if (value === undefined) return;
  if (typeof value !== "string" || !/^\d+$/.test(value)) {
    throw new AppError("invalid_content_length", 400, false, "Content-Length must be a non-negative integer.");
  }
  const bytes = Number(value);
  if (!Number.isSafeInteger(bytes)) throw new AppError("invalid_content_length", 400, false, "Content-Length is invalid.");
  if (bytes > maxBytes) throw new AppError("request_too_large", 413, false, `Request body exceeds the ${maxBytes} byte limit.`);
}
