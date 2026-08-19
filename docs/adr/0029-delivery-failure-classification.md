# ADR 0029 — Delivery failure classification

Status: Accepted in v0.0.88.

## Context

The outbox previously treated most sink exceptions as retryable. That is safe for temporary availability failures but wastes the retry budget on invalid event contracts and ordinary non-retryable HTTP 4xx responses. HTTP 429/5xx also need a way to carry server-requested retry timing.

## Decision

Use a typed `DeliveryError` with `retryable`, optional `retryAfterMs`, and `stopBatch`. Treat invalid integration-event contracts and ordinary non-retryable HTTP 4xx as terminal. Treat transport failures, 408, 425, 429, and 5xx as retryable. A terminal record uses the current durable attempt as the final attempt and moves to DLQ.

`Retry-After` may be delta seconds or an HTTP date. The durable delay is `max(local equal-jitter backoff, Retry-After)`, measured from failure completion.

## Consequences

Poison records leave the active queue quickly. Temporary failures keep bounded retries. The classification is intentionally explicit rather than inferred from arbitrary exception text, except for the existing invalid-event contract prefix used at the internal/external boundary.
