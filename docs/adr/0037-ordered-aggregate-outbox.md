# ADR 0037 — Ordered aggregate outbox heads

## Status

Accepted in RxFlow v0.1.2.

## Problem

RxFlow already attached a monotonic `aggregateSequence` to integration events and downstream consumers rejected stale reordered events. That protected a projection from being overwritten by an older event, but it did not stop the sender from publishing a later event while an earlier event from the same case was still retrying or dead-lettered.

A failure injection made the gap concrete: sequence 1 was moved to `DEAD_LETTER`, while sequences 2–4 were still publishable. Consumer-side sequence checks could hide the late predecessor, but the integration stream itself no longer represented the workflow order.

## Decision

The durable outbox stores aggregate identity and sequence as relational queue metadata. A claim is eligible only when there is no lower sequence for the same `(tenant_id, aggregate_case_id)` whose status is not `PUBLISHED`.

SQLite and PostgreSQL therefore expose only the unresolved head of each ordered aggregate. Legacy/unsequenced events remain independent. PostgreSQL applies this eligibility rule before tenant ranking and `FOR UPDATE ... SKIP LOCKED`.

A terminal head deliberately blocks its successors. Operator redrive resets that exact durable head to `PENDING`; after it publishes successfully, later sequence events become eligible.

## Why consumer-side stale-event rejection is not enough

Consumer ordering protection is still useful for duplicated or externally reordered deliveries, but it is a last safety layer. It should not be used to excuse a producer that knowingly allows an unresolved predecessor to be overtaken.

## Throughput consequence

One-head eligibility could make a healthy single aggregate advance only one event per publisher timer. The dispatcher therefore uses multiple claim waves in one drain. After a successful head publishes, the next head may be claimed immediately in a later wave, while failures end extra waves so a failed head is not hot-looped in the same drain.

## Evidence

Local tests cover:

- one unresolved head per aggregate;
- terminal head blocks untouched successors without consuming their attempt budget;
- redrive releases successors in sequence;
- SQLite migration backfills aggregate queue metadata;
- PostgreSQL SQL contract applies predecessor filtering before tenant ranking and `SKIP LOCKED`;
- a spawned worker + HTTP receiver proves that a terminal sequence-1 failure does not let sequence 2+ overtake, while another aggregate continues and redrive later restores `1,2,3,...` successful delivery order.

The live PostgreSQL CI scenario contains the same head-block/redrive property, but a live PostgreSQL result has not been observed in this sandbox.
