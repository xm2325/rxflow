# ADR 0030 — Systemic-outage batch short-circuit

Status: Accepted in v0.0.89.

## Context

An outbox worker claims a batch before delivering records one at a time. If the first external call returns a shared retryable failure such as HTTP 503, continuing through every claimed row can generate many requests to the same unhealthy dependency. It also increments attempt counts for records that were not independently faulty.

## Decision

A retryable `DeliveryError` may set `stopBatch=true`. The event whose external call failed is persisted with one additional attempt and its retry time. Remaining claims are returned from `IN_FLIGHT` to `PENDING`, claim/lease ownership is cleared, their attempt counts remain unchanged, and they receive the same retry floor. The dispatcher then stops the batch.

Worker metrics report both `claimed` and `attempted`, plus `deferred` and `batchShortCircuits`.

## Evidence

The spawned systemic-outage gate queues 40 durable events, returns `503 Retry-After: 1`, and records one receiver request while the dependency is down. One record has one attempt and 39 remain at zero attempts. After recovery all 40 publish.

## Consequences

This reduces avoidable calls during shared outages without weakening hard-crash recovery. It is conservative: one failure is allowed to delay the rest of that sink batch. Deployed telemetry could later support a more selective policy.
