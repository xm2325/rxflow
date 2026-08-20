# ADR 0031 — Pub/Sub token refresh and retry clock

Status: Accepted in v0.0.90.

## Context

Two timing defects can waste durable retries. A cached OAuth token can be rejected before its locally calculated refresh time, and a slow delivery can fail long after the batch was claimed. Reusing the rejected token or measuring backoff from claim time can cause repeated authentication failure or immediately eligible retries.

## Decision

On Pub/Sub HTTP 401, invalidate the exact cached token, obtain a fresh token, and retry the publish once before returning the failure to the outbox policy.

Retry scheduling always takes its time origin from the dispatcher clock after the failure is observed. An explicit `drain(now)` value controls claim/lease timing only; it cannot replace failure-completion time. `Retry-After` is applied as a minimum delay on top of local backoff.

## Consequences

A known-bad cached token is not reused across the normal durable retry budget. Slow failures receive the intended delay after they actually complete. Tests use injected tokens and clocks so these properties are deterministic.
