import { createHmac, timingSafeEqual } from "node:crypto";
import { DeliveryError, type EventSink, type IntegrationEvent } from "./events.js";
import { httpDeliveryError, type HeaderLookup } from "./http-delivery.js";
import { VERSION } from "./version.js";

interface FetchResponse { ok: boolean; status: number; headers?: HeaderLookup; }
type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal; }) => Promise<FetchResponse>;

export class SignedWebhookEventSink implements EventSink {
  constructor(private readonly url: string, private readonly secret: string, private readonly timeoutMs = 5_000, private readonly fetcher: FetchLike = fetch) {
    if (!url) throw new Error("webhook_url_required");
    if (secret.length < 16) throw new Error("webhook_secret_too_short");
  }
  async deliver(event: IntegrationEvent): Promise<void> {
    const body = JSON.stringify(event);
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const signature = signWebhook(body, timestamp, this.secret);
    let response: FetchResponse;
    try {
      response = await this.fetcher(this.url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "user-agent": `rxflow-webhook/${VERSION}`,
          "x-rxflow-event-id": event.eventId,
          "x-rxflow-event-type": event.type,
          "x-rxflow-timestamp": timestamp,
          "x-rxflow-signature": signature
        },
        body,
        signal: AbortSignal.timeout(this.timeoutMs)
      });
    } catch {
      throw new DeliveryError("webhook_transport_error", { retryable: true, failureScope: "global" });
    }
    if (!response.ok) throw httpDeliveryError("webhook", response.status, response.headers);
  }
}

export function signWebhook(body: string, timestamp: string, secret: string): string {
  const digest = createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex");
  return `v1=${digest}`;
}

export function verifyWebhookSignature(body: string, timestamp: string, signature: string, secret: string, nowMs = Date.now(), toleranceSeconds = 300): boolean {
  if (!/^\d+$/.test(timestamp)) return false;
  const ageSeconds = Math.abs(nowMs / 1000 - Number(timestamp));
  if (ageSeconds > toleranceSeconds) return false;
  const expected = signWebhook(body, timestamp, secret);
  const left = Buffer.from(expected);
  const right = Buffer.from(signature);
  return left.length === right.length && timingSafeEqual(left, right);
}
