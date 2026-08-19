# ADR 0050 — Bound shared-outage fan-out by delivery concurrency

## Status

Accepted in v0.2.6.

## Context

Cross-tenant concurrency improves latency, but a global failure is only known after a downstream call returns an error. Other calls that were already sent cannot be recalled.

## Decision

When a retryable global failure is observed, stop launching new external calls and defer every untouched claimed record without consuming its attempt budget. Calls already in progress are allowed to complete under their existing claims. Therefore the number of requests that can already be exposed to a newly detected shared outage is bounded by `RXFLOW_OUTBOX_TENANT_DELIVERY_CONCURRENCY`.

## Consequences

- Global failure containment is bounded rather than absolute.
- Raising concurrency trades lower cross-tenant latency for more possible in-flight requests during a newly detected shared outage.
- Already-active calls may independently succeed or fail; downstream idempotency and normal durable failure handling still apply.
- Untouched claims return to `PENDING` with the shared retry floor and no attempt cost.

## Evidence

A spawned worker with three tenants, batch size six and tenant concurrency two receives delayed HTTP 503 responses. Exactly two requests start before the global stop is known, four untouched claims are deferred without attempt cost, and all 24 seeded events publish after the receiver recovers.
