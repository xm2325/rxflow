import { createHmac, timingSafeEqual } from "node:crypto";
import type { EventSink, IntegrationEvent } from "./events.js";
import { DeliveryError } from "./events.js";

export class SignedWebhookEventSink implements EventSink {
  constructor(
    private readonly url: string,
    private readonly secret: string,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly timeoutMs = 5000,
    private readonly clock: () => number = () => Date.now()
  ) {
    if (!/^https?:\/\//.test(url)) throw new Error("invalid_webhook_url");
    if (secret.length < 16) throw new Error("webhook_secret_too_short");
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1) throw new Error("invalid_webhook_timeout");
  }

  async publish(event: IntegrationEvent): Promise<void> {
    const body = JSON.stringify(event);
    const timestamp = String(this.clock());
    const signature = signWebhook(body, timestamp, this.secret);
    let response: Response;
    try {
      response = await this.fetchImpl(this.url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-rxflow-timestamp": timestamp,
          "x-rxflow-signature": signature,
          "x-rxflow-event-id": event.eventId,
          "x-rxflow-tenant-id": event.tenantId,
          "x-rxflow-correlation-id": event.correlationId
        },
        body,
        signal: AbortSignal.timeout(this.timeoutMs)
      });
    } catch {
      throw new DeliveryError("webhook_transport_failed", { retryable: true, failureScope: "tenant" });
    }
    if (!response.ok) {
      const retryable = response.status === 408 || response.status === 425 || response.status === 429 || response.status >= 500;
      const retryAfterMs = retryable ? parseRetryAfter(response.headers.get("retry-after"), this.clock()) : undefined;
      throw new DeliveryError(`webhook_http_${response.status}`, { retryable, retryAfterMs, failureScope: retryable ? "tenant" : "record" });
    }
  }
}

export function signWebhook(body: string, timestamp: string, secret: string): string {
  return `v1=${createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex")}`;
}

export function verifyWebhookSignature(body: string, timestamp: string, signature: string, secret: string): boolean {
  const expected = signWebhook(body, timestamp, secret);
  const a = Buffer.from(expected);
  const b = Buffer.from(signature);
  return a.length === b.length && timingSafeEqual(a, b);
}

function parseRetryAfter(value: string | null, nowMs: number): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1000);
  const date = Date.parse(value);
  if (!Number.isFinite(date)) return undefined;
  return Math.max(0, date - nowMs);
}
