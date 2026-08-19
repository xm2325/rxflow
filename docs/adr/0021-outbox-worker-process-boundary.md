# ADR 0021 — Separate API and outbox worker process

## Decision

When `RXFLOW_EXTERNAL_OUTBOX_WORKER=true`, the request-serving API never publishes outbox events. A separate `worker-server` process claims and delivers events from the shared store.

## Why

The earlier flag disabled the API timer but request-triggered calls could still invoke the publisher. That meant a deployment could claim to have external worker ownership while API instances continued to deliver events. Delivery ownership must be a process-level invariant, not a timer convention.

## Evidence

`integration/external-worker-smoke.mjs` proves events stay pending without the worker, drain after start, remain pending after worker shutdown, and drain after restart. `integration/multi-process-worker-smoke.mjs` starts two worker processes over one SQLite WAL queue and verifies 120 unique event deliveries with no duplicate sink delivery.

## Boundary

SQLite is used only for local process evidence. The cloud mapping uses the same store contract with PostgreSQL lease claims; no live Cloud Run/Cloud SQL result is claimed.
