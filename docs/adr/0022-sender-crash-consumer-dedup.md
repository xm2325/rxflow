# ADR 0022 — Sender crash requires consumer deduplication

## Decision

Integration delivery remains at-least-once. Receivers that apply durable business state must deduplicate by stable `(tenantId, eventId)` and commit the processed-event marker with the side effect.

## Why

A receiver can commit work and the sender can crash before recording its own acknowledgement. The lease later expires and another worker sends the same event again. Sender-side queue correctness cannot remove this window.

## Evidence

`integration/worker-crash-recovery.mjs` sends a no-PA route through a signed webhook. The receiver commits `PrescriptionRouted`, Worker A is killed before its acknowledgement is recorded, and Worker B reclaims/redelivers the same event. The routed event is delivered twice, while the pharmacy projection applies its route once and reports the second delivery as duplicate.

## Boundary

This proves an exactly-once effect only for the local SQLite projection and stable event ID. It is not a claim of transport-level exactly-once delivery or a real pharmacy integration.
