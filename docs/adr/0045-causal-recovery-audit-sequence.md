# ADR 0045 — Use a causal sequence for recovery audit

## Status

Accepted in v0.1.9 and released in v0.2.0.

## Context

Some recovery actions occur inside one transaction and can share the same application timestamp. Ordering equal timestamps by a random audit UUID has no causal meaning. A process test exposed this when `REDRIVEN` was returned before `RETIREMENT_SUPERSEDED` even though supersession was recorded first.

## Decision

Every recovery audit entry has a monotonic integer `sequence` scoped to `(tenantId, eventId)`. `createdAt` remains a wall-clock field, while `sequence` is the authoritative per-event causal order.

SQLite and PostgreSQL persist the sequence and enforce uniqueness for `(tenant,event,sequence)`. SQLite migration backfills legacy entries in stable historical order. PostgreSQL migration uses `ROW_NUMBER()` partitioned by tenant/event for existing rows. New entries allocate `MAX(sequence)+1` while recovery operations hold the durable outbox-row transaction lock.

## Evidence

The spawned recovery gate requires the action history:

```text
1 RETIREMENT_REQUESTED
2 RETIREMENT_SUPERSEDED
3 REDRIVEN
4 RETIREMENT_REQUESTED
5 RETIREMENT_APPROVED
```

The API exposes the sequence so an operator or audit consumer does not need to infer causality from timestamps.

## Consequences

The sequence is local to one recovered event, not a global system sequence. It records recovery-control actions, not integration-event ordering. Aggregate delivery still uses `aggregateSequence` for a different purpose.
