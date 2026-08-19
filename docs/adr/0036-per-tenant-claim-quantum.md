# ADR 0036 — Per-tenant claim quantum for late-arriving fairness

## Decision

Limit how many ready records a single tenant may own in one outbox claim through `RXFLOW_OUTBOX_PER_TENANT_CLAIM_LIMIT`.

## Why

Tenant-rank interleaving only helps tenants present when a claim is made. If one tenant is alone and a worker claims a very large batch, a second tenant that arrives a moment later cannot access those already-owned slots. A claim quantum leaves part of the backlog unowned so later claim cycles can include newly active tenants.

## Evidence

The process gate seeds 100 tenant-A events and starts a worker with `batchSize=100` and a tenant claim limit of four. Tenant B is inserted only after A delivery begins. B reaches the sink at position 6 rather than the potential uncapped position 101.

## Trade-off

A low quantum increases claim frequency and database work; a high quantum weakens late-arrival fairness. The default preserves the batch-size behavior for compatibility, while the cloud reference sets an explicit value. This is not a latency SLO.
