# ADR 0034 — Privacy-safe queue-age objective

## Decision

Track pending-age health as aggregate storage metrics: oldest pending age, overdue pending count, overdue tenant count, and whether a configurable pending-age target is breached.

## Why

Backlog size alone cannot distinguish a large but fresh queue from a smaller queue that has stopped making progress. Queue age adds a second operational signal. The metrics path must not return tenant names, event payloads, patient references, or clinical text.

## Boundary

`RXFLOW_OUTBOX_PENDING_AGE_TARGET_MS` is a local operational objective used by tests and monitoring design. It is not a production latency SLO and has not been tuned from deployed traffic.

## Evidence

A spawned API process runs without a worker and with a 100 ms target. Four pending events cross the target, `targetBreached` becomes true, and the response contains no tenant identifier.
