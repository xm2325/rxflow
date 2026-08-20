import { DeliveryError } from "./events.js";

export interface HeaderLookup {
  get(name: string): string | null;
}

export function parseRetryAfterMs(value: string | null | undefined, nowMs = Date.now()): number | undefined {
  const raw = value?.trim();
  if (!raw) return undefined;
  if (/^\d+$/.test(raw)) {
    const seconds = Number(raw);
    if (!Number.isSafeInteger(seconds)) return undefined;
    return seconds * 1_000;
  }
  const absoluteMs = Date.parse(raw);
  if (!Number.isFinite(absoluteMs)) return undefined;
  return Math.max(0, absoluteMs - nowMs);
}

export function httpDeliveryError(
  prefix: string,
  status: number,
  headers?: HeaderLookup,
  nowMs = Date.now(),
  rateLimitScope: "tenant" | "global" = "tenant"
): DeliveryError {
  if (!Number.isInteger(status) || status < 100 || status > 599) {
    return new DeliveryError(`${prefix}_http_invalid_status`, { retryable: true });
  }
  const retryable = status === 408 || status === 425 || status === 429 || status >= 500;
  const retryAfterMs = retryable ? parseRetryAfterMs(headers?.get("retry-after"), nowMs) : undefined;
  const failureScope = status === 429 ? rateLimitScope : status >= 500 ? "global" : "record";
  return new DeliveryError(`${prefix}_http_${status}`, {
    retryable,
    failureScope,
    ...(retryAfterMs !== undefined ? { retryAfterMs } : {})
  });
}
